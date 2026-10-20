// The working parts of the cluster evaluation (`eval:links -- clusters`,
// docs/LINK_EVALUATION.md, "Clusters"): how well clusterNotes()
// (services/graphEngine.js) groups a subject's topics, with each method and
// setting. The link evaluation's rated same-subject pairs serve as labels -
// a pair rated related should be in one cluster, a pair rated not related
// should not - and the rest is description: sizes, modularity, how much one
// removed link moves, agreement with the documents' own sections. Pure, so
// test/linkEvaluation.test.mjs can check every step.

import { clusterNotes } from "../../src/services/graphEngine.js";
import { CHOICE, notClearlyBelow, pairedF1Differences, quantileOf } from "./links.js";
import { round } from "./stats.js";

// The resolutions tried, written down before the first run (PLAN.md).
export const RESOLUTIONS = Object.freeze([0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3]);

/** Connected components first (today's method), then Louvain at each resolution. */
export function clusterSettings(resolutions = RESOLUTIONS) {
  return [
    { name: "components", method: "components", resolution: null },
    ...resolutions.map((r) => ({ name: `louvain ${r}`, method: "louvain", resolution: r })),
  ];
}

/**
 * Each subject's topics and same-subject links as the graph route hands them
 * to clusterNotes(): [{ subject, notes, edges }]. `pairs` are scorePairs()'s,
 * so the links are today's rule. A topic's createdAt is its place in the
 * notes (subject, file, section): the order an upload creates them in, which
 * is the order Louvain visits them in. Weights are rounded as edges store them.
 */
export function subjectGraphs(topics, pairs) {
  const bySubject = new Map();
  topics.forEach((t, i) => {
    if (!bySubject.has(t.subjectId)) bySubject.set(t.subjectId, { subject: t.subjectId, notes: [], edges: [] });
    bySubject.get(t.subjectId).notes.push({ ...t, createdAt: new Date(i) });
  });
  for (const p of pairs) {
    if (p.current !== "same-subject") continue;
    const [a, b] = [topics[p.a], topics[p.b]];
    bySubject.get(a.subjectId).edges.push({ sourceNoteId: a._id, targetNoteId: b._id, weight: Number(p.weight.toFixed(4)) });
  }
  return [...bySubject.values()];
}

/** One setting on every subject: { clusterOf: Map topicId -> "subject#clusterId", bySubject: [{ subject, clusterOf, clusters }] }. */
export function clusterAll(graphs, setting) {
  const clusterOf = new Map();
  const bySubject = graphs.map((g) => {
    const result = clusterNotes(g.notes, g.edges, setting);
    for (const [id, c] of result.clusterOf) clusterOf.set(id, `${g.subject}#${c}`);
    return { subject: g.subject, ...result };
  });
  return { clusterOf, bySubject };
}

/**
 * A run's labelled same-subject pairs (its key.csv rows, `labels` from
 * pairLabels), found in `topics` by their refs as rescorePairs finds them:
 * { items: [{ pair, stratum, a, b, label, sameSubject }], unmatched: [pair] },
 * a and b being topic ids.
 */
export function ratedSameSubjectPairs(keyRows, labels, topics) {
  const byRef = new Map(topics.map((t) => [t.ref, t]));
  const items = [];
  const unmatched = [];
  for (const row of keyRows) {
    if (row.same_subject !== "yes") continue;
    const label = labels.get(row.pair)?.label;
    if (label === null || label === undefined) continue;
    const [a, b] = [byRef.get(row.ref_a), byRef.get(row.ref_b)];
    if (!a || !b || a.subjectId !== b.subjectId) {
      unmatched.push(row.pair);
      continue;
    }
    items.push({ pair: row.pair, stratum: row.stratum, a: String(a._id), b: String(b._id), label, sameSubject: true });
  }
  return { items, unmatched };
}

/** For ruleMetrics / f1Bootstrap: a rated pair counts as "linked" when its two topics share a cluster. */
export const together = (clusterOf) => (it) => (clusterOf.get(it.a) === clusterOf.get(it.b) ? "same-subject" : null);

/** `row`'s F1 minus `ref`'s, with its paired 95% interval over their bootstrap draws (f1Draws). */
export function pairedDifference(row, ref) {
  if (row.f1 === null || ref.f1 === null) return null;
  const diffs = pairedF1Differences(row, ref);
  if (!diffs.length) return null;
  return { change: round(row.f1 - ref.f1, 4), ci: [round(quantileOf(diffs, 0.025), 4), round(quantileOf(diffs, 0.975), 4)] };
}

/**
 * The decision rule of PLAN.md, on one run's rows (one per setting, as
 * ruleMetrics returns them plus `method`, `resolution` and f1Draws):
 *   1. only settings putting at least `minLinked` rated pairs together count;
 *   2. "as good as the best": F1 not clearly below the best (notClearlyBelow,
 *      the link evaluation's paired test);
 *   3. connected components (`current`) as good as the best: keep them;
 *   4. otherwise resolution 1 if it is as good as the best, else the
 *      resolution closest to 1 that is (tie: the lower).
 * Returns { row, keep, best, band, reason }. The check on a second run
 * (step 5) is checkOnRun().
 */
export function chooseClustering(rows, current, options = {}) {
  const { flat, minLinked } = { ...CHOICE, ...options };
  const eligible = rows.filter((r) => r.f1 !== null && r.linked >= minLinked);
  if (!eligible.length) return { row: current, keep: true, best: null, band: [], reason: `no setting puts ${minLinked} or more rated pairs together` };
  const bestRow = eligible.reduce((a, r) => (r.f1 > a.f1 ? r : a));
  const band = eligible.filter((r) => notClearlyBelow(r, bestRow, flat));
  if (band.includes(current)) {
    return { row: current, keep: true, best: bestRow.f1, band, reason: `connected components' F1 (${current.f1}) is not clearly below the best (${bestRow.f1}, ${bestRow.setting})` };
  }
  const louvain = band.filter((r) => r.method === "louvain");
  if (!louvain.length) return { row: current, keep: true, best: bestRow.f1, band, reason: "no Louvain setting is as good as the best" };
  const pick = [...louvain].sort((x, y) => Math.abs(x.resolution - 1) - Math.abs(y.resolution - 1) || x.resolution - y.resolution)[0];
  const why = pick.resolution === 1 ? "resolution 1 is as good as the best" : `resolution 1 is not as good as the best; ${pick.resolution} is the closest to it that is`;
  return { row: pick, keep: false, best: bestRow.f1, band, reason: `${why} (best F1 ${bestRow.f1}, ${bestRow.setting}); connected components' F1 (${current.f1}) is clearly below it` };
}

/** Step 5: on another run, the chosen setting's F1 is not clearly below connected components'. */
export function checkOnRun(chosen, current, options = {}) {
  const { flat } = { ...CHOICE, ...options };
  return chosen.f1 !== null && current.f1 !== null && notClearlyBelow(chosen, current, flat);
}

// ---------------------------------------------------------------------------
// Description: sizes, modularity, stability, structure
// ---------------------------------------------------------------------------

const choose2 = (k) => (k * (k - 1)) / 2;

/** Modularity (at resolution 1) of a subject's clusters: Map noteId -> cluster. Null with no links. */
export function modularity(edges, clusterOf) {
  const m = edges.reduce((s, e) => s + e.weight, 0);
  if (!m) return null;
  const inside = new Map();
  const degree = new Map();
  for (const e of edges) {
    const [a, b] = [clusterOf.get(String(e.sourceNoteId)), clusterOf.get(String(e.targetNoteId))];
    if (a === b) inside.set(a, (inside.get(a) || 0) + e.weight);
    degree.set(a, (degree.get(a) || 0) + e.weight);
    degree.set(b, (degree.get(b) || 0) + e.weight);
  }
  let q = 0;
  for (const [c, d] of degree) q += (inside.get(c) || 0) / m - (d / (2 * m)) ** 2;
  return q;
}

/** Share of the pairs of `ids` that are together in one grouping and apart in the other. */
export function pairsMoved(ids, a, b) {
  let moved = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if ((a.get(ids[i]) === a.get(ids[j])) !== (b.get(ids[i]) === b.get(ids[j]))) moved += 1;
    }
  }
  return ids.length > 1 ? moved / choose2(ids.length) : 0;
}

/**
 * Adjusted Rand index between two groupings of `ids` (Maps id -> group): 1 when
 * they agree, about 0 when they agree no more than chance would (exactly 0
 * against a single group). Null when both are one group, or both all apart.
 */
export function adjustedRand(ids, a, b) {
  const cells = new Map();
  const rows = new Map();
  const cols = new Map();
  for (const id of ids) {
    const [x, y] = [a.get(id), b.get(id)];
    const key = `${x}\u0000${y}`;
    cells.set(key, (cells.get(key) || 0) + 1);
    rows.set(x, (rows.get(x) || 0) + 1);
    cols.set(y, (cols.get(y) || 0) + 1);
  }
  const sum = (m) => [...m.values()].reduce((s, k) => s + choose2(k), 0);
  const [index, sa, sb] = [sum(cells), sum(rows), sum(cols)];
  const expected = (sa * sb) / choose2(ids.length);
  const max = (sa + sb) / 2;
  return max === expected ? null : (index - expected) / (max - expected);
}

// The clusters the graph page colours: numbered 1-3 and of two notes or more
// (KnowledgeGraph.jsx, clusterSwatch), as "id:members" strings.
const colouredClusters = (clusterOf) => {
  const members = new Map();
  for (const [id, c] of clusterOf) if (c <= 3) members.set(c, [...(members.get(c) || []), id]);
  return [...members].filter(([, m]) => m.length > 1).map(([c, m]) => `${c}:${m.sort().join(",")}`).sort().join("|");
};

/**
 * One subject under one setting: its clusters and how they behave.
 *   clusters, alone   - clusters of two or more notes, and notes alone
 *   sizes             - the sizes of the clusters of two or more
 *   largest_share     - the largest cluster's share of the subject's notes
 *   together          - pairs of notes in one cluster
 *   modularity        - at resolution 1, whatever the setting
 *   removal           - each link removed in turn: mean and worst share of
 *                       pairs that move between together and apart, and the
 *                       share of removals that change the coloured clusters
 *   reversed          - share of pairs that move when the notes' order is reversed
 *   structure_ari     - adjusted Rand index against the documents' sections
 *                       (file and section group)
 */
export function describeSubject(graph, setting) {
  const ids = graph.notes.map((n) => String(n._id));
  const base = clusterNotes(graph.notes, graph.edges, setting);
  const sizes = base.clusters.filter((c) => c.size > 1).map((c) => c.size);
  const coloured = colouredClusters(base.clusterOf);
  const moves = [];
  let colouredChanged = 0;
  graph.edges.forEach((_, k) => {
    const without = clusterNotes(graph.notes, graph.edges.filter((__, j) => j !== k), setting).clusterOf;
    moves.push(pairsMoved(ids, base.clusterOf, without));
    if (colouredClusters(without) !== coloured) colouredChanged += 1;
  });
  const reversedNotes = graph.notes.map((n, i) => ({ ...n, createdAt: new Date(graph.notes.length - i) }));
  const reversed = clusterNotes(reversedNotes, graph.edges, setting).clusterOf;
  const structure = new Map(graph.notes.map((n) => [String(n._id), `${n.file}#${n.section || ""}`]));
  return {
    subject: graph.subject,
    setting: setting.name,
    notes: ids.length,
    links: graph.edges.length,
    clusters: sizes.length,
    alone: base.clusters.length - sizes.length,
    sizes,
    largest_share: ids.length ? round(Math.max(1, ...sizes) / ids.length) : null,
    together: sizes.reduce((s, k) => s + choose2(k), 0),
    modularity: round(modularity(graph.edges, base.clusterOf)),
    removal: moves.length
      ? { mean: round(moves.reduce((s, x) => s + x, 0) / moves.length), worst: round(Math.max(...moves)), coloured_changed: round(colouredChanged / moves.length) }
      : null,
    reversed: round(pairsMoved(ids, base.clusterOf, reversed)),
    structure_ari: round(adjustedRand(ids, base.clusterOf, structure)),
  };
}

/** Milliseconds per clusterNotes() call on `graph` (median and 95th percentile of `reps`). */
export function timeClustering(graph, setting, reps = 1000) {
  for (let i = 0; i < 50; i++) clusterNotes(graph.notes, graph.edges, setting);
  const times = [];
  for (let i = 0; i < reps; i++) {
    const start = process.hrtime.bigint();
    clusterNotes(graph.notes, graph.edges, setting);
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  times.sort((x, y) => x - y);
  return { median: round(times[Math.floor(reps / 2)], 4), p95: round(times[Math.floor(reps * 0.95)], 4) };
}
