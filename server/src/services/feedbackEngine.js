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

  // Grouping is by topicId (a note id) rather than the note's title, so a
  // student's per-topic record survives a note being renamed and lines up
  // with the mastery store. Questions written before topicId existed fall
  // back to their title, which is exactly what they were keyed on then.
  for (const r of responses) {
    const q = questionsById.get(String(r.questionId));
    if (!q) continue;
    const key = String(q.topicId || q.topic || "General");
    if (!byTopic.has(key))
      byTopic.set(key, {
        label: q.topic || key,
        subtopic: q.subtopic || null,
        parentTopicId: q.parentTopicId || null,
        parentTopic: q.parentTopic || null,
        totalScore: 0,
        total: 0,
        totalTimeMs: 0,
      });
    const bucket = byTopic.get(key);
    if (q.topic) bucket.label = q.topic; // keep the freshest display label
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

  const scores = [...byTopic.entries()].map(([topicId, b]) => {
    const accuracy = b.totalScore / b.total;
    const avgTimeMs = b.totalTimeMs / b.total;
    const normalizedTime = overallAvgMs > 0 ? Math.min(1, avgTimeMs / (2 * overallAvgMs)) : 0.5;
    return {
      topicId,
      topic: b.label,
      // Set when the topic is a subtopic of a split document ("Paging" in
      // "Unit 3"): lets the report group and name subtopics precisely.
      subtopic: b.subtopic,
      parentTopicId: b.parentTopicId,
      parentTopic: b.parentTopic,
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

// A topic's mastery has to move by more than this before the feedback claims
// it changed. Without a floor, a single question nudges the number a little
// and the report would announce "improved" after every attempt regardless of
// whether anything real happened - which is how a progress report stops being
// believed. A team-chosen threshold, not a published one.
const MASTERY_MOVE_THRESHOLD = 0.08;

/**
 * Turn the per-topic mastery movement recorded for this attempt into one
 * plain sentence. Returns null when nothing moved enough to be worth saying,
 * or when this is the student's first attempt on every topic - in which case
 * there is no trajectory to describe yet and claiming one would be false.
 */
// "Unit 3 › Paging" -> "**Paging** (Unit 3)"; a plain label -> "**label**"
function boldLabel(label) {
  const i = String(label).lastIndexOf(" › ");
  return i > 0 ? `**${label.slice(i + 3)}** (${label.slice(0, i)})` : `**${label}**`;
}

function progressSentence(masteryDeltas) {
  if (!Array.isArray(masteryDeltas) || masteryDeltas.length === 0) return null;
  const pct = (x) => `${Math.round(x * 100)}%`;
  const moved = masteryDeltas
    .map((d) => ({ ...d, change: d.after - d.before }))
    .filter((d) => Math.abs(d.change) >= MASTERY_MOVE_THRESHOLD);
  if (moved.length === 0) return null;

  const gained = moved.filter((d) => d.change > 0).sort((a, b) => b.change - a.change);
  const slipped = moved.filter((d) => d.change < 0).sort((a, b) => a.change - b.change);

  const parts = [];
  if (gained.length) {
    const g = gained[0];
    parts.push(`Your grasp of ${boldLabel(g.topicLabel)} moved from ${pct(g.before)} to ${pct(g.after)} with this attempt`);
  }
  if (slipped.length) {
    const sl = slipped[0];
    parts.push(
      `${parts.length ? "but " : ""}${boldLabel(sl.topicLabel)} slipped from ${pct(sl.before)} to ${pct(sl.after)}`
    );
  }
  return parts.join(", ") + ".";
}

function fallbackFeedbackText(topicScores, masteryDeltas) {
  if (topicScores.length === 0) return "No questions were answered on this attempt.";
  // Topics are ranked by attentionScore (accuracy AND response time), not
  // by accuracy alone, so the template must not call the last-ranked topic
  // "strongest" by percent-correct: a slow 50% topic can outrank a fast 33%
  // one, and the text would then contradict its own numbers.
  const top = topicScores[0];
  const least = topicScores[topicScores.length - 1];
  const pct = (t) => `${Math.round(t.accuracy * 100)}% correct`;
  // "**Paging** (Unit 3)" reads better than "**Unit 3 › Paging**"
  const name = (t) => (t.subtopic && t.parentTopic ? `**${t.subtopic}** (${t.parentTopic})` : `**${t.topic}**`);
  const lines = [
    `${name(top)} needs the most attention right now (${pct(top)}) - that's the best place to focus your next study session.`,
  ];
  if (topicScores.length > 1) {
    lines.push(`${name(least)} needs the least (${pct(least)}) - a quick review is enough there.`);
    if (top.accuracy > least.accuracy) {
      lines.push("The ranking also weighs how long you took on each topic, so it can differ from raw accuracy.");
    }
  }
  const within = documentSentence(topicScores);
  if (within) lines.push(within);
  const progress = progressSentence(masteryDeltas);
  if (progress) lines.push(progress);
  return lines.join(" ");
}

/**
 * Roll subtopic scores up to their document, question-weighted, for the report
 * and the results screen: "Unit 3: 58% overall - Paging 100%, Deadlocks 0%".
 * Only documents with at least one subtopic answered are included, in
 * weakest-first order. Pure arithmetic over topicScores, no new judgement.
 */
export function computeDocumentRollup(topicScores) {
  const byDoc = new Map();
  for (const t of topicScores) {
    if (!t.parentTopicId) continue;
    const key = String(t.parentTopicId);
    if (!byDoc.has(key)) byDoc.set(key, { parentTopicId: t.parentTopicId, parentTopic: t.parentTopic, subtopics: [] });
    byDoc.get(key).subtopics.push(t);
  }
  return [...byDoc.values()]
    .map((d) => {
      const answered = d.subtopics.reduce((n, t) => n + t.questionsAnswered, 0);
      const accuracy = answered ? d.subtopics.reduce((n, t) => n + t.accuracy * t.questionsAnswered, 0) / answered : 0;
      const sorted = [...d.subtopics].sort((a, b) => b.attentionScore - a.attentionScore);
      const best = sorted[sorted.length - 1];
      return {
        parentTopicId: d.parentTopicId,
        parentTopic: d.parentTopic,
        accuracy: Number(accuracy.toFixed(4)),
        questionsAnswered: answered,
        subtopicsAnswered: d.subtopics.length,
        weakestSubtopic: sorted[0]?.subtopic || sorted[0]?.topic || null,
        // only called "strongest" when it actually went well, not merely least bad
        strongestSubtopic:
          sorted.length > 1 && best.accuracy >= 0.6 && best.accuracy > sorted[0].accuracy ? best.subtopic || best.topic : null,
      };
    })
    .sort((a, b) => a.accuracy - b.accuracy);
}

// One sentence naming the weakest and strongest subtopic inside a document,
// when a test covered at least two subtopics of it - the "which part of Unit 3"
// answer the per-document view could never give.
function documentSentence(topicScores) {
  const doc = computeDocumentRollup(topicScores).find((d) => d.subtopicsAnswered >= 2);
  if (!doc) return null;
  const pct = Math.round(doc.accuracy * 100);
  return `Across **${doc.parentTopic}** you scored ${pct}% overall: **${doc.weakestSubtopic}** is the subtopic to revisit first${
    doc.strongestSubtopic ? `, while **${doc.strongestSubtopic}** is in good shape` : ""
  }.`;
}

export async function phraseFeedback(topicScores, masteryDeltas = []) {
  if (!llmAvailable()) {
    return { text: fallbackFeedbackText(topicScores, masteryDeltas), generatedBy: "template" };
  }

  // The mastery trajectory is handed over as data alongside the ranking, so
  // the LLM can mention improvement or decline across attempts. It still gets
  // no say in either: both the ranking and the before/after numbers are fixed
  // before this call, and the instruction is explicitly to phrase, not judge.
  const movement = masteryDeltas.length
    ? `\n\nPer-topic mastery before and after this attempt (0-1 scale, from the student's full history - state changes only if they are meaningful, and never invent a direction the numbers do not show):\n${JSON.stringify(masteryDeltas, null, 2)}`
    : "";

  const prompt = `A student just finished a test. Here is their deterministic per-topic performance ranking (weakest first, do not change the ranking or the numbers - only phrase it clearly and encouragingly, 3-5 sentences, no markdown headers). Where a topic has a "subtopic" and "parentTopic", it is one section of a larger document: name the specific subtopic (e.g. "Paging in Unit 3"), never just the document:

${JSON.stringify(topicScores, null, 2)}${movement}`;

  const text = await callLLM(prompt, { temperature: 0.5 });
  if (!text) return { text: fallbackFeedbackText(topicScores, masteryDeltas), generatedBy: "template" };
  return { text: text.trim(), generatedBy: "llm" };
}
