import { findNoteById, findNotesBySubject, isSplitParent, updateNote } from "../models/Note.js";
import { buildNoteConcepts, expandConcepts } from "../services/testEngine.js";
import { notesFingerprint, CONCEPTS_VERSION } from "../services/conceptRecords.js";
import { requireAuth } from "../middleware/auth.js";
import { safeRouter } from "../middleware/safeRouter.js";
import { LIMITS, text } from "../middleware/validate.js";
import { deleteNote, editNote, refreshNoteConcepts } from "../services/noteLifecycle.js";
import { findOwnedSubject } from "../models/Subject.js";
import { withSyllabus } from "../services/keyTermSignals.js";
import { termPattern } from "../services/keyTerms.js";
import { editTextFor, publicNote, withKeyTerms } from "../services/noteView.js";
import { exportNote, parseFormat, sendExport } from "../services/noteExport/index.js";

// One note, by id: read it for editing, download it, change it, delete it. (Creating and
// listing notes belong to a subject and live in routes/notes.js.)
const router = safeRouter();
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
const subjectOf = (note) => findOwnedSubject(note.subjectId, note.ownerId);

router.get("/:id", loadOwnedNote, async (req, res) => {
  const [note] = withKeyTerms([req.note], await findNotesBySubject(req.note.subjectId), { subject: await subjectOf(req.note) });
  res.json({ note: publicNote(note), editText: editTextFor(req.note) });
});

// GET /api/notes/:id/concepts - the note's machine-readable side: its concept
// records (services/conceptRecords.js), as test generation reads them. Built
// now if the note has none yet or they are out of date. A split document is a
// container: its subtopics have the records.
router.get("/:id/concepts", loadOwnedNote, async (req, res, next) => {
  try {
    if (isSplitParent(req.note)) return res.status(400).json({ error: "this document is split into subtopics - each subtopic has its own concepts" });
    let stored = req.note.concepts;
    const subjectDoc = await subjectOf(req.note);
    const [self] = withSyllabus([req.note], subjectDoc);
    if (!stored || stored.version !== CONCEPTS_VERSION || stored.fingerprint !== notesFingerprint(self)) {
      const subject = withSyllabus((await findNotesBySubject(req.note.subjectId)).filter((n) => !isSplitParent(n)), subjectDoc);
      stored = await buildNoteConcepts(self, subject);
      await updateNote(req.note._id, { concepts: stored });
    }
    res.json({ noteId: req.note._id, ...expandConcepts(stored) });
  } catch (err) {
    next(err);
  }
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
  const body = req.body || {};
  if (body.title === undefined && body.content === undefined) return res.status(400).json({ error: "send a title, content, or both" });
  const title = body.title === undefined ? undefined : text(body.title, "title", { max: LIMITS.title });
  const content = body.content === undefined ? undefined : text(body.content, "content", { max: LIMITS.noteText, trim: false });
  try {
    const result = await editNote(req.note, { title, text: content });
    const [note, parent] = withKeyTerms([result.note, result.parent], await findNotesBySubject(req.note.subjectId), { subject: await subjectOf(req.note) });
    res.json({
      note: publicNote(note),
      parent: parent ? publicNote(parent) : null,
      edgesCreated: result.edgesCreated,
      crossSubjectEdgesCreated: result.crossSubjectEdgesCreated,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// PUT /api/notes/:id/key-terms  { add: [term], remove: [term] }
// The student's own say on the note's key terms: terms to add (they must be
// in the note, word for word) and terms to take away. The lists replace the
// ones stored. Added terms are always key terms - highlighted, asked about,
// ranked first - and removed ones never are (services/keyTermSignals.js).
// The note's concept records are rebuilt with them, so the next test uses them.
const MAX_MARKED = 30;
function termList(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw Object.assign(new Error(`${name} must be a list of terms`), { status: 400 });
  if (value.length > MAX_MARKED) throw Object.assign(new Error(`at most ${MAX_MARKED} terms in ${name}`), { status: 400 });
  const out = [];
  for (const v of value) {
    const t = text(v, name, { max: 80 }).replace(/\s+/g, " ");
    if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}
router.put("/:id/key-terms", loadOwnedNote, async (req, res, next) => {
  try {
    if (isSplitParent(req.note)) return res.status(400).json({ error: "this document is split into subtopics - mark key terms on each subtopic" });
    const add = termList(req.body?.add, "add");
    const remove = termList(req.body?.remove, "remove");
    const source = `${req.note.title || ""}\n${req.note.rawText || ""}`;
    const missing = add.filter((t) => !termPattern(t, "i").test(source));
    if (missing.length) return res.status(400).json({ error: `not found in this note: ${missing.join(", ")} - a key term has to be written in the note`, code: "not_in_note", missing });
    const both = add.filter((t) => remove.some((r) => r.toLowerCase() === t.toLowerCase()));
    if (both.length) return res.status(400).json({ error: `a term cannot be added and removed at once: ${both.join(", ")}` });
    await updateNote(req.note._id, { termMarks: { add, remove, updatedAt: new Date() } });
    const updated = (await refreshNoteConcepts({ ...req.note })) || (await findNoteById(req.note._id));
    const [note] = withKeyTerms([updated], await findNotesBySubject(req.note.subjectId), { subject: await subjectOf(req.note) });
    res.json({ note: publicNote(note) });
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
    res.json({ ...result, parent: result.parent ? publicNote(result.parent) : null });
  } catch (err) {
    next(err);
  }
});

export default router;
