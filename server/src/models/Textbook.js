import { getCollection } from "../db/index.js";

// A reference textbook uploaded to a subject, and its passages
// (textbook_chunks). `df` / `numDocs` are the book's TF-IDF statistics, kept
// so notes added later can be matched against the same index - see
// services/textbook.js.
const textbooks = () => getCollection("textbooks");
const chunks = () => getCollection("textbook_chunks");

export async function createTextbook({ ownerId, subjectId, title, sourceFile, fileType, pageCount, skippedPages, df, numDocs }) {
  return textbooks().insertOne({
    ownerId,
    subjectId,
    title,
    sourceFile,
    fileType,
    pageCount,
    skippedPages,
    chunkCount: numDocs,
    df,
    numDocs,
    createdAt: new Date(),
  });
}

export async function createTextbookChunks(textbook, chunkList) {
  const saved = [];
  for (const [i, c] of chunkList.entries()) {
    saved.push(
      await chunks().insertOne({
        textbookId: textbook._id,
        subjectId: textbook.subjectId,
        ownerId: textbook.ownerId,
        index: i,
        ...c,
      })
    );
  }
  return saved;
}

export async function findTextbooksBySubject(subjectId) {
  return textbooks().find({ subjectId }, { sort: { createdAt: 1 } });
}

export async function findOwnedTextbook(id, ownerId) {
  return textbooks().findOne({ _id: id, ownerId });
}

export async function findChunksByTextbook(textbookId) {
  return chunks().find({ textbookId }, { sort: { index: 1 } });
}

export async function findOwnedChunk(id, ownerId) {
  return chunks().findOne({ _id: id, ownerId });
}

/** Every textbook in a subject with its chunks, in the shape findReferences() expects. */
export async function loadSubjectLibrary(subjectId) {
  const books = await findTextbooksBySubject(subjectId);
  return Promise.all(books.map(async (textbook) => ({ textbook, chunks: await findChunksByTextbook(textbook._id) })));
}

/** A textbook without its (large) index statistics - what the API returns. */
export function publicTextbook({ df, numDocs, ...rest }) {
  return rest;
}
