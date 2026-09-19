import { callLLM, llmAvailable, parseJsonLoose } from "./llm.js";

// Grades free-text theory/short-answer responses. MCQ responses never pass
// through here - they're scored deterministically and instantly the moment
// the student picks an option (routes/attempts.js). Theory answers can't be
// scored that way, so grading is deferred to attempt submission, same
// timing philosophy as feedbackEngine's phrasing step: keep the timed,
// per-question "focus mode" flow fast, and do the heavier work once, in
// bulk, when the attempt closes.
//
// Two grading paths, same graceful-degradation pattern used everywhere
// else an LLM is involved: an LLM path that judges meaning (so a
// differently-worded but correct answer isn't punished), and a
// zero-dependency keyword-overlap fallback that runs with no GROQ_API_KEY
// at all - deterministic, and grounded in the same keyPoints rubric the
// question itself was generated (or gated) against.

function normalize(s) {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function keywordOverlapScore(answerText, keyPoints) {
  const normalizedAnswer = normalize(answerText);
  if (!normalizedAnswer || !Array.isArray(keyPoints) || keyPoints.length === 0) return 0;
  const hits = keyPoints.filter((kp) => normalizedAnswer.includes(normalize(kp)));
  return Number((hits.length / keyPoints.length).toFixed(4));
}

/**
 * A fast, synchronous, no-network stand-in score used ONLY to drive the
 * adaptive difficulty controller (adaptiveEngine.js) the instant a theory
 * answer is submitted - the real "focus mode" flow can't wait on an LLM
 * round trip just to decide the next question's difficulty. This is
 * always the keyword-overlap heuristic, even when an LLM is configured;
 * the authoritative grade used for scoring/feedback still prefers the LLM
 * and is computed separately, at submission, by gradeAttemptResponses.
 */
export function quickTheoryScore(question, answerText) {
  return keywordOverlapScore(answerText, question.keyPoints);
}

async function gradeWithLLM(question, answerText) {
  const prompt = `You are grading a student's short-answer response against a model answer. Score how well the student's answer captures the model answer's meaning, from 0 (missing or incorrect) to 1 (fully correct), giving partial credit for partially correct answers. Judge meaning only - do not penalize different wording.

QUESTION: ${question.prompt}
MODEL ANSWER: ${question.answerKey}
KEY POINTS EXPECTED: ${(question.keyPoints || []).join("; ")}
STUDENT ANSWER: ${answerText?.trim() ? answerText : "(no answer given)"}

Return ONLY a JSON object shaped like: {"score": <number between 0 and 1>, "note": "<one short sentence explaining the score>"}`;

  const raw = await callLLM(prompt, { temperature: 0.2 });
  const parsed = parseJsonLoose(raw);
  if (!parsed || typeof parsed.score !== "number" || Number.isNaN(parsed.score)) return null;

  const score = Math.max(0, Math.min(1, parsed.score));
  return { score: Number(score.toFixed(4)), note: parsed.note || null, gradedBy: "llm" };
}

/** Grade a single theory response against its question's rubric. */
export async function gradeTheoryResponse(question, answerText) {
  if (llmAvailable()) {
    const graded = await gradeWithLLM(question, answerText);
    if (graded) return graded;
  }
  return { score: keywordOverlapScore(answerText, question.keyPoints), note: null, gradedBy: "keyword-overlap" };
}

/**
 * Grade every not-yet-graded theory response in `responses` (mutates each
 * response object in place with score/gradedBy/graderNote so the caller
 * can immediately feed them into feedbackEngine.computeTopicScores) and
 * returns the list of {attemptId, questionId, score, gradedBy, graderNote}
 * the caller should persist. MCQ responses and already-graded theory
 * responses are left untouched.
 */
export async function gradeAttemptResponses(responses, questionsById) {
  const updates = [];

  for (const r of responses) {
    const q = questionsById.get(String(r.questionId));
    if (!q || q.type !== "theory") continue;
    if (r.score !== null && r.score !== undefined) continue;

    const graded = await gradeTheoryResponse(q, r.answer);
    r.score = graded.score;
    r.gradedBy = graded.gradedBy;
    r.graderNote = graded.note;
    updates.push({ attemptId: r.attemptId, questionId: r.questionId, ...graded });
  }

  return updates;
}
