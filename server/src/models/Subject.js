import { getCollection } from "../db/index.js";

const subjects = () => getCollection("subjects");

// `group` is the student's own folder for the subject - a semester ("Sem 5"),
// a year, a course - so many subjects stay organised. Optional.
export async function createSubject({ ownerId, name, group = null }) {
  return subjects().insertOne({ ownerId, name, group, createdAt: new Date() });
}

/**
 * Delete a subject and everything in it: its notes and their links, its
 * tests with their questions, attempts, answers and reports, and the mastery
 * and question reports recorded against it. Returns how many went, per kind.
 */
export async function deleteSubjectAndData(id, ownerId) {
  const col = (name) => getCollection(name);
  const subject = await subjects().findOne({ _id: id, ownerId });
  if (!subject) return null;
  const removed = {};
  const noteIds = (await col("notes").find({ subjectId: id, ownerId })).map((n) => n._id);
  const testIds = (await col("tests").find({ subjectId: id, ownerId })).map((t) => t._id);
  const attemptIds = (await col("attempts").find({ subjectId: id, ownerId })).map((a) => a._id);
  removed.graph_edges = noteIds.length
    ? (await col("graph_edges").deleteMany({ sourceNoteId: noteIds })) + (await col("graph_edges").deleteMany({ targetNoteId: noteIds }))
    : 0;
  removed.questions = testIds.length ? await col("questions").deleteMany({ testId: testIds }) : 0;
  removed.responses = attemptIds.length ? await col("responses").deleteMany({ attemptId: attemptIds }) : 0;
  for (const name of ["feedback_reports", "question_reports", "attempts", "tests", "mastery", "notes"]) {
    removed[name] = await col(name).deleteMany({ subjectId: id, ownerId });
  }
  removed.subjects = await subjects().deleteMany({ _id: id, ownerId });
  return removed;
}

/** Rename a subject or move it to another folder. */
export async function updateSubject(id, ownerId, fields) {
  return subjects().findOneAndUpdate({ _id: id, ownerId }, { $set: { ...fields, updatedAt: new Date() } });
}

export async function findSubjectsByOwner(ownerId) {
  return subjects().find({ ownerId }, { sort: { createdAt: -1 } });
}

export async function findOwnedSubject(id, ownerId) {
  return subjects().findOne({ _id: id, ownerId });
}
