// Tests for knowledge-graph linking, in two parts:
//   1. classifyPair's rules, on hand-made vectors (exact boundaries) and on
//      realistic notes run through the real TF-IDF step, including the
//      ambiguous "cell" pairs the cross-subject rule exists to turn down;
//   2. the storage contract, against the in-memory database - same-subject
//      edges stay where findEdgesBySubject has always found them, and
//      cross-subject/rejected edges are visible from both subjects.
process.env.MONGODB_URI = ""; // always the in-memory store, never a real cluster
process.env.DB_FILE = "memory"; // a throwaway database: never write server/data/ from a test

import { computeTfidf } from "../src/services/tfidf.js";
import {
  classifyPair, clusterNotes, updateGraphForNote,
  SIMILARITY_THRESHOLD, CROSS_SUBJECT_THRESHOLD, CROSS_SUBJECT_MIN_SHARED,
} from "../src/services/graphEngine.js";
import { connectDB, getCollection } from "../src/db/index.js";
import { createNote, findNotesByOwner } from "../src/models/Note.js";
import { findCrossSubjectEdges, findEdgesBySubject, setEdgeCorrection } from "../src/models/GraphEdge.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!cond) failures++;
};
const typeOf = (pair) => (pair ? pair.edgeType : "none");

console.log("\n=== Rule boundaries (hand-made vectors) ===");
const mk = (subjectId, vector, keywords) => ({ subjectId, vector, keywords });
// cosine of these two is exactly 0.5
const half = [{ a: 1, b: 1, c: 0 }, { a: 1, b: 0, c: 1 }];
check("same subject at/above the threshold links", typeOf(classifyPair(mk("s1", half[0], ["a"]), mk("s1", half[1], ["a"]))) === "same-subject");
check("same subject needs no shared keyword", typeOf(classifyPair(mk("s1", half[0], ["x"]), mk("s1", half[1], ["y"]))) === "same-subject");
check("same subject below the threshold does not link",
  typeOf(classifyPair(mk("s1", { a: 1, b: 10 }, ["a"]), mk("s1", { a: 1, c: 10 }, ["a"]))) === "none");
check(`cross subject with ${CROSS_SUBJECT_MIN_SHARED} shared keywords and high similarity links`,
  typeOf(classifyPair(mk("s1", half[0], ["a", "b"]), mk("s2", half[1], ["a", "b"]))) === "cross-subject");
check("cross subject with only ONE shared keyword is rejected, however similar",
  typeOf(classifyPair(mk("s1", { a: 1 }, ["a"]), mk("s2", { a: 1 }, ["a"]))) === "rejected");
check(`cross subject below ${CROSS_SUBJECT_THRESHOLD} similarity is rejected even with shared keywords`,
  typeOf(classifyPair(mk("s1", { a: 1, b: 2 }, ["a", "b"]), mk("s2", { a: 1, c: 2.5 }, ["a", "b"]))) === "rejected");
check(`cross subject below ${SIMILARITY_THRESHOLD} is not stored at all`,
  typeOf(classifyPair(mk("s1", { a: 1, b: 10 }, ["a"]), mk("s2", { a: 1, c: 10 }, ["a"]))) === "none");
check("cross subject with no shared keyword is not stored",
  typeOf(classifyPair(mk("s1", half[0], ["x"]), mk("s2", half[1], ["y"]))) === "none");

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

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
