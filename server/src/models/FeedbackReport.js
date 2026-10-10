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
  promptVersion = null,
  model = null,
  marksAwarded,
  marksPossible,
}) {
  // one report per attempt: written by upsert, so it can never be doubled
  return feedbackReports().findOneAndUpdate(
    { attemptId },
    {
      $set: {
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
        // which prompt and model worded the feedback, when an LLM did
        promptVersion,
        model,
        marksAwarded,
        marksPossible,
        createdAt: new Date(),
      },
    },
    { upsert: true }
  );
}

export async function findFeedbackByAttempt(attemptId) {
  return feedbackReports().findOne({ attemptId });
}

export async function findFeedbackBySubject(ownerId, subjectId) {
  return feedbackReports().find({ ownerId, subjectId }, { sort: { createdAt: 1 } });
}

/** After a re-mark: the report's scores and marks, worked out again from the responses. */
export async function updateFeedbackScores(attemptId, { topicScores, documentScores, marksAwarded, marksPossible, feedbackText }) {
  const set = { topicScores, documentScores, marksAwarded, marksPossible, remarkedAt: new Date() };
  if (typeof feedbackText === "string") set.feedbackText = feedbackText;
  return feedbackReports().findOneAndUpdate({ attemptId }, { $set: set });
}
