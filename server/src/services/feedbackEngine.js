import { callLLM, llmAvailable } from "./llm.js";

// Mirrors the architecture doc's most-emphasized design decision for this
// flow: fuse correctness + time into a per-topic score with a plain
// deterministic formula FIRST - no LLM involved - and only afterwards let
// an LLM phrase that already-fixed ranking as readable text. The ranking
// itself must stay auditable and reproducible on identical input; the LLM
// never gets a vote in what counts as a weak topic, only in how it's worded.

function attentionScore({ accuracy, normalizedTime }) {
  // Higher score = needs more attention. Weighted toward correctness
  // (70%) with response speed as a secondary signal (30%) - a fast wrong
  // answer and a slow wrong answer both signal weakness, but the slow one
  // signals it a little more strongly.
  const correctnessComponent = 1 - accuracy;
  return Number((0.7 * correctnessComponent + 0.3 * normalizedTime).toFixed(4));
}

// A response's `score` is a 0..1 fraction - 1/0 for mcq (set the instant
// it's answered), fractional partial credit for theory (filled in by
// gradingEngine at submit time). Treating both as "score" is what lets a
// mixed mcq+theory test collapse into one accuracy number per topic
// instead of needing type-specific branches here.
function responseScore(r) {
  if (typeof r.score === "number") return r.score;
  return r.isCorrect ? 1 : 0; // defensive fallback, shouldn't normally trigger
}

/**
 * Deterministic fusion step: correctness + time -> per-topic attention
 * score, ranked weakest-first. No LLM calls happen here. Works the same
 * whether the underlying questions are mcq, theory, or a mix of both -
 * `accuracy` is really "average score" once partial credit is involved.
 */
export function computeTopicScores(questionsById, responses) {
  const byTopic = new Map();

  for (const r of responses) {
    const q = questionsById.get(String(r.questionId));
    if (!q) continue;
    const topic = q.topic || "General";
    if (!byTopic.has(topic)) byTopic.set(topic, { totalScore: 0, total: 0, totalTimeMs: 0 });
    const bucket = byTopic.get(topic);
    bucket.total += 1;
    bucket.totalScore += responseScore(r);
    bucket.totalTimeMs += r.timeMs || 0;
  }

  // Response time is normalized against the attempt's own overall average
  // response time: a topic exactly as fast as the attempt average scores
  // 0.5, one twice as slow (or slower) scores 1, and an instant one scores 0.
  // This is scale-free (a slow reader and a fast one are each compared to
  // themselves) and, unlike min-max across topics, it can't blow a 100 ms
  // difference between two topics up into a full 0-to-1 swing that outweighs
  // a real accuracy gap. A single topic, or identical times everywhere, comes
  // out neutral (0.5) rather than a spurious extreme.
  const totalResponses = [...byTopic.values()].reduce((n, b) => n + b.total, 0);
  const totalTimeMs = [...byTopic.values()].reduce((n, b) => n + b.totalTimeMs, 0);
  const overallAvgMs = totalResponses > 0 ? totalTimeMs / totalResponses : 0;

  const scores = [...byTopic.entries()].map(([topic, b]) => {
    const accuracy = b.totalScore / b.total;
    const avgTimeMs = b.totalTimeMs / b.total;
    const normalizedTime = overallAvgMs > 0 ? Math.min(1, avgTimeMs / (2 * overallAvgMs)) : 0.5;
    return {
      topic,
      accuracy: Number(accuracy.toFixed(4)),
      avgTimeMs: Math.round(avgTimeMs),
      questionsAnswered: b.total,
      attentionScore: attentionScore({ accuracy, normalizedTime }),
    };
  });

  scores.sort((a, b) => b.attentionScore - a.attentionScore);
  scores.forEach((s, i) => (s.rank = i + 1));
  return scores;
}

/**
 * Total marks awarded vs. possible across the whole attempt, using the
 * same per-response score (partial credit included). Kept separate from
 * computeTopicScores since marks are a test-wide summary number, not a
 * per-topic one.
 */
export function computeMarksSummary(questionsById, responses) {
  let marksAwarded = 0;
  let marksPossible = 0;
  for (const r of responses) {
    const q = questionsById.get(String(r.questionId));
    if (!q) continue;
    marksAwarded += responseScore(r) * (q.marks || 0);
    marksPossible += q.marks || 0;
  }
  return {
    marksAwarded: Number(marksAwarded.toFixed(2)),
    marksPossible: Number(marksPossible.toFixed(2)),
  };
}

function fallbackFeedbackText(topicScores) {
  if (topicScores.length === 0) return "No questions were answered on this attempt.";
  // Topics are ranked by attentionScore (accuracy AND response time), not
  // by accuracy alone, so the template must not call the last-ranked topic
  // "strongest" by percent-correct: a slow 50% topic can outrank a fast 33%
  // one, and the text would then contradict its own numbers.
  const top = topicScores[0];
  const least = topicScores[topicScores.length - 1];
  const pct = (t) => `${Math.round(t.accuracy * 100)}% correct`;
  const lines = [
    `**${top.topic}** needs the most attention right now (${pct(top)}) - that's the best place to focus your next study session.`,
  ];
  if (topicScores.length > 1) {
    lines.push(`**${least.topic}** needs the least (${pct(least)}) - a quick review is enough there.`);
    if (top.accuracy > least.accuracy) {
      lines.push("The ranking also weighs how long you took on each topic, so it can differ from raw accuracy.");
    }
  }
  return lines.join(" ");
}

/**
 * Phrase an already-fixed topicScores ranking as readable feedback. Falls
 * back to a plain template if no GROQ_API_KEY is configured - the ranking
 * itself (computeTopicScores, above) is identical either way.
 */
export async function phraseFeedback(topicScores) {
  if (!llmAvailable()) return { text: fallbackFeedbackText(topicScores), generatedBy: "template" };

  const prompt = `A student just finished a test. Here is their deterministic per-topic performance ranking (weakest first, do not change the ranking or the numbers - only phrase it clearly and encouragingly, 3-5 sentences, no markdown headers):

${JSON.stringify(topicScores, null, 2)}`;

  const text = await callLLM(prompt, { temperature: 0.5 });
  if (!text) return { text: fallbackFeedbackText(topicScores), generatedBy: "template" };
  return { text: text.trim(), generatedBy: "llm" };
}
