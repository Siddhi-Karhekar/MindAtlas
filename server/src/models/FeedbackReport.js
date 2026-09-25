import { getCollection } from "../db/index.js";

const feedbackReports = () => getCollection("feedback_reports");

export async function createFeedbackReport({
  attemptId,
  ownerId,
  subjectId,
  masteryDeltas,
  topicScores,
  documentScores = [],
  feedbackText,
  generatedBy,
  marksAwarded,
  marksPossible,
}) {
  return feedbackReports().insertOne({
    attemptId,
    ownerId,
    subjectId,
    // per-topic { topicId, topicLabel, before, after } for this attempt, so the
    // progress view can plot a trajectory without recomputing it from responses
    masteryDeltas,
    topicScores,
    // per split document: subtopic scores rolled up (feedbackEngine.computeDocumentRollup)
    documentScores,
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

export async function findFeedbackBySubject(ownerId, subjectId) {
  return feedbackReports().find({ ownerId, subjectId }, { sort: { createdAt: 1 } });
}
