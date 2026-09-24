import { getCollection } from "../db/index.js";

const notes = () => getCollection("notes");

export async function createNote({
  ownerId,
  subjectId,
  title,
  sourceType,
  rawText,
  keywords,
  vector,
  ocrFailed,
}) {
  return notes().insertOne({
    ownerId,
    subjectId,
    title,
    sourceType,
    rawText,
    keywords,
    vector,
    ocrFailed,
    createdAt: new Date(),
  });
}

export async function findNotesBySubject(subjectId) {
  return notes().find({ subjectId }, { sort: { createdAt: -1 } });
}

// Every note a student owns, across all their subjects - what cross-subject
// linking compares a new note against.
export async function findNotesByOwner(ownerId) {
  return notes().find({ ownerId }, { sort: { createdAt: -1 } });
}

export async function findNotesByIds(ids) {
  if (!ids.length) return [];
  return notes().find({ _id: ids });
}
