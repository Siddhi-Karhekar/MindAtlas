import { getCollection } from "../db/index.js";

const feedbackReports = () => getCollection("feedback_reports");

export async function createFeedbackReport({ attemptId, ownerId, topicScores, feedbackText, generatedBy }) {
  return feedbackReports().insertOne({
    attemptId,
    ownerId,
    topicScores,
    feedbackText,
    generatedBy,
    createdAt: new Date(),
  });
}

export async function findFeedbackByAttempt(attemptId) {
  return feedbackReports().findOne({ attemptId });
}
