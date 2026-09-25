import { Router } from "express";
import multer from "multer";
import { findOwnedSubject } from "../models/Subject.js";
import { createNote, findNotesBySubject, isSplitParent, setChildCount } from "../models/Note.js";
import { requireAuth } from "../middleware/auth.js";
import { extractTextFromImage } from "../services/ocr.js";
import { classifyUpload, extractDocument, titleFromFilename } from "../services/documentText.js";
import { blocksFromPlainText, countWords, segmentDocument } from "../services/documentStructure.js";
import { computeTfidf } from "../services/tfidf.js";
import { updateGraphForNote } from "../services/graphEngine.js";

const router = Router();
router.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const UNSUPPORTED =
  "unsupported file type - upload a PDF, Word (.docx), PowerPoint (.pptx), text/markdown file or an image";

// Multer rejects an over-limit file by throwing; turn that into the same kind
// of readable 400 every other upload problem gets, instead of a bare 500.
function acceptUpload(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "file is larger than 10 MB" });
    return res.status(400).json({ error: err.message || "could not read the upload" });
  });
}

/**
 * Read an uploaded file into { content, sourceType, ocrFailed, blocks }.
 * Throws an Error with a student-safe message on anything unreadable.
 */
async function readUpload(file) {
  const kind = classifyUpload(file);
  if (!kind) throw new Error(UNSUPPORTED);
  if (kind === "image") {
    // scanned / photographed notes: read with OCR. No structure to split on.
    const { text, ocrFailed } = await extractTextFromImage(file.buffer);
    return { kind, content: text, sourceType: "image", ocrFailed, blocks: null };
  }
  const { text, blocks } = await extractDocument(file, kind);
  if (!text) {
    throw new Error(
      kind === "pdf"
        ? "no readable text found in this file (if it is a scanned PDF, upload the pages as images instead)"
        : "no readable text found in this file"
    );
  }
  return { kind, content: text, sourceType: "file", ocrFailed: false, blocks };
}

// POST /api/subjects/:id/notes/preview - read an uploaded file and report how
// it WOULD be split, without saving anything. Lets the upload screen show the
// detected subtopics before the student commits.
router.post("/:id/notes/preview", acceptUpload, async (req, res) => {
  const subject = await findOwnedSubject(req.params.id, req.user.id);
  if (!subject) return res.status(404).json({ error: "subject not found" });
  if (!req.file) return res.status(400).json({ error: "attach a file to preview" });

  let read;
  try {
    read = await readUpload(req.file);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const seg = read.blocks ? segmentDocument(read.blocks) : { sections: [], method: "none", docTitle: null };
  res.json({
    kind: read.kind,
    title:
      (seg.sections.length >= 2 && seg.docTitle) || titleFromFilename(req.file.originalname) || req.file.originalname,
    detectedTitle: seg.docTitle,
    words: countWords(read.content),
    splitMethod: seg.method,
    sections: seg.sections.map((s) => ({
      title: s.title,
      group: s.group,
      words: countWords(s.text),
      excerpt: s.text.slice(0, 160),
    })),
  });
});

// POST /api/subjects/:id/notes
// Accepts either JSON { title, content } for a typed note, or a
// multipart/form-data upload with a `file` field: an image (read with OCR) or an
// existing document - PDF, .docx, .pptx, .txt/.md (text is extracted directly).
//
// A long document with detectable subtopics (headings, slide titles, or - as a
// fallback - evenly sized parts) is saved as one parent note plus a child note
// per subtopic. Send the form field split=false to keep it as a single note.
router.post("/:id/notes", acceptUpload, async (req, res) => {
  const subject = await findOwnedSubject(req.params.id, req.user.id);
  if (!subject) return res.status(404).json({ error: "subject not found" });

  let { title, content } = req.body || {};
  const userTitle = Boolean(title && String(title).trim());
  let sourceType = "typed";
  let ocrFailed = false;
  let blocks = null;
  const wantSplit = String(req.body?.split ?? "true").toLowerCase() !== "false";

  if (req.file) {
    try {
      ({ content, sourceType, ocrFailed, blocks } = await readUpload(req.file));
    } catch (err) {
      return res.status(400).json({ error: err.message });
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

  // Typed notes can be long, structured documents too (pasted lecture notes
  // with markdown headings), so they go through the same splitter.
  // Only real headings split a typed note, though - never the evenly-sized
  // "parts" fallback, which would be a surprise for text the student wrote.
  if (!blocks && sourceType === "typed" && wantSplit && content) blocks = blocksFromPlainText(content);
  let seg = wantSplit && blocks ? segmentDocument(blocks) : { sections: [], method: "none" };
  if (sourceType === "typed" && seg.method === "chunks") seg = { sections: [], method: "none" };
  // A file name like "unit3_final_v2" makes a worse title than the heading the
  // document gives itself, so an untitled upload uses its own title if found.
  if (req.file && !userTitle && seg.docTitle && seg.sections.length >= 2) title = seg.docTitle;

  // Split parents are containers whose text duplicates their children's, so
  // they are left out of both the TF-IDF corpus (it would double-count every
  // term) and the similarity comparison.
  const existingNotes = (await findNotesBySubject(subject._id)).filter((n) => !isSplitParent(n));
  const corpus = existingNotes.map((n) => n.rawText);

  if (seg.sections.length < 2) {
    const { vector, keywords } = computeTfidf(content, corpus);
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
    return res.status(201).json({ note, children: [], edgesCreated: edges.length });
  }

  // Parent: keeps the whole text for reading, and document-level keywords for
  // display, but is not itself a node the similarity graph links.
  const parentTfidf = computeTfidf(content, corpus);
  const parent = await createNote({
    ownerId: req.user.id,
    subjectId: subject._id,
    title: title.trim(),
    sourceType,
    rawText: content.trim(),
    keywords: parentTfidf.keywords,
    vector: parentTfidf.vector,
    ocrFailed,
    childCount: seg.sections.length,
    splitMethod: seg.method,
  });

  // Children: each subtopic's IDF is computed against the rest of the subject
  // AND its sibling sections, so its keywords are what make it distinct from
  // the other parts of the same document - "tlb, frames, offset" for Paging
  // rather than "memory, process" shared by every section.
  const sectionTexts = seg.sections.map((s) => s.text);
  const children = [];
  let edgesCreated = 0;
  const linkable = [...existingNotes];
  for (let i = 0; i < seg.sections.length; i++) {
    const s = seg.sections[i];
    const siblings = sectionTexts.filter((_, j) => j !== i);
    const { vector, keywords } = computeTfidf(s.text, [...corpus, ...siblings]);
    const child = await createNote({
      ownerId: req.user.id,
      subjectId: subject._id,
      title: s.title,
      sourceType,
      rawText: s.text,
      keywords,
      vector,
      ocrFailed: false,
      parentNoteId: parent._id,
      order: i,
      sectionGroup: s.group || null,
    });
    // Link against the rest of the subject and the siblings saved before it,
    // so related subtopics inside one document connect to each other too.
    const edges = await updateGraphForNote(child, linkable);
    edgesCreated += edges.length;
    linkable.push(child);
    children.push(child);
  }
  await setChildCount(parent._id, children.length);

  res.status(201).json({ note: { ...parent, childCount: children.length }, children, edgesCreated });
});

router.get("/:id/notes", async (req, res) => {
  const subject = await findOwnedSubject(req.params.id, req.user.id);
  if (!subject) return res.status(404).json({ error: "subject not found" });

  const notes = await findNotesBySubject(subject._id);
  res.json({ notes });
});

export default router;
