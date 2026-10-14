// Checks for the link evaluation (evaluation/links.mjs, evaluation/lib/links.js,
// docs/LINK_EVALUATION.md). It decides the linking thresholds, so an error
// here would quietly move every student's graph. Covered: the split of
// classifyPair the evaluation relies on, notes -> topics -> pairs exactly as
// the graph scores them, which pairs are rated and that raters see no
// scores, the weighted precision / recall / F1 (against values worked out by
// hand), the choice of setting, a whole generate -> rate -> score run, and
// scoring the same ratings again on features worked out now (--recompute).
// In-process, no server and no port.
process.env.MONGODB_URI = ""; // never a real cluster
process.env.DB_FILE = "memory"; // never write server/data/ from a test

import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyPair, decideEdge, LINK_RULE, pairFeatures } from "../src/services/graphEngine.js";
import { computeTfidf } from "../src/services/tfidf.js";
import {
  allStrata, bootstrapDraws, chooseSetting, collectSubjects, excerpt, GRID, gridSearch, loadTopics, pairLabels,
  raterAgreement, readRelated, ruleMetrics, scorePairs, stratumOf, stratumWeights, waterFill,
} from "../evaluation/lib/links.js";
import { comparisonMarkdown, HOW_TO_RATE, runLinkGeneration, runLinkRescoring, runLinkScoring } from "../evaluation/links.mjs";
import { parseCsv, seededRandom, toCsv, wilson } from "../evaluation/lib/stats.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!cond) failures++;
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mindatlas-links-"));
const DBMS = fileURLToPath(new URL("../evaluation/samples/dbms_unit4.md", import.meta.url));

// The realistic notes from graphEngine.test.mjs, one file per topic, plus a
// document that splits into subtopics. physics.txt sits loose in the folder,
// so it is a subject of its own.
const NOTES = {
  "biology/cell_structure.txt": "The cell is the basic unit of life. The cell membrane controls what enters and leaves the cell. The nucleus holds DNA, and mitochondria release energy through respiration. Plant cells also have a cell wall and chloroplasts.",
  "biology/osmosis_and_diffusion.txt": "Diffusion is the movement of particles from a high concentration to a low concentration. Osmosis is the diffusion of water across a partially permeable membrane. The concentration gradient drives both processes, and the cell membrane is partially permeable.",
  "biology/cell_division.txt": "During mitosis the nucleus divides and the DNA is copied so each new cell gets the same DNA. The cell membrane then pinches in and two daughter cells form.",
  "chemistry/diffusion_in_gases.txt": "Diffusion is the net movement of particles from a region of high concentration to a region of low concentration. The rate of diffusion increases with temperature and a steeper concentration gradient. Diffusion is faster in gases than liquids.",
  "chemistry/electrochemical_cells.txt": "An electrochemical cell converts chemical energy into electrical energy. Oxidation happens at the anode and reduction at the cathode. A salt bridge completes the circuit between the two half cells.",
  "chemistry/atomic_structure.txt": "An atom has a nucleus of protons and neutrons, surrounded by electrons in shells. The number of protons is the atomic number. Isotopes have the same protons but different neutrons.",
  "networks/atm_networks.txt": "Asynchronous Transfer Mode sends data in fixed-size cells of 53 bytes. Each cell has a 5 byte header and 48 byte payload. Virtual circuits are set up before cells are switched through the network.",
  "networks/empty.txt": "   ",
  "physics.txt": "Unstable nuclei emit radiation. Alpha particles are two protons and two neutrons. Beta decay turns a neutron into a proton and emits an electron. Isotopes of an element have the same number of protons but different numbers of neutrons, and some isotopes are radioactive.",
};
const NOTES_DIR = path.join(tmp, "notes");
for (const [rel, text] of Object.entries(NOTES)) {
  fs.mkdirSync(path.dirname(path.join(NOTES_DIR, rel)), { recursive: true });
  fs.writeFileSync(path.join(NOTES_DIR, rel), text);
}
fs.mkdirSync(path.join(NOTES_DIR, "dbms"));
fs.copyFileSync(DBMS, path.join(NOTES_DIR, "dbms", "dbms_unit4.md"));

console.log("\n=== The linking rule, split into features and decision ===");
const f = (weight, shared, sameSubject) => ({ weight, sharedKeywords: Array.from({ length: shared }, (_, i) => `k${i}`), sameSubject });
check("decideEdge with the current rule matches the constants",
  decideEdge(f(LINK_RULE.similarity, 0, true)) === "same-subject" && decideEdge(f(LINK_RULE.similarity - 0.0001, 0, true)) === null &&
  decideEdge(f(LINK_RULE.crossSimilarity, LINK_RULE.crossMinShared, false)) === "cross-subject" &&
  decideEdge(f(0.3, LINK_RULE.crossMinShared - 1, false)) === "rejected" && decideEdge(f(0.3, 0, false)) === null);
check("another rule changes only what it should",
  decideEdge(f(0.1, 0, true), { ...LINK_RULE, similarity: 0.08 }) === "same-subject" &&
  decideEdge(f(0.3, 1, false), { ...LINK_RULE, crossMinShared: 1 }) === "cross-subject" &&
  decideEdge(f(0.3, 2, false), { ...LINK_RULE, crossSimilarity: 0.35 }) === "rejected");
check("LINK_RULE cannot be changed by accident", Object.isFrozen(LINK_RULE));

console.log("\n=== Subjects and topics ===");
const subjects = collectSubjects(NOTES_DIR);
check("each subfolder is a subject, and a loose file is one of its own",
  subjects.map((s) => s.subject).join(",") === "biology,chemistry,dbms,networks,physics", subjects.map((s) => s.subject).join(","));
const clash = path.join(tmp, "clash");
fs.mkdirSync(path.join(clash, "maths"), { recursive: true });
fs.writeFileSync(path.join(clash, "maths", "a.txt"), "Vectors have size and direction.");
fs.writeFileSync(path.join(clash, "maths.txt"), "Matrices are rectangular arrays.");
let clashError = "";
try {
  collectSubjects(clash);
} catch (err) {
  clashError = err.message;
}
check("two subjects with one name are refused", /two subjects are called "maths"/.test(clashError), clashError);

const loaded = await loadTopics(NOTES_DIR);
const { topics } = loaded;
const byTitle = (needle) => topics.find((t) => t.ref.includes(needle));
check("every file becomes topics, a long document its subtopics", topics.length === 16 && topics.filter((t) => t.subjectId === "dbms").length === 8,
  `${topics.length} topics: ${loaded.subjects.map((s) => `${s.subject} ${s.topics}`).join(", ")}`);
check("a file that cannot be read is skipped and named", loaded.problems.length === 1 && loaded.problems[0].startsWith("networks/empty.txt"), loaded.problems.join("; "));
check("topic ids are T01... and unique", new Set(topics.map((t) => t.id)).size === topics.length && topics[0].id === "T01");
check("refs name subject, file and section", byTitle("dbms_unit4.md#1") && byTitle("biology/cell_structure.txt#0") && new Set(topics.map((t) => t.ref)).size === topics.length);
check("a subtopic's title says which document it is from", byTitle("dbms_unit4.md#1").label.includes(" › "), byTitle("dbms_unit4.md#1").label);
const cell = byTitle("cell_structure");
const relinkStyle = computeTfidf(NOTES["biology/cell_structure.txt"], [NOTES["biology/osmosis_and_diffusion.txt"], NOTES["biology/cell_division.txt"]]);
check("keywords are worked out against the rest of the subject, as a relink does", JSON.stringify(cell.keywords) === JSON.stringify(relinkStyle.keywords), cell.keywords.join(" "));

const pairs = scorePairs(topics);
check("every pair of topics is scored once", pairs.length === (topics.length * (topics.length - 1)) / 2);
check("each pair is decided exactly as classifyPair decides it", pairs.every((p) => {
  const pair = classifyPair(topics[p.a], topics[p.b]);
  return (pair?.edgeType ?? null) === p.current && (!pair || pair.weight === Number(p.weight.toFixed(4)));
}));
check("pairFeatures is what classifyPair looks at", pairs.every((p) => JSON.stringify(pairFeatures(topics[p.a], topics[p.b]).sharedKeywords) === JSON.stringify(p.sharedKeywords)));

console.log("\n=== Strata and sample sizes ===");
check("strata by subject, keywords and similarity",
  stratumOf(f(0.12, 0, true)) === "same 0.100-0.125" && stratumOf(f(0.01, 3, true)) === "same <0.050" && stratumOf(f(0.3, 0, true)) === "same >=0.300" &&
  stratumOf(f(0.26, 2, false)) === "cross 2 shared 0.250-0.300" && stratumOf(f(0.5, 4, false)) === "cross 3+ shared >=0.400" &&
  stratumOf(f(0.07, 0, false)) === "cross 0 shared >=0.050" && stratumOf(f(0.01, 0, false)) === "cross 0 shared <0.050");
const known = new Set(allStrata().map((s) => s.id));
check("every pair falls in a known stratum", pairs.every((p) => known.has(stratumOf(p))));
check("water-fill takes everything when it fits", JSON.stringify(waterFill([3, 4], 10)) === "[3,4]");
check("water-fill shares a budget as evenly as possible", JSON.stringify(waterFill([5, 50, 50], 40)) === "[5,18,17]", JSON.stringify(waterFill([5, 50, 50], 40)));
check("water-fill never goes over the budget", JSON.stringify(waterFill([0, 0, 9], 5)) === "[0,0,5]");

console.log("\n=== Generating the rating sheet ===");
const run = path.join(tmp, "run");
const gen = await runLinkGeneration({ folder: NOTES_DIR, out: run, seed: 1, quiet: true, perBin: 3 });
const sheetText = fs.readFileSync(path.join(run, "for-raters", "rating_sheet.csv"), "utf8");
const sheet = parseCsv(sheetText);
const key = parseCsv(fs.readFileSync(path.join(run, "key.csv"), "utf8"));
const refPair = (a, b) => [a, b].sort().join("|");
const keyPairs = new Set(key.map((k) => refPair(k.ref_a, k.ref_b)));
const sharing = pairs.filter((p) => !p.sameSubject && p.sharedKeywords.length);
check("every cross-subject pair sharing a keyword is rated", sharing.length > 0 && sharing.every((p) => keyPairs.has(refPair(topics[p.a].ref, topics[p.b].ref))), `${sharing.length} such pairs`);
const stratumSize = (id) => pairs.filter((p) => stratumOf(p) === id).length;
check("same-subject strata are sampled up to the per-bin count, the lowest half as many again", gen.strata.filter((s) => s.group === "same").every((s) =>
  key.filter((k) => k.stratum === s.id).length === Math.min(stratumSize(s.id), s.id === "same <0.050" ? 5 : 3)));
check("stratum sizes add up to every pair", gen.manifest.strata.reduce((a, s) => a + s.size, 0) === pairs.length);
check("the sheet shows topics, never scores", JSON.stringify(Object.keys(sheet[0])) === JSON.stringify(["pair", "subject_a", "topic_a", "title_a", "excerpt_a", "subject_b", "topic_b", "title_b", "excerpt_b", "related", "comment"]));
// (a similarity of exactly 0 is the string "0", which any text contains)
check("  ...and no similarity or decision hides in its cells", !key.some((k) => k.similarity.length > 4 && sheetText.includes(k.similarity)) && !/same-subject|cross-subject|rejected/.test(sheetText));
check("the raters' folder holds only what raters need",
  JSON.stringify(fs.readdirSync(path.join(run, "for-raters")).sort()) === JSON.stringify(["HOW_TO_RATE.txt", "practice_sheet.csv", "rating_sheet.csv", "topics.md"]));
check("sheet and key list the same pairs in the same order, with the same topics",
  sheet.length === key.length && sheet.every((r, i) => r.pair === key[i].pair && r.topic_a === key[i].topic_a && r.topic_b === key[i].topic_b));
const order = new Map(topics.map((t, i) => [t.id, i]));
const flipped = key.filter((k) => order.get(k.topic_a) > order.get(k.topic_b)).length;
check("which topic comes first is random", flipped > 0 && flipped < key.length, `${flipped} of ${key.length} shown in reverse order`);
const similarities = key.map((k) => Number(k.similarity));
check("the sheet is not in similarity order", similarities.some((s, i) => i && s > similarities[i - 1]) && similarities.some((s, i) => i && s < similarities[i - 1]));
const practice = parseCsv(fs.readFileSync(path.join(run, "for-raters", "practice_sheet.csv"), "utf8"));
const sheetPairs = new Set(sheet.map((r) => [r.topic_a, r.topic_b].sort().join("|")));
check("practice pairs are separate from the rated ones", practice.length > 0 && practice.every((r) => /^X\d+$/.test(r.pair) && !sheetPairs.has([r.topic_a, r.topic_b].sort().join("|"))), `${practice.length} practice pairs`);
const topicsMd = fs.readFileSync(path.join(run, "for-raters", "topics.md"), "utf8");
check("topics.md has every topic's full text", topics.every((t) => topicsMd.includes(`## ${t.id} · `)) && topicsMd.includes(NOTES["physics.txt"]));
check("the instructions explain the three answers", fs.readFileSync(path.join(run, "for-raters", "HOW_TO_RATE.txt"), "utf8") === HOW_TO_RATE && /yes[\s\S]*no[\s\S]*unsure/.test(HOW_TO_RATE));
const again = await runLinkGeneration({ folder: NOTES_DIR, out: path.join(tmp, "again"), seed: 1, quiet: true, perBin: 3 });
const other = await runLinkGeneration({ folder: NOTES_DIR, out: path.join(tmp, "other"), seed: 2, quiet: true, perBin: 3 });
const fileOf = (dir, name) => fs.readFileSync(path.join(dir, name), "utf8");
check("the same seed gives the same sheet and key", fileOf(again.outDir, "for-raters/rating_sheet.csv") === sheetText && fileOf(again.outDir, "key.csv") === fileOf(run, "key.csv"));
check("another seed gives another order", fileOf(other.outDir, "for-raters/rating_sheet.csv") !== sheetText);
const long = "First sentence here. ".repeat(30);
check("an excerpt ends at a sentence and says there is more", excerpt(long).endsWith(". …") && excerpt(long).length <= 352 && excerpt("Short note.") === "Short note.");

console.log("\n=== Raters' answers -> labels ===");
check("answers in their usual spellings", readRelated("Yes") === "yes" && readRelated("n") === "no" && readRelated("not related") === "no" && readRelated("?") === "unsure" && readRelated("") === null && readRelated("perhaps") === undefined);
const labels = pairLabels(new Map([
  ["a", ["yes", "yes", "no"]], ["b", ["yes", "no"]], ["c", ["unsure", "yes"]], ["d", ["unsure", "unsure"]], ["e", [null, null]], ["f", ["no", null]],
]));
const label = (id) => labels.get(id).label;
check("majority decides, a tie is not related, unsure is no vote",
  label("a") === 1 && label("b") === 0 && label("c") === 1 && label("f") === 0, [..."abcf"].map((x) => label(x)).join(","));
check("a pair nobody answered yes or no has no label", label("d") === null && label("e") === null);
const agreement = raterAgreement(["r1", "r2"], new Map([["p1", ["yes", "yes"]], ["p2", ["no", "no"]], ["p3", ["yes", "no"]], ["p4", ["unsure", "yes"]]]), () => true);
const all = agreement.find((a) => a.group === "all");
check("agreement counts only pairs both answered yes or no", all.n === 3 && all.same === 0.667 && agreement.find((a) => a.group === "cross").n === 0, JSON.stringify(all));

console.log("\n=== Weighted precision, recall and F1 (worked by hand) ===");
// Stratum A: 100 pairs, 4 rated (each stands for 25). Stratum B: 10 pairs, 5 rated (each stands for 2).
const item = (stratum, weight, lbl) => ({ stratum, weight, label: lbl, sharedKeywords: [], sameSubject: true });
const handItems = [
  item("A", 0.02, 0), item("A", 0.03, 0), item("A", 0.04, 1), item("A", 0.01, 0),
  item("B", 0.2, 1), item("B", 0.25, 1), item("B", 0.3, 1), item("B", 0.22, 0), item("B", 0.35, 1),
];
const { weightOf, unrepresented } = stratumWeights(handItems, [{ id: "A", size: 100 }, { id: "B", size: 10 }, { id: "C", size: 7 }, { id: "D", size: 0 }]);
check("each rated pair stands for its stratum's size over its rated pairs", weightOf.get("A") === 25 && weightOf.get("B") === 2);
check("a stratum with pairs but no label is reported", JSON.stringify(unrepresented) === '["C"]');
const weighted = handItems.map((it) => ({ ...it, sampleWeight: weightOf.get(it.stratum) }));
const at15 = ruleMetrics(weighted, { ...LINK_RULE, similarity: 0.15 });
// linked: B's five (weight 10), related among them 4 (8); related in all: 25 + 8 = 33
check("threshold 0.15: precision 8/10, recall 8/33, F1 16/43", at15.precision === 0.8 && at15.recall === 0.242 && at15.f1 === 0.372, JSON.stringify(at15));
const at035 = ruleMetrics(weighted, { ...LINK_RULE, similarity: 0.035 });
check("threshold 0.035: precision 33/35, recall 1, F1 66/68", at035.precision === 0.943 && at035.recall === 1 && at035.f1 === 0.971, JSON.stringify(at035));
check("  ...without weights recall would look far better at 0.15 than it is", at15.related === 5 && at15.linked_related === 4);
const nEff = 35 ** 2 / (25 ** 2 + 5 * 2 ** 2);
check("intervals are Wilson on the effective number of pairs", JSON.stringify(at035.precision_ci) === JSON.stringify(wilson((33 / 35) * nEff, nEff)), JSON.stringify(at035.precision_ci));
check("nothing linked: F1 0 and no precision", ruleMetrics(weighted, { ...LINK_RULE, similarity: 0.9 }).f1 === 0 && ruleMetrics(weighted, { ...LINK_RULE, similarity: 0.9 }).precision === null);

console.log("\n=== Grid and the choice of setting ===");
check("the grid covers 0.05-0.30 and 0.15-0.40 in steps of 0.01, and 1-3 shared keywords",
  GRID.same.length === 26 && GRID.same[0] === 0.05 && GRID.same.at(-1) === 0.3 && GRID.same.includes(0.12) &&
  GRID.cross.length === 26 && GRID.cross[0] === 0.15 && GRID.cross.at(-1) === 0.4 && GRID.cross.includes(0.25) && GRID.minShared.join() === "1,2,3");
const row = (similarity, f1, precision, linked) => ({ similarity, crossSimilarity: 0.25, crossMinShared: 2, f1, precision, linked, related: 5 });
const rows = [row(0.1, 0.8, 0.7, 20), row(0.12, 0.79, 0.8, 15), row(0.14, 0.7, 0.9, 12), row(0.16, 0.81, 0.85, 5)];
const moved = chooseSetting(rows, rows[2]);
check("when F1 is flat the most precise setting wins, and too few linked pairs rule a setting out",
  !moved.keep && moved.row.similarity === 0.12 && moved.best === 0.8 && moved.band.length === 2, moved.reason);
const kept = chooseSetting(rows, rows[0]);
check("the current setting is kept when it is within the flat band", kept.keep && kept.row.similarity === 0.1, kept.reason);
check("no related pairs: nothing to recommend", chooseSetting([{ ...row(0.1, null, null, 0), related: 0 }], null).row === null);
const tied = chooseSetting([row(0.1, 0.9, 0.9, 20), row(0.11, 0.9, 0.9, 20)], null);
check("equal precision and F1: the stricter setting", tied.row.similarity === 0.11);
// With bootstrap draws, "as good as the best" is judged on the same resamples:
// a setting that beats the best in some of them is not clearly below it.
const withDraws = (r, f1Draws) => Object.defineProperty({ ...r }, "f1Draws", { value: f1Draws, enumerable: false });
const bestD = withDraws(row(0.1, 0.8, 0.6, 20), [0.8, 0.82, 0.78, 0.81]);
const closeD = withDraws(row(0.12, 0.75, 0.7, 20), [0.79, 0.83, 0.7, 0.74]);
const belowD = withDraws(row(0.14, 0.7, 0.9, 20), [0.7, 0.72, 0.68, 0.71]);
const paired = chooseSetting([bestD, closeD, belowD], belowD);
check("a setting lower in every resample is clearly below the best; one that wins some is not",
  !paired.keep && paired.row.similarity === 0.12 && paired.band.length === 2, paired.reason);
const floor = chooseSetting([row(0.1, 0.4, 0.3, 20), row(0.12, 0.39, 0.45, 20)], row(0.25, 0.1, 0.33, 3));
check("no change whose links would be wrong more often than right", floor.keep && floor.row.similarity === 0.25 && /wrong more often than right/.test(floor.reason), floor.reason);

// A census (every pair rated, weight 1) whose raters call same-subject pairs
// related from 0.2 up, and cross-subject pairs related with 2+ shared
// keywords and similarity 0.3 or more. The choice must find those lines.
// Each pair is rated ten times over, so that the resamples can tell settings
// apart (with eight pairs, no difference is clear).
const feat = (sameSubject, weight, shared, lbl) => ({ stratum: "all", sampleWeight: 1, sameSubject, weight, sharedKeywords: Array.from({ length: shared }, (_, i) => `k${i}`), label: lbl });
const census = [
  ...[0.05, 0.1, 0.15, 0.18].map((w) => feat(true, w, 0, 0)), ...[0.21, 0.25, 0.3, 0.35].map((w) => feat(true, w, 0, 1)),
  feat(false, 0.35, 1, 0), feat(false, 0.2, 2, 0), feat(false, 0.28, 2, 0), feat(false, 0.32, 2, 1), feat(false, 0.4, 3, 1), feat(false, 0.5, 2, 1),
];
const tenfold = census.flatMap((it) => Array.from({ length: 10 }, () => ({ ...it })));
const censusGrid = gridSearch({ items: tenfold, population: census, draws: bootstrapDraws(tenfold, seededRandom(1), 200) });
const sameChoice = chooseSetting(censusGrid.same, censusGrid.current.same, { minLinked: 1 });
check("same subject: finds the line the raters drew, at its strictest", !sameChoice.keep && sameChoice.row.similarity === 0.21 && sameChoice.row.f1 === 1, sameChoice.reason);
check("  ...and the current 0.12 scores what it should (P 4/6, R 1)", censusGrid.current.same.precision === 0.667 && censusGrid.current.same.recall === 1);
const crossChoice = chooseSetting(censusGrid.cross, censusGrid.current.cross, { minLinked: 1 });
check("cross subject: two shared keywords and 0.32", crossChoice.row.crossMinShared === 2 && crossChoice.row.crossSimilarity === 0.32 && crossChoice.row.f1 === 1, crossChoice.reason);
check("links made are counted over every pair", censusGrid.current.same.links === 6 && censusGrid.cross.find((r) => r.crossMinShared === 1 && r.crossSimilarity === 0.3).links === 4);
check("F1 has a bootstrap interval", Array.isArray(censusGrid.current.same.f1_ci));
check("each row keeps its resampled F1s for the choice, but not in results.json",
  censusGrid.current.same.f1Draws.length === 200 && !JSON.stringify(censusGrid.current.same).includes("f1Draws"));

console.log("\n=== Scoring a rated run ===");
const keyById = new Map(key.map((k) => [k.pair, k]));
const linked = (id) => ["same-subject", "cross-subject"].includes(keyById.get(id).current);
// rater "one" agrees with the graph everywhere; "two" too, except as noted
const one = sheet.map((r) => ({ ...r, related: linked(r.pair) ? "yes" : "no" }));
const two = sheet.map((r, i) => ({ ...r, related: i === 0 ? (linked(r.pair) ? "no" : "yes") : i === 1 ? "" : i === 2 ? "unsure" : i === 3 ? "perhaps" : r.related || (linked(r.pair) ? "y" : "n"), comment: i === 2 ? "hard one" : "" }));
two.push({ ...practice[0], related: "yes" });
const columns = Object.keys(sheet[0]);
fs.writeFileSync(path.join(run, "ratings_one.csv"), toCsv(one, columns));
fs.writeFileSync(path.join(run, "ratings_two.csv"), toCsv(two, columns));
const results = runLinkScoring({ dir: run, quiet: true, reps: 200, minLinked: 1 });
check("both raters are read", results.raters.join() === "one,two");
check("every pair has a label (rater one answered all)", results.labelled === sheet.length && results.ties === 1, `${results.labelled} labelled, ${results.ties} tie`);
check("an answer that is not yes, no or unsure is reported and ignored", results.problems.some((p) => p.includes('"perhaps"')));
check("practice rows are not scored", results.practice_rows_ignored === 1 && !results.problems.some((p) => p.includes("X01")));
check("comments are kept", Object.values(results.comments).flat().some((c) => c === "two: hard one"));
const pairAgreement = results.agreement.find((a) => a.group === "all");
check("agreement is measured", pairAgreement.n === sheet.length - 3 && pairAgreement.kappa !== null, JSON.stringify(pairAgreement));
check("the whole grid is scored", results.grid.same.length === 26 && results.grid.cross.length === 78);
check("results.md, results.json and grid.csv are written", ["results.md", "results.json", "grid.csv"].every((name) => fs.existsSync(path.join(run, name))) &&
  fs.readFileSync(path.join(run, "results.md"), "utf8").includes("## Recommendation") && parseCsv(fs.readFileSync(path.join(run, "grid.csv"), "utf8")).length === 104);
const agreeing = runLinkScoring({ dir: run, files: [path.join(run, "ratings_one.csv")], quiet: true, write: false, reps: 100, minLinked: 1 });
check("raters who agree with the graph: the current rule is perfect and kept",
  agreeing.current.same.precision === 1 && agreeing.current.same.recall === 1 && agreeing.choice.same.keep &&
  agreeing.rule.recommended.similarity === LINK_RULE.similarity, agreeing.choice.same.reason);
check("  ...and the report says agreement needs a second rater", !agreeing.agreement.length);

console.log("\n=== Scoring the same ratings again (score --recompute) ===");
const resultsBefore = fs.readFileSync(path.join(run, "results.md"), "utf8");
const unchanged = await runLinkRescoring({ dir: run, recompute: NOTES_DIR, quiet: true, reps: 200, minLinked: 1 });
const uc = unchanged.comparison;
check("with nothing changed, every rated pair is found again by its refs, at the same similarity",
  uc.pairs_found === key.length && uc.largest_similarity_change < 1e-12 && !uc.warnings.some((w) => !w.startsWith("file skipped")), uc.warnings.join("; "));
check("  ...and scores exactly as before", JSON.stringify(unchanged.after.current) === JSON.stringify(results.current) &&
  JSON.stringify(unchanged.before.current) === JSON.stringify(results.current) && uc.changed.length === 0 && uc.current.same.f1_change.change === 0);
check("it writes into recomputed/ and leaves the run's own results alone",
  ["comparison.md", "comparison.json", "key.recomputed.csv", "results.md", "results.json", "grid.csv"].every((f) => fs.existsSync(path.join(run, "recomputed", f))) &&
  fs.readFileSync(path.join(run, "results.md"), "utf8") === resultsBefore &&
  parseCsv(fs.readFileSync(path.join(run, "recomputed", "key.recomputed.csv"), "utf8")).length === key.length);

// a topic gone, and one note's vector replaced by another's
const CELL_REF = "biology/cell_structure.txt#0";
const ECHEM_REF = "chemistry/electrochemical_cells.txt#0";
const GONE_REF = "physics/physics.txt#0";
const reread = (await loadTopics(NOTES_DIR)).topics;
const echem = reread.find((t) => t.ref === ECHEM_REF);
const altered = reread.filter((t) => t.ref !== GONE_REF).map((t) => (t.ref === CELL_REF ? { ...t, vector: echem.vector } : t));
const rescored = await runLinkRescoring({ dir: run, topics: altered, quiet: true, write: false, reps: 200, minLinked: 1 });
const rc = rescored.comparison;
const gone = key.filter((k) => k.ref_a === GONE_REF || k.ref_b === GONE_REF).map((k) => k.pair);
check("a rated pair whose topic is gone is reported and left out",
  gone.length > 0 && rc.pairs_found === key.length - gone.length && gone.every((id) => rc.warnings.some((w) => w.startsWith(`${id} left out`))), `${gone.length} pair(s)`);
check("  ...its answers are dropped without complaint, and 'before' leaves it out too",
  !rescored.after.problems.some((p) => p.includes("not in key.csv")) && rescored.before.labelled === rescored.after.labelled && rescored.after.labelled < results.labelled);
check("  ...and the changed number of pairs is flagged", rc.warnings.some((w) => w.startsWith("the notes now give")));
const cellEchem = key.find((k) => refPair(k.ref_a, k.ref_b) === refPair(CELL_REF, ECHEM_REF));
const cellEchemChange = rc.changed.find((c) => c.pair === cellEchem?.pair);
check("a pair is decided on its features as they are now",
  cellEchemChange?.after === "cross-subject" && cellEchemChange.before !== "cross-subject" && cellEchemChange.similarity === 1, JSON.stringify(cellEchemChange));
check("  ...and a change in similarity is flagged: the notes are not the ones rated", rc.warnings.some((w) => w.startsWith("similarities differ")));
check("the comparison counts shared keywords before and after", rc.sharing.rated.after[0] >= rc.sharing.rated.before[0] - gone.length && rc.links.after.cross >= 1);
check("comparison.md has the tables", /## At today's rule[\s\S]*## Shared keywords across subjects[\s\S]*## Rated pairs decided differently/.test(comparisonMarkdown(rc)));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
