import { upsertEdge } from "../models/GraphEdge.js";
import { cosineSimilarity } from "./tfidf.js";

// Below this similarity score, two notes in the same subject are considered
// unrelated and no edge is drawn - mirrors "Similarity scoring within
// subject folder" in Diagram 2 of the architecture doc.
export const SIMILARITY_THRESHOLD = 0.12;

// Cross-subject pairs have to clear a stricter bar, because a word shared
// across subjects is often the same spelling with a different meaning: "cell"
// in Biology, Chemistry (electrochemical cell) and Computer Networks (ATM
// cell), or "nucleus" in Biology and Chemistry. A pair is linked across
// subjects only when BOTH hold:
//   - at least CROSS_SUBJECT_MIN_SHARED of their top-12 TF-IDF keywords match,
//   - and their cosine similarity is at least CROSS_SUBJECT_THRESHOLD.
// CONTRIBUTING.md first proposed "at least one shared keyword"; on real notes
// that still linked Biology "Cell structure" to Chemistry "Electrochemical
// cells" (similarity 0.252, sharing only "cell"), because one word repeated
// often enough in both notes can lift the similarity past 0.25 on its own.
// Notes that are genuinely about the same thing share several key terms
// (Osmosis <-> Diffusion shared six), so requiring two is what separates a
// real overlap from one ambiguous word.
export const CROSS_SUBJECT_THRESHOLD = 0.25;
export const CROSS_SUBJECT_MIN_SHARED = 2;

/**
 * Decide what edge, if any, belongs between two notes. Pure - no database -
 * so the linking rules can be unit tested on their own.
 *
 * Returns { edgeType, weight, sharedKeywords }, or null for "no edge":
 *   "same-subject"  - same subject, similarity >= SIMILARITY_THRESHOLD
 *   "cross-subject" - different subjects, passes the stricter rule above
 *   "rejected"      - different subjects, shares a keyword and would have
 *                     been linked under the same-subject rule, but fails the
 *                     stricter one: the ambiguous case. Stored rather than
 *                     dropped so the graph can show that the pair was
 *                     considered and turned down.
 */
export function classifyPair(a, b) {
  const weight = cosineSimilarity(a.vector, b.vector);
  const sharedKeywords = a.keywords.filter((k) => b.keywords.includes(k));
  const sameSubject = String(a.subjectId) === String(b.subjectId);

  let edgeType = null;
  if (sameSubject) {
    if (weight >= SIMILARITY_THRESHOLD) edgeType = "same-subject";
  } else if (sharedKeywords.length >= CROSS_SUBJECT_MIN_SHARED && weight >= CROSS_SUBJECT_THRESHOLD) {
    edgeType = "cross-subject";
  } else if (sharedKeywords.length > 0 && weight >= SIMILARITY_THRESHOLD) {
    edgeType = "rejected";
  }

  return edgeType ? { edgeType, weight: Number(weight.toFixed(4)), sharedKeywords } : null;
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
// first; ties go to the keyword ranked higher within those notes.
function sharedClusterKeywords(members) {
  if (members.length < 2) return [];
  const stats = new Map();
  for (const n of members) {
    (n.keywords || []).forEach((k, rank) => {
      const s = stats.get(k) || { count: 0, rank: 0 };
      stats.set(k, { count: s.count + 1, rank: s.rank + rank });
    });
  }
  return [...stats.entries()]
    .filter(([, s]) => s.count >= 2)
    .sort(([ka, a], [kb, b]) => b.count - a.count || a.rank - b.rank || (ka < kb ? -1 : 1))
    .slice(0, 3)
    .map(([k]) => k);
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
