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
