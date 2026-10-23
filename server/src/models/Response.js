import { getCollection } from "../db/index.js";

const responses = () => getCollection("responses");

// `score` is a 0..1 fraction, always populated by the time an attempt is
// scored: mcq responses get 1/0 immediately (isCorrect kept alongside for
// the UI), theory responses start as null/undefined ("ungraded") and are
// filled in at submit time by gradingEngine.gradeAttemptResponses. This is
// what lets feedbackEngine.computeTopicScores treat mcq and theory
// questions uniformly - partial credit and binary correctness are both
// just a score.
// `imageIds`: the pictures attached to a theory answer (models/AnswerImage.js),
// worked out by the server from what was uploaded for that question.
export async function upsertResponse({ attemptId, questionId, answer, isCorrect, score, timeMs, imageIds = [] }) {
  return responses().findOneAndUpdate(
    { attemptId, questionId },
    { $set: { attemptId, questionId, answer, isCorrect, score, timeMs, imageIds, answeredAt: new Date() } },
    { upsert: true }
  );
}

export async function findResponsesByAttempt(attemptId) {
  return responses().find({ attemptId });
}

/** Every response in several attempts (an array filter is matched as $in). */
export async function findResponsesByAttempts(attemptIds) {
  if (!attemptIds.length) return [];
  return responses().find({ attemptId: attemptIds });
}

/**
 * Persist a grading result computed after the fact (theory questions only):
 * the score, how it was marked, the one-line reason shown to the student, and
 * per key point whether the answer covered it.
 */
export async function updateResponseGrade({ attemptId, questionId, score, gradedBy, graderNote, keyPointResults = null, flagged = false, promptVersion = null, model = null, needsReview = false, imageReading = null, fallbackReason = null }) {
  return responses().findOneAndUpdate(
    { attemptId, questionId },
    // promptVersion / model: which prompt and model marked it, when an LLM did;
    // needsReview / imageReading: what was read from the answer's pictures, and
    // whether that leaves the mark uncertain (gradingEngine.gradeTheoryWithImages)
    // fallbackReason: why the AI marker could not be used, when it could not
    { $set: { score, gradedBy, graderNote, keyPointResults, flagged: Boolean(flagged), promptVersion, model, needsReview: Boolean(needsReview), imageReading, fallbackReason } },
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
        fallbackReason: graded.fallbackReason || null,
        ...(graded.imageReading ? { imageReading: graded.imageReading, needsReview: Boolean(graded.needsReview) } : {}),
        remark: { requestedAt: new Date(), reason, before, after: graded.score, gradedBy: graded.gradedBy, promptVersion: graded.promptVersion || null, model: graded.model || null },
      },
    },
    { upsert: false }
  );
}
