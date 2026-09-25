// A stand-in for a real MongoDB collection whose matching is TYPE-SENSITIVE,
// exactly like the server's: the string "50c..." never equals ObjectId("50c...").
// This is what memoryStore.js cannot simulate (it String()s both sides), so it
// is what catches id-type bugs without needing a live Atlas cluster.
import { ObjectId } from "mongodb";
import { MongoCollectionWrapper } from "../src/db/mongoStore.js";

function bsonEqual(a, b) {
  const aIsOid = a instanceof ObjectId;
  const bIsOid = b instanceof ObjectId;
  if (aIsOid !== bIsOid) return false;          // <-- real Mongo's behaviour
  if (aIsOid && bIsOid) return a.equals(b);
  return a === b;
}

function docMatches(doc, filter) {
  return Object.entries(filter).every(([k, v]) => {
    if (v && typeof v === "object" && !(v instanceof ObjectId) && "$in" in v) {
      return v.$in.some((c) => bsonEqual(doc[k], c));
    }
    return bsonEqual(doc[k], v);
  });
}

class StrictFakeCollection {
  constructor() { this.docs = []; }
  async insertOne(doc) {
    const record = { ...doc };
    if (record._id === undefined) record._id = new ObjectId(); // real Mongo assigns a BSON ObjectId
    this.docs.push(record);
    return { insertedId: record._id };
  }
  async findOne(filter) { return this.docs.find((d) => docMatches(d, filter)) || null; }
  find(filter) {
    const out = this.docs.filter((d) => docMatches(d, filter));
    return { sort: () => ({ toArray: async () => out }), toArray: async () => out };
  }
  async findOneAndUpdate(filter, update, { upsert, returnDocument }) {
    let doc = this.docs.find((d) => docMatches(d, filter));
    if (!doc) {
      if (!upsert) return null;
      doc = { ...filter, ...(update.$setOnInsert || {}) };
      if (doc._id === undefined) doc._id = new ObjectId();
      this.docs.push(doc);
    }
    Object.assign(doc, update.$set || {});
    return returnDocument === "after" ? doc : doc;
  }
}

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!cond) failures++;
};

async function runFlow(makeWrapper, title) {
  console.log(`\n=== ${title} ===`);
  const col = (name) => makeWrapper(new StrictFakeCollection(), name);
  const users = col("users"), subjects = col("subjects"), notes = col("notes"), responses = col("responses");

  const user = await users.insertOne({ email: "a@b.co", passwordHash: "x" });
  check("user._id is a 24-hex string", typeof user._id === "string" && /^[0-9a-f]{24}$/.test(user._id), String(user._id));

  // findUserById -> findOne({_id})
  check("findUserById finds the user", (await users.findOne({ _id: user._id })) !== null);

  const subject = await subjects.insertOne({ ownerId: user._id, name: "Chemistry", createdAt: new Date() });

  // findOwnedSubject -> findOne({_id, ownerId})   <-- the ownership check that broke
  const owned = await subjects.findOne({ _id: subject._id, ownerId: user._id });
  check("findOwnedSubject(id, ownerId)", owned !== null, owned ? "" : "returned null - subject invisible to its owner");

  // findSubjectsByOwner -> find({ownerId})
  const mine = await subjects.find({ ownerId: user._id }, { sort: { createdAt: -1 } });
  check("findSubjectsByOwner(ownerId)", mine.length === 1, `got ${mine.length}, expected 1`);

  const n1 = await notes.insertOne({ ownerId: user._id, subjectId: subject._id, title: "Atoms", createdAt: new Date() });
  const n2 = await notes.insertOne({ ownerId: user._id, subjectId: subject._id, title: "Bonds", createdAt: new Date() });

  // findNotesBySubject -> find({subjectId})
  const bySubject = await notes.find({ subjectId: subject._id }, { sort: { createdAt: -1 } });
  check("findNotesBySubject(subjectId)", bySubject.length === 2, `got ${bySubject.length}, expected 2`);


  // findNotesByIds -> find({_id: [a, b]})  (array shorthand for $in)
  const byIds = await notes.find({ _id: [n1._id, n2._id] });
  check("findNotesByIds([a,b]) $in shorthand", byIds.length === 2, `got ${byIds.length}, expected 2`);

  // Split documents: children point at their parent by a string id, and
  // findChildNotes / setChildCount query on it - the same type-sensitivity trap.
  const parent = await notes.insertOne({ ownerId: user._id, subjectId: subject._id, title: "Unit 3", childCount: 0, createdAt: new Date() });
  await notes.insertOne({ ownerId: user._id, subjectId: subject._id, title: "Paging", parentNoteId: parent._id, order: 0 });
  await notes.insertOne({ ownerId: user._id, subjectId: subject._id, title: "Segmentation", parentNoteId: parent._id, order: 1 });
  const kids = await notes.find({ parentNoteId: [parent._id] });
  check("findChildNotes([parentId]) finds subtopics", kids.length === 2, `got ${kids.length}, expected 2`);
  const counted = await notes.findOneAndUpdate({ _id: parent._id }, { $set: { childCount: 2 } });
  check("setChildCount(parentId) updates the parent", counted?.childCount === 2, JSON.stringify(counted?.childCount));

  // upsertResponse -> findOneAndUpdate(..., {upsert:true})
  const r = await responses.findOneAndUpdate(
    { attemptId: "att1", questionId: "q1" },
    { $set: { answer: "electrons", score: 1 } },
    { upsert: true }
  );
  check("upserted response gets a string _id", typeof r._id === "string" && /^[0-9a-f]{24}$/.test(r._id), String(r._id));
  return failures;
}

// ---- the OLD implementation, reproduced verbatim from git history ----
const OLD_ID_FIELDS = new Set(["_id", "ownerId", "subjectId", "sourceNoteId", "targetNoteId"]);
const oldToVal = (f, v) => (OLD_ID_FIELDS.has(f) && typeof v === "string" && ObjectId.isValid(v) ? new ObjectId(v) : v);
function oldFilter(filter) {
  const out = {};
  for (const [k, v] of Object.entries(filter)) {
    const c = Array.isArray(v) ? v : v && typeof v === "object" && "$in" in v ? v.$in : null;
    out[k] = c ? { $in: c.map((x) => oldToVal(k, x)) } : oldToVal(k, v);
  }
  return out;
}
const oldFrom = (doc) => {
  if (!doc) return null;
  const out = { ...doc };
  for (const f of OLD_ID_FIELDS) if (out[f] != null) out[f] = String(out[f]);
  return out;
};
class OldWrapper {
  constructor(col) { this.col = col; }
  async insertOne(doc) { const t = { ...doc }; delete t._id; const r = await this.col.insertOne(t); return oldFrom({ ...t, _id: r.insertedId }); }
  async findOne(f) { return oldFrom(await this.col.findOne(oldFilter(f))); }
  async find(f = {}, { sort } = {}) { let c = this.col.find(oldFilter(f)); if (sort) c = c.sort(sort); return (await c.toArray()).map(oldFrom); }
  async findOneAndUpdate(f, u, { upsert = false } = {}) {
    const r = await this.col.findOneAndUpdate(oldFilter(f), u, { upsert, returnDocument: "after" });
    return oldFrom(r && "value" in r ? r.value : r);
  }
}

const before = await runFlow((c) => new OldWrapper(c), "OLD mongoStore.js (before the fix)");
failures = 0;
const after = await runFlow((c) => new MongoCollectionWrapper(c), "NEW mongoStore.js (after the fix)");

console.log(`\nOld implementation: ${before} failing check(s)`);
console.log(`New implementation: ${after} failing check(s)`);
process.exit(after === 0 ? 0 : 1);
