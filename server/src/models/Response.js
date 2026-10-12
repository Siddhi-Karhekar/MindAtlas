import { getCollection } from "../db/index.js";

const responses = () => getCollection("responses");

// `score` is a 0..1 fraction, always populated by the time an attempt is
// scored: mcq responses get 1/0 immediately (isCorrect kept alongside for
// the UI), theory responses start as null/undefined ("ungraded") and are
// filled in at submit time by gradingEngine.gradeAttemptResponses. This is
// what lets feedbackEngine.computeTopicScores treat mcq and theory
// questions uniformly - partial credit and binary correctness are both
// just a score.
export async function upsertResponse({ attemptId, questionId, answer, isCorrect, score, timeMs }) {
  return responses().findOneAndUpdate(
    { attemptId, questionId },
    { $set: { attemptId, questionId, answer, isCorrect, score, timeMs, answeredAt: new Date() } },
    { upsert: true }
  );
}

export async function findResponsesByAttempt(attemptId) {
  return responses().find({ attemptId });
}

/**
 * Persist a grading result computed after the fact (theory questions only):
 * the score, how it was marked, the one-line reason shown to the student, and
 * per key point whether the answer covered it.
 */
export async function updateResponseGrade({ attemptId, questionId, score, gradedBy, graderNote, keyPointResults = null, flagged = false, promptVersion = null, model = null }) {
  return responses().findOneAndUpdate(
    { attemptId, questionId },
    // promptVersion / model: which prompt and model marked it, when an LLM did
    { $set: { score, gradedBy, graderNote, keyPointResults, flagged: Boolean(flagged), promptVersion, model } },
    { upsert: false }
  );
}

/**
 * Record a second marking the student asked for. The first mark is kept in
 * `remark.before`, so what changed, and why, can always be shown.
 */
export async function recordRemark({ attemptId, questionId, before, reason, graded }) {
  return responses().findOneAndUpdate(
    { attemptId, questionId },
    {
      $set: {
        score: graded.score,
        gradedBy: graded.gradedBy,
        graderNote: graded.note,
        keyPointResults: graded.keyPointResults || null,
        promptVersion: graded.promptVersion || null,
        model: graded.model || null,
        remark: { requestedAt: new Date(), reason, before, after: graded.score, gradedBy: graded.gradedBy, promptVersion: graded.promptVersion || null, model: graded.model || null },
      },
    },
    { upsert: false }
  );
}
