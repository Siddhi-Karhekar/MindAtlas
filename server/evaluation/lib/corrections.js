// Students' link corrections as evidence about the linking rule
// (evaluation/corrections.mjs, CONTRIBUTING.md, Member 2, item 6): reading
// them from a database backup, and the refit - a logistic regression of
// "removed" on a link's similarity and shared words - that may suggest a
// stricter threshold once there are enough of them. Pure apart from reading
// the backup, so test/corrections.test.mjs can check every step.
//
// A backup holds every student's data. Only graph_edges.json and
// subjects.json (to know whose link an edge is) are ever read, never
// notes.json, and nothing here returns a note's text, an id or a name.

import fs from "node:fs";
import path from "node:path";
import { BSON } from "mongodb";
import { LINK_RULE } from "../../src/services/graphEngine.js";
import { CHOICE, notClearlyBelow } from "./links.js";
import { round } from "./stats.js";

export const isRemoved = (e) => e.correction === "removed";
// rows from before cross-subject linking have no type (models/GraphEdge.js)
export const typeOf = (e) => e.edgeType || "same-subject";
const num = (x) => (x === null || x === undefined || Number.isNaN(Number(x)) ? null : Number(x));

/** The newest folder `npm run db:backup` wrote in `backupsDir`, or null. */
export function newestBackup(backupsDir) {
  const all = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).filter((d) => d.startsWith("mindatlas-")).sort() : [];
  return all.length ? path.join(backupsDir, all.at(-1)) : null;
}

// a backup's collection, or [] when the backup has none
const readCollection = (dir, name) => {
  const file = path.join(dir, `${name}.json`);
  return fs.existsSync(file) ? BSON.EJSON.parse(fs.readFileSync(file, "utf8")) : [];
};

/**
 * A backup's graph edges, each with `owner` (the user id of its subject's
 * owner, or null when the subject is not in the backup), leaving out the
 * accounts in `exclude` (the team's own test accounts, say). Returns
 * { takenAt, edges, excluded: edges left out }.
 */
export function readBackup(dir, { exclude = new Set() } = {}) {
  if (!fs.existsSync(path.join(dir, "graph_edges.json"))) throw new Error(`no graph_edges.json in ${dir} - is it a folder npm run db:backup wrote?`);
  const manifestFile = path.join(dir, "manifest.json");
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : {};
  const ownerOf = new Map(readCollection(dir, "subjects").map((s) => [String(s._id), String(s.ownerId)]));
  const all = readCollection(dir, "graph_edges").map((e) => ({ ...e, owner: ownerOf.get(String(e.sourceSubjectId ?? e.subjectId)) ?? null }));
  const edges = all.filter((e) => !exclude.has(e.owner));
  return { takenAt: manifest.takenAt ?? null, edges, excluded: all.length - edges.length };
}

// ---------------------------------------------------------------------------
// The refit
// ---------------------------------------------------------------------------

/**
 * When a refit is tried, and how much one student can weigh in it.
 *   minRemovals, minStudents - a group needs at least this many removed links,
 *     from at least this many students: roughly 10 removals for each thing
 *     the regression weighs, and never one student's say alone.
 *   capPerStudent - each student's removals count for at most this many
 *     together, so one student who removes a lot cannot move the rule for
 *     everyone (their removed links are weighted down, not dropped).
 */
export const REFIT = Object.freeze({ minRemovals: 50, minStudents: 5, capPerStudent: 10 });

/**
 * The thresholds of the linking rule (services/graphEngine.js, LINK_RULE)
 * a refit can move, one per group of links:
 *   score     - the similarity the threshold is on
 *   ruleKey   - the threshold in LINK_RULE; minSharedKey, the shared words
 *               the group also needs (kept as it is)
 *   measure   - the link evaluation run whose ratings check it ("tfidf" or
 *               "embedding", manifest.json's similarity)
 *   max       - the top of the link evaluation's grid for it, so any
 *               suggestion can be checked on the ratings
 */
export const GROUPS = Object.freeze([
  {
    id: "same", name: "Same-subject links", constant: "SIMILARITY_THRESHOLD", ruleKey: "similarity", minSharedKey: null,
    measure: "tfidf", max: 0.3, inGroup: (e) => typeOf(e) === "same-subject", score: (e) => num(e.weight),
  },
  {
    id: "cross-meaning", name: "Cross-subject links by meaning", constant: "CROSS_SUBJECT_MEANING_THRESHOLD", ruleKey: "crossMeaning",
    minSharedKey: "crossMeaningMinShared", measure: "embedding", max: 0.8,
    inGroup: (e) => typeOf(e) === "cross-subject" && num(e.meaning) !== null, score: (e) => num(e.meaning),
  },
  {
    id: "cross-tfidf", name: "Cross-subject links by TF-IDF", constant: "CROSS_SUBJECT_THRESHOLD", ruleKey: "crossSimilarity",
    minSharedKey: "crossMinShared", measure: "tfidf", max: 0.4,
    inGroup: (e) => typeOf(e) === "cross-subject" && num(e.meaning) === null, score: (e) => num(e.weight),
  },
]);

/**
 * The links of `group` as rows for the regression: { x: similarity, shared:
 * shared words, y: 1 removed / 0 not, w: weight, owner }. A student's removed
 * links each weigh min(1, capPerStudent / their removals). Links without a
 * score (rows older than the score) and pairs that were never linked
 * ("rejected") are left out.
 */
export function refitRows(edges, group, { capPerStudent = REFIT.capPerStudent } = {}) {
  const links = edges.filter((e) => group.inGroup(e) && group.score(e) !== null);
  const removalsOf = new Map();
  for (const e of links) if (isRemoved(e)) removalsOf.set(e.owner, (removalsOf.get(e.owner) || 0) + 1);
  return links.map((e) => {
    const y = isRemoved(e) ? 1 : 0;
    return { x: group.score(e), shared: (e.sharedKeywords || []).length, y, w: y ? Math.min(1, capPerStudent / removalsOf.get(e.owner)) : 1, owner: e.owner };
  });
}

/**
 * Whether `rows` hold enough corrections to refit: { links, removals,
 * students (who removed any), counted (removals after the cap), enough }.
 */
export function refitGate(rows, { minRemovals = REFIT.minRemovals, minStudents = REFIT.minStudents } = {}) {
  const removed = rows.filter((r) => r.y === 1);
  const removals = removed.length;
  const students = new Set(removed.map((r) => r.owner)).size;
  return { links: rows.length, removals, students, counted: round(removed.reduce((s, r) => s + r.w, 0), 1), enough: removals >= minRemovals && students >= minStudents };
}

// Solve A x = b for a small square system (Gaussian elimination, partial pivoting).
function solve(A, b) {
  const n = b.length;
  const m = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = c + 1; r < n; r++) {
      const f = m[r][c] / m[c][c];
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r][n];
    for (let k = r + 1; k < n; k++) s -= m[r][k] * x[k];
    x[r] = s / m[r][r];
  }
  return x;
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/**
 * Weighted logistic regression of `y` on `features` (each row: { features:
 * number[], y: 0|1, w }), by Newton's method on standardised features. A
 * light ridge penalty (`lambda`, not on the intercept) keeps the fit finite
 * when similarity separates removed links from the rest perfectly. Returns
 * { intercept, coefficients (on the original scale), iterations, converged }.
 */
export function fitLogistic(rows, { lambda = 1, maxIterations = 100 } = {}) {
  const k = rows[0].features.length;
  const totalW = rows.reduce((s, r) => s + r.w, 0);
  const mean = Array.from({ length: k }, (_, j) => rows.reduce((s, r) => s + r.w * r.features[j], 0) / totalW);
  const sd = mean.map((m, j) => Math.sqrt(rows.reduce((s, r) => s + r.w * (r.features[j] - m) ** 2, 0) / totalW) || 1);
  const z = rows.map((r) => [1, ...r.features.map((x, j) => (x - mean[j]) / sd[j])]);
  let beta = new Array(k + 1).fill(0);
  let iterations = 0;
  let converged = false;
  while (iterations < maxIterations && !converged) {
    iterations += 1;
    const grad = beta.map((b, j) => (j ? -lambda * b : 0));
    const hess = beta.map((_, i) => beta.map((__, j) => (i === j && i ? lambda : 0)));
    rows.forEach((r, n) => {
      const p = sigmoid(z[n].reduce((s, v, j) => s + v * beta[j], 0));
      for (let i = 0; i <= k; i++) {
        grad[i] += r.w * (r.y - p) * z[n][i];
        for (let j = 0; j <= k; j++) hess[i][j] += r.w * p * (1 - p) * z[n][i] * z[n][j];
      }
    });
    const step = solve(hess, grad);
    beta = beta.map((b, j) => b + step[j]);
    converged = Math.max(...step.map(Math.abs)) < 1e-9;
  }
  const coefficients = beta.slice(1).map((b, j) => b / sd[j]);
  const intercept = beta[0] - coefficients.reduce((s, c, j) => s + c * mean[j], 0);
  return { intercept, coefficients, iterations, converged };
}

/** The model's probability that a link is removed. */
export const removalProbability = (model, features) => sigmoid(model.intercept + model.coefficients.reduce((s, c, j) => s + c * features[j], 0));

/**
 * The threshold a fitted model (on [similarity, shared words]) suggests for
 * links with `shared` shared words: the lowest similarity, in steps of 0.01
 * from `current` up to `max`, at which the model says a link is kept more
 * often than removed. Never below `current`: students can remove a wrong link
 * but cannot add one the graph missed, so corrections only ever show that the
 * rule should be stricter. Returns { threshold, stricter, atCurrent (the
 * removal probability at today's threshold), reason }.
 */
export function suggestThreshold(model, { current, max, shared }) {
  const p = (t) => removalProbability(model, [t, shared]);
  const atCurrent = round(p(current));
  if (p(current) < 0.5) return { threshold: current, stricter: false, atCurrent, reason: "links at today's threshold are kept more often than removed" };
  if (model.coefficients[0] >= 0) return { threshold: current, stricter: false, atCurrent, reason: "removals do not fall as similarity rises, so no threshold separates them" };
  for (let t = round(current + 0.01, 2); t <= max + 1e-9; t = round(t + 0.01, 2)) {
    if (p(t) < 0.5) return { threshold: t, stricter: true, atCurrent, reason: `from ${t} on, links are kept more often than removed` };
  }
  return { threshold: max, stricter: true, atCurrent, reason: `links are removed more often than kept all the way to ${max}, the top of the link evaluation's grid - look at the removals before going further` };
}

/**
 * Whether the link evaluation's ratings agree with a suggested threshold for
 * `group`: `results` are a scored run's (runLinkScoring), on the group's
 * similarity. They agree when the suggested setting links at least
 * `minLinked` rated pairs, its F1 is not clearly below the best setting's
 * (the choice rule's paired test, notClearlyBelow) and its precision is at
 * least `minPrecision` - the corrections may move the threshold only within
 * what the ratings consider as good as the best. The ratings check a refit;
 * they never train it. Returns { agrees, reason, row }.
 */
export function checkOnRatings(results, group, threshold, options = {}) {
  const { flat, minLinked, minPrecision } = { ...CHOICE, ...options };
  const rows = group.id === "same" ? results.grid.same : results.grid.cross.filter((r) => r.crossMinShared === LINK_RULE[group.minSharedKey]);
  const at = (r) => (group.id === "same" ? r.similarity : r.crossSimilarity);
  const row = rows.find((r) => Math.abs(at(r) - threshold) < 1e-9);
  if (!row) return { agrees: false, row: null, reason: `${threshold} is not in the run's grid` };
  if (row.f1 === null || row.linked < minLinked) return { agrees: false, row, reason: `${threshold} links ${row.linked} rated pairs, fewer than ${minLinked}: the ratings cannot judge it` };
  const eligible = rows.filter((r) => r.f1 !== null && r.linked >= minLinked);
  const best = eligible.reduce((a, r) => (r.f1 > a.f1 ? r : a));
  if (!notClearlyBelow(row, best, flat)) return { agrees: false, row, reason: `its F1 (${row.f1}) is clearly below the best (${best.f1}, at ${at(best)})` };
  if (row.precision < minPrecision) return { agrees: false, row, reason: `its precision (${Math.round(row.precision * 100)}%) is under ${Math.round(minPrecision * 100)}%` };
  return { agrees: true, row, reason: `its F1 (${row.f1}) is as good as the best (${best.f1}) and its precision is ${Math.round(row.precision * 100)}%` };
}
