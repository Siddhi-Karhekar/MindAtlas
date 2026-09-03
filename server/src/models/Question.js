import { getCollection } from "../db/index.js";

const questions = () => getCollection("questions");

// `status` is "accepted" or "discarded" - the hallucination-gate outcome
// from services/testEngine.js. Discarded items are kept (not deleted) so
// the test builder can show *why* a candidate question didn't make it in,
// same spirit as the architecture doc's "item discarded, not surfaced"
// branch in Diagram 3.
export async function createQuestions(items) {
  const created = [];
  for (const item of items) {
    created.push(await questions().insertOne({ ...item, createdAt: new Date() }));
  }
  return created;
}

export async function findQuestionsByTest(testId, { onlyAccepted = false } = {}) {
  const filter = onlyAccepted ? { testId, status: "accepted" } : { testId };
  return questions().find(filter, { sort: { createdAt: 1 } });
}

export async function findQuestionsByIds(ids) {
  if (!ids.length) return [];
  return questions().find({ _id: ids });
}
