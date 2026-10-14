// The working parts of the link evaluation (evaluation/links.mjs,
// docs/LINK_EVALUATION.md): note files -> every pair of topics scored the way
// the knowledge graph scores it now, which pairs people should rate, their
// answers -> one label per pair, and precision / recall / F1 for any linking
// rule. Pure apart from reading note files, so test/linkEvaluation.test.mjs
// can check every step.

import fs from "node:fs";
import path from "node:path";
import { cosine } from "../../src/services/embeddings.js";
import { decideEdge, decideLink, LINK_RULE, pairFeatures } from "../../src/services/graphEngine.js";
import { embedNoteText } from "../../src/services/noteEmbedding.js";
import { freshTerms } from "../../src/services/relink.js";
import { collectFiles, notesFromFile } from "./ingest.js";
import { cohenKappa, round, shuffled, wilson } from "./stats.js";

// ---------------------------------------------------------------------------
// Notes -> topics -> pairs
// ---------------------------------------------------------------------------

/**
 * The subjects in `folder`. Each subfolder is one subject, its files that
 * subject's uploads; a note file directly in `folder` is a subject of its
 * own. Returns [{ subject, files }], sorted by name.
 */
export function collectSubjects(folder) {
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error(`not a folder: ${folder}`);
  const subjects = [];
  for (const name of fs.readdirSync(folder).sort()) {
    const full = path.join(folder, name);
    if (name.startsWith(".") || !fs.statSync(full).isDirectory()) continue;
    const files = collectFiles([full]);
    if (files.length) subjects.push({ subject: name, files });
  }
  for (const file of collectFiles([folder])) subjects.push({ subject: path.basename(file).replace(/\.[^.]+$/, ""), files: [file] });
  const names = subjects.map((s) => s.subject);
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice) throw new Error(`two subjects are called "${twice}" - rename the file or the folder`);
  return subjects.sort((a, b) => (a.subject < b.subject ? -1 : 1));
}

/**
 * Every topic in `folder`, as the app would hold it after a relink: each file
 * made into notes exactly as an upload would (ingest.js), then every topic's
 * keywords and vector recomputed against the rest of its subject by relink's
 * own freshTerms(), so they do not depend on the order the files were added.
 * Each topic also gets:
 *   id     - T01, T02... in subject, file and section order (raters see it)
 *   ref    - "<subject>/<file>#<n>", the same topic on every run over the
 *            same files (#0 a whole file, #1... its subtopics)
 *   label  - the title a student sees: "Document › Subtopic" for a subtopic
 *   embedding - with an `embedder` (embeddings.js), the topic's meaning as
 *            one vector (noteEmbedding.js), for runs on sentence-embedding
 *            similarity
 * Files that cannot be read are skipped and listed in `problems`.
 */
export async function loadTopics(folder, { embedder = null } = {}) {
  const subjects = collectSubjects(folder);
  if (!subjects.length) throw new Error(`no note files in ${folder} - put each subject's files in a subfolder named after it`);
  const notes = [];
  const problems = [];
  const summary = [];
  for (const [si, { subject, files }] of subjects.entries()) {
    const before = notes.length;
    for (const [fi, file] of files.entries()) {
      const name = path.basename(file);
      try {
        const doc = await notesFromFile(file, { idPrefix: `s${si}f${fi}` });
        for (const n of doc.notes) {
          notes.push({ ...n, subjectId: subject, file: name, ref: `${subject}/${name}#${String(n._id).split("-").pop()}`, label: n.topicLabel || n.title });
        }
      } catch (err) {
        problems.push(`${subject}/${name}: ${err.message}`);
      }
    }
    summary.push({ subject, files: files.map((f) => path.basename(f)), topics: notes.length - before });
  }
  const terms = freshTerms(notes);
  const width = Math.max(2, String(notes.length).length);
  const topics = notes.map((n, i) => ({
    _id: n._id,
    id: `T${String(i + 1).padStart(width, "0")}`,
    ref: n.ref,
    subjectId: n.subjectId,
    file: n.file,
    label: n.label,
    text: n.rawText || "",
    ...terms.get(String(n._id)),
  }));
  if (embedder) for (const t of topics) t.embedding = await embedNoteText(t.text, embedder);
  return { subjects: summary, topics, problems };
}

/**
 * A pair's features for a run on `measure`: graphEngine's pairFeatures
 * (weight, sharedKeywords, sameSubject), with `weight` the similarity the run
 * measures - TF-IDF, or the cosine of the topics' sentence embeddings - and
 * the TF-IDF similarity always kept as `tfidfWeight`, because today's rule
 * needs it (todaysEdge).
 */
export function pairFeaturesBy(a, b, measure = "tfidf") {
  const features = pairFeatures(a, b);
  if (measure === "tfidf") return { ...features, tfidfWeight: features.weight };
  if (measure !== "embedding") throw new Error(`unknown similarity "${measure}"`);
  if (!a.embedding || !b.embedding) throw new Error("topics have no embeddings - load them with an embedder");
  return { ...features, tfidfWeight: features.weight, weight: cosine(a.embedding, b.embedding) };
}

/**
 * What the graph decides today for a pair, from its features in a run on
 * `measure`: graphEngine's decideLink on its TF-IDF similarity, with its
 * embedding similarity as `meaning` when the run measured that - so across
 * subjects, the rule by meaning that the graph uses wherever both notes have
 * an embedding. A run on TF-IDF measures the graph without the model.
 */
export function todaysEdge(it, measure = "tfidf") {
  return decideLink({
    weight: it.tfidfWeight ?? it.weight,
    sharedKeywords: it.sharedKeywords,
    sameSubject: it.sameSubject,
    meaning: measure === "embedding" ? it.weight : null,
  });
}

/**
 * Every pair of `topics`, with what the linking rule looks at
 * (pairFeaturesBy) and what it decides now (`current`: an edge type or null,
 * by today's rule). `a` and `b` index into `topics`.
 */
export function scorePairs(topics, { measure = "tfidf" } = {}) {
  const pairs = [];
  for (let i = 0; i < topics.length; i++) {
    for (let j = i + 1; j < topics.length; j++) {
      const features = pairFeaturesBy(topics[i], topics[j], measure);
      pairs.push({ a: i, b: j, ...features, current: todaysEdge(features, measure) });
    }
  }
  return pairs;
}

export const isLink = (edgeType) => edgeType === "same-subject" || edgeType === "cross-subject";

/**
 * An earlier run's rated pairs (its key.csv rows), scored again on `topics`:
 * the same notes read with the current code (loadTopics). This is how a
 * change to the keywords is measured on ratings that already exist - the
 * labels are about the notes, not the keywords, so they still apply. Each
 * pair is found again by its topics' refs ("<subject>/<file>#<n>"), so T
 * numbers and file order play no part. Returns:
 *   key           - the pairs found, as scoring reads them: the run's stratum,
 *                   so the sampling weights stay as generated, with the
 *                   features worked out now (pairFeatures) and today's decision
 *   unmatched     - [{ pair, reason }]: a topic no longer exists, or the two
 *                   topics are no longer in the same (or different) subjects
 *   largestChange - the largest change in similarity from key.csv. The
 *                   keywords play no part in it, so anything above rounding
 *                   means the notes or the vector are not what was rated.
 */
export function rescorePairs(keyRows, topics, { measure = "tfidf" } = {}) {
  const byRef = new Map(topics.map((t) => [t.ref, t]));
  const key = [];
  const unmatched = [];
  let largestChange = 0;
  for (const row of keyRows) {
    const [a, b] = [byRef.get(row.ref_a), byRef.get(row.ref_b)];
    if (!a || !b) {
      const gone = [!a && row.ref_a, !b && row.ref_b].filter(Boolean);
      unmatched.push({ pair: row.pair, reason: `no topic ${gone.join(" or ")} in the notes now` });
      continue;
    }
    const features = pairFeaturesBy(a, b, measure);
    if (features.sameSubject !== (row.same_subject === "yes")) {
      unmatched.push({ pair: row.pair, reason: `${row.ref_a} and ${row.ref_b} are no longer ${features.sameSubject ? "in different subjects" : "in the same subject"}` });
      continue;
    }
    largestChange = Math.max(largestChange, Math.abs(features.weight - Number(row.similarity)));
    key.push({ pair: row.pair, stratum: row.stratum, ...features, current: todaysEdge(features, measure) });
  }
  return { key, unmatched, largestChange };
}

// ---------------------------------------------------------------------------
// Which pairs to rate
// ---------------------------------------------------------------------------

// Most pairs in a subject have nothing to do with each other and score near
// zero, so a random sample would be almost all easy "no"s and say little
// about where the threshold belongs. Same-subject pairs are therefore taken
// in similarity bins, the same number from each bin across the range the
// threshold could sensibly move in (0.05-0.30), plus samples below and above
// it so recall counts related pairs that score low.
const SAME_EDGES = [0.05, 0.075, 0.1, 0.125, 0.15, 0.175, 0.2, 0.225, 0.25, 0.275, 0.3];
// Cross-subject pairs that share a keyword are the ones the cross-subject
// rule decides between, so all of them are rated. Only past `crossCap` are
// they sampled, evenly across these bins of shared keywords and similarity.
const CROSS_EDGES = [0.1, 0.15, 0.2, 0.25, 0.3, 0.4];
// Cross-subject pairs sharing no keyword are never linked, whatever the
// thresholds; a few are rated to see whether the keyword requirement itself
// misses real links (two notes that say "cell" and "cells", say).
const NONE_EDGES = [0.05];

const binOf = (x, edges) => {
  if (x < edges[0]) return `<${edges[0].toFixed(3)}`;
  for (let i = 1; i < edges.length; i++) if (x < edges[i]) return `${edges[i - 1].toFixed(3)}-${edges[i].toFixed(3)}`;
  return `>=${edges.at(-1).toFixed(3)}`;
};
const binsOf = (edges) => [`<${edges[0].toFixed(3)}`, ...edges.slice(1).map((e, i) => `${edges[i].toFixed(3)}-${e.toFixed(3)}`), `>=${edges.at(-1).toFixed(3)}`];
const sharedBand = (n) => (n >= 3 ? "3+" : String(n));

// Sentence-embedding similarity runs on another scale: on the link
// evaluation's notes, same-subject pairs mostly score 0.3-0.7 and
// cross-subject ones below 0.5, with a few to 0.8. A pair sharing no word
// can still be close in meaning, so for this measure the cross-subject pairs
// sharing none are binned as finely as the others.
const STRATA_EDGES = Object.freeze({
  tfidf: { same: SAME_EDGES, cross: CROSS_EDGES, none: NONE_EDGES },
  embedding: {
    same: [0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75],
    cross: [0.4, 0.5, 0.55, 0.6, 0.65, 0.7],
    none: [0.4, 0.5, 0.55, 0.6, 0.65, 0.7],
  },
});
const edgesOf = (measure) => {
  if (!STRATA_EDGES[measure]) throw new Error(`unknown similarity "${measure}"`);
  return STRATA_EDGES[measure];
};

/** The stratum a pair is sampled from: "same 0.100-0.125", "cross 2 shared 0.250-0.300", "cross 0 shared <0.050". */
export function stratumOf(pair, measure = "tfidf") {
  const edges = edgesOf(measure);
  if (pair.sameSubject) return `same ${binOf(pair.weight, edges.same)}`;
  const shared = pair.sharedKeywords.length;
  if (!shared) return `cross 0 shared ${binOf(pair.weight, edges.none)}`;
  return `cross ${sharedBand(shared)} shared ${binOf(pair.weight, edges.cross)}`;
}

/** Every stratum, in the order they are sampled and reported, with its sampling group. */
export function allStrata(measure = "tfidf") {
  const edges = edgesOf(measure);
  return [
    ...binsOf(edges.same).map((bin) => ({ id: `same ${bin}`, group: "same" })),
    ...["1", "2", "3+"].flatMap((k) => binsOf(edges.cross).map((bin) => ({ id: `cross ${k} shared ${bin}`, group: "cross-shared" }))),
    ...binsOf(edges.none).map((bin) => ({ id: `cross 0 shared ${bin}`, group: "cross-none" })),
  ];
}

/**
 * How many to take from groups of these sizes so the total is at most
 * `budget` and as even as possible: each group gets min(size, c) for the
 * largest c that fits, and what is left goes one each to the largest groups.
 * Everything, if it all fits.
 */
export function waterFill(sizes, budget) {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= budget) return [...sizes];
  let c = 0;
  while (sizes.reduce((a, n) => a + Math.min(n, c + 1), 0) <= budget) c += 1;
  const take = sizes.map((n) => Math.min(n, c));
  let left = budget - take.reduce((a, b) => a + b, 0);
  const larger = sizes.map((_, i) => i).filter((i) => sizes[i] > c).sort((x, y) => sizes[y] - sizes[x] || x - y);
  for (const i of larger) {
    if (left <= 0) break;
    take[i] += 1;
    left -= 1;
  }
  return take;
}

export const SAMPLING = Object.freeze({ perBin: 10, crossCap: 150, zeroShared: 20, practice: 10 });

/**
 * Which pairs to rate, binned by the similarity `options.measure` ("tfidf",
 * the default, or "embedding"; the pairs' `weight` is that similarity). Every
 * random choice comes from `random`, in a fixed order, so a seed always gives
 * the same pairs. Returns:
 *   strata   - [{ id, group, size, take }] in allStrata() order. `size` is
 *              how many pairs the stratum has; it weights the stratum's
 *              ratings when scoring (stratumWeights)
 *   sample   - the chosen pairs, each with .stratum
 *   practice - pairs for the raters' practice round, none of them in `sample`
 */
export function choosePairs(pairs, options, random) {
  const o = { ...SAMPLING, measure: "tfidf", ...options };
  const members = new Map(allStrata(o.measure).map((s) => [s.id, []]));
  for (const p of pairs) members.get(stratumOf(p, o.measure)).push(p);
  const strata = allStrata(o.measure).map((s) => ({ ...s, size: members.get(s.id).length, take: 0 }));

  // the lowest bin holds most pairs, and most of the related ones recall
  // could miss, so it gets half as many again
  const lowest = `same <${edgesOf(o.measure).same[0].toFixed(3)}`;
  for (const s of strata.filter((x) => x.group === "same")) s.take = Math.min(s.size, s.id === lowest ? Math.round(o.perBin * 1.5) : o.perBin);
  for (const [group, budget] of [["cross-shared", o.crossCap], ["cross-none", o.zeroShared]]) {
    const inGroup = strata.filter((s) => s.group === group);
    waterFill(inGroup.map((s) => s.size), budget).forEach((take, i) => (inGroup[i].take = take));
  }

  const sample = [];
  const leftOver = [];
  for (const s of strata) {
    const mixed = shuffled(members.get(s.id), random);
    sample.push(...mixed.slice(0, s.take).map((p) => ({ ...p, stratum: s.id })));
    if (mixed.length > s.take) leftOver.push(mixed.slice(s.take).map((p) => ({ ...p, stratum: s.id })));
  }
  // practice pairs: one from each of several strata in turn, so the round
  // meets easy and hard pairs alike
  const practice = [];
  const queues = shuffled(leftOver, random);
  while (practice.length < o.practice && queues.some((q) => q.length)) {
    for (const q of queues) if (q.length && practice.length < o.practice) practice.push(q.shift());
  }
  return { strata, sample, practice };
}

/** The opening of a topic's text, about `max` characters, ended at a sentence when one ends late enough. */
export function excerpt(text, max = 350) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  if (sentence >= max / 2) return `${cut.slice(0, sentence + 1)} …`;
  const space = cut.lastIndexOf(" ");
  return `${cut.slice(0, space > 0 ? space : max)} …`;
}

// ---------------------------------------------------------------------------
// Raters' answers -> labels
// ---------------------------------------------------------------------------

const YES = /^(y|yes|1|true|t|related)$/i;
const NO = /^(n|no|0|false|f|not related|unrelated)$/i;
const UNSURE = /^(u|unsure|\?|not sure|maybe|don't know|dont know)$/i;

/** One `related` cell -> "yes", "no" or "unsure"; null if empty; undefined if it is not an answer. */
export function readRelated(raw) {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  return YES.test(v) ? "yes" : NO.test(v) ? "no" : UNSURE.test(v) ? "unsure" : undefined;
}

/**
 * One label per pair from all raters' answers (Map pairId -> [answers]).
 * Related (1) when more raters said yes than no; not related (0) otherwise,
 * so a tie counts as not related - as score.mjs counts it, and it leans the
 * choice of threshold towards precision. "unsure" is no vote. A pair nobody
 * answered yes or no has no label (null) and is left out of the estimates.
 * Returns Map pairId -> { label, yes, no, unsure }.
 */
export function pairLabels(answers) {
  const out = new Map();
  for (const [id, list] of answers) {
    const count = (a) => list.filter((x) => x === a).length;
    const yes = count("yes");
    const no = count("no");
    out.set(id, { label: yes + no ? (yes > no ? 1 : 0) : null, yes, no, unsure: count("unsure") });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Precision, recall and F1 of a rule
// ---------------------------------------------------------------------------

/**
 * The weight of each labelled pair: how many pairs of its stratum it stands
 * for (the stratum's size over its labelled pairs). Rating pairs near the
 * thresholds more densely than the rest is what makes the sample useful;
 * the weights undo it, so the estimates are for all pairs, not for the
 * sample. Unweighted, recall would come out too high: most related pairs that
 * score low are in the big low-similarity strata, where few pairs are rated.
 * `strata` are generation's [{ id, size }]. Returns { weightOf: Map stratum
 * -> sample weight, unrepresented: strata with pairs but no labelled pair, whose
 * pairs the estimates therefore leave out }.
 */
export function stratumWeights(labelled, strata) {
  const counts = new Map();
  for (const item of labelled) counts.set(item.stratum, (counts.get(item.stratum) || 0) + 1);
  const weightOf = new Map();
  const unrepresented = [];
  for (const s of strata) {
    if (!s.size) continue;
    if (counts.get(s.id)) weightOf.set(s.id, s.size / counts.get(s.id));
    else unrepresented.push(s.id);
  }
  return { weightOf, unrepresented };
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
// Kish's effective sample size: how many equally weighted pairs would be as
// informative as these weighted ones. Used to give weighted shares a Wilson
// interval.
const effectiveN = (ws) => {
  const sq = sum(ws.map((w) => w * w));
  return sq ? sum(ws) ** 2 / sq : 0;
};
const weightedWilson = (share, ws) => {
  if (share === null) return null;
  const n = effectiveN(ws);
  return wilson(share * n, n);
};

/**
 * Precision, recall and F1 of `rule` on labelled pairs: each has the pair's
 * features (as pairFeatures returns them, so `weight` is its similarity),
 * .label (0/1) and .sampleWeight (stratumWeights). A pair counts as linked when the rule makes it a
 * same-subject or cross-subject link; "rejected" is not a link. Shares are
 * weighted (stratumWeights) and their intervals are 95% Wilson on the
 * effective sample size. Counts (`linked`, `related`, `linked_related`) are
 * of rated pairs, unweighted. F1 = 2TP / (linked + related), so it is 0 when
 * nothing is linked, and null when no pair is related.
 */
export function ruleMetrics(items, rule, decide = (it) => decideEdge(it, rule)) {
  let tp = 0;
  let pp = 0;
  let rel = 0;
  let linkedRelated = 0;
  const linkedW = [];
  const relatedW = [];
  for (const it of items) {
    const linked = isLink(decide(it));
    if (linked) {
      pp += it.sampleWeight;
      linkedW.push(it.sampleWeight);
    }
    if (it.label) {
      rel += it.sampleWeight;
      relatedW.push(it.sampleWeight);
    }
    if (linked && it.label) {
      tp += it.sampleWeight;
      linkedRelated += 1;
    }
  }
  const precision = pp ? tp / pp : null;
  const recall = rel ? tp / rel : null;
  return {
    linked: linkedW.length,
    related: relatedW.length,
    linked_related: linkedRelated,
    precision: round(precision),
    precision_ci: weightedWilson(precision, linkedW),
    recall: round(recall),
    recall_ci: weightedWilson(recall, relatedW),
    f1: rel ? round((2 * tp) / (pp + rel)) : null,
  };
}

/**
 * Resamples for F1's interval - F1 is not a proportion, so it has no Wilson
 * interval. Each draw picks every stratum's labelled pairs again, with
 * replacement, and keeps the stratum's weight. Drawn once and reused for
 * every rule, so rules are compared on the same draws. Returns arrays of
 * indices into `items`.
 */
export function bootstrapDraws(items, random, reps = 1000) {
  const byStratum = new Map();
  items.forEach((it, i) => {
    if (!byStratum.has(it.stratum)) byStratum.set(it.stratum, []);
    byStratum.get(it.stratum).push(i);
  });
  const groups = [...byStratum.values()];
  return Array.from({ length: reps }, () => groups.flatMap((g) => g.map(() => g[Math.floor(random() * g.length)])));
}

/**
 * `rule`'s F1 in each bootstrap draw (`draws`, aligned with them; null where a
 * draw has no related pair) and their 95% percentile interval (`ci`, null
 * when too few draws have a related pair).
 */
export function f1Bootstrap(items, draws, rule, decide = (it) => decideEdge(it, rule)) {
  const linked = items.map((it) => isLink(decide(it)));
  const f1s = draws.map((draw) => {
    let tp = 0;
    let pp = 0;
    let rel = 0;
    for (const i of draw) {
      const w = items[i].sampleWeight;
      if (linked[i]) pp += w;
      if (items[i].label) rel += w;
      if (linked[i] && items[i].label) tp += w;
    }
    return rel ? (2 * tp) / (pp + rel) : null;
  });
  const valid = f1s.filter((x) => x !== null).sort((x, y) => x - y);
  if (valid.length < draws.length / 2) return { ci: null, draws: f1s };
  const at = (q) => valid[Math.min(valid.length - 1, Math.floor(q * valid.length))];
  return { ci: [round(at(0.025)), round(at(0.975))], draws: f1s };
}

// thresholds 0.01 apart, as exact two-place numbers
const steps = (from, to) => Array.from({ length: Math.round((to - from) * 100) + 1 }, (_, i) => round(from + i / 100, 2));
export const GRID = Object.freeze({ same: steps(0.05, 0.3), cross: steps(0.15, 0.4), minShared: [1, 2, 3] });
// For sentence-embedding similarity: its own range, and across subjects also
// no shared word at all, since meaning can link two notes without one.
export const EMBEDDING_GRID = Object.freeze({ same: steps(0.3, 0.8), cross: steps(0.4, 0.8), minShared: [0, 1, 2, 3] });
export const gridFor = (measure = "tfidf") => (measure === "embedding" ? EMBEDDING_GRID : GRID);

/**
 * Every setting of the grid, scored. Same-subject decisions depend only on
 * the same-subject threshold, and cross-subject ones only on the
 * cross-subject threshold and the number of shared keywords, so the two are
 * searched separately: `same` varies `similarity`, `cross` varies
 * `crossSimilarity` x `crossMinShared`, each on its own group of pairs.
 * `population` is every pair (scorePairs), for `links`: how many links the
 * setting makes across all the notes, exactly rather than estimated.
 * `grid` is GRID, or EMBEDDING_GRID for a run on embedding similarity. The
 * current setting is scored by `today` (the graph's own decision, todaysEdge),
 * so a setting on another similarity is compared with what the graph does
 * now, on the same draws; `current` gives its rows' thresholds.
 * Returns { same: rows, cross: rows, current: { same, cross } }; each row
 * also carries its F1 in every bootstrap draw (`f1Draws`, not enumerable).
 */
export function gridSearch({ items, population, draws, current = LINK_RULE, grid = GRID, today = (it) => todaysEdge(it) }) {
  const sameItems = items.filter((it) => it.sameSubject);
  const crossItems = items.filter((it) => !it.sameSubject);
  const samePop = population.filter((p) => p.sameSubject);
  const crossPop = population.filter((p) => !p.sameSubject);
  // draws index into `items`; each group's interval only counts its own pairs
  const remap = (group) => {
    const at = new Map(items.map((it, i) => [it, i]));
    const index = new Map(group.map((it, j) => [at.get(it), j]));
    return draws.map((d) => d.filter((i) => index.has(i)).map((i) => index.get(i)));
  };
  const sameDraws = remap(sameItems);
  const crossDraws = remap(crossItems);
  const row = (group, groupDraws, pop, rule, decide = (it) => decideEdge(it, rule)) => {
    const spread = f1Bootstrap(group, groupDraws, rule, decide);
    const out = {
      similarity: rule.similarity,
      crossSimilarity: rule.crossSimilarity,
      crossMinShared: rule.crossMinShared,
      links: pop.filter((p) => isLink(decide(p))).length,
      ...ruleMetrics(group, rule, decide),
      f1_ci: spread.ci,
    };
    // for chooseSetting's paired comparison; kept out of results.json
    Object.defineProperty(out, "f1Draws", { value: spread.draws, enumerable: false });
    return out;
  };
  return {
    same: grid.same.map((t) => row(sameItems, sameDraws, samePop, { ...current, similarity: t })),
    cross: grid.minShared.flatMap((k) => grid.cross.map((t) => row(crossItems, crossDraws, crossPop, { ...current, crossSimilarity: t, crossMinShared: k }))),
    current: { same: row(sameItems, sameDraws, samePop, current, today), cross: row(crossItems, crossDraws, crossPop, current, today) },
  };
}

export const CHOICE = Object.freeze({ flat: 0.02, minLinked: 10, minPrecision: 0.5 });

/**
 * The setting to recommend from one group's grid rows:
 *   1. Only settings that link at least `minLinked` rated pairs count: a
 *      precision resting on fewer means little.
 *   2. "As good as the best": settings whose F1 is not clearly below the best
 *      one's. With the rows' bootstrap draws (gridSearch), clearly below means
 *      that across the same resamples the setting's F1 minus the best's stays
 *      under -`flat` at the 97.5th percentile - a real difference, not noise.
 *      Paired, because every setting is scored on the same pairs. Rows
 *      without draws fall back to "more than `flat` below the best".
 *   3. If the current setting is as good as the best, it is kept.
 *   4. Otherwise the most precise of them, because a wrong link costs a
 *      student more than a missing one (ties: higher F1, then the stricter
 *      setting) - but only one with precision of at least `minPrecision`, so
 *      the links a change adds are right more often than wrong. If none is,
 *      the current setting is kept.
 * Returns { row, keep, best, band, reason }; row is null when nothing qualifies.
 */
export function chooseSetting(rows, currentRow, options = {}) {
  const { flat, minLinked, minPrecision } = { ...CHOICE, ...options };
  const eligible = rows.filter((r) => r.f1 !== null && r.linked >= minLinked);
  if (!eligible.length) {
    const reason = rows.some((r) => r.related) ? `no setting links ${minLinked} or more rated pairs` : "no rated pair in this group is related";
    return { row: null, keep: true, best: null, band: [], reason };
  }
  const bestRow = eligible.reduce((a, r) => (r.f1 > a.f1 ? r : a));
  const best = bestRow.f1;
  const asGood = (r) => {
    if (!r || r.f1 === null || r.linked < minLinked) return false;
    if (r.f1Draws && bestRow.f1Draws) {
      const diffs = r.f1Draws
        .map((x, i) => (x === null || bestRow.f1Draws[i] === null ? null : x - bestRow.f1Draws[i]))
        .filter((d) => d !== null)
        .sort((x, y) => x - y);
      if (diffs.length) return diffs[Math.min(diffs.length - 1, Math.floor(0.975 * diffs.length))] >= -flat - 1e-9;
    }
    return r.f1 >= best - flat - 1e-9;
  };
  const band = eligible.filter(asGood);
  if (asGood(currentRow)) {
    return { row: currentRow, keep: true, best, band, reason: `the current setting's F1 (${currentRow.f1}) is not clearly below the best (${best})` };
  }
  const acceptable = band.filter((r) => r.precision >= minPrecision);
  if (!acceptable.length) {
    const reason = `none of the ${band.length} setting(s) as good as the best F1 (${best}) has precision of ${minPrecision} or more, so their links would be wrong more often than right`;
    return { row: currentRow ?? null, keep: true, best, band, reason };
  }
  const strictness = (r) => [r.similarity, r.crossSimilarity, r.crossMinShared];
  const pick = [...acceptable].sort((x, y) => {
    if (y.precision !== x.precision) return y.precision - x.precision;
    if (y.f1 !== x.f1) return y.f1 - x.f1;
    const [sx, sy] = [strictness(x), strictness(y)];
    for (let i = 0; i < sx.length; i++) if (sy[i] !== sx[i]) return sy[i] - sx[i];
    return 0;
  })[0];
  const why = band.length > 1 ? `highest precision of the ${band.length} settings whose F1 is not clearly below the best (${best})` : `best F1 (${best})`;
  const current = currentRow?.linked >= minLinked ? `; the current setting's F1 (${currentRow.f1}) is clearly below it` : "; the current setting links too few rated pairs to judge";
  return { row: pick, keep: false, best, band, reason: why + current };
}

// ---------------------------------------------------------------------------
// Agreement between raters
// ---------------------------------------------------------------------------

/**
 * For every pair of raters: over the pairs both answered yes or no, the share
 * of identical answers and Cohen's kappa, for all pairs and for same- and
 * cross-subject pairs apart. `answers` is Map pairId -> [answer per rater];
 * `sameSubjectOf` is pairId -> boolean.
 */
export function raterAgreement(raters, answers, sameSubjectOf) {
  const rows = [];
  for (let x = 0; x < raters.length; x++) {
    for (let y = x + 1; y < raters.length; y++) {
      for (const group of ["all", "same", "cross"]) {
        const a = [];
        const b = [];
        for (const [id, list] of answers) {
          if (group !== "all" && sameSubjectOf(id) !== (group === "same")) continue;
          const [ax, by] = [list[x], list[y]];
          if ((ax === "yes" || ax === "no") && (by === "yes" || by === "no")) {
            a.push(ax);
            b.push(by);
          }
        }
        const same = a.filter((v, i) => v === b[i]).length;
        rows.push({ raters: [raters[x], raters[y]], group, n: a.length, same: a.length ? round(same / a.length) : null, kappa: cohenKappa(a, b) });
      }
    }
  }
  return rows;
}
