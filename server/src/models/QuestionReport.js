import { getCollection } from "../db/index.js";

// "Report this question": a student says a question is wrong, unclear, not
// from their notes or a repeat. One report per student per question (a second
// one replaces the first). The question is then left out of that student's
// future attempts at the test, and the reports are kept for the team to read
// when judging the generator (docs/EVALUATION.md).
const reports = () => getCollection("question_reports");

export const REPORT_REASONS = ["wrong-answer", "unclear", "not-in-notes", "repeated", "other"];

export async function saveQuestionReport({ questionId, testId, subjectId, ownerId, attemptId = null, reason, comment = "" }) {
  return reports().findOneAndUpdate(
    { questionId, ownerId },
    { $set: { questionId, testId, subjectId, ownerId, attemptId, reason, comment, reportedAt: new Date() } },
    { upsert: true }
  );
}

export async function findReportsByOwner(ownerId, { testId = null } = {}) {
  return reports().find(testId ? { ownerId, testId } : { ownerId });
}
