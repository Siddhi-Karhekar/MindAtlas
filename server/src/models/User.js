import { getCollection } from "../db/index.js";

const users = () => getCollection("users");

// `emailVerified`: false until the address is confirmed, when the server has
// email set up at sign-up time; true otherwise. Accounts made before this
// existed have no such field and count as confirmed.
export async function createUser({ email, passwordHash, emailVerified = true }) {
  return users().insertOne({ email, passwordHash, emailVerified, createdAt: new Date() });
}

/** What the API says about an account: never the password hash. */
export function publicUser(user) {
  return { id: user._id, email: user.email, createdAt: user.createdAt, emailVerified: user.emailVerified !== false };
}

export async function markEmailVerified(id) {
  return users().findOneAndUpdate({ _id: id }, { $set: { emailVerified: true } });
}

/** Store a stronger hash of the same password (the cost setting went up). Does not end sessions. */
export async function upgradePasswordHash(id, passwordHash) {
  return users().findOneAndUpdate({ _id: id }, { $set: { passwordHash } });
}

export async function findUserByEmail(email) {
  return users().findOne({ email });
}

export async function findUserById(id) {
  return users().findOne({ _id: id });
}

// Raising `sessionVersion` ends every session of the account: a session token
// carries the version it was issued under (middleware/auth.js).
export async function updateUserPassword(id, passwordHash) {
  const user = await users().findOne({ _id: id });
  // a reset link asked for before the change must not work after it
  await getCollection("email_tokens").deleteMany({ userId: String(id), purpose: "reset" });
  return users().findOneAndUpdate(
    { _id: id },
    { $set: { passwordHash, passwordChangedAt: new Date(), sessionVersion: (user?.sessionVersion || 0) + 1 } }
  );
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
  await col("email_tokens").deleteMany({ userId: String(userId) });
  removed.users = await users().deleteMany({ _id: userId });
  return removed;
}
