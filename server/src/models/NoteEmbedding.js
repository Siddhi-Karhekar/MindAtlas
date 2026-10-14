import { getCollection } from "../db/index.js";

const noteEmbeddings = () => getCollection("note_embeddings");

// A note's meaning as a vector (services/noteEmbedding.js), kept apart from
// the note itself: the knowledge graph is the only reader, and the vector
// only exists where the optional embedding model is installed. One row per
// note: { noteId, ownerId, model, textHash, vector }. `textHash` is of the
// text the vector was made from, so an edited note's old vector is never
// used; `model` names the model, so vectors from two models are never
// compared.

/** The stored rows for `noteIds`, as a Map of note id -> row. */
export async function findEmbeddings(noteIds) {
  if (!noteIds.length) return new Map();
  const rows = await noteEmbeddings().find({ noteId: noteIds.map(String) });
  return new Map(rows.map((r) => [r.noteId, r]));
}

export async function findEmbeddingsByOwner(ownerId) {
  return noteEmbeddings().find({ ownerId: String(ownerId) });
}

export async function saveEmbedding({ noteId, ownerId, model, textHash, vector }) {
  return noteEmbeddings().findOneAndUpdate(
    { noteId: String(noteId) },
    { $set: { noteId: String(noteId), ownerId: String(ownerId), model, textHash, vector, savedAt: new Date() } },
    { upsert: true }
  );
}

/** Delete the rows of `noteIds` - when the notes are deleted, or no longer exist. */
export async function deleteEmbeddingsForNotes(noteIds) {
  return noteIds.length ? noteEmbeddings().deleteMany({ noteId: noteIds.map(String) }) : 0;
}
