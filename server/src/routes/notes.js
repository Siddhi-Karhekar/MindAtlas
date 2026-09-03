import { Router } from "express";
import multer from "multer";
import { findOwnedSubject } from "../models/Subject.js";
import { createNote, findNotesBySubject } from "../models/Note.js";
import { requireAuth } from "../middleware/auth.js";
import { extractTextFromImage } from "../services/ocr.js";
import { computeTfidf } from "../services/tfidf.js";
import { updateGraphForNote } from "../services/graphEngine.js";

const router = Router();
router.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// POST /api/subjects/:id/notes
// Accepts either JSON { title, content } for a typed note, or a
// multipart/form-data upload with a `file` field (image) for OCR ingestion.
router.post("/:id/notes", upload.single("file"), async (req, res) => {
  const subject = await findOwnedSubject(req.params.id, req.user.id);
  if (!subject) return res.status(404).json({ error: "subject not found" });

  let { title, content } = req.body || {};
  let sourceType = "typed";
  let ocrFailed = false;

  if (req.file) {
    sourceType = "image";
    const { text, ocrFailed: failed } = await extractTextFromImage(req.file.buffer);
    content = text;
    ocrFailed = failed;
    title = title || req.file.originalname;
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

  const edges = await updateGraphForNote(note, existingNotes);

  res.status(201).json({ note, edgesCreated: edges.length });
});

router.get("/:id/notes", async (req, res) => {
  const subject = await findOwnedSubject(req.params.id, req.user.id);
  if (!subject) return res.status(404).json({ error: "subject not found" });

  const notes = await findNotesBySubject(subject._id);
  res.json({ notes });
});

export default router;
