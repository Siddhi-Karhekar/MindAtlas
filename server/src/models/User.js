import { getCollection } from "../db/index.js";
import { adminIds } from "../config.js";

const users = () => getCollection("users");

// `emailVerified`: false until the address is confirmed, when the server has
// email set up at sign-up time; true otherwise. Accounts made before this
// existed have no such field and count as confirmed.
export async function createUser({ email, passwordHash, emailVerified = true }) {
  return users().insertOne({ email, passwordHash, emailVerified, createdAt: new Date() });
}

/** What the API says about an account: never the password hash. */
export function publicUser(user) {
  return {
    id: user._id,
    email: user.email,
    createdAt: user.createdAt,
    emailVerified: user.emailVerified !== false,
    isAdmin: adminIds().includes(String(user._id)),
  };
}

/**
 * Record that the student did something that counts as using the app (added
 * a note, finished a test), for two numbers on the admin page: did they get
 * started in their first week, and did they come back in their second.
 * Only dates and a flag are kept - nothing about what they did.
 */
export async function markActivity(userId, kind) {
  const user = await users().findOne({ _id: userId });
  if (!user) return;
  const now = new Date();
  const set = { lastActiveAt: now };
  if (kind === "note" && !user.firstNoteAt) set.firstNoteAt = now;
  if (kind === "test" && !user.firstTestAt) set.firstTestAt = now;
  const age = now.getTime() - new Date(user.createdAt).getTime();
  if (age >= 7 * 86_400_000 && age < 14 * 86_400_000) set.activeInWeek2 = true;
  await users().findOneAndUpdate({ _id: userId }, { $set: set });
}

/** Suspend (or restore) an account: a suspended one cannot sign in, and its sessions end at once. */
export async function setSuspended(id, suspended) {
  const user = await users().findOne({ _id: id });
  if (!user) return null;
  return users().findOneAndUpdate(
    { _id: id },
    { $set: { suspended: Boolean(suspended), suspendedAt: suspended ? new Date() : null, sessionVersion: (user.sessionVersion || 0) + 1 } }
  );
}

/** Accounts created since `since`, for the admin page's numbers. */
export async function findUsersSince(since) {
  return (await users().find({})).filter((u) => new Date(u.createdAt) >= since);
}

export async function countUsers() {
  return (await users().find({})).length;
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
  for (const name of ["feedback_reports", "question_reports", "attempts", "tests", "mastery", "notes", "subjects"]) {
    removed[name] = await col(name).deleteMany({ ownerId: userId });
  }
  await col("email_tokens").deleteMany({ userId: String(userId) });
  removed.users = await users().deleteMany({ _id: userId });
  return removed;
}
