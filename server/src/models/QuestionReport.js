import { getCollection } from "../db/index.js";

// "Report this question": a student says a question is wrong, unclear, not
// from their notes or a repeat. One report per student per question (a second
// one replaces the first). The question is then left out of that student's
// future attempts at the test; when the reason says it is broken (wrong
// answer, unclear, not from the notes) it is also never generated for them
// again, in any later test on those notes (routes/tests.js, testEngine
// isReported). The reports are kept for the team to read when judging the
// generator (docs/EVALUATION.md).
const reports = () => getCollection("question_reports");

// "invalid": the student marks the question as one they never want to see
// again - stricter than a report: it is left out of every later attempt and
// every later test for them, with any rewording of it (routes/attempts.js
// deliverablePool, routes/tests.js), and can be undone.
export const REPORT_REASONS = ["wrong-answer", "unclear", "not-in-notes", "repeated", "other", "invalid"];

export async function saveQuestionReport({ questionId, testId, subjectId, ownerId, attemptId = null, reason, comment = "" }) {
  return reports().findOneAndUpdate(
    { questionId, ownerId },
    { $set: { questionId, testId, subjectId, ownerId, attemptId, reason, comment, reportedAt: new Date() } },
    { upsert: true }
  );
}

/** Undo a report or an "invalid" mark (the student's own). Returns how many went. */
export async function deleteQuestionReport(questionId, ownerId) {
  return reports().deleteMany({ questionId, ownerId });
}

/** The questions a student marked invalid in one subject. */
export async function findInvalidBySubject(ownerId, subjectId) {
  return reports().find({ ownerId, subjectId, reason: "invalid" });
}

export async function findReportsByOwner(ownerId, { testId = null } = {}) {
  return reports().find(testId ? { ownerId, testId } : { ownerId });
}
