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
 * Compare a newly-created note against the student's other notes - in its
 * own subject and in every other subject - and persist a graph_edge for each
 * pair classifyPair() keeps. Returns the stored edges, each with its
 * edgeType, so the caller can count same-subject and cross-subject links
 * separately.
 */
export async function updateGraphForNote(newNote, otherNotes) {
  const storedEdges = [];

  for (const other of otherNotes) {
    if (String(other._id) === String(newNote._id)) continue;

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
