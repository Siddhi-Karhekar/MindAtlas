import { Router } from "express";
import { findOwnedSubject } from "../models/Subject.js";
import { createNote, findNotesBySubject } from "../models/Note.js";
import { requireAuth } from "../middleware/auth.js";
import { extractTextFromImage } from "../services/ocr.js";
import {
  classifyUpload,
  extractDocumentLines,
  extractTextFromDocument,
  titleFromFilename,
} from "../services/documentText.js";
import { splitIntoSections } from "../services/sectionSplitter.js";
import { findReferences } from "../services/textbook.js";
import { loadSubjectLibrary } from "../models/Textbook.js";
import { uploadSingle } from "../middleware/upload.js";
import { computeTfidf } from "../services/tfidf.js";
import { updateGraphForNote } from "../services/graphEngine.js";

const router = Router();
router.use(requireAuth);

// POST /api/subjects/:id/notes
// Accepts either JSON { title, content } for a typed note, or a
// multipart/form-data upload with a `file` field: an image (read with OCR) or an
// existing document - PDF, .docx, .txt/.md (text is extracted directly).
//
// A document with its own heading structure (e.g. a whole unit's notes as one
// PDF) is split into one note per top-level section, so each topic becomes
// its own graph node / test topic - send `split=false` to keep it as a single
// note. Every new note is also linked to the best-matching passages of the
// subject's reference textbooks (see routes/textbooks.js).
router.post("/:id/notes", uploadSingle("file", 10), async (req, res) => {
  const subject = await findOwnedSubject(req.params.id, req.user.id);
  if (!subject) return res.status(404).json({ error: "subject not found" });

  let { title, content } = req.body || {};
  let sourceType = "typed";
  let ocrFailed = false;
  let fileType = null;
  let sections = null;

  if (req.file) {
    const kind = classifyUpload(req.file);
    if (!kind) {
      return res.status(400).json({
        error: "unsupported file type - upload a PDF, Word (.docx), text/markdown file or an image",
      });
    }
    fileType = kind;
    if (kind === "image") {
      // scanned / photographed notes: read with OCR
      sourceType = "image";
      const { text, ocrFailed: failed } = await extractTextFromImage(req.file.buffer);
      content = text;
      ocrFailed = failed;
    } else {
      // an existing digital document: pull the text straight out of it
      sourceType = "file";
      try {
        ({ text: content } = await extractTextFromDocument(req.file, kind));
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      if (!content) {
        return res.status(400).json({
          error: "no readable text found in this file (if it is a scanned PDF, upload the pages as images instead)",
        });
      }
      if (String(req.body?.split) !== "false") {
        sections = splitIntoSections(await extractDocumentLines(req.file, kind));
      }
    }
    title = title || titleFromFilename(req.file.originalname) || req.file.originalname;
  }

  if (!title || !title.trim()) return res.status(400).json({ error: "title is required" });
  if (!content || !content.trim()) {
    return res.status(400).json({
      error: ocrFailed
        ? "OCR could not read this image (see ocrFailed) and no typed content was provided"
        : "content is required",
    });
  }

  const library = await loadSubjectLibrary(subject._id);
  const sourceFile = req.file?.originalname || null;
  // One entry per note to create: each section of a split document, or the
  // whole upload / typed note.
  const pieces = sections
    ? sections.map((sec, i) => ({ title: sec.title, content: sec.text, sectionIndex: i }))
    : [{ title: title.trim(), content, sectionIndex: null }];

  const created = [];
  let edgesCreated = 0;
  for (const piece of pieces) {
    const existingNotes = await findNotesBySubject(subject._id);
    const { vector, keywords } = computeTfidf(
      piece.content,
      existingNotes.map((n) => n.rawText)
    );

    const note = await createNote({
      ownerId: req.user.id,
      subjectId: subject._id,
      title: piece.title,
      sourceType,
      fileType,
      sourceFile,
      sectionIndex: piece.sectionIndex,
      textbookRefs: findReferences(`${piece.title}\n${piece.content}`, library),
      rawText: piece.content.trim(),
      keywords,
      vector,
      ocrFailed,
    });

    const edges = await updateGraphForNote(note, existingNotes);
    edgesCreated += edges.length;
    created.push(note);
  }

  // `note` stays the first note for older clients; `notes` has all of them.
  res.status(201).json({ note: created[0], notes: created, edgesCreated, sectionsCreated: sections ? created.length : 0 });
});

router.get("/:id/notes", async (req, res) => {
  const subject = await findOwnedSubject(req.params.id, req.user.id);
  if (!subject) return res.status(404).json({ error: "subject not found" });

  const notes = await findNotesBySubject(subject._id);
  res.json({ notes });
});

export default router;
