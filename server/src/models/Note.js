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
  fileType = null,
  sourceFile = null,
  sectionIndex = null,
  textbookRefs = [],
}) {
  return notes().insertOne({
    ownerId,
    subjectId,
    title,
    sourceType,
    // For uploads: "pdf" | "docx" | "text" | "image", the original file name,
    // and - when a long document was split into one note per section - this
    // note's position in it.
    fileType,
    sourceFile,
    sectionIndex,
    // Best-matching reference-textbook passages (services/textbook.js).
    textbookRefs,
    rawText,
    keywords,
    vector,
    ocrFailed,
    createdAt: new Date(),
  });
}

export async function setTextbookRefs(noteId, textbookRefs) {
  return notes().findOneAndUpdate({ _id: noteId }, { $set: { textbookRefs } });
}

export async function findNotesBySubject(subjectId) {
  return notes().find({ subjectId }, { sort: { createdAt: -1 } });
}

export async function findNotesByIds(ids) {
  if (!ids.length) return [];
  return notes().find({ _id: ids });
}
