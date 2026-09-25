import { Router } from "express";
import { findOwnedSubject } from "../models/Subject.js";
import { createNote, findNotesByOwner, findNotesBySubject } from "../models/Note.js";
import { requireAuth } from "../middleware/auth.js";
import { uploadSingle } from "../middleware/upload.js";
import { extractTextFromImage } from "../services/ocr.js";
import { classifyUpload, extractTextFromDocument, titleFromFilename } from "../services/documentText.js";
import { computeTfidf } from "../services/tfidf.js";
import { updateGraphForNote } from "../services/graphEngine.js";

const router = Router();
router.use(requireAuth);

// POST /api/subjects/:id/notes
// Accepts either JSON { title, content } for a typed note, or a
// multipart/form-data upload with a `file` field: an image (read with OCR) or an
// existing document - PDF, .docx, .txt/.md (text is extracted directly).
router.post("/:id/notes", uploadSingle("file", 10), async (req, res) => {
  const subject = await findOwnedSubject(req.params.id, req.user.id);
  if (!subject) return res.status(404).json({ error: "subject not found" });

  let { title, content } = req.body || {};
  let sourceType = "typed";
  let ocrFailed = false;

  if (req.file) {
    const kind = classifyUpload(req.file);
    if (!kind) {
      return res.status(400).json({
        error: "unsupported file type - upload a PDF, Word (.docx), text/markdown file or an image",
      });
    }
    if (kind === "image") {
      // scanned / photographed notes: read with OCR
      sourceType = "image";
      const { text, ocrFailed: failed } = await extractTextFromImage(req.file.buffer);
      content = text;
      ocrFailed = failed;
      if (!content) {
        return res.status(400).json({
          error: ocrFailed
            ? "could not read this image - it may be damaged, or text recognition is unavailable right now"
            : "no readable text found in this image - try a sharper, well-lit photo, or type the note instead",
        });
      }
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
          error:
            kind === "pdf"
              ? "no readable text found in this file (if it is a scanned PDF, upload the pages as images instead)"
              : "no readable text found in this file - it is empty",
        });
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

  const existingNotes = await findNotesBySubject(subject._id);
  const { vector, keywords } = computeTfidf(
    content,
    existingNotes.map((n) => n.rawText)
  );

  const note = await createNote({
    ownerId: req.user.id,
    subjectId: subject._id,
    title: title.trim(),
    sourceType,
    rawText: content.trim(),
    keywords,
    vector,
    ocrFailed,
  });

  // Compared against every note the student owns, not just this subject's:
  // graphEngine links same-subject pairs as before and applies a stricter
  // rule to notes from other subjects.
  const ownerNotes = await findNotesByOwner(req.user.id);
  const edges = await updateGraphForNote(note, ownerNotes);

  res.status(201).json({
    note,
    // Same-subject links only, as before - the subject page's "N new links
    // to related notes" message counts links within this subject.
    edgesCreated: edges.filter((e) => e.edgeType === "same-subject").length,
    crossSubjectEdgesCreated: edges.filter((e) => e.edgeType === "cross-subject").length,
  });
});

router.get("/:id/notes", async (req, res) => {
  const subject = await findOwnedSubject(req.params.id, req.user.id);
  if (!subject) return res.status(404).json({ error: "subject not found" });

  const notes = await findNotesBySubject(subject._id);
  res.json({ notes });
});

export default router;
