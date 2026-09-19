import { getCollection } from "../db/index.js";

const feedbackReports = () => getCollection("feedback_reports");

export async function createFeedbackReport({
  attemptId,
  ownerId,
  topicScores,
  feedbackText,
  generatedBy,
  marksAwarded,
  marksPossible,
}) {
  return feedbackReports().insertOne({
    attemptId,
    ownerId,
    topicScores,
    feedbackText,
    generatedBy,
    marksAwarded,
    marksPossible,
    createdAt: new Date(),
  });
}

export async function findFeedbackByAttempt(attemptId) {
  return feedbackReports().findOne({ attemptId });
}
