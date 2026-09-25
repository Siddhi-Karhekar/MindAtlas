import { getCollection } from "../db/index.js";

const notes = () => getCollection("notes");

// Notes form a two-level hierarchy:
//   - an ordinary note (typed, a photo, a short file): parentNoteId null,
//     childCount 0. It is a topic in its own right.
//   - a long uploaded document that was split into subtopics: a PARENT note
//     (parentNoteId null, childCount N) holding the full text for reading,
//     plus N CHILD notes (parentNoteId = the parent's id, `order` 0..N-1),
//     one per subtopic.
// Only "leaf" notes - ordinary notes and children - are topics: they are what
// the knowledge graph links by similarity, what questions are tagged with,
// and what mastery and feedback are keyed on. A split parent is a container.
// `sectionGroup` is the coarser heading a subtopic sat under in the source
// (e.g. "Memory Management" for "Paging"), kept for display only.

export async function createNote({
  ownerId,
  subjectId,
  title,
  sourceType,
  rawText,
  keywords,
  vector,
  ocrFailed,
  parentNoteId = null,
  order = null,
  sectionGroup = null,
  childCount = 0,
  splitMethod = null,
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
    parentNoteId,
    order,
    sectionGroup,
    childCount,
    splitMethod,
    createdAt: new Date(),
  });
}

/** Record how many subtopics a parent ended up with, once they exist. */
export async function setChildCount(noteId, childCount) {
  return notes().findOneAndUpdate({ _id: noteId }, { $set: { childCount } });
}

export async function findNotesBySubject(subjectId) {
  return notes().find({ subjectId }, { sort: { createdAt: -1 } });
}

export async function findNotesByIds(ids) {
  if (!ids.length) return [];
  return notes().find({ _id: ids });
}

export async function findChildNotes(parentIds) {
  if (!parentIds.length) return [];
  const children = await notes().find({ parentNoteId: parentIds });
  return children.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** True for a note that was split into subtopics (a container, not a topic). */
export function isSplitParent(note) {
  return !note?.parentNoteId && (note?.childCount || 0) > 0;
}

/** Leaf notes are the topics: everything except split parents. */
export function leafNotes(allNotes) {
  return allNotes.filter((n) => !isSplitParent(n));
}

/**
 * Display label for a topic note: "Parent › Subtopic" for a child, the plain
 * title otherwise. This is what questions, feedback and mastery show, so a
 * student reads "Unit 3 › Paging" instead of just "Unit 3".
 */
export function topicLabelFor(note, parentsById) {
  if (!note?.parentNoteId) return note?.title;
  const parent = parentsById.get(String(note.parentNoteId));
  return parent ? `${parent.title} › ${note.title}` : note.title;
}
