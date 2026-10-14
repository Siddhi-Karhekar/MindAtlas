import { upsertEdge } from "../models/GraphEdge.js";
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

// The three numbers above as one rule, the form decideEdge() takes.
export const LINK_RULE = Object.freeze({
  similarity: SIMILARITY_THRESHOLD,
  crossSimilarity: CROSS_SUBJECT_THRESHOLD,
  crossMinShared: CROSS_SUBJECT_MIN_SHARED,
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
 * TF-IDF terms they share (linkTerms), and whether they are in the same
 * subject. `sharedKeywords` keeps its name: edges store it, and the graph
 * page shows it as what two notes have in common.
 */
export function pairFeatures(a, b) {
  const termsOfB = linkTerms(b);
  return {
    weight: cosineSimilarity(a.vector, b.vector),
    sharedKeywords: linkTerms(a).filter((k) => termsOfB.includes(k)),
    sameSubject: String(a.subjectId) === String(b.subjectId),
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
 * exactly this code.
 */
export function decideEdge({ weight, sharedKeywords, sameSubject }, rule = LINK_RULE) {
  if (sameSubject) return weight >= rule.similarity ? "same-subject" : null;
  if (sharedKeywords.length >= rule.crossMinShared && weight >= rule.crossSimilarity) return "cross-subject";
  if (sharedKeywords.length > 0 && weight >= rule.similarity) return "rejected";
  return null;
}

/**
 * Decide what edge, if any, belongs between two notes under the current
 * rule. Pure - no database - so the linking rules can be unit tested on
 * their own. Returns { edgeType, weight, sharedKeywords }, or null.
 */
export function classifyPair(a, b) {
  const features = pairFeatures(a, b);
  const edgeType = decideEdge(features);
  return edgeType ? { edgeType, weight: Number(features.weight.toFixed(4)), sharedKeywords: features.sharedKeywords } : null;
}

/**
 * Group one subject's notes into clusters: notes linked directly, or through
 * a chain of links, form one cluster (connected components, via union-find).
 * A deliberately simple stand-in for Louvain/Leiden community detection,
 * which stays on the post-prototype backlog - see CONTRIBUTING.md. Pure, and
 * computed on every graph request rather than stored, so clusters can never
 * go stale as notes and links are added.
 *
 * `edges` are the subject's same-subject edges (sourceNoteId/targetNoteId);
 * an edge to a note outside `notes` is ignored. Returns:
 *   clusterOf - Map of noteId -> clusterId
 *   clusters  - [{ id, size, keywords }], numbered from 1 largest-first (ties:
 *               the cluster with the oldest note first), so the same notes and
 *               links always produce the same numbering. A note with no links
 *               is a cluster of one. `keywords` are up to three keywords shared
 *               by at least two of the cluster's notes, as a readable label.
 */
export function clusterNotes(notes, edges) {
  const parent = new Map(notes.map((n) => [String(n._id), String(n._id)]));
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x))); // path halving
      x = parent.get(x);
    }
    return x;
  };
  for (const e of edges) {
    const a = String(e.sourceNoteId);
    const b = String(e.targetNoteId);
    if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b));
  }

  const groups = new Map();
  for (const n of notes) {
    const root = find(String(n._id));
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(n);
  }

  const time = (n) => new Date(n.createdAt || 0).getTime();
  const older = (a, b) => time(a) - time(b) || (String(a._id) < String(b._id) ? -1 : 1);
  const ordered = [...groups.values()]
    .map((members) => members.sort(older))
    .sort((a, b) => b.length - a.length || older(a[0], b[0]));

  const clusterOf = new Map();
  const clusters = ordered.map((members, i) => {
    const id = i + 1;
    for (const n of members) clusterOf.set(String(n._id), id);
    return { id, size: members.length, keywords: sharedClusterKeywords(members) };
  });
  return { clusterOf, clusters };
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

  for (const other of otherNotes) {
    if (String(other._id) === String(newNote._id)) continue;
    if (isSplitParent(other)) continue;

    const pair = classifyPair(newNote, other);
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
