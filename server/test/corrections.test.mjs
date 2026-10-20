// Tests for refitting the linking rule from students' corrections
// (evaluation/lib/corrections.js, evaluation/corrections.mjs):
//   1. reading a backup: whose link an edge is, excluded accounts, and that
//      notes.json is never read;
//   2. the gate, and the cap on what one student's removals can weigh;
//   3. the logistic regression, and the threshold it suggests (never lower
//      than today's);
//   4. the check on the link evaluation's ratings, on a small rated run;
//   5. the whole refit: with no corrections, as on the live site in Oct 2026,
//      and with enough of them.
process.env.MONGODB_URI = "";
process.env.DB_FILE = "memory";
process.env.SEMANTIC_MODEL = "off";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BSON } from "mongodb";
import { LINK_RULE } from "../src/services/graphEngine.js";
import {
  checkOnRatings, fitLogistic, GROUPS, newestBackup, readBackup, REFIT, refitGate, refitRows, removalProbability, suggestThreshold,
} from "../evaluation/lib/corrections.js";
import { refitReport, runCorrectionRefit } from "../evaluation/corrections.mjs";
import { runLinkScoring } from "../evaluation/links.mjs";
import { seededRandom, toCsv } from "../evaluation/lib/stats.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!cond) failures++;
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mindatlas-corrections-"));
const same = GROUPS.find((g) => g.id === "same");

// A backup as `npm run db:backup` writes it. notes.json is not even JSON, so
// reading it would fail.
function writeBackup(name, edges, subjects) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "graph_edges.json"), BSON.EJSON.stringify(edges, { relaxed: false }));
  fs.writeFileSync(path.join(dir, "subjects.json"), BSON.EJSON.stringify(subjects, { relaxed: false }));
  fs.writeFileSync(path.join(dir, "notes.json"), "students' notes - never to be read");
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ takenAt: "2026-10-15T03:17:29.933Z" }));
  return dir;
}

// Same-subject links for `students` students, similarities spread evenly over
// 0.11-0.5. `removedIf(similarity, random)` says which a student removed.
function studentLinks(students, perStudent, removedIf, seed = 1) {
  const random = seededRandom(seed);
  const subjects = [];
  const edges = [];
  for (let s = 0; s < students; s++) {
    subjects.push({ _id: `subject-${s}`, ownerId: `owner-secret-${s}`, name: `Private subject ${s}` });
    for (let i = 0; i < perStudent; i++) {
      const weight = Number((0.11 + random() * 0.39).toFixed(4));
      const removed = removedIf(weight, random);
      edges.push({
        _id: `e${s}-${i}`, subjectId: `subject-${s}`, sourceSubjectId: `subject-${s}`, targetSubjectId: `subject-${s}`,
        sourceNoteId: `n${s}-${i}a`, targetNoteId: `n${s}-${i}b`, edgeType: "same-subject", weight,
        sharedKeywords: ["alpha", "beta", "gamma"].slice(0, Math.floor(random() * 4)), meaning: null,
        ...(removed ? { correction: "removed", correctedAt: new Date("2026-10-10") } : {}),
      });
    }
  }
  return { edges, subjects };
}
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
// students remove a link with probability 1/2 at similarity 1/7 (0.143), more below
const removeLowOnes = (w, random) => random() < sigmoid(5 - 35 * w);

console.log("\n=== Reading a backup ===");
const live = studentLinks(3, 60, () => false);
const liveDir = writeBackup("mindatlas-2026-10-15T031728Z", [...live.edges, { _id: "r1", subjectId: null, sourceSubjectId: "subject-0", targetSubjectId: "subject-1", edgeType: "rejected", weight: 0.2, sharedKeywords: ["alpha"] }], live.subjects);
writeBackup("mindatlas-2026-10-14T000000Z", [], []);
const readFiles = [];
const realRead = fs.readFileSync;
fs.readFileSync = (file, ...rest) => {
  readFiles.push(path.basename(String(file)));
  return realRead(file, ...rest);
};
const backup = readBackup(liveDir);
fs.readFileSync = realRead;
check("reads graph_edges.json, subjects.json and manifest.json, and never notes.json",
  !readFiles.includes("notes.json") && ["graph_edges.json", "subjects.json", "manifest.json"].every((f) => readFiles.includes(f)), readFiles.join(", "));
check("each edge knows whose it is, from its subject", backup.edges.length === 181 && backup.edges.every((e) => e.owner?.startsWith("owner-secret-")));
check("excluded accounts are left out and counted", readBackup(liveDir, { exclude: new Set(["owner-secret-0"]) }).excluded === 61);
check("the newest backup is found by its name", path.basename(newestBackup(tmp)) === "mindatlas-2026-10-15T031728Z" && newestBackup(path.join(tmp, "none")) === null);
check("a folder that is not a backup is refused", (() => {
  try {
    readBackup(tmp);
    return false;
  } catch (err) {
    return /graph_edges\.json/.test(err.message);
  }
})());

console.log("\n=== The gate and the cap ===");
const liveRows = refitRows(backup.edges, same);
check("rejected pairs are not links, so they are not rows", liveRows.length === 180 && liveRows.every((r) => r.y === 0));
const gateNow = refitGate(liveRows);
check("no removals: not enough to refit", !gateNow.enough && gateNow.removals === 0 && gateNow.students === 0, JSON.stringify(gateNow));
const rowsOf = (removals, students) => Array.from({ length: removals }, (_, i) => ({ y: 1, w: 1, owner: `o${i % students}` }));
check("49 removals from 6 students: not enough", !refitGate(rowsOf(49, 6)).enough);
check("60 removals from 4 students: not enough", !refitGate(rowsOf(60, 4)).enough);
check("50 removals from 5 students: enough", refitGate(rowsOf(50, 5)).enough && REFIT.minRemovals === 50 && REFIT.minStudents === 5);
// one student removes 100 links, four others 5 each
const heavy = [
  ...Array.from({ length: 100 }, (_, i) => ({ _id: `h${i}`, edgeType: "same-subject", weight: 0.3, owner: "heavy", correction: "removed" })),
  ...Array.from({ length: 20 }, (_, i) => ({ _id: `l${i}`, edgeType: "same-subject", weight: 0.3, owner: `light${i % 4}`, correction: "removed" })),
  { _id: "kept", edgeType: "same-subject", weight: 0.3, owner: "heavy" },
];
const heavyRows = refitRows(heavy, same);
check("one student's removals count for at most 10 together; others' in full",
  Math.abs(heavyRows.filter((r) => r.owner === "heavy" && r.y).reduce((s, r) => s + r.w, 0) - REFIT.capPerStudent) < 1e-9 &&
  heavyRows.filter((r) => r.owner !== "heavy").every((r) => r.w === 1) && heavyRows.find((r) => r.y === 0).w === 1);
check("  ...and the gate reports what they count for", refitGate(heavyRows).counted === 30 && refitGate(heavyRows).enough);

console.log("\n=== The logistic regression ===");
const random = seededRandom(7);
const truth = { intercept: 3, coefficients: [-20, 0.5] };
const synthetic = Array.from({ length: 4000 }, () => {
  const features = [0.05 + random() * 0.4, Math.floor(random() * 4)];
  return { features, y: random() < removalProbability(truth, features) ? 1 : 0, w: 1 };
});
const fitted = fitLogistic(synthetic);
check("recovers the coefficients it was generated with",
  fitted.converged && Math.abs(fitted.intercept - 3) < 0.6 && Math.abs(fitted.coefficients[0] + 20) < 3 && Math.abs(fitted.coefficients[1] - 0.5) < 0.2,
  `${fitted.intercept.toFixed(2)}, ${fitted.coefficients.map((c) => c.toFixed(2)).join(", ")}`);
const half = synthetic.slice(0, 500);
const doubled = fitLogistic([...half, ...half]);
const weighted = fitLogistic(half.map((r) => ({ ...r, w: 2 })));
check("a weight of 2 is the same as the row twice",
  Math.abs(doubled.intercept - weighted.intercept) < 1e-6 && doubled.coefficients.every((c, j) => Math.abs(c - weighted.coefficients[j]) < 1e-6));
const separated = fitLogistic(Array.from({ length: 100 }, (_, i) => ({ features: [i / 100, 1], y: i < 30 ? 1 : 0, w: 1 })));
check("removals that similarity separates perfectly still give a finite fit", separated.converged && Number.isFinite(separated.coefficients[0]) && separated.coefficients[0] < 0);

console.log("\n=== The threshold it suggests ===");
const crossing = { intercept: 5, coefficients: [-35, 0] }; // P(removed) = 1/2 at 0.1429
const stricter = suggestThreshold(crossing, { current: 0.11, max: 0.3, shared: 1 });
check("the lowest similarity, in steps of 0.01, from which links are kept more often than removed",
  stricter.stricter && stricter.threshold === 0.15 && stricter.atCurrent > 0.5, JSON.stringify(stricter));
const kept = suggestThreshold({ intercept: 1, coefficients: [-35, 0] }, { current: 0.11, max: 0.3, shared: 1 });
check("links at today's threshold kept more often than removed: no change", !kept.stricter && kept.threshold === 0.11);
check("never below today's threshold, however few are removed", !suggestThreshold({ intercept: -10, coefficients: [-1, 0] }, { current: 0.11, max: 0.3, shared: 0 }).stricter);
const rising = suggestThreshold({ intercept: 1, coefficients: [5, 0] }, { current: 0.11, max: 0.3, shared: 1 });
check("removals that do not fall as similarity rises: no change", !rising.stricter && /do not fall/.test(rising.reason));
const runaway = suggestThreshold({ intercept: 50, coefficients: [-35, 0] }, { current: 0.11, max: 0.3, shared: 1 });
check("never past the top of the evaluation's grid, and it says so", runaway.threshold === 0.3 && /top of the link evaluation's grid/.test(runaway.reason));

console.log("\n=== The check on the ratings ===");
// A rated run: 60 same-subject pairs from 0.05 to 0.40, every one rated
// (one stratum, weight 1). `lineAt` is where the rater draws "related".
function ratedRun(name, lineAt) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const rows = Array.from({ length: 60 }, (_, i) => {
    const similarity = Number((0.05 + (i * 0.35) / 59).toFixed(4));
    return {
      pair: `P${String(i + 1).padStart(3, "0")}`, stratum: "same all", same_subject: "yes", topic_a: `T${i}a`, topic_b: `T${i}b`,
      ref_a: `s/a.md#${i}`, ref_b: `s/b.md#${i}`, subject_a: "s", subject_b: "s", similarity: String(similarity), tfidf_similarity: String(similarity),
      shared_keywords: "alpha", current: similarity >= LINK_RULE.similarity ? "same-subject" : "none",
    };
  });
  const columns = Object.keys(rows[0]);
  fs.writeFileSync(path.join(dir, "key.csv"), toCsv(rows, columns));
  fs.writeFileSync(path.join(dir, "pairs.csv"), toCsv(rows, columns));
  fs.writeFileSync(path.join(dir, "ratings_test.csv"), toCsv(rows.map((r) => ({ pair: r.pair, related: Number(r.similarity) >= lineAt ? "yes" : "no" })), ["pair", "related"]));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ seed: 1, similarity: "tfidf", commit: "test", subjects: [], topics: 120, pairs: { all: 60, same: 60, cross: 0 }, strata: [{ id: "same all", size: 60 }] }));
  return dir;
}
const agreeingRun = ratedRun("run-line-0.15", 0.15);
const disagreeingRun = ratedRun("run-line-0.06", 0.06);
const agreeing = runLinkScoring({ dir: agreeingRun, write: false, quiet: true, reps: 200 });
const atLine = checkOnRatings(agreeing, same, 0.15);
check("raters who draw the line at 0.15 agree with 0.15", atLine.agrees && atLine.row.precision === 1, atLine.reason);
const tooStrict = checkOnRatings(agreeing, same, 0.3);
check("  ...not with 0.30, whose F1 is clearly below the best", !tooStrict.agrees && /clearly below/.test(tooStrict.reason), tooStrict.reason);
check("a threshold outside the grid cannot be checked", !checkOnRatings(agreeing, same, 0.45).agrees);
const lenient = checkOnRatings(runLinkScoring({ dir: disagreeingRun, write: false, quiet: true, reps: 200 }), same, 0.15);
check("raters who call nearly every pair related do not agree with 0.15", !lenient.agrees, lenient.reason);

console.log("\n=== The whole refit ===");
const now = runCorrectionRefit({ backup: liveDir, runs: [agreeingRun], quiet: true, reps: 200 });
const nowSame = now.groups.find((g) => g.id === "same");
check("no corrections (the live site in Oct 2026): nothing fitted, every threshold kept",
  now.groups.every((g) => g.keep && !g.model) && nowSame.links === 180 && /0 of 50 removals, 0 of 5 students/.test(nowSame.verdict), nowSame.verdict);
check("  ...and groups with no links say so", now.groups.filter((g) => g.id !== "same").every((g) => g.verdict === "no links"));
const nowText = refitReport(now);
check("the report has numbers only: no ids, names or words from the backup",
  !/owner-secret|Private subject|alpha|subject-0/.test(nowText) && /SIMILARITY_THRESHOLD, now 0\.11/.test(nowText) && /Nothing was changed/.test(nowText));

const many = studentLinks(8, 60, removeLowOnes, 3);
const manyDir = writeBackup("mindatlas-2026-11-01T000000Z", many.edges, many.subjects);
const unchecked = runCorrectionRefit({ backup: manyDir, quiet: true });
const uncheckedSame = unchecked.groups.find((g) => g.id === "same");
check("enough corrections: a stricter threshold is suggested where links start being kept",
  uncheckedSame.enough && uncheckedSame.model?.similarity < 0 && uncheckedSame.suggestion.stricter &&
  uncheckedSame.suggestion.threshold >= 0.13 && uncheckedSame.suggestion.threshold <= 0.17, JSON.stringify(uncheckedSame.suggestion));
check("  ...but without a rated run it is not checked, and today's threshold is kept",
  uncheckedSame.keep && /not checked on the ratings/.test(uncheckedSame.verdict), uncheckedSame.verdict);
const agreed = runCorrectionRefit({ backup: manyDir, runs: [agreeingRun], quiet: true, reps: 200 }).groups.find((g) => g.id === "same");
check("with ratings that agree, it says what to set", !agreed.keep && agreed.ratings.agrees && /^set SIMILARITY_THRESHOLD to 0\.1\d/.test(agreed.verdict), agreed.verdict);
const refused = runCorrectionRefit({ backup: manyDir, runs: [disagreeingRun], quiet: true, reps: 200 }).groups.find((g) => g.id === "same");
check("with ratings that do not agree, today's threshold is kept", refused.keep && !refused.ratings.agrees && /do not agree/.test(refused.verdict), refused.verdict);
check("excluding accounts can take a group back under the gate",
  !runCorrectionRefit({ edges: readBackup(manyDir, { exclude: new Set(["owner-secret-0", "owner-secret-1", "owner-secret-2", "owner-secret-3"]) }).edges, quiet: true })
    .groups.find((g) => g.id === "same").enough);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
