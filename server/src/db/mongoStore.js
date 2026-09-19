import { MongoClient } from "mongodb";
import { generateId } from "./ids.js";

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
function toMongoFilter(filter) {
  const out = {};
  for (const [k, v] of Object.entries(filter)) {
    const candidates = Array.isArray(v) ? v : v && typeof v === "object" && "$in" in v ? v.$in : null;
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
      ? { ...update, $setOnInsert: { ...(update.$setOnInsert || {}), _id: generateId() } }
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
}

export async function createMongoDb(uri) {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db("mindatlas");
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
