import { MongoClient, ObjectId } from "mongodb";

// Real MongoDB backend (e.g. Atlas), implementing the same tiny interface
// as memoryStore.js so route/service code never has to know or care which
// one is active.

const ID_FIELDS = new Set(["_id", "ownerId", "subjectId", "sourceNoteId", "targetNoteId"]);

function toMongoFilter(filter) {
  const out = {};
  for (const [k, v] of Object.entries(filter)) {
    out[k] = ID_FIELDS.has(k) && typeof v === "string" && ObjectId.isValid(v) ? new ObjectId(v) : v;
  }
  return out;
}

function fromMongoDoc(doc) {
  if (!doc) return null;
  const out = { ...doc };
  for (const f of ID_FIELDS) {
    if (out[f] != null) out[f] = String(out[f]);
  }
  return out;
}

class MongoCollectionWrapper {
  constructor(col) {
    this.col = col;
  }

  async insertOne(doc) {
    const toInsert = { ...doc };
    delete toInsert._id;
    const result = await this.col.insertOne(toInsert);
    return fromMongoDoc({ ...toInsert, _id: result.insertedId });
  }

  async findOne(filter) {
    const doc = await this.col.findOne(toMongoFilter(filter));
    return fromMongoDoc(doc);
  }

  async find(filter = {}, { sort } = {}) {
    let cursor = this.col.find(toMongoFilter(filter));
    if (sort) cursor = cursor.sort(sort);
    const docs = await cursor.toArray();
    return docs.map(fromMongoDoc);
  }

  async findOneAndUpdate(filter, update, { upsert = false } = {}) {
    const result = await this.col.findOneAndUpdate(toMongoFilter(filter), update, {
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
