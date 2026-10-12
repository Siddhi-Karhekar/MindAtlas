import { MongoClient } from "mongodb";
import { generateId } from "./ids.js";
import { redact } from "../services/log.js";
import { assertSafeFilter, candidatesOf } from "./filter.js";

// Real MongoDB backend (e.g. Atlas), implementing the same tiny interface
// as memoryStore.js so route/service code never has to know or care which
// one is active.
//
// IDS ARE PLAIN 24-HEX STRINGS ON BOTH BACKENDS (see ids.js), and this
// store generates them itself rather than letting the driver assign a BSON
// ObjectId. That is deliberate, and it is the whole point of this comment:
// MongoDB's equality matching is TYPE-SENSITIVE, so the string
// "507f1f77bcf86cd799439011" does not match ObjectId("507f1f77bcf86cd799439011").
// An earlier version of this file let Mongo assign ObjectId _ids and then
// converted _id/ownerId/subjectId back to ObjectId when building filters -
// but insertOne() stored those same owner/subject fields as strings, so
// every ownership lookup (findOwnedSubject, findOwnedTest, findOwnedAttempt,
// findNotesBySubject, ...) silently matched nothing and returned null.
//
// That bug could not surface in local development, because memoryStore.js
// compares with String() on both sides and therefore treats the two as
// equal. Keeping exactly one id type everywhere removes the whole class of
// problem: nothing in this file converts id types any more, because there
// is only one id type.

// An array filter value (or an explicit {$in: [...]}) matches if the field
// equals any element - the same shorthand memoryStore.js supports. No type
// conversion happens here by design (see above).
//
// This is also where a query is "parameterised": the only operator that ever
// reaches MongoDB is the $in written on the line below. A filter value that
// is itself an object - how an operator such as {$ne: null} would be injected
// - is refused by candidatesOf (filter.js) before the query is built.
function toMongoFilter(filter) {
  assertSafeFilter(filter);
  const out = {};
  for (const [k, v] of Object.entries(filter)) {
    const candidates = candidatesOf(k, v);
    out[k] = candidates ? { $in: candidates } : v;
  }
  return out;
}

// Defensive only: a document written by an older build could still carry a
// BSON ObjectId _id. Normalizing it keeps the API contract that every id is
// a 24-hex string (CONTRIBUTING.md) true for legacy rows too.
function fromMongoDoc(doc) {
  if (!doc) return null;
  return typeof doc._id === "string" ? { ...doc } : { ...doc, _id: String(doc._id) };
}

export class MongoCollectionWrapper {
  constructor(col) {
    this.col = col;
  }

  async insertOne(doc) {
    const record = { ...doc, _id: doc._id || generateId() };
    await this.col.insertOne(record);
    return { ...record };
  }

  async findOne(filter) {
    return fromMongoDoc(await this.col.findOne(toMongoFilter(filter)));
  }

  async find(filter = {}, { sort } = {}) {
    let cursor = this.col.find(toMongoFilter(filter));
    if (sort) cursor = cursor.sort(sort);
    return (await cursor.toArray()).map(fromMongoDoc);
  }

  async findOneAndUpdate(filter, update, { upsert = false } = {}) {
    // On an upsert that creates a new document, Mongo would assign its own
    // ObjectId _id unless one is supplied - $setOnInsert is the only way to
    // set _id here, since $set on an existing doc's _id is rejected as an
    // immutable field. This keeps upserted rows (responses, graph edges) on
    // the same string-id shape as inserted ones.
    const effectiveUpdate = upsert
      ? { ...update, $setOnInsert: { ...update.$setOnInsert, _id: generateId() } }
      : update;

    const result = await this.col.findOneAndUpdate(toMongoFilter(filter), effectiveUpdate, {
      upsert,
      returnDocument: "after",
    });
    // driver v5/v6 returns the document directly; older versions wrap it
    // in {value}. Handle both so this doesn't silently break on a version bump.
    const doc = result && "value" in result ? result.value : result;
    return fromMongoDoc(doc);
  }

  /** Delete every document matching `filter`; returns how many went. Same contract as memoryStore.js. */
  async deleteMany(filter) {
    if (!filter || Object.keys(filter).length === 0) throw new Error("deleteMany needs a filter");
    const result = await this.col.deleteMany(toMongoFilter(filter));
    return result?.deletedCount || 0;
  }
}

export async function createMongoDb(uri) {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db("mindatlas");
  // One account per email address, enforced by the database itself: two
  // sign-ups for the same address arriving together cannot both be stored.
  // (If the collection already holds duplicates the index cannot be built;
  // the server still starts, and says so.)
  await db
    .collection("users")
    .createIndex({ email: 1 }, { unique: true })
    .catch((err) => console.warn("[db] could not create the unique index on users.email:", redact(err.message)));
  // one feedback report per attempt (routes/attempts.js writes it by upsert)
  await db
    .collection("feedback_reports")
    .createIndex({ attemptId: 1 }, { unique: true })
    .catch((err) => console.warn("[db] could not create the unique index on feedback_reports.attemptId:", redact(err.message)));
  // An index for every query the app runs, so each request reads the few
  // documents it needs rather than a whole collection - the difference
  // between fine and slow once there are a few thousand students. Creating an
  // index that exists is a no-op; a failure is reported and the server
  // carries on (queries still work, just slower).
  const INDEXES = {
    subjects: [{ ownerId: 1, createdAt: -1 }],
    notes: [{ subjectId: 1, createdAt: -1 }, { ownerId: 1, createdAt: -1 }, { parentNoteId: 1 }],
    tests: [{ subjectId: 1, createdAt: -1 }, { ownerId: 1 }],
    questions: [{ testId: 1, status: 1, createdAt: 1 }],
    attempts: [{ ownerId: 1, subjectId: 1, startedAt: -1 }, { testId: 1, ownerId: 1, status: 1 }],
    responses: [{ attemptId: 1, questionId: 1 }],
    feedback_reports: [{ ownerId: 1, subjectId: 1, createdAt: 1 }],
    mastery: [{ ownerId: 1, subjectId: 1, topicId: 1 }],
    graph_edges: [{ sourceNoteId: 1 }, { targetNoteId: 1 }, { subjectId: 1 }, { sourceSubjectId: 1 }, { targetSubjectId: 1 }],
    question_reports: [{ ownerId: 1, testId: 1 }, { questionId: 1, ownerId: 1 }],
    email_tokens: [{ tokenHash: 1, purpose: 1 }, { userId: 1, purpose: 1 }],
  };
  await Promise.all(
    Object.entries(INDEXES).flatMap(([name, keys]) =>
      keys.map((key) =>
        db
          .collection(name)
          .createIndex(key)
          .catch((err) => console.warn(`[db] could not create an index on ${name}:`, redact(err.message)))
      )
    )
  );
  return {
    kind: "mongo",
    collection(name) {
      return new MongoCollectionWrapper(db.collection(name));
    },
    async close() {
      await client.close();
    },
  };
}
