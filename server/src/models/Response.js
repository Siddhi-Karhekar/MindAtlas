import { getCollection } from "../db/index.js";

const responses = () => getCollection("responses");

export async function upsertResponse({ attemptId, questionId, answer, isCorrect, timeMs }) {
  return responses().findOneAndUpdate(
    { attemptId, questionId },
    { $set: { attemptId, questionId, answer, isCorrect, timeMs, answeredAt: new Date() } },
    { upsert: true }
  );
}

export async function findResponsesByAttempt(attemptId) {
  return responses().find({ attemptId });
}
