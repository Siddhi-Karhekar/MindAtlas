// Files -> notes, the way the app does it, without a database.
//
// The evaluation has to run on notes exactly as a student's upload would
// produce them: same text extraction, same split into subtopics, same
// keywords. This mirrors what POST /api/subjects/:id/notes does in
// routes/notes.js - the same service calls in the same order - minus saving
// anything and minus the knowledge graph, which question generation does not
// read. test/evaluation.test.mjs uploads a file through the real API and
// checks that both paths give the same notes, so the two cannot drift apart
// unnoticed.
//
// Each file is treated as its own subject: a note's keywords are judged
// against the other subtopics of the same document only.

import fs from "node:fs";
import path from "node:path";
import { extractTextFromImage } from "../../src/services/ocr.js";
import { blocksFromOcrLines, classifyUpload, extractDocument, titleFromFilename } from "../../src/services/documentText.js";
import { blocksFromPlainText, normalizeContent, segmentDocument } from "../../src/services/documentStructure.js";
import { computeTfidf } from "../../src/services/tfidf.js";

const NO_SPLIT = { sections: [], method: "none", docTitle: null };

/**
 * Read one file into the topic notes questions are generated from.
 * Returns { file, title, kind, splitMethod, fullText, notes } where `notes`
 * are the leaf notes (the subtopics of a split document, or the one note).
 * Throws the same student-facing errors the upload route would.
 */
export async function notesFromFile(filePath, { idPrefix = "doc" } = {}) {
  const file = { originalname: path.basename(filePath), mimetype: "", buffer: fs.readFileSync(filePath) };
  const kind = classifyUpload(file);
  if (!kind) throw new Error(`unsupported file type: ${file.originalname}`);

  let text;
  let blocks;
  let sourceType = "file";
  if (kind === "image") {
    const ocr = await extractTextFromImage(file.buffer);
    if (!ocr.text) throw new Error(ocr.ocrFailed ? "could not read this image" : "no readable text found in this image");
    const page = ocr.lines?.length ? blocksFromOcrLines(ocr.lines) : null;
    text = page?.text || ocr.text;
    blocks = page?.blocks || blocksFromPlainText(ocr.text, { ocr: true });
    sourceType = "image";
  } else {
    ({ text, blocks } = await extractDocument(file, kind));
    if (!text) throw new Error("no readable text found in this file");
  }

  let seg = segmentDocument(blocks);
  if (sourceType !== "file" && seg.method === "chunks") seg = NO_SPLIT;
  const fileTitle = titleFromFilename(file.originalname) || file.originalname;
  const title = seg.sections.length >= 2 && seg.docTitle ? seg.docTitle : fileTitle;
  const base = { ownerId: "evaluation", subjectId: idPrefix, sourceType, ocrFailed: false };

  if (seg.sections.length < 2) {
    const { keywords, vector } = computeTfidf(text, []);
    const note = { ...base, _id: `${idPrefix}-0`, title, rawText: text.trim(), keywords, vector, content: normalizeContent(blocks, { title }), path: [], parentNoteId: null, childCount: 0 };
    return { file: file.originalname, title, kind, splitMethod: "none", fullText: text, notes: [note] };
  }

  const texts = seg.sections.map((s) => s.text);
  const notes = seg.sections.map((s, i) => {
    const { keywords, vector } = computeTfidf(s.text, texts.filter((_, j) => j !== i));
    return {
      ...base,
      _id: `${idPrefix}-${i + 1}`,
      title: s.title,
      rawText: s.text,
      keywords,
      vector,
      content: s.content,
      path: s.path || [],
      sectionGroup: s.group || null,
      parentNoteId: `${idPrefix}-0`,
      order: i,
      // what routes/tests.js adds before generating (resolveTopicNotes)
      topicLabel: `${title} › ${s.title}`,
      parentTopicId: `${idPrefix}-0`,
      parentTopic: title,
    };
  });
  return { file: file.originalname, title, kind, splitMethod: seg.method, fullText: text, notes };
}

const SUPPORTED = /\.(pdf|docx|pptx|txt|md|markdown|text|png|jpe?g|gif|webp|bmp|tiff?)$/i;
const LABELS_SUFFIX = ".offtopic.txt";
// a label file sits beside the notes it describes and a README describes the
// folder; neither is itself a note
const isNoteFile = (name) => SUPPORTED.test(name) && !name.toLowerCase().endsWith(LABELS_SUFFIX) && !/^readme\./i.test(name);

/** Expand files and folders (one level deep) into a sorted list of readable note files. */
export function collectFiles(inputs) {
  const out = [];
  for (const input of inputs) {
    if (!fs.existsSync(input)) throw new Error(`not found: ${input}`);
    const stat = fs.statSync(input);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(input).sort()) {
        const full = path.join(input, name);
        if (fs.statSync(full).isFile() && isNoteFile(name)) out.push(full);
      }
    } else if (isNoteFile(path.basename(input))) out.push(input);
  }
  return [...new Set(out)];
}

/**
 * Hand-written labels for one file: lines of the document that are NOT subject
 * matter (the college name, "prepared by", an exercise). They live beside the
 * file as "<name>.offtopic.txt", one line or distinctive fragment per line;
 * blank lines and lines starting with # are ignored. Returns [] if none.
 */
export function readOffTopicLabels(filePath, labelsDir = null) {
  const name = `${path.basename(filePath)}${LABELS_SUFFIX}`;
  const candidates = [labelsDir && path.join(labelsDir, name), path.join(path.dirname(filePath), name)].filter(Boolean);
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) return [];
  return fs
    .readFileSync(found, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}
