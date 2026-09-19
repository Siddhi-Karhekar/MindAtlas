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

/** Persist a grading result computed after the fact (theory questions only). */
export async function updateResponseGrade({ attemptId, questionId, score, gradedBy, graderNote }) {
  return responses().findOneAndUpdate(
    { attemptId, questionId },
    { $set: { score, gradedBy, graderNote } },
    { upsert: false }
  );
}
