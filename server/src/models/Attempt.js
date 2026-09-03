import { getCollection } from "../db/index.js";

const attempts = () => getCollection("attempts");

export async function createAttempt({ testId, ownerId }) {
  return attempts().insertOne({
    testId,
    ownerId,
    status: "in_progress",
    startedAt: new Date(),
    submittedAt: null,
  });
}

export async function findOwnedAttempt(id, ownerId) {
  return attempts().findOne({ _id: id, ownerId });
}

export async function markAttemptSubmitted(id) {
  return attempts().findOneAndUpdate({ _id: id }, { $set: { status: "submitted", submittedAt: new Date() } });
}
