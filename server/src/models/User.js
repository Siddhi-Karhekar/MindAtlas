import { getCollection } from "../db/index.js";

const users = () => getCollection("users");

export async function createUser({ email, passwordHash }) {
  return users().insertOne({ email, passwordHash, createdAt: new Date() });
}

export async function findUserByEmail(email) {
  return users().findOne({ email });
}

export async function findUserById(id) {
  return users().findOne({ _id: id });
}

export async function updateUserPassword(id, passwordHash) {
  return users().findOneAndUpdate({ _id: id }, { $set: { passwordHash, passwordChangedAt: new Date() } });
}

/**
 * Delete a user and everything they own, in every collection. Order matters
 * only for lookups: the ids of tests and attempts are read before those rows
 * go, because questions, responses and feedback hang off them.
 * Returns how many documents were removed per collection.
 */
export async function deleteUserAndData(userId) {
  const col = (name) => getCollection(name);
  const removed = {};
  const noteIds = (await col("notes").find({ ownerId: userId })).map((n) => n._id);
  const testIds = (await col("tests").find({ ownerId: userId })).map((t) => t._id);
  const attemptIds = (await col("attempts").find({ ownerId: userId })).map((a) => a._id);

  // graph edges carry no owner: they belong to whoever owns the notes they join
  let edges = 0;
  if (noteIds.length) {
    edges += await col("graph_edges").deleteMany({ sourceNoteId: noteIds });
    edges += await col("graph_edges").deleteMany({ targetNoteId: noteIds });
  }
  removed.graph_edges = edges;
  removed.questions = testIds.length ? await col("questions").deleteMany({ testId: testIds }) : 0;
  removed.responses = attemptIds.length ? await col("responses").deleteMany({ attemptId: attemptIds }) : 0;
  for (const name of ["feedback_reports", "attempts", "tests", "mastery", "notes", "subjects"]) {
    removed[name] = await col(name).deleteMany({ ownerId: userId });
  }
  removed.users = await users().deleteMany({ _id: userId });
  return removed;
}
