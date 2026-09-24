import { Router } from "express";
import { findOwnedSubject } from "../models/Subject.js";
import { findNotesBySubject, setTextbookRefs } from "../models/Note.js";
import {
  createTextbook,
  createTextbookChunks,
  findTextbooksBySubject,
  findOwnedChunk,
  findOwnedTextbook,
  loadSubjectLibrary,
  publicTextbook,
} from "../models/Textbook.js";
import { requireAuth } from "../middleware/auth.js";
import { classifyUpload, extractPdfPages, extractTextFromDocument, titleFromFilename } from "../services/documentText.js";
import { chunkPages, chunkPlainText, findReferences, indexChunks } from "../services/textbook.js";
import { uploadSingle } from "../middleware/upload.js";

const router = Router();
router.use(requireAuth);

const MAX_TEXTBOOK_MB = 50;

// POST /api/subjects/:id/textbooks  (multipart: `file`, optional `title`)
// Upload a reference textbook: split it into page-range passages, index them,
// then (re)link every note in the subject to its best-matching passages.
router.post("/subjects/:id/textbooks", uploadSingle("file", MAX_TEXTBOOK_MB), async (req, res) => {
  const subject = await findOwnedSubject(req.params.id, req.user.id);
  if (!subject) return res.status(404).json({ error: "subject not found" });
  if (!req.file) return res.status(400).json({ error: "attach the textbook as `file`" });

  const kind = classifyUpload(req.file);
  if (!kind || kind === "image") {
    return res.status(400).json({ error: "upload the textbook as a PDF, Word (.docx) or text file" });
  }

  let rawChunks;
  let pageCount = null;
  let skippedPages = 0;
  try {
    if (kind === "pdf") {
      const pages = await extractPdfPages(req.file.buffer);
      pageCount = pages.length;
      ({ chunks: rawChunks, skippedPages } = chunkPages(pages));
    } else {
      const { text } = await extractTextFromDocument(req.file, kind);
      rawChunks = chunkPlainText(text);
    }
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!rawChunks.length) {
    return res.status(400).json({
      error: "no readable text found in this textbook (a scanned book needs a text layer - run it through OCR first)",
    });
  }

  const { chunks, df, numDocs } = indexChunks(rawChunks);
  const textbook = await createTextbook({
    ownerId: req.user.id,
    subjectId: subject._id,
    title: (req.body?.title || "").trim() || titleFromFilename(req.file.originalname) || "Textbook",
    sourceFile: req.file.originalname,
    fileType: kind,
    pageCount,
    skippedPages,
    df,
    numDocs,
  });
  await createTextbookChunks(textbook, chunks);

  // Re-link every existing note now that there is more reference material.
  const library = await loadSubjectLibrary(subject._id);
  const notes = await findNotesBySubject(subject._id);
  let notesLinked = 0;
  for (const note of notes) {
    const refs = findReferences(`${note.title}\n${note.rawText}`, library);
    await setTextbookRefs(note._id, refs);
    if (refs.some((r) => String(r.textbookId) === String(textbook._id))) notesLinked++;
  }

  res.status(201).json({ textbook: publicTextbook(textbook), chunkCount: chunks.length, notesLinked });
});

router.get("/subjects/:id/textbooks", async (req, res) => {
  const subject = await findOwnedSubject(req.params.id, req.user.id);
  if (!subject) return res.status(404).json({ error: "subject not found" });
  const textbooks = await findTextbooksBySubject(subject._id);
  res.json({ textbooks: textbooks.map(publicTextbook) });
});

// GET /api/textbooks/:id/chunks/:chunkId - the full text of one passage, for
// "read this in the textbook" links on a note.
router.get("/textbooks/:id/chunks/:chunkId", async (req, res) => {
  const textbook = await findOwnedTextbook(req.params.id, req.user.id);
  const chunk = textbook && (await findOwnedChunk(req.params.chunkId, req.user.id));
  if (!chunk || String(chunk.textbookId) !== String(textbook._id)) {
    return res.status(404).json({ error: "passage not found" });
  }
  const { vector, ...rest } = chunk;
  res.json({ chunk: rest, textbook: publicTextbook(textbook) });
});

export default router;
