import { upsertEdge } from "../models/GraphEdge.js";
import { cosineSimilarity } from "./tfidf.js";

// Below this similarity score, two notes are considered unrelated and no
// edge is drawn - mirrors "Similarity scoring within subject folder" in
// Diagram 2 of the architecture doc.
const SIMILARITY_THRESHOLD = 0.12;

/**
 * Compare a newly-created note against every other note already in the
 * same subject, and persist a graph_edge for every pair that clears the
 * similarity threshold. Same-subject notes skip the cross-subject
 * disambiguation pass from the architecture doc (that only applies when a
 * term shows up in more than one subject) - this is the "no (same
 * subject)" branch of Diagram 2.
 */
//
// Only topic notes are ever compared: a split document's parent note is a
// container whose text is the union of its subtopics, so linking it by
// similarity would just duplicate its children's links. Its relationship to
// its subtopics is the separate "contains" edge the graph API derives.
export async function updateGraphForNote(newNote, otherNotes) {
  const createdEdges = [];
  if (!newNote.parentNoteId && (newNote.childCount || 0) > 0) return createdEdges;

  for (const other of otherNotes) {
    if (String(other._id) === String(newNote._id)) continue;
    if (!other.parentNoteId && (other.childCount || 0) > 0) continue;

    const weight = cosineSimilarity(newNote.vector, other.vector);
    if (weight < SIMILARITY_THRESHOLD) continue;

    const sharedKeywords = newNote.keywords.filter((k) => other.keywords.includes(k));

    const [sourceNoteId, targetNoteId] =
      String(newNote._id) < String(other._id)
        ? [newNote._id, other._id]
        : [other._id, newNote._id];

    const edge = await upsertEdge({
      subjectId: newNote.subjectId,
      sourceNoteId,
      targetNoteId,
      weight: Number(weight.toFixed(4)),
      sharedKeywords,
    });
    createdEdges.push(edge);
  }

  return createdEdges;
}
