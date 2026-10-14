// Tests for knowledge-graph linking, in two parts:
//   1. classifyPair's rules, on hand-made vectors (exact boundaries) and on
//      realistic notes run through the real TF-IDF step, including the
//      ambiguous "cell" pairs the cross-subject rule exists to turn down,
//      and that the words two notes share come from their vectors' top
//      TF-IDF terms, not their stored keywords;
//   2. the storage contract, against the in-memory database - same-subject
//      edges stay where findEdgesBySubject has always found them, and
//      cross-subject/rejected edges are visible from both subjects;
//   3. cross-subject links by meaning, with a stand-in for the embedding
//      model: notes' embeddings made, stored, reused and deleted with them.
process.env.MONGODB_URI = ""; // always the in-memory store, never a real cluster
process.env.DB_FILE = "memory"; // a throwaway database: never write server/data/ from a test
// No embedding model unless a test asks for one, so results do not depend on
// whether the optional model is installed on this machine.
process.env.SEMANTIC_MODEL = "off";

import { computeTfidf } from "../src/services/tfidf.js";
import {
  classifyPair, clusterNotes, decideLink, linkTerms, updateGraphForNote, LINK_RULE,
  SIMILARITY_THRESHOLD, CROSS_SUBJECT_THRESHOLD, CROSS_SUBJECT_MIN_SHARED, CROSS_SUBJECT_MEANING_THRESHOLD,
} from "../src/services/graphEngine.js";
import { connectDB, getCollection } from "../src/db/index.js";
import { createNote, findNotesByOwner, updateNote } from "../src/models/Note.js";
import { findCrossSubjectEdges, findEdgesBySubject, setEdgeCorrection } from "../src/models/GraphEdge.js";
import { findEmbeddings, findEmbeddingsByOwner } from "../src/models/NoteEmbedding.js";
import { createSubject, deleteSubjectAndData } from "../src/models/Subject.js";
import { deleteUserAndData } from "../src/models/User.js";
import { setEmbedderForTests } from "../src/services/embeddings.js";
import { withEmbeddings } from "../src/services/noteEmbedding.js";
import { deleteNote } from "../src/services/noteLifecycle.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!cond) failures++;
};
const typeOf = (pair) => (pair ? pair.edgeType : "none");

console.log("\n=== Rule boundaries (hand-made vectors) ===");
// The words two notes share are their top TF-IDF terms, read from the vector
// (linkTerms), so these notes are just a subject and a vector.
const mk = (subjectId, vector) => ({ subjectId, vector, keywords: [] });
// cosine of these two is exactly 0.5, and they share the terms a and b
const half = [{ a: 1, b: 1, x: 1, y: 1 }, { a: 1, b: 1, z: 1, w: 1 }];
check("same subject at/above the threshold links", typeOf(classifyPair(mk("s1", half[0]), mk("s1", half[1]))) === "same-subject");
check("same subject below the threshold does not link",
  typeOf(classifyPair(mk("s1", { a: 1, b: 10 }), mk("s1", { a: 1, c: 10 }))) === "none");
check(`cross subject with ${CROSS_SUBJECT_MIN_SHARED} shared terms and high similarity links`,
  typeOf(classifyPair(mk("s1", half[0]), mk("s2", half[1]))) === "cross-subject");
check("cross subject with only ONE shared term is rejected, however similar",
  typeOf(classifyPair(mk("s1", { a: 1 }), mk("s2", { a: 1 }))) === "rejected");
// share a and b; cosine 2/11 = 0.18
check(`cross subject below ${CROSS_SUBJECT_THRESHOLD} similarity is rejected even with ${CROSS_SUBJECT_MIN_SHARED} shared terms`,
  typeOf(classifyPair(mk("s1", { a: 1, b: 1, x: 3 }), mk("s2", { a: 1, b: 1, y: 3 }))) === "rejected");
check(`cross subject below ${SIMILARITY_THRESHOLD} is not stored at all`,
  typeOf(classifyPair(mk("s1", { a: 1, b: 10 }), mk("s2", { a: 1, c: 10 }))) === "none");
// 32 equally weighted terms each, 20 of them shared (similarity 0.625); the
// shared ones come last, so ties leave them out of both top 12s
const terms = (prefix, n) => Array.from({ length: n }, (_, i) => [`${prefix}${i}`, 1]);
const outside = [mk("s1", Object.fromEntries([...terms("p", 12), ...terms("s", 20)])), mk("s2", Object.fromEntries([...terms("q", 12), ...terms("s", 20)]))];
check("terms shared outside both notes' top 12 do not count, however similar the notes",
  classifyPair(...outside) === null && classifyPair(outside[0], { ...outside[1], subjectId: "s1" })?.edgeType === "same-subject");
// The link evaluation (docs/LINK_EVALUATION.md) lowered the same-subject
// threshold from 0.12 to 0.11. Two vectors with cosine exactly `sim`:
const atSim = (sim) => [{ a: 1, b: Math.sqrt(1 / sim - 1) }, { a: 1, c: Math.sqrt(1 / sim - 1) }];
check("same subject at 0.115 links (it did not under the earlier 0.12)",
  typeOf(classifyPair(mk("s1", atSim(0.115)[0]), mk("s1", atSim(0.115)[1]))) === "same-subject");
check("  ...while across subjects, sharing one term, the same pair is only rejected",
  typeOf(classifyPair(mk("s1", atSim(0.115)[0]), mk("s2", atSim(0.115)[1]))) === "rejected");

console.log("\n=== Across subjects by meaning, when both notes have an embedding ===");
const lf = (weight, shared, sameSubject, meaning) => ({ weight, sharedKeywords: Array.from({ length: shared }, (_, i) => `k${i}`), sameSubject, meaning });
check(`meaning of at least ${CROSS_SUBJECT_MEANING_THRESHOLD} with one shared term links, however low the TF-IDF similarity`,
  decideLink(lf(0.05, 1, false, CROSS_SUBJECT_MEANING_THRESHOLD)) === "cross-subject" && decideLink(lf(0.05, 1, false, CROSS_SUBJECT_MEANING_THRESHOLD - 0.001)) === null);
check("  ...but not without a shared term", decideLink(lf(0.3, 0, false, 0.9)) === null);
check("  ...and it replaces the TF-IDF test: a pair that would pass it, lower in meaning, is only rejected",
  decideLink(lf(0.3, 2, false, 0.6)) === "rejected" && decideLink(lf(0.3, 2, false, null)) === "cross-subject");
check("without embeddings, the TF-IDF rule as before", [lf(0.3, 2, false, null), lf(0.3, 1, false, null), lf(0.1, 2, false, null)].map((x) => decideLink(x)).join() === "cross-subject,rejected,");
check("same-subject links ignore meaning", decideLink(lf(0.05, 3, true, 0.95)) === null && decideLink(lf(0.2, 0, true, 0.1)) === "same-subject");
check("the rule's numbers are part of LINK_RULE", LINK_RULE.crossMeaning === CROSS_SUBJECT_MEANING_THRESHOLD && LINK_RULE.crossMeaningMinShared === 1);
const withVec = (n, vec) => ({ ...n, embedding: vec, embeddingModel: "m" });
const pairA = withVec(mk("s1", { a: 1, b: 2 }), [1, 0]);
const pairB = withVec(mk("s2", { a: 1, c: 2 }), [0.8, 0.6]);
check("classifyPair records the meaning of a cross-subject pair", classifyPair(pairA, pairB)?.meaning === 0.8 && classifyPair(pairA, pairB).edgeType === "cross-subject");
check("  ...but not of a same-subject one", classifyPair({ ...pairA, subjectId: "s2" }, pairB)?.meaning === null);
check("vectors from different models are not compared", classifyPair(pairA, { ...pairB, embeddingModel: "other" })?.meaning === null);

console.log("\n=== Linking compares TF-IDF terms, not the stored keywords ===");
const tfidfTop = (vector) => Object.entries(vector).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t]) => t);
const sample = computeTfidf(
  "Routing tables map a destination prefix to the next hop. Distance vector routing shares the table with neighbours; link state routing floods link costs.",
  ["A switch forwards frames by MAC address.", "The network layer routes packets between networks."]
);
check("linkTerms are the vector's 12 highest terms, ties in the vector's order (the keywords until Oct 2026)",
  JSON.stringify(linkTerms(sample)) === JSON.stringify(tfidfTop(sample.vector)), linkTerms(sample).join(", "));
check("  ...and the stored keywords play no part in a link",
  JSON.stringify(classifyPair(mk("s1", half[0]), mk("s2", half[1]))) ===
    JSON.stringify(classifyPair({ ...mk("s1", half[0]), keywords: ["unrelated"] }, { ...mk("s2", half[1]), keywords: ["words"] })));
check("  ...so shared words are reported from the vectors", JSON.stringify(classifyPair(mk("s1", half[0]), mk("s2", half[1])).sharedKeywords) === JSON.stringify(["a", "b"]),
  JSON.stringify(classifyPair(mk("s1", half[0]), mk("s2", half[1])).sharedKeywords));

console.log("\n=== Realistic notes (real TF-IDF, built like routes/notes.js) ===");
const SUBJECTS = {
  bio: [
    ["Cell structure", "The cell is the basic unit of life. The cell membrane controls what enters and leaves the cell. The nucleus holds DNA, and mitochondria release energy through respiration. Plant cells also have a cell wall and chloroplasts."],
    ["Osmosis and diffusion", "Diffusion is the movement of particles from a high concentration to a low concentration. Osmosis is the diffusion of water across a partially permeable membrane. The concentration gradient drives both processes, and the cell membrane is partially permeable."],
    ["Cell division", "During mitosis the nucleus divides and the DNA is copied so each new cell gets the same DNA. The cell membrane then pinches in and two daughter cells form."],
  ],
  net: [
    ["ATM networks", "Asynchronous Transfer Mode sends data in fixed-size cells of 53 bytes. Each cell has a 5 byte header and 48 byte payload. Virtual circuits are set up before cells are switched through the network."],
  ],
  chem: [
    ["Diffusion in gases and liquids", "Diffusion is the net movement of particles from a region of high concentration to a region of low concentration. The rate of diffusion increases with temperature and a steeper concentration gradient. Diffusion is faster in gases than liquids."],
    ["Electrochemical cells", "An electrochemical cell converts chemical energy into electrical energy. Oxidation happens at the anode and reduction at the cathode. A salt bridge completes the circuit between the two half cells."],
    ["Atomic structure", "An atom has a nucleus of protons and neutrons, surrounded by electrons in shells. The number of protons is the atomic number. Isotopes have the same protons but different neutrons."],
  ],
  phys: [
    ["Nuclear radiation", "Unstable nuclei emit radiation. Alpha particles are two protons and two neutrons. Beta decay turns a neutron into a proton and emits an electron. Isotopes of an element have the same number of protons but different numbers of neutrons, and some isotopes are radioactive."],
  ],
};
const note = {};
for (const [subjectId, list] of Object.entries(SUBJECTS)) {
  const earlier = [];
  for (const [title, text] of list) {
    const { vector, keywords } = computeTfidf(text, earlier);
    note[title] = { subjectId, title, vector, keywords };
    earlier.push(text);
  }
}
const pairCase = (a, b, expected) => {
  const pair = classifyPair(note[a], note[b]);
  const detail = pair ? `${pair.edgeType}, similarity ${pair.weight}, shared [${pair.sharedKeywords.join(", ")}]` : "no edge";
  check(`${a} <-> ${b}: ${expected}`, typeOf(pair) === expected, detail);
  return pair;
};
pairCase("Cell structure", "Cell division", "same-subject");
pairCase("Osmosis and diffusion", "Diffusion in gases and liquids", "cross-subject");
pairCase("Nuclear radiation", "Atomic structure", "cross-subject");
const cellCell = pairCase("Cell structure", "Electrochemical cells", "rejected");
check("  ...and that pair would pass a one-keyword rule, which is why two are required",
  cellCell && cellCell.weight >= CROSS_SUBJECT_THRESHOLD && cellCell.sharedKeywords.length === 1,
  cellCell ? `similarity ${cellCell.weight}, shared [${cellCell.sharedKeywords}]` : "");
pairCase("Cell structure", "ATM networks", "rejected");
pairCase("Cell division", "Atomic structure", "none");
check("classification does not depend on argument order",
  Object.keys(note).every((a) => Object.keys(note).every((b) =>
    a === b || typeOf(classifyPair(note[a], note[b])) === typeOf(classifyPair(note[b], note[a])))));

console.log("\n=== Clustering (connected components) ===");
// A-B-C is a chain (A and C are not linked directly), D-E a pair, F alone.
const day = (d) => new Date(`2026-09-0${d}T00:00:00Z`);
const cn = (id, d, keywords = []) => ({ _id: id, createdAt: day(d), keywords });
const cNotes = [
  cn("A", 1, ["cell", "membrane", "dna"]), cn("B", 2, ["membrane", "cell", "osmosis"]), cn("C", 3, ["dna", "cell"]),
  cn("D", 4, ["atom"]), cn("E", 5, ["proton"]), cn("F", 6),
];
const ce = (a, b) => ({ sourceNoteId: a, targetNoteId: b });
const cEdges = [ce("A", "B"), ce("B", "C"), ce("D", "E"), ce("E", "not-in-this-subject")];
const { clusterOf, clusters } = clusterNotes(cNotes, cEdges);
const idOf = (x) => clusterOf.get(x);
check("notes linked through a chain share a cluster", idOf("A") === idOf("C") && idOf("A") === idOf("B"));
check("unlinked groups get different clusters", idOf("A") !== idOf("D") && idOf("D") === idOf("E"));
check("a note with no links is a cluster of one", clusters.find((c) => c.id === idOf("F"))?.size === 1);
check("every note gets a clusterId", cNotes.every((n) => typeof idOf(n._id) === "number"));
check("clusters are numbered from 1, largest first",
  idOf("A") === 1 && idOf("D") === 2 && idOf("F") === 3, clusters.map((c) => `${c.id}:${c.size}`).join(" "));
check("an edge to a note outside the subject is ignored", clusters.length === 3 && !clusterOf.has("not-in-this-subject"));
check("cluster keywords are shared by at least two notes, most widespread first",
  JSON.stringify(clusters[0].keywords) === JSON.stringify(["cell", "membrane", "dna"]), JSON.stringify(clusters[0].keywords));
check("a cluster of one has no keyword label", clusters.find((c) => c.id === idOf("F")).keywords.length === 0);
const reshuffled = clusterNotes([...cNotes].reverse(), [...cEdges].reverse());
check("numbering does not depend on input order", cNotes.every((n) => reshuffled.clusterOf.get(n._id) === idOf(n._id)));
const tie = clusterNotes([cn("Y", 2), cn("X", 1), cn("Z", 3)], []);
check("equal-size clusters: the one with the oldest note comes first",
  tie.clusterOf.get("X") === 1 && tie.clusterOf.get("Y") === 2 && tie.clusterOf.get("Z") === 3);
check("no notes, no clusters", clusterNotes([], []).clusters.length === 0);

console.log("\n=== Storage contract (in-memory database) ===");
await connectDB();
// Replay the notes through the same steps routes/notes.js takes.
const OWNER = "a".repeat(24);
const ids = {};
for (const [subjectId, list] of Object.entries(SUBJECTS)) {
  const earlier = [];
  for (const [title, text] of list) {
    const { vector, keywords } = computeTfidf(text, earlier);
    const saved = await createNote({ ownerId: OWNER, subjectId, title, sourceType: "typed", rawText: text, keywords, vector, ocrFailed: false });
    await updateGraphForNote(saved, await findNotesByOwner(OWNER));
    ids[title] = String(saved._id);
    earlier.push(text);
  }
}
// A second student with a near-identical note must never be linked to the first.
const other = await createNote({
  ownerId: "b".repeat(24), subjectId: "chem2", title: "Diffusion copy", sourceType: "typed",
  rawText: "x", keywords: note["Diffusion in gases and liquids"].keywords,
  vector: note["Diffusion in gases and liquids"].vector, ocrFailed: false,
});
await updateGraphForNote(other, await findNotesByOwner("b".repeat(24)));

const hasPair = (edges, a, b) => edges.some((e) =>
  [String(e.sourceNoteId), String(e.targetNoteId)].sort().join() === [ids[a], ids[b]].sort().join());

const bioEdges = await findEdgesBySubject("bio");
check("findEdgesBySubject returns same-subject edges only",
  bioEdges.length > 0 && bioEdges.every((e) => e.edgeType === "same-subject" && e.subjectId === "bio"),
  `${bioEdges.length} edge(s): ${bioEdges.map((e) => e.edgeType).join(", ")}`);
check("  ...including Cell structure <-> Cell division", hasPair(bioEdges, "Cell structure", "Cell division"));

const bioCross = await findCrossSubjectEdges("bio");
const chemCross = await findCrossSubjectEdges("chem");
check("cross-subject edge is visible from the first subject",
  hasPair(bioCross.filter((e) => e.edgeType === "cross-subject"), "Osmosis and diffusion", "Diffusion in gases and liquids"));
check("  ...and from the second subject",
  hasPair(chemCross.filter((e) => e.edgeType === "cross-subject"), "Osmosis and diffusion", "Diffusion in gases and liquids"));
check("the ambiguous 'cell' pair is stored as rejected",
  hasPair(bioCross.filter((e) => e.edgeType === "rejected"), "Cell structure", "Electrochemical cells"));
check("cross-subject and rejected edges carry no subjectId",
  [...bioCross, ...chemCross].every((e) => e.subjectId === null));

const all = await getCollection("graph_edges").find({});
check("no edge ever joins two students' notes",
  !all.some((e) => [String(e.sourceNoteId), String(e.targetNoteId)].includes(String(other._id))));

const before = all.length;
const osmosis = (await findNotesByOwner(OWNER)).find((n) => n.title === "Osmosis and diffusion");
await updateGraphForNote(osmosis, await findNotesByOwner(OWNER));
const after = (await getCollection("graph_edges").find({})).length;
check("re-running the linker for a note does not duplicate edges", after === before, `${before} -> ${after}`);

console.log("\n=== Corrections: links the student removes ===");
const ownerNotes = async () => findNotesByOwner(OWNER);
const cellPair = (await findEdgesBySubject("bio")).find((e) => hasPair([e], "Cell structure", "Cell division"));
await setEdgeCorrection(cellPair._id, "removed");
check("a removed link leaves findEdgesBySubject", !hasPair(await findEdgesBySubject("bio"), "Cell structure", "Cell division"));
check("  ...but is still stored, for restoring",
  hasPair(await findEdgesBySubject("bio", { includeRemoved: true }), "Cell structure", "Cell division"));
// Re-scoring the pair is exactly what brought removed links back in the
// Second Brain prototype this feature comes from.
const division = (await ownerNotes()).find((n) => n.title === "Cell division");
await updateGraphForNote(division, await ownerNotes());
check("re-running the linker does not bring a removed link back",
  !hasPair(await findEdgesBySubject("bio"), "Cell structure", "Cell division"));
const bioNotes = (await ownerNotes()).filter((n) => n.subjectId === "bio");
const split = clusterNotes(bioNotes, await findEdgesBySubject("bio")).clusterOf;
check("removing a link splits its cluster", split.get(ids["Cell structure"]) !== split.get(ids["Cell division"]));
await setEdgeCorrection(cellPair._id, null);
check("restoring brings the link back", hasPair(await findEdgesBySubject("bio"), "Cell structure", "Cell division"));

const crossLink = (await findCrossSubjectEdges("bio")).find((e) => e.edgeType === "cross-subject");
await setEdgeCorrection(crossLink._id, "removed");
const inList = async (subject, opts) => (await findCrossSubjectEdges(subject, opts)).some((e) => e._id === crossLink._id);
check("a removed cross-subject link leaves both subjects' lists", !(await inList("bio")) && !(await inList("chem")));
check("  ...but is still stored, for restoring", await inList("bio", { includeRemoved: true }));
await setEdgeCorrection(crossLink._id, null);
check("restoring a cross-subject link brings it back to both subjects", (await inList("bio")) && (await inList("chem")));

console.log("\n=== Cross-subject links by meaning (a stand-in model) ===");
// The stand-in reads a sentence's meaning off these words; every sentence also
// gets a small constant, so none is a zero vector.
const MEANING_WORDS = ["missing", "outlier", "impute", "clean", "router", "packet", "routing"];
let embedCalls = 0;
const standIn = (texts) => {
  embedCalls += texts.length;
  return texts.map((t) => {
    const v = [...MEANING_WORDS.map((w) => (t.toLowerCase().includes(w) ? 1 : 0)), 0.15];
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  });
};
process.env.SEMANTIC_MODEL = "";
setEmbedderForTests(standIn);
const C = "c".repeat(24);
const save = async (subjectId, title, text, corpus = []) => {
  const { vector, keywords } = computeTfidf(text, corpus);
  const n = await createNote({ ownerId: C, subjectId, title, sourceType: "typed", rawText: text, keywords, vector, ocrFailed: false });
  await updateGraphForNote(n, await findNotesByOwner(C));
  return n;
};
const dedvSubject = await createSubject({ ownerId: C, name: "DEDV" });
const mlSubject = await createSubject({ ownerId: C, name: "ML" });
const cleaning = await save(dedvSubject._id, "Data cleaning", "Data cleaning fills missing values. Outliers are removed before analysis. Missing values can be imputed with the mean.");
const prep = await save(mlSubject._id, "Pre-processing for ML", "Pre-processing for machine learning handles missing values and outliers. Missing values are imputed with the median; outliers are clipped.");
const routing = await save(mlSubject._id, "Routing", "A router forwards each packet by its routing table. Missing routes send the packet to the default gateway.");
const stored = await findEmbeddings([cleaning._id, prep._id, routing._id]);
check("a saved note gets its embedding, stored with the model and a fingerprint of its text",
  stored.size === 3 && [...stored.values()].every((r) => r.model === "test-double" && r.vector.length === MEANING_WORDS.length + 1 && r.textHash && r.ownerId === C));
const meaningEdges = await getCollection("graph_edges").find({});
const between = (x, y) => meaningEdges.find((e) => [String(e.sourceNoteId), String(e.targetNoteId)].sort().join() === [String(x._id), String(y._id)].sort().join());
const meaningLink = between(cleaning, prep);
check("two notes on one idea in different subjects are linked by meaning", meaningLink?.edgeType === "cross-subject" && meaningLink.meaning >= CROSS_SUBJECT_MEANING_THRESHOLD,
  JSON.stringify(meaningLink && { type: meaningLink.edgeType, meaning: meaningLink.meaning, shared: meaningLink.sharedKeywords }));
check("  ...while one that shares a word but not the idea is not", !between(cleaning, routing) || between(cleaning, routing).edgeType !== "cross-subject",
  JSON.stringify(between(cleaning, routing) && { type: between(cleaning, routing).edgeType, meaning: between(cleaning, routing).meaning }));
const calls = embedCalls;
const again = await withEmbeddings(await findNotesByOwner(C), { embedder: { model: "test-double", embed: async (t) => standIn(t) }, compute: await findNotesByOwner(C) });
check("a stored embedding is reused while the text is unchanged", again.computed === 0 && embedCalls === calls);
await updateNote(cleaning._id, { rawText: "Data cleaning removes outliers and fills missing values by imputation." });
const edited = await withEmbeddings(await findNotesByOwner(C), { embedder: { model: "test-double", embed: async (t) => standIn(t) }, compute: await findNotesByOwner(C) });
check("  ...and made again once it changes", edited.computed === 1);
const otherModel = await withEmbeddings(await findNotesByOwner(C), { embedder: { model: "another-model", embed: async (t) => standIn(t) }, compute: [], save: false });
check("an embedding from another model is not used", otherModel.notes.every((n) => !n.embedding));

// a note saved while the model is off has no embedding, and its pairs fall back to TF-IDF
process.env.SEMANTIC_MODEL = "off";
const plain = await save(dedvSubject._id, "Missing data, again", "Missing values and outliers: impute missing values, clip outliers.");
process.env.SEMANTIC_MODEL = "";
check("a note saved without the model has no embedding", !(await findEmbeddings([plain._id])).size);
const plainEdge = (await getCollection("graph_edges").find({})).find((e) => [String(e.sourceNoteId), String(e.targetNoteId)].includes(String(plain._id)) && e.edgeType !== "same-subject");
check("  ...and its cross-subject pairs are decided by TF-IDF", !plainEdge || plainEdge.meaning === null, JSON.stringify(plainEdge && { type: plainEdge.edgeType, meaning: plainEdge.meaning }));

await deleteNote(await (async () => (await findNotesByOwner(C)).find((n) => n.title === "Routing"))());
check("deleting a note deletes its embedding", !(await findEmbeddings([routing._id])).size && (await findEmbeddings([prep._id])).size === 1);
await deleteSubjectAndData(String(mlSubject._id), C);
check("deleting a subject deletes its notes' embeddings", !(await findEmbeddings([prep._id])).size && (await findEmbeddings([cleaning._id])).size === 1);
await deleteUserAndData(C);
check("deleting an account deletes all its embeddings", (await findEmbeddingsByOwner(C)).length === 0);
setEmbedderForTests(null);
process.env.SEMANTIC_MODEL = "off";

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
