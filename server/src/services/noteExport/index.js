// Download notes as a PDF or a Word file.
//
//   exportNote(note, { format, timeZone })       one note; for a document that
//                                                was split into subtopics, the
//                                                whole document
//   exportSubject(subject, { format, timeZone }) every note of a subject
//
// Both return { buffer, fileName, contentType }. The file is built from the
// note's `content` - the same blocks the reading pane formats - by model.js,
// then written by pdf.js or docx.js. Nothing is stored and no service outside
// this server is involved.

import { findChildNotes, findNoteById, findNotesBySubject, isSplitParent } from "../../models/Note.js";
import { findOwnedSubject } from "../../models/Subject.js";
import { dateLabel, documentModel, noteModel, subjectModel } from "./model.js";

export const FORMATS = {
  pdf: { extension: "pdf", contentType: "application/pdf", render: async (model) => (await import("./pdf.js")).renderPdf(model) },
  docx: {
    extension: "docx",
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    render: async (model) => (await import("./docx.js")).renderDocx(model),
  },
};

/** "pdf" or "docx" from what the request asked for ("word" is accepted too); null if neither. */
export function parseFormat(value) {
  const v = String(value || "pdf").trim().toLowerCase();
  if (v === "word" || v === "doc") return "docx";
  return FORMATS[v] ? v : null;
}

async function write(model, format) {
  const { extension, contentType, render } = FORMATS[format];
  return { buffer: await render(model), fileName: `${model.fileName}.${extension}`, contentType };
}

export async function exportNote(note, { format = "pdf", timeZone } = {}) {
  const date = dateLabel(new Date(), timeZone);
  const subject = await findOwnedSubject(note.subjectId, note.ownerId);
  if (isSplitParent(note)) {
    const children = await findChildNotes([note._id]);
    // a document whose subtopics are all gone is written as the note it still is
    if (children.length) return write(documentModel({ parent: note, children, subject, date }), format);
  }
  if (note.parentNoteId) {
    const parent = await findNoteById(note.parentNoteId);
    const siblings = parent ? await findChildNotes([parent._id]) : [];
    return write(noteModel({ note, subject, parent, siblings, date }), format);
  }
  return write(noteModel({ note, subject, date }), format);
}

export async function exportSubject(subject, { format = "pdf", timeZone } = {}) {
  const notes = await findNotesBySubject(subject._id);
  if (!notes.length) {
    const err = new Error("this subject has no notes to download yet");
    err.status = 404;
    throw err;
  }
  return write(subjectModel({ subject, notes, date: dateLabel(new Date(), timeZone) }), format);
}

/**
 * Send an export as a download. The file name goes out twice: plain ASCII for
 * old clients, and the real (UTF-8) name for everything else.
 */
export function sendExport(res, { buffer, fileName, contentType }) {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", buffer.length);
  res.setHeader("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  // a student's notes: not for shared caches
  res.setHeader("Cache-Control", "private, no-store");
  res.end(buffer);
}
