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

/**
 * Retire a question for every student (admin page): it stays in tests and in
 * reviews of attempts already taken, but is never given in a new attempt
 * (routes/attempts.js, deliverablePool). Pass retired=false to bring it back.
 */
export async function setQuestionRetired(id, retired, { by = null, reason = "" } = {}) {
  return questions().findOneAndUpdate(
    { _id: id },
    { $set: retired ? { retiredAt: new Date(), retiredBy: by, retiredReason: reason } : { retiredAt: null, retiredBy: null, retiredReason: null } }
  );
}

/** Every accepted question of these tests: what a student has already been asked. */
export async function findAcceptedQuestionsByTests(testIds) {
  if (!testIds.length) return [];
  return questions().find({ testId: testIds, status: "accepted" });
}
