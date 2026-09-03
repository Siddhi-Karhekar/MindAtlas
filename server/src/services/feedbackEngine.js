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

/**
 * Deterministic fusion step: correctness + time -> per-topic attention
 * score, ranked weakest-first. No LLM calls happen here.
 */
export function computeTopicScores(questionsById, responses) {
  const byTopic = new Map();

  for (const r of responses) {
    const q = questionsById.get(String(r.questionId));
    if (!q) continue;
    const topic = q.topic || "General";
    if (!byTopic.has(topic)) byTopic.set(topic, { correct: 0, total: 0, totalTimeMs: 0 });
    const bucket = byTopic.get(topic);
    bucket.total += 1;
    if (r.isCorrect) bucket.correct += 1;
    bucket.totalTimeMs += r.timeMs || 0;
  }

  const avgTimes = [...byTopic.values()].map((b) => b.totalTimeMs / b.total);
  const minTime = Math.min(...avgTimes, 0);
  const maxTime = Math.max(...avgTimes, 1);
  const range = Math.max(maxTime - minTime, 1);

  const scores = [...byTopic.entries()].map(([topic, b]) => {
    const accuracy = b.correct / b.total;
    const avgTimeMs = b.totalTimeMs / b.total;
    const normalizedTime = (avgTimeMs - minTime) / range;
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

function fallbackFeedbackText(topicScores) {
  if (topicScores.length === 0) return "No questions were answered on this attempt.";
  const weakest = topicScores[0];
  const strongest = topicScores[topicScores.length - 1];
  const lines = [
    `You're weakest on **${weakest.topic}** right now (${Math.round(weakest.accuracy * 100)}% correct) - that's the best place to focus your next study session.`,
  ];
  if (topicScores.length > 1) {
    lines.push(
      `**${strongest.topic}** is your strongest area (${Math.round(strongest.accuracy * 100)}% correct) - a quick review is enough there.`
    );
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
