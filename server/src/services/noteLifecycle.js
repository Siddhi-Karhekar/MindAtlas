// Editing and deleting notes, and keeping everything that hangs off a note
// consistent when it changes.
//
// What depends on a note:
//   - its links in the knowledge graph (graph_edges), worked out from its text;
//   - its keywords and vector (tfidf.js), also from its text;
//   - for a subtopic: its parent document, whose full text is its subtopics';
//   - mastery records, keyed by the note's id;
//   - tests built from it. Those are deliberately NOT touched: a question
//     carries its own text, answer, excerpt and topic label, so a test is a
//     snapshot of the notes as they were when it was built. Editing or
//     deleting a note never changes or breaks an existing test, attempt or
//     feedback report.
//
// So an edit recomputes keywords, relinks the note and refreshes its parent;
// a delete removes the note, its links and its mastery, and for a split
// document its subtopics with it.

import { deleteEdgesForNotes } from "../models/GraphEdge.js";
import { deleteMasteryForTopics } from "../models/Mastery.js";
import {
  deleteNotesByIds,
  findChildNotes,
  findNotesByOwner,
  findNotesBySubject,
  isSplitParent,
  setChildCount,
  updateNote,
} from "../models/Note.js";
import { blocksFromPlainText, blocksToText, normalizeContent } from "./documentStructure.js";
import { updateGraphForNote } from "./graphEngine.js";
import { withContent } from "./noteView.js";
import { computeTfidf } from "./tfidf.js";

const sameId = (a, b) => String(a) === String(b);

/**
 * A split document's own text and content, rebuilt from its subtopics.
 * The parent holds the whole document for "Read the full document". Once a
 * subtopic has been edited or deleted that copy is out of date, so it is
 * written again from the subtopics, in order, under the headings they sit
 * beneath. (Parts of the original that were never subtopics - a contents
 * page, the references - are not carried over: they belonged to the upload,
 * and the upload no longer matches.)
 */
export function composeDocument(children) {
  const blocks = [];
  let open = []; // the path headings already written
  for (const child of children) {
    const path = Array.isArray(child.path) ? child.path : [];
    let common = 0;
    while (common < path.length && common < open.length && path[common] === open[common]) common += 1;
    for (let i = common; i < path.length; i++) blocks.push({ type: "heading", level: i + 1, text: path[i] });
    open = path;
    const base = path.length + 1;
    blocks.push({ type: "heading", level: base, text: child.title });
    for (const b of withContent(child).content) {
      blocks.push(b.type === "heading" ? { ...b, level: base + (b.level || 1) } : { ...b });
    }
    // what follows a chapter introduction sits under that chapter
    if (path.length === 0) open = [child.title];
  }
  // an introduction's heading and the chapter heading that follows it are one
  const deduped = blocks.filter((b, i) => !(b.type === "heading" && blocks[i - 1]?.type === "heading" && blocks[i - 1].text === b.text && blocks[i - 1].level === b.level));
  return { rawText: blocksToText(deduped), content: normalizeContent(deduped) };
}

async function refreshParent(parentId, subjectNotes) {
  const children = await findChildNotes([parentId]);
  if (children.length === 0) return null;
  const { rawText, content } = composeDocument(children);
  const corpus = subjectNotes.filter((n) => !isSplitParent(n) && !sameId(n.parentNoteId, parentId)).map((n) => n.rawText);
  const { keywords, vector } = computeTfidf(rawText, corpus);
  await setChildCount(parentId, children.length);
  return updateNote(parentId, { rawText, content, keywords, vector });
}

/**
 * Apply an edit to a note. `changes` may hold `title` and/or `text` (the
 * editable text - see contentToEditText). Returns
 *   { note, edgesCreated, crossSubjectEdgesCreated, parent }
 * or throws an Error with `.status` and a message safe to show the student.
 */
export async function editNote(note, { title, text }) {
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const fields = {};

  if (title !== undefined) {
    const t = String(title).trim();
    if (!t) throw fail(400, "the title cannot be empty");
    if (t !== note.title) fields.title = t;
  }

  const textChanged = text !== undefined;
  if (textChanged) {
    // A split document is its subtopics: its text is edited there.
    if (isSplitParent(note)) throw fail(400, "this document is split into subtopics - edit the subtopic you want to change");
    const typed = String(text);
    const blocks = blocksFromPlainText(typed);
    // a typed note keeps what was typed; any other note keeps plain text, as
    // it had from its file (questions quote rawText, so it stays unformatted)
    const rawText = note.sourceType === "typed" ? typed.trim() : blocksToText(blocks);
    if (!rawText.trim()) throw fail(400, "the note cannot be empty - delete it instead if you no longer want it");
    fields.rawText = rawText;
    fields.content = normalizeContent(blocks, { title: fields.title || note.title });
    fields.ocrFailed = false;
  }

  if (Object.keys(fields).length === 0) return { note, edgesCreated: 0, crossSubjectEdgesCreated: 0, parent: null };

  const subjectNotes = await findNotesBySubject(note.subjectId);
  if (fields.rawText !== undefined) {
    const corpus = subjectNotes.filter((n) => !isSplitParent(n) && !sameId(n._id, note._id)).map((n) => n.rawText);
    Object.assign(fields, computeTfidf(fields.rawText, corpus));
    fields.editedAt = new Date();
  }
  const updated = await updateNote(note._id, fields);

  // New words mean new links. The old ones are dropped first - except links
  // the student removed by hand, which stay removed.
  let edges = [];
  if (fields.rawText !== undefined) {
    await deleteEdgesForNotes([note._id], { keepCorrections: true });
    edges = await updateGraphForNote(updated, await findNotesByOwner(note.ownerId));
  }
  const parent = note.parentNoteId && fields.rawText !== undefined ? await refreshParent(note.parentNoteId, subjectNotes) : null;

  return {
    note: updated,
    edgesCreated: edges.filter((e) => e.edgeType === "same-subject").length,
    crossSubjectEdgesCreated: edges.filter((e) => e.edgeType === "cross-subject").length,
    parent,
  };
}

/**
 * Delete a note and what depends on it. A split document goes with all its
 * subtopics; a document whose last subtopic is deleted goes with it.
 * Returns { deletedIds, parentDeleted, parent } - `parent` is the refreshed
 * document when a subtopic was removed from one that still has others.
 */
export async function deleteNote(note) {
  const ids = [note._id];
  if (isSplitParent(note)) ids.push(...(await findChildNotes([note._id])).map((c) => c._id));

  let parentDeleted = false;
  let parentId = note.parentNoteId || null;
  if (parentId) {
    const siblings = (await findChildNotes([parentId])).filter((c) => !sameId(c._id, note._id));
    if (siblings.length === 0) {
      ids.push(parentId);
      parentDeleted = true;
      parentId = null;
    }
  }

  await deleteEdgesForNotes(ids);
  await deleteMasteryForTopics(note.ownerId, ids);
  await deleteNotesByIds(ids);

  const parent = parentId ? await refreshParent(parentId, await findNotesBySubject(note.subjectId)) : null;
  return { deletedIds: ids.map(String), parentDeleted, parent };
}
