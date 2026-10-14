import { upsertEdge } from "../models/GraphEdge.js";
import { cosine, getEmbedder } from "./embeddings.js";
import { withEmbeddings } from "./noteEmbedding.js";
import { cosineSimilarity, sameWord } from "./tfidf.js";

// Below this similarity score, two notes in the same subject are considered
// unrelated and no edge is drawn - mirrors "Similarity scoring within
// subject folder" in Diagram 2 of the architecture doc.
// Set by the link evaluation (docs/LINK_EVALUATION.md, 14 Oct 2026): 117
// topics from real notes in 5 subjects, 123 same-subject pairs rated
// related / not related without seeing scores. 0.12, set on sample notes,
// found only about a third of the related pairs (recall 34%, precision 62%,
// F1 0.44). At 0.11 recall is 46% and precision 65% (F1 0.54); the gain over
// 0.12 held across resamples (+0.10 F1, 95% interval +0.02 to +0.17).
// Lower thresholds scored as well on F1 but no more precisely, so the most
// precise of them was taken. One rater (an AI, blind to the scores) - see
// the document for that limit.
export const SIMILARITY_THRESHOLD = 0.11;

// Cross-subject pairs have to clear a stricter bar, because a word shared
// across subjects is often the same spelling with a different meaning: "cell"
// in Biology, Chemistry (electrochemical cell) and Computer Networks (ATM
// cell), or "nucleus" in Biology and Chemistry. A pair is linked across
// subjects only when BOTH hold:
//   - at least CROSS_SUBJECT_MIN_SHARED of their top-12 TF-IDF terms match
//     (linkTerms below),
//   - and their cosine similarity is at least CROSS_SUBJECT_THRESHOLD.
// CONTRIBUTING.md first proposed "at least one shared keyword"; on real notes
// that still linked Biology "Cell structure" to Chemistry "Electrochemical
// cells" (similarity 0.252, sharing only "cell"), because one word repeated
// often enough in both notes can lift the similarity past 0.25 on its own.
// Notes that are genuinely about the same thing share several key terms
// (Osmosis <-> Diffusion shared six), so requiring two is what separates a
// real overlap from one ambiguous word.
// The link evaluation (14 Oct 2026, 170 cross-subject pairs rated) kept both
// numbers: every looser setting that linked 10 or more rated pairs was right
// only 30-40% of the time, so loosening would add more wrong links than
// right ones. Pairs sharing only "class" (IPv4 address classes, class-
// imbalanced datasets) are typical. Better cross-subject links need a better
// signal, not a lower bar. TextRank keywords were tried as that signal and
// were not one (see linkTerms below); a word's meaning, from sentence
// embeddings, is the next thing to try (CONTRIBUTING.md, Member 2, item 5).
export const CROSS_SUBJECT_THRESHOLD = 0.25;
export const CROSS_SUBJECT_MIN_SHARED = 2;

// Across subjects, when both notes have a sentence embedding (the optional
// MiniLM model, services/noteEmbedding.js), the pair is linked by meaning
// instead: embedding similarity of at least CROSS_SUBJECT_MEANING_THRESHOLD
// and at least CROSS_SUBJECT_MEANING_MIN_SHARED shared top TF-IDF term.
// Set by the link evaluation's run 2 (docs/LINK_EVALUATION.md, "Sentence
// embeddings"; 14 Oct 2026): 153 new pairs sampled by embedding similarity
// and rated blind, with the decision rule written down before rating. The
// TF-IDF rule found 8% of the related cross-subject pairs (F1 0.15); this
// setting finds 29% at 58% precision (95% interval 29-82%; F1 0.39), a gain
// that held across resamples (+0.02 to +0.50). On run 1's ratings the same
// setting was right 48% of the time, so expect about half of these links to
// be right: data pre-processing in DEDV and in ML is what the subjects truly
// share; Decision trees <-> Data reduction is a typical wrong one. Same-
// subject links stay on TF-IDF: embeddings were not clearly better there in
// either run. Without the model, or for a note saved without it, the TF-IDF
// rule above applies.
export const CROSS_SUBJECT_MEANING_THRESHOLD = 0.68;
export const CROSS_SUBJECT_MEANING_MIN_SHARED = 1;

// The numbers above as one rule, the form decideEdge() and decideLink() take.
export const LINK_RULE = Object.freeze({
  similarity: SIMILARITY_THRESHOLD,
  crossSimilarity: CROSS_SUBJECT_THRESHOLD,
  crossMinShared: CROSS_SUBJECT_MIN_SHARED,
  crossMeaning: CROSS_SUBJECT_MEANING_THRESHOLD,
  crossMeaningMinShared: CROSS_SUBJECT_MEANING_MIN_SHARED,
});

// The words linking compares: a note's 12 highest TF-IDF terms, read from
// its vector - what its stored keywords were until Oct 2026. Keywords now
// count a word's singular and plural as one and leave out numbers
// (tfidf.js). Linking on them, the link evaluation's rated pairs were all
// decided as before but one, while 18 more cross-subject pairs shared two
// words (docs/LINK_EVALUATION.md, "Keywords and TextRank"); with nothing
// gained, links stay exactly as they were. TextRank keywords were tried for
// linking too, and were worse: of the 12 rated cross-subject pairs that are
// related, 5 share two or more TF-IDF terms, and only 1-2 shared two TextRank
// keywords (weighted by IDF, whatever the window), because TextRank demotes
// the words two subjects genuinely share - "data", "missing", "outliers".
const LINK_TERMS = 12;
const linkTermsOf = new WeakMap(); // vector -> its terms, worked out once

/**
 * A note's top TF-IDF terms, highest first (ties in the vector's own order),
 * as computeTfidf ranked its keywords until Oct 2026.
 */
export function linkTerms(note) {
  const vector = note.vector || {};
  if (linkTermsOf.has(vector)) return linkTermsOf.get(vector);
  const terms = Object.entries(vector)
    .sort((a, b) => b[1] - a[1])
    .slice(0, LINK_TERMS)
    .map(([term]) => term);
  linkTermsOf.set(vector, terms);
  return terms;
}

/**
 * What the linking rule looks at for two notes: their similarity, the top
 * TF-IDF terms they share (linkTerms), whether they are in the same subject,
 * and `meaning` - the similarity of their sentence embeddings, when both
 * have one from the same model (noteEmbedding.js, withEmbeddings), else
 * null. `sharedKeywords` keeps its name: edges store it, and the graph page
 * shows it as what two notes have in common.
 */
export function pairFeatures(a, b) {
  const termsOfB = linkTerms(b);
  return {
    weight: cosineSimilarity(a.vector, b.vector),
    sharedKeywords: linkTerms(a).filter((k) => termsOfB.includes(k)),
    sameSubject: String(a.subjectId) === String(b.subjectId),
    meaning: a.embedding && b.embedding && a.embeddingModel === b.embeddingModel ? cosine(a.embedding, b.embedding) : null,
  };
}

/**
 * The edge type for a pair's features under `rule`, or null for "no edge":
 *   "same-subject"  - same subject, similarity >= rule.similarity
 *   "cross-subject" - different subjects, passes the stricter rule above
 *   "rejected"      - different subjects, shares a keyword and would have
 *                     been linked under the same-subject rule, but fails the
 *                     stricter one: the ambiguous case. Stored rather than
 *                     dropped so the graph can show that the pair was
 *                     considered and turned down.
 * Kept apart from pairFeatures() so the link evaluation
 * (evaluation/links.mjs) can try other thresholds on the same pairs with
 * exactly this code: it reads only `weight`, so the evaluation can put
 * another similarity there.
 */
export function decideEdge({ weight, sharedKeywords, sameSubject }, rule = LINK_RULE) {
  if (sameSubject) return weight >= rule.similarity ? "same-subject" : null;
  if (sharedKeywords.length >= rule.crossMinShared && weight >= rule.crossSimilarity) return "cross-subject";
  if (sharedKeywords.length > 0 && weight >= rule.similarity) return "rejected";
  return null;
}

/**
 * The edge the graph draws for a pair's features (pairFeatures): decideEdge,
 * except that a cross-subject pair whose notes both have an embedding is
 * linked by meaning - `meaning` of at least rule.crossMeaning and at least
 * rule.crossMeaningMinShared shared terms - in place of the TF-IDF test. A
 * pair it does not link is still "rejected" when it shares a term and its
 * TF-IDF similarity would have linked it within a subject, as before.
 */
export function decideLink(features, rule = LINK_RULE) {
  const { meaning, sameSubject, sharedKeywords, weight } = features;
  if (sameSubject || meaning === null || meaning === undefined) return decideEdge(features, rule);
  if (sharedKeywords.length >= rule.crossMeaningMinShared && meaning >= rule.crossMeaning) return "cross-subject";
  return sharedKeywords.length > 0 && weight >= rule.similarity ? "rejected" : null;
}

/**
 * Decide what edge, if any, belongs between two notes under the current
 * rule. Pure - no database - so the linking rules can be unit tested on
 * their own. Returns { edgeType, weight, sharedKeywords, meaning }, or null;
 * `meaning` is the embedding similarity of a cross-subject pair that has
 * one, else null.
 */
export function classifyPair(a, b) {
  const features = pairFeatures(a, b);
  const edgeType = decideLink(features);
  if (!edgeType) return null;
  // recorded only where it decides anything: across subjects
  const meaning = features.sameSubject || features.meaning === null ? null : Number(features.meaning.toFixed(4));
  return { edgeType, weight: Number(features.weight.toFixed(4)), sharedKeywords: features.sharedKeywords, meaning };
}

// How finely Louvain divides a subject (clusterNotes): the "resolution" of
// modularity. Higher makes more, smaller clusters; 1 is the standard
// definition, and was kept as such rather than tuned.
// Set by the cluster evaluation (docs/LINK_EVALUATION.md, "Clusters"; 14 Oct
// 2026), on the link evaluation's rated same-subject pairs read as "should
// these two share a cluster?", with the decision rule written down before
// the first run. Connected components, as before, put 32 of DEDV's 32
// topics and 51 of ML's 54 in one cluster: F1 0.32 (precision 20%). Louvain
// at resolution 1 makes 4 clusters in DEDV and 8 in ML: F1 0.55 (precision
// 73%), a gain that held across resamples (+0.03 to +0.44) and on the second
// run's pairs and rater (+0.04 to +0.52). Resolutions 0.75-3 scored about as
// well; part of 1's lead on the first run rests on four pairs.
export const CLUSTER_RESOLUTION = 1;

const time = (n) => new Date(n.createdAt || 0).getTime();
const older = (a, b) => time(a) - time(b) || (String(a._id) < String(b._id) ? -1 : String(a._id) > String(b._id) ? 1 : 0);

/**
 * Group one subject's notes into clusters: notes linked to each other more
 * than to the rest of the subject. Pure, and computed on every graph request
 * rather than stored, so clusters can never go stale as notes and links are
 * added (about 1.6 ms for the evaluation's largest subject, 54 topics and
 * 168 links, most of it the keyword labels).
 *
 * `method`:
 *   "louvain"    - Louvain community detection on the links, weighted by
 *                  their similarity, at `resolution`; then every cluster is
 *                  split into its connected pieces (see louvain() below).
 *                  What the graph uses.
 *   "components" - notes linked directly, or through a chain of links, form
 *                  one cluster (connected components): what the graph used
 *                  until Oct 2026, kept for the cluster evaluation
 *
 * `edges` are the subject's same-subject edges (sourceNoteId, targetNoteId,
 * weight); an edge to a note outside `notes` is ignored. Returns:
 *   clusterOf - Map of noteId -> clusterId
 *   clusters  - [{ id, size, keywords }], numbered from 1 largest-first (ties:
 *               the cluster with the oldest note first), so the same notes and
 *               links always produce the same numbering. A note with no links
 *               is a cluster of one. `keywords` are up to three keywords shared
 *               by at least two of the cluster's notes, as a readable label.
 */
export function clusterNotes(notes, edges, { method = "louvain", resolution = CLUSTER_RESOLUTION } = {}) {
  // Oldest first: the order Louvain visits notes in, so the result never
  // depends on the order the database returns notes or edges in.
  const ordered = [...notes].sort(older);
  const indexOf = new Map(ordered.map((n, i) => [String(n._id), i]));
  const links = linksAmong(indexOf, edges);
  let groupOf;
  if (method === "louvain") {
    const community = louvain(ordered.length, links, resolution);
    groupOf = components(ordered.length, links.filter((l) => community[l.a] === community[l.b]));
  } else if (method === "components") {
    groupOf = components(ordered.length, links);
  } else {
    throw new Error(`unknown clustering method "${method}"`);
  }

  const groups = new Map();
  ordered.forEach((n, i) => {
    if (!groups.has(groupOf[i])) groups.set(groupOf[i], []);
    groups.get(groupOf[i]).push(n); // oldest first, as `ordered` is
  });
  const clusterOf = new Map();
  const clusters = [...groups.values()]
    .sort((a, b) => b.length - a.length || older(a[0], b[0]))
    .map((members, i) => {
      const id = i + 1;
      for (const n of members) clusterOf.set(String(n._id), id);
      return { id, size: members.length, keywords: sharedClusterKeywords(members) };
    });
  return { clusterOf, clusters };
}

// The edges between the notes of `indexOf` (Map noteId -> index), as
// { a, b, w } with a < b, one per pair, sorted by a then b. Edges are stored
// one per pair; should a pair ever have two, the stronger counts. A row with
// no usable weight counts as the weakest link the rule makes.
function linksAmong(indexOf, edges) {
  const byPair = new Map();
  for (const e of edges) {
    const [x, y] = [indexOf.get(String(e.sourceNoteId)), indexOf.get(String(e.targetNoteId))];
    if (x === undefined || y === undefined || x === y) continue;
    const [a, b] = x < y ? [x, y] : [y, x];
    const w = Number(e.weight) > 0 ? Number(e.weight) : SIMILARITY_THRESHOLD;
    const key = a * indexOf.size + b;
    if (!byPair.has(key) || byPair.get(key).w < w) byPair.set(key, { a, b, w });
  }
  return [...byPair.values()].sort((p, q) => p.a - q.a || p.b - q.b);
}

// Connected components of nodes 0..n-1 (union-find): each node's group, the
// smallest node index in its component.
function components(n, links) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]; // path halving
      x = parent[x];
    }
    return x;
  };
  for (const { a, b } of links) {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
  return parent.map((_, i) => find(i));
}

// A move must gain more than this to count, so rounding in the sums can never
// make two equally good choices look different or a node move back and forth.
const GAIN_EPSILON = 1e-12;
const MAX_PASSES = 100; // a safeguard: every pass that moves a node raises modularity

/**
 * Louvain community detection (Blondel et al., 2008): each node, in index
 * order, moves to the neighbouring community that raises modularity most;
 * repeated until no node moves; then each community becomes one node and the
 * same is done on that smaller graph, until nothing merges. Returns each
 * node's community.
 *
 * Connected components put a whole subject in one cluster as soon as one
 * chain of links runs through it (all 32 DEDV topics of the link evaluation's
 * notes). Modularity instead groups notes that are linked to each other more
 * than the link counts alone would lead one to expect, so a chain of weak links
 * between two groups no longer merges them.
 *
 * Deterministic: nodes are visited in index order (oldest note first),
 * neighbouring communities are tried in ascending order, a node moves only
 * for a strictly larger gain (ties keep it where it is, then go to the
 * lower-numbered community), and merged nodes are numbered in order of their
 * oldest note. No randomness, so the same notes and links always give the
 * same clusters.
 *
 * Louvain can leave a community that its own links do not hold together;
 * clusterNotes() splits each one into its connected pieces, which only ever
 * raises modularity. Leiden (Traag et al., 2019) guards against that inside
 * the algorithm, at the price of randomness and about twice the code; on a
 * subject's few dozen notes the split is enough.
 */
function louvain(n, links, resolution) {
  let membership = Array.from({ length: n }, (_, i) => i);
  const total = links.reduce((sum, l) => sum + l.w, 0);
  if (!total) return membership;
  let adjacency = Array.from({ length: n }, () => new Map());
  for (const { a, b, w } of links) {
    adjacency[a].set(b, w);
    adjacency[b].set(a, w);
  }
  let inside = new Array(n).fill(0); // weight of links within each node (merged nodes)

  for (;;) {
    const community = moveNodes(adjacency, inside, total, resolution);
    const count = community.reduce((max, c) => Math.max(max, c + 1), 0);
    if (count === adjacency.length) return membership;
    membership = membership.map((node) => community[node]);
    const merged = Array.from({ length: count }, () => new Map());
    const mergedInside = new Array(count).fill(0);
    adjacency.forEach((neighbours, i) => {
      const ci = community[i];
      mergedInside[ci] += inside[i];
      for (const [j, w] of neighbours) {
        if (j < i) continue; // each link once
        const cj = community[j];
        if (ci === cj) mergedInside[ci] += w;
        else {
          merged[ci].set(cj, (merged[ci].get(cj) || 0) + w);
          merged[cj].set(ci, (merged[cj].get(ci) || 0) + w);
        }
      }
    });
    adjacency = merged;
    inside = mergedInside;
  }
}

// Louvain's first phase on one level: returns each node's community,
// numbered 0.. in order of first appearance.
function moveNodes(adjacency, inside, total, resolution) {
  const n = adjacency.length;
  const degree = adjacency.map((neighbours, i) => 2 * inside[i] + [...neighbours.values()].reduce((s, w) => s + w, 0));
  const community = Array.from({ length: n }, (_, i) => i);
  const communityDegree = [...degree];
  let moved = true;
  for (let pass = 0; moved && pass < MAX_PASSES; pass++) {
    moved = false;
    for (let i = 0; i < n; i++) {
      const own = community[i];
      const k = degree[i];
      const toCommunity = new Map();
      for (const [j, w] of adjacency[i]) toCommunity.set(community[j], (toCommunity.get(community[j]) || 0) + w);
      communityDegree[own] -= k;
      // modularity gained by adding node i to community c, times `total`
      const gain = (c) => (toCommunity.get(c) || 0) - (resolution * communityDegree[c] * k) / (2 * total);
      let best = own;
      let bestGain = gain(own);
      for (const c of [...toCommunity.keys()].sort((x, y) => x - y)) {
        const g = gain(c);
        if (g > bestGain + GAIN_EPSILON) {
          best = c;
          bestGain = g;
        }
      }
      communityDegree[best] += k;
      if (best !== own) {
        community[i] = best;
        moved = true;
      }
    }
  }
  const renumbered = new Map();
  return community.map((c) => {
    if (!renumbered.has(c)) renumbered.set(c, renumbered.size);
    return renumbered.get(c);
  });
}

// Keywords appearing in at least two of a cluster's notes, most widespread
// first; ties go to the keyword ranked higher within those notes. Singular
// and plural count as one keyword (sameWord), shown in the shorter form.
function sharedClusterKeywords(members) {
  if (members.length < 2) return [];
  const stats = [];
  for (const n of members) {
    const counted = new Set(); // a note saved with both "cell" and "cells" counts once
    (n.keywords || []).forEach((k, rank) => {
      let s = stats.find((x) => sameWord(x.word, k));
      if (!s) stats.push((s = { word: k, count: 0, rank: 0 }));
      if (k.length < s.word.length) s.word = k;
      if (counted.has(s)) return;
      counted.add(s);
      s.count += 1;
      s.rank += rank;
    });
  }
  return stats
    .filter((s) => s.count >= 2)
    .sort((a, b) => b.count - a.count || a.rank - b.rank || (a.word < b.word ? -1 : 1))
    .slice(0, 3)
    .map((s) => s.word);
}

// A long upload split into subtopics (see services/documentStructure.js) is a
// PARENT note whose text is the union of its subtopic CHILD notes. Only the
// children are topics: linking the parent by similarity would just duplicate
// every child's links, so split parents are never compared, on either side.
// The parent -> subtopic relationship is shown separately, as the graph
// API's derived "contains" edges.
const isSplitParent = (n) => !n?.parentNoteId && (n?.childCount || 0) > 0;

/**
 * Compare a newly-created note against the student's other notes - in its
 * own subject and in every other subject - and persist a graph_edge for each
 * pair classifyPair() keeps. Returns the stored edges, each with its
 * edgeType, so the caller can count same-subject and cross-subject links
 * separately.
 */
export async function updateGraphForNote(newNote, otherNotes) {
  const storedEdges = [];
  if (isSplitParent(newNote)) return storedEdges;

  // The note's embedding, made now when the optional model is ready - a save
  // never waits for it to load; a note saved without one is linked by TF-IDF
  // until the next relink - and the others' stored ones.
  const others = otherNotes.filter((o) => String(o._id) !== String(newNote._id) && !isSplitParent(o));
  const { notes: [subject, ...rest] } = await withEmbeddings([newNote, ...others], { embedder: await getEmbedder(), compute: [newNote] });

  for (const other of rest) {
    const pair = classifyPair(subject, other);
    if (!pair) continue;

    // One undirected edge per pair: the lower id is always the source.
    const [source, target] =
      String(newNote._id) < String(other._id) ? [newNote, other] : [other, newNote];

    const edge = await upsertEdge({
      sourceNoteId: source._id,
      targetNoteId: target._id,
      sourceSubjectId: source.subjectId,
      targetSubjectId: target.subjectId,
      ...pair,
    });
    storedEdges.push(edge);
  }

  return storedEdges;
}
