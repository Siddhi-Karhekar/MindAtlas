import { getCollection } from "../db/index.js";

const attempts = () => getCollection("attempts");

// shownQuestionIds and currentDifficulty are the adaptive controller's
// entire state (see services/adaptiveEngine.js): which questions from the
// test's pool this attempt has already been given, and which difficulty
// tier to draw the next one from. targetCount is how many questions this
// attempt will deliver in total before routes/attempts.js tells the
// client to submit.
export async function createAttempt({ testId, ownerId, targetCount, currentDifficulty, shownQuestionIds = [] }) {
  return attempts().insertOne({
    testId,
    ownerId,
    status: "in_progress",
    startedAt: new Date(),
    submittedAt: null,
    shownQuestionIds,
    currentDifficulty,
    targetCount,
  });
}

export async function findOwnedAttempt(id, ownerId) {
  return attempts().findOne({ _id: id, ownerId });
}

export async function markAttemptSubmitted(id) {
  return attempts().findOneAndUpdate({ _id: id }, { $set: { status: "submitted", submittedAt: new Date() } });
}

/** Record that a question has been shown and update the staircase's current tier. */
export async function recordQuestionShown(id, { shownQuestionIds, currentDifficulty }) {
  return attempts().findOneAndUpdate({ _id: id }, { $set: { shownQuestionIds, currentDifficulty } });
}
