import { Router } from "express";
import { findNoteById } from "../models/Note.js";
import { requireAuth } from "../middleware/auth.js";
import { deleteNote, editNote } from "../services/noteLifecycle.js";
import { editTextFor, withContent } from "../services/noteView.js";
import { exportNote, parseFormat, sendExport } from "../services/noteExport/index.js";

// One note, by id: read it for editing, download it, change it, delete it. (Creating and
// listing notes belong to a subject and live in routes/notes.js.)
const router = Router();
router.use(requireAuth);

// Someone else's note is reported exactly like one that does not exist.
async function loadOwnedNote(req, res, next) {
  try {
    const note = await findNoteById(req.params.id);
    if (!note || String(note.ownerId) !== String(req.user.id)) return res.status(404).json({ error: "note not found" });
    req.note = note;
    next();
  } catch (err) {
    next(err);
  }
}

// GET /api/notes/:id - the note, plus `editText`: its content as editable text
router.get("/:id", loadOwnedNote, (req, res) => {
  res.json({ note: withContent(req.note), editText: editTextFor(req.note) });
});

// GET /api/notes/:id/export?format=pdf|docx&tz=Asia/Kolkata
// The note as a formatted file to keep or print. For a document that was
// split into subtopics this is the whole document, with a contents list.
router.get("/:id/export", loadOwnedNote, async (req, res, next) => {
  const format = parseFormat(req.query.format);
  if (!format) return res.status(400).json({ error: "format must be pdf or docx" });
  try {
    sendExport(res, await exportNote(req.note, { format, timeZone: req.query.tz }));
  } catch (err) {
    next(err);
  }
});

// PATCH /api/notes/:id  { title?, content? }
// `content` is the edited text. Keywords and links are recomputed from it;
// tests already built from the note are snapshots and do not change.
router.patch("/:id", loadOwnedNote, async (req, res, next) => {
  const { title, content } = req.body || {};
  if (title === undefined && content === undefined) return res.status(400).json({ error: "send a title, content, or both" });
  try {
    const result = await editNote(req.note, { title, text: content });
    res.json({
      note: withContent(result.note),
      parent: result.parent ? withContent(result.parent) : null,
      edgesCreated: result.edgesCreated,
      crossSubjectEdgesCreated: result.crossSubjectEdgesCreated,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// DELETE /api/notes/:id - the note, its links and its mastery record. A split
// document takes its subtopics with it.
router.delete("/:id", loadOwnedNote, async (req, res, next) => {
  try {
    const result = await deleteNote(req.note);
    res.json({ ...result, parent: result.parent ? withContent(result.parent) : null });
  } catch (err) {
    next(err);
  }
});

export default router;
