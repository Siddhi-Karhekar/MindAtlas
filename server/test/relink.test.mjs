// Tests for the relink tool (services/relink.js, scripts/relink.mjs), against
// the in-memory database. One student's notes are saved the way
// routes/notes.js saves them, then given the kinds of out-of-date graph data
// relinking exists for: keywords that depend on the order notes were added,
// cross-subject links missing because the notes predate cross-subject linking,
// a row from before edges had a type, a link the rule no longer makes, a link
// to a deleted note, and links the student removed. Then, with a stand-in
// for the embedding model, the embeddings a relink makes, reuses and drops.
process.env.MONGODB_URI = ""; // always the in-memory store, never a real cluster
process.env.DB_FILE = "memory"; // a throwaway database: never write server/data/ from a test
// No embedding model unless a test asks for one, so results do not depend on
// whether the optional model is installed on this machine.
process.env.SEMANTIC_MODEL = "off";

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { connectDB, getCollection } from "../src/db/index.js";
import { setEdgeCorrection } from "../src/models/GraphEdge.js";
import { createNote, findNotesByOwner, findNotesBySubject, isSplitParent } from "../src/models/Note.js";
import { findEmbeddingsByOwner, saveEmbedding } from "../src/models/NoteEmbedding.js";
import { setEmbedderForTests } from "../src/services/embeddings.js";
import { updateGraphForNote } from "../src/services/graphEngine.js";
import { desiredEdges, freshTerms, relinkOwner } from "../src/services/relink.js";
import { computeTfidf } from "../src/services/tfidf.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!cond) failures++;
};

await connectDB();
const edges = () => getCollection("graph_edges");
const ALICE = "a".repeat(24);
const BOB = "b".repeat(24);

// Saved as routes/notes.js saves a note: keywords against the subject's notes
// so far, then linked against every note the student has so far.
async function save(ownerId, subjectId, title, rawText, extra = {}) {
  const corpus = (await findNotesBySubject(subjectId)).filter((n) => !isSplitParent(n)).map((n) => n.rawText);
  const note = await createNote({ ownerId, subjectId, title, sourceType: "typed", rawText, ...computeTfidf(rawText, corpus), ocrFailed: false, ...extra });
  await updateGraphForNote(note, await findNotesByOwner(ownerId));
  return note;
}

const TEXT = {
  cell: "The cell is the basic unit of life. The cell membrane controls what enters and leaves the cell. The nucleus holds DNA, and mitochondria release energy through respiration. Plant cells also have a cell wall and chloroplasts.",
  osmosis: "Diffusion is the movement of particles from a high concentration to a low concentration. Osmosis is the diffusion of water across a partially permeable membrane. The concentration gradient drives both processes, and the cell membrane is partially permeable.",
  division: "During mitosis the nucleus divides and the DNA is copied so each new cell gets the same DNA. The cell membrane then pinches in and two daughter cells form.",
  photo: "Photosynthesis happens in chloroplasts. Light energy splits water, and carbon dioxide is fixed into glucose. Chlorophyll in the plant cell absorbs the light energy.",
  resp: "Respiration in mitochondria releases energy from glucose. Aerobic respiration uses oxygen and gives out carbon dioxide and water. The energy is stored as ATP in the cell.",
  diffusion: "Diffusion is the net movement of particles from a region of high concentration to a region of low concentration. The rate of diffusion increases with temperature and a steeper concentration gradient. Diffusion is faster in gases than liquids.",
  electro: "An electrochemical cell converts chemical energy into electrical energy. Oxidation happens at the anode and reduction at the cathode. A salt bridge completes the circuit between the two half cells.",
};

// Chemistry first, then Biology: the Biology notes link to Chemistry as they
// are saved. The cross-subject rows are then deleted, as for notes that were
// saved before cross-subject linking existed.
const diffusion = await save(ALICE, "chem", "Diffusion in gases and liquids", TEXT.diffusion);
const electro = await save(ALICE, "chem", "Electrochemical cells", TEXT.electro);
const cell = await save(ALICE, "bio", "Cell structure", TEXT.cell);
const osmosis = await save(ALICE, "bio", "Osmosis and diffusion", TEXT.osmosis);
const division = await save(ALICE, "bio", "Cell division", TEXT.division);
// a split document: the parent is a container, never linked
const unit = await createNote({
  ownerId: ALICE, subjectId: "bio", title: "Unit 2", sourceType: "file", rawText: `${TEXT.photo}\n\n${TEXT.resp}`,
  ...computeTfidf(`${TEXT.photo}\n\n${TEXT.resp}`, [TEXT.cell, TEXT.osmosis, TEXT.division]), ocrFailed: false, childCount: 2,
});
const photo = await save(ALICE, "bio", "Photosynthesis", TEXT.photo, { parentNoteId: unit._id, order: 0 });
const resp = await save(ALICE, "bio", "Respiration", TEXT.resp, { parentNoteId: unit._id, order: 1 });

const bobA = await save(BOB, "bio", "Bob's osmosis", TEXT.osmosis);
const bobB = await save(BOB, "bio", "Bob's cells", TEXT.cell);

const pairOf = (a, b) => (String(a._id) < String(b._id) ? [a, b] : [b, a]);
const findPair = async (a, b) => {
  const [s, t] = pairOf(a, b);
  return edges().findOne({ sourceNoteId: s._id, targetNoteId: t._id });
};
const addEdge = (a, b, fields = {}) => {
  const [s, t] = pairOf(a, b);
  return edges().insertOne({ sourceNoteId: s._id, targetNoteId: t._id, subjectId: "bio", sourceSubjectId: "bio", targetSubjectId: "bio", edgeType: "same-subject", weight: 0.5, sharedKeywords: [], ...fields });
};

const crossRows = (await edges().find({})).filter((e) => e.edgeType !== "same-subject").map((e) => String(e._id));
await edges().deleteMany({ _id: crossRows });
const cellDivision = await findPair(cell, division);
const photoResp = await findPair(photo, resp);
check("setup: the notes were linked when saved", Boolean(cellDivision && photoResp) && crossRows.length > 0,
  `${crossRows.length} cross-subject row(s) deleted to simulate old notes`);
// a row from before edges had a type
await edges().findOneAndUpdate({ _id: photoResp._id }, { $set: { edgeType: undefined, sourceSubjectId: undefined, targetSubjectId: undefined } });
// the student removed one link the rule still makes, and one it never would
await setEdgeCorrection(cellDivision._id, "removed");
const removedOdd = await addEdge(unit, electro, { subjectId: null, targetSubjectId: "chem", edgeType: "cross-subject", correction: "removed" });
// and a cross-subject link, removed, whose pair the rule now turns down
const [cs, ct] = pairOf(cell, electro);
const removedCross = await addEdge(cell, electro, { subjectId: null, sourceSubjectId: cs.subjectId, targetSubjectId: ct.subjectId, edgeType: "cross-subject", correction: "removed" });
// a link to a split document, which the rule never makes
const toParent = await addEdge(unit, division);
// a link to a note that was deleted
const dangling = await addEdge(cell, { _id: "f".repeat(24) });
// a link to a note that is not in the set being relinked - a note saved while
// relink runs. Bob's note stands in for it.
const outside = await addEdge(osmosis, bobA);

const snapshot = async () => JSON.stringify({
  notes: (await getCollection("notes").find({})).sort((a, b) => (a._id < b._id ? -1 : 1)),
  edges: (await edges().find({})).sort((a, b) => (a._id < b._id ? -1 : 1)),
});
const bobEdges = async () => JSON.stringify((await edges().find({ sourceNoteId: [bobA._id, bobB._id] })).sort((a, b) => (a._id < b._id ? -1 : 1)));
const bobBefore = await bobEdges();
const idsBefore = new Map((await edges().find({})).map((e) => [`${e.sourceNoteId}|${e.targetNoteId}`, String(e._id)]));

console.log("\n=== Dry run ===");
const before = await snapshot();
const dry = await relinkOwner(ALICE, { dryRun: true });
check("writes nothing", (await snapshot()) === before);
check("counts the student's notes and topics", dry.notes === 8 && dry.topics === 7, `${dry.notes} notes, ${dry.topics} topics`);
check("finds keywords that depend on the order notes were saved", dry.keywordsChanged > 0, `${dry.keywordsChanged} note(s)`);
check("finds the missing cross-subject link", dry.added >= 1 && dry.after["cross-subject"] > dry.before["cross-subject"],
  `cross-subject ${dry.before["cross-subject"]} -> ${dry.after["cross-subject"]}`);
check("finds the link to the split document and the link to the deleted note", dry.dropped >= 1 && dry.dangling === 1,
  `dropped ${dry.dropped}, dangling ${dry.dangling}`);
check("counts the three removed links as kept", dry.removedKept === 3);
check("before = kept + updated + dropped; after = kept + updated + added",
  Object.values(dry.before).reduce((a, b) => a + b) === dry.kept + dry.updated + dry.dropped
  && Object.values(dry.after).reduce((a, b) => a + b) === dry.kept + dry.updated + dry.added, JSON.stringify(dry));

console.log("\n=== Relink ===");
const run = await relinkOwner(ALICE);
check("reports what the dry run said it would", JSON.stringify(run) === JSON.stringify(dry));

const notes = await findNotesByOwner(ALICE);
const byTitle = (t) => notes.find((n) => n.title === t);
const keywordsVs = (title, corpus) => JSON.stringify(byTitle(title).keywords) === JSON.stringify(computeTfidf(byTitle(title).rawText, corpus).keywords);
check("a note's keywords are against every other topic in its subject", keywordsVs("Cell structure", [TEXT.osmosis, TEXT.division, TEXT.photo, TEXT.resp]));
check("  ...a subtopic's include its siblings", keywordsVs("Photosynthesis", [TEXT.cell, TEXT.osmosis, TEXT.division, TEXT.resp]));
check("  ...a split document's are against the topics outside it", keywordsVs("Unit 2", [TEXT.cell, TEXT.osmosis, TEXT.division]));
check("  ...and other subjects play no part", keywordsVs("Electrochemical cells", [TEXT.diffusion]));

const topics = notes.filter((n) => !isSplitParent(n));
const want = desiredEdges(topics);
const aliceIds = new Set(notes.map((n) => String(n._id)));
const aliceEdges = (await edges().find({})).filter((e) => aliceIds.has(String(e.sourceNoteId)) && aliceIds.has(String(e.targetNoteId)));
const active = aliceEdges.filter((e) => e.correction !== "removed");
const sameFields = (e, w) => Object.entries(w).every(([k, v]) => JSON.stringify(e[k] ?? null) === JSON.stringify(v ?? null));
check("every link is one the current rule makes, with its current fields",
  active.every((e) => want.has(`${e.sourceNoteId}|${e.targetNoteId}`) && sameFields(e, want.get(`${e.sourceNoteId}|${e.targetNoteId}`))));
check("every pair the rule makes is stored", [...want.keys()].every((k) => aliceEdges.some((e) => `${e.sourceNoteId}|${e.targetNoteId}` === k)),
  `${want.size} pair(s)`);
check("the missing cross-subject link is back", (await findPair(osmosis, diffusion))?.edgeType === "cross-subject");
check("the ambiguous pairs are stored as rejected again", (await findPair(electro, photo))?.edgeType === "rejected" && (await findPair(electro, resp))?.edgeType === "rejected");
const stillCross = await edges().findOne({ _id: removedCross._id });
check("a removed link whose pair is now turned down keeps its type, so it can still be restored",
  stillCross?.correction === "removed" && stillCross.edgeType === "cross-subject");
const legacy = await edges().findOne({ _id: photoResp._id });
check("the old untyped row is rewritten in place", legacy?.edgeType === "same-subject" && legacy.sourceSubjectId === "bio");
check("links that still qualify keep their ids",
  aliceEdges.every((e) => !idsBefore.has(`${e.sourceNoteId}|${e.targetNoteId}`) || idsBefore.get(`${e.sourceNoteId}|${e.targetNoteId}`) === String(e._id)));
check("a removed link the rule still makes stays removed", (await edges().findOne({ _id: cellDivision._id }))?.correction === "removed");
check("a removed link the rule no longer makes is kept, removed", (await edges().findOne({ _id: removedOdd._id }))?.correction === "removed");
check("the link to the split document is gone", !(await edges().findOne({ _id: toParent._id })));
check("the link to the deleted note is gone", !(await edges().findOne({ _id: dangling._id })));
check("a link to a note outside the relinked set is left alone", Boolean(await edges().findOne({ _id: outside._id })));
check("another student's links are untouched", (await bobEdges()) === bobBefore);
const keywordsById = (list) => JSON.stringify([...list].sort((a, b) => (a._id < b._id ? -1 : 1)).map((n) => [String(n._id), n.keywords]));
check("  ...and so are their notes' keywords", keywordsById(await findNotesByOwner(BOB)) === keywordsById([bobA, bobB]));
check("nothing links to a split document", !aliceEdges.some((e) => [String(e.sourceNoteId), String(e.targetNoteId)].includes(String(unit._id)) && e.correction !== "removed"));

console.log("\n=== Running it again ===");
const again = await relinkOwner(ALICE);
check("changes nothing", again.termsChanged === 0 && again.added === 0 && again.dropped === 0 && again.updated === 0 && again.dangling === 0,
  JSON.stringify(again));
check("  ...and keeps the removed links", again.removedKept === 3);
const fresh = freshTerms(notes);
check("freshTerms matches what was stored", notes.every((n) => JSON.stringify(fresh.get(String(n._id)).keywords) === JSON.stringify(n.keywords)));
const nobody = await relinkOwner("c".repeat(24));
check("a student with no notes is a no-op", nobody.notes === 0 && nobody.added === 0 && nobody.dropped === 0);

console.log("\n=== Embeddings (a stand-in model) ===");
// Notes saved without the model, then relinked with it.
const DAN = "d".repeat(24);
const WORDS = ["missing", "outlier", "impute", "router", "packet"];
const standIn = (texts) => texts.map((t) => {
  const v = [...WORDS.map((w) => (t.toLowerCase().includes(w) ? 1 : 0)), 0.15];
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
});
for (const [subjectId, title, text] of [
  ["dedv", "Data cleaning", "Data cleaning fills missing values. Outliers are removed. Missing values can be imputed."],
  ["ml", "Pre-processing", "Pre-processing handles missing values and outliers. Missing values are imputed; outliers are clipped."],
  ["net", "Routing", "A router forwards each packet. Missing routes send the packet to the default gateway."],
]) {
  const { vector, keywords } = computeTfidf(text, []);
  const n = await createNote({ ownerId: DAN, subjectId, title, sourceType: "typed", rawText: text, keywords, vector, ocrFailed: false });
  await updateGraphForNote(n, await findNotesByOwner(DAN));
}
const danNotes = await findNotesByOwner(DAN);
await saveEmbedding({ noteId: "f".repeat(24), ownerId: DAN, model: "test-double", textHash: "x", vector: [1] }); // of a deleted note
process.env.SEMANTIC_MODEL = "";
setEmbedderForTests(standIn);
const without = await relinkOwner(DAN, { dryRun: true, embedder: null });
check("without the model, a relink makes no embeddings", without.embeddingModel === null && without.embedded === 0 && without.embeddingsMade === 0);
const embDry = await relinkOwner(DAN, { dryRun: true });
check("a dry run with the model says what it would make, and saves nothing",
  embDry.embeddingModel === "test-double" && embDry.embeddingsMade === 3 && embDry.embeddingsDropped === 1 &&
  (await findEmbeddingsByOwner(DAN)).length === 1, JSON.stringify({ made: embDry.embeddingsMade, dropped: embDry.embeddingsDropped }));
const embRun = await relinkOwner(DAN);
const danEmb = await findEmbeddingsByOwner(DAN);
check("a relink makes and stores every topic's embedding, and drops a deleted note's",
  embRun.embedded === 3 && danEmb.length === 3 && danEmb.every((r) => danNotes.some((n) => String(n._id) === r.noteId)));
const danLink = (await edges().find({})).find((e) => e.edgeType === "cross-subject" &&
  [e.sourceNoteId, e.targetNoteId].map(String).sort().join() === danNotes.filter((n) => n.title !== "Routing").map((n) => String(n._id)).sort().join());
check("  ...and links the notes on one idea by meaning", danLink?.meaning >= 0.68, JSON.stringify(danLink && { meaning: danLink.meaning }));
const embAgain = await relinkOwner(DAN);
check("running it again makes no embedding and changes nothing",
  embAgain.embeddingsMade === 0 && embAgain.embeddingsDropped === 0 && embAgain.updated === 0 && embAgain.added === 0 && embAgain.dropped === 0);
setEmbedderForTests(null);
process.env.SEMANTIC_MODEL = "off";
const noModelNow = await relinkOwner(DAN, { dryRun: true });
check("stored embeddings are used even when the model is not there", noModelNow.embedded === 3 && noModelNow.updated === 0 && noModelNow.dropped === 0);

console.log("\n=== Command line (scripts/relink.mjs) ===");
const cwd = fileURLToPath(new URL("..", import.meta.url));
const cli = (args, env = {}) => spawnSync(process.execPath, ["scripts/relink.mjs", ...args], {
  cwd, encoding: "utf8", timeout: 30_000,
  env: { ...process.env, MONGODB_URI: "", DB_FILE: "memory", ATLAS_URI: "", NODE_ENV: "development", ...env },
});
const noArgs = cli([]);
check("needs --email or --all", noArgs.status === 1 && /--email/.test(noArgs.stderr), noArgs.stderr.trim().split("\n")[0]);
check("refuses an unknown option", cli(["--all", "--yess"]).status === 1);
const dryAll = cli(["--all"]);
check("a dry run of every student works on an empty database", dryAll.status === 0 && /dry run/i.test(dryAll.stdout), dryAll.stderr.trim());
const unknown = cli(["--email", "nobody@example.com"]);
check("an unknown email is an error", unknown.status === 1 && /no account/i.test(unknown.stderr), unknown.stderr.trim());
check("--live needs ATLAS_URI", cli(["--live", "--all"]).status === 1);
const noBackup = cli(["--live", "--all", "--yes"], { ATLAS_URI: "mongodb+srv://user:secret@relink-test.invalid/x" });
check("--live --yes refuses without a recent backup, before connecting",
  noBackup.status === 1 && /db:backup/.test(noBackup.stderr) && !/connecting/.test(noBackup.stdout), noBackup.stderr.trim());
check("  ...and never prints the connection string", !/secret/.test(noBackup.stdout + noBackup.stderr));

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
