// Turn an uploaded file into note text. Images go through OCR (ocr.js);
// everything handled here is a "born-digital" document, where the text can be
// read straight out of the file with no OCR: plain text / markdown, Word
// (.docx), PowerPoint (.pptx) and PDF.
//
// Each extractor returns { text, blocks }:
//   - `text` is the whole document as plain paragraphs (what a single note
//     stores, exactly as before),
//   - `blocks` is the same content with its structure kept - headings (with a
//     level) and paragraphs - which documentStructure.js uses to split a long
//     document into one child note per subtopic.
// Errors are thrown with a message that is safe to show to the student.

import mammoth from "mammoth";
import JSZip from "jszip";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { blocksFromPlainText, looksLikeHeadingLine } from "./documentStructure.js";

const TEXT_EXT = new Set([".txt", ".md", ".markdown", ".text", ".csv"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"]);
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function extOf(name = "") {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

// Plain text as editors save it: UTF-8 (a leading BOM is dropped by tidy()'s
// trim), or UTF-16 with a byte-order mark - what Windows Notepad writes for
// "Unicode". Read as UTF-8, a UTF-16 file became a note full of NUL
// characters with no keywords. Anything still containing NULs, or mostly
// undecodable bytes, is binary data with a text extension, not notes.
function decodeText(buf) {
  let text;
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    text = buf.subarray(2).toString("utf16le");
  } else if (buf[0] === 0xfe && buf[1] === 0xff) {
    text = Buffer.from(buf.subarray(2, buf.length - (buf.length % 2))).swap16().toString("utf16le");
  } else {
    text = buf.toString("utf8");
  }
  const undecodable = text.match(/\uFFFD/g)?.length || 0;
  if (text.includes("\0") || undecodable > text.length / 10) {
    throw new Error("this does not look like a text file - save it as plain text (UTF-8) and upload again");
  }
  return text;
}

/** "image" | "text" | "docx" | "pptx" | "pdf" | null (unsupported) for an uploaded file. */
export function classifyUpload(file) {
  const ext = extOf(file.originalname);
  const mime = (file.mimetype || "").toLowerCase();
  if (mime.startsWith("image/") || IMAGE_EXT.has(ext)) return "image";
  if (ext === ".pdf" || mime === "application/pdf") return "pdf";
  if (ext === ".docx" || mime === DOCX_MIME) return "docx";
  if (ext === ".pptx" || mime === PPTX_MIME) return "pptx";
  if (TEXT_EXT.has(ext) || mime.startsWith("text/")) return "text";
  return null;
}

/** File name without its extension, as a default note title. */
export function titleFromFilename(name = "") {
  const base = name.replace(/\\/g, "/").split("/").pop() || "";
  const i = base.lastIndexOf(".");
  return (i > 0 ? base.slice(0, i) : base).replace(/[_]+/g, " ").trim();
}

function tidy(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function textFromBlocks(blocks) {
  return tidy(blocks.map((b) => b.text).join("\n\n"));
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

const stripTags = (html) => decodeEntities(String(html || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// DOCX: mammoth maps Word's "Heading 1..6" styles to <h1>..<h6>, which is the
// author's own structure - the most reliable signal there is. Documents
// written without heading styles often fake them with a short bold line; those
// are used only when no real headings exist.
// ---------------------------------------------------------------------------
async function extractDocx(buffer) {
  let html;
  try {
    ({ value: html } = await mammoth.convertToHtml(
      { buffer },
      { styleMap: ["p[style-name='Title'] => h6.doctitle:fresh", "p[style-name='Subtitle'] => p:fresh"] }
    ));
  } catch {
    throw new Error("could not read this Word file - is it a valid .docx?");
  }
  const blocks = [];
  const re = /<(h[1-6]|p|li|td|th)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[1];
    const text = stripTags(m[3]);
    if (!text) continue;
    if (/class="doctitle"/.test(m[2])) {
      blocks.push({ type: "title", text });
    } else if (tag[0] === "h" && tag !== "th") {
      blocks.push({ type: "heading", level: Number(tag[1]), text });
    } else {
      const inner = m[3].trim();
      const allBold = /^<strong>[\s\S]*<\/strong>$/.test(inner) && !/<\/strong>[\s\S]*<strong>/.test(inner);
      blocks.push({ type: "para", text, boldOnly: tag === "p" && allBold });
    }
  }
  if (!blocks.some((b) => b.type === "heading")) {
    for (const b of blocks) {
      const t = b.text;
      const shortLine = t.split(/\s+/).length <= 10 && !/[.?!;,]$/.test(t);
      if (b.boldOnly && shortLine) Object.assign(b, { type: "heading", level: 7 });
      else if (looksLikeHeadingLine(t)) Object.assign(b, { type: "heading", level: 8 });
    }
  }
  blocks.forEach((b) => delete b.boldOnly);
  return { text: textFromBlocks(blocks), blocks };
}

// ---------------------------------------------------------------------------
// PPTX: a zip of one XML file per slide. The slide's title placeholder is the
// natural subtopic name; everything else on the slide is its body. Slides are
// read in presentation order (presentation.xml), not file-name order.
// ---------------------------------------------------------------------------
function paragraphsFromXml(xml) {
  const paras = [];
  const re = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g;
  let m;
  while ((m = re.exec(xml))) {
    const runs = [...m[1].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((r) => decodeEntities(r[1]));
    const text = runs.join("").replace(/\s+/g, " ").trim();
    if (text) paras.push(text);
  }
  return paras;
}

async function slideOrder(zip) {
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const byNumber = [...names].sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  try {
    const pres = await zip.file("ppt/presentation.xml")?.async("string");
    const rels = await zip.file("ppt/_rels/presentation.xml.rels")?.async("string");
    if (!pres || !rels) return byNumber;
    const targetById = new Map(
      [...rels.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)].map((r) => [r[1], r[2]])
    );
    // attribute order varies between writers, so also accept Target before Id
    for (const r of rels.matchAll(/<Relationship\b[^>]*\bTarget="([^"]+)"[^>]*\bId="([^"]+)"/g)) targetById.set(r[2], r[1]);
    const ordered = [...pres.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)]
      .map((s) => targetById.get(s[1]))
      .filter(Boolean)
      .map((t) => `ppt/${t.replace(/^\.?\//, "").replace(/^\.\.\//, "")}`)
      .filter((n) => zip.files[n]);
    return ordered.length ? ordered : byNumber;
  } catch {
    return byNumber;
  }
}

async function extractPptx(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new Error("could not read this PowerPoint file - is it a valid .pptx?");
  }
  const slides = await slideOrder(zip);
  if (slides.length === 0) throw new Error("could not read this PowerPoint file - no slides found");

  const blocks = [];
  for (const name of slides) {
    const xml = await zip.file(name).async("string");
    const shapes = xml.match(/<p:(sp|graphicFrame)\b[\s\S]*?<\/p:\1>/g) || [];
    let title = null;
    let isCoverSlide = false;
    const body = [];
    for (const shape of shapes) {
      const ph = shape.match(/<p:ph\b[^>]*\btype="([^"]+)"/);
      const type = ph?.[1];
      const paras = paragraphsFromXml(shape);
      if (!paras.length) continue;
      if ((type === "title" || type === "ctrTitle") && !title) {
        title = paras.join(" ");
        if (type === "ctrTitle") isCoverSlide = true;
      } else if (type === "sldNum" || type === "dt" || type === "ftr") {
        continue; // slide number, date, footer: repeated noise
      } else {
        body.push(...paras);
      }
    }
    // A cover slide's title is the deck's title (level 1); ordinary slide
    // titles are its subtopics (level 2).
    if (title) blocks.push({ type: "heading", level: isCoverSlide ? 1 : 2, text: title });
    if (body.length) blocks.push({ type: "para", text: body.join("\n") });
  }
  const text = textFromBlocks(blocks);
  if (!text) throw new Error("no readable text found in this PowerPoint file");
  return { text, blocks };
}

// ---------------------------------------------------------------------------
// PDF: no semantic structure, so headings are recovered from typography.
// Lines set noticeably larger than the body text are headings (bigger = higher
// level); body-size lines only count when they carry explicit numbering
// ("2.3 Paging", "Unit 4 ..."). Running headers/footers and page numbers that
// repeat on most pages are dropped before anything else, otherwise a course
// name printed at the top of every slide would look like 20 identical headings.
// ---------------------------------------------------------------------------
const round = (x) => Math.round(x * 2) / 2;

function pageLines(content) {
  const lines = [];
  let text = "";
  let y = null;
  let size = 0;
  const flush = () => {
    if (text.trim()) lines.push({ text: text.replace(/\s+/g, " ").trim(), y, size });
    text = "";
    size = 0;
  };
  for (const item of content.items) {
    if (!("str" in item)) continue;
    const t = item.transform || [];
    const iy = t[5];
    if (y !== null && iy !== undefined && Math.abs(iy - y) > 2) flush();
    if (iy !== undefined) y = iy;
    text += item.str;
    if (item.str.trim()) size = Math.max(size, Math.hypot(t[2] || 0, t[3] || 0) || item.height || 0);
    if (item.hasEOL) flush();
  }
  flush();
  return lines;
}

async function extractPdf(buffer) {
  let pdf;
  try {
    pdf = await getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: true,
      isEvalSupported: false,
      verbosity: 0,
    }).promise;
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      pages.push(pageLines(await page.getTextContent()));
      page.cleanup();
    }
    return buildPdfBlocks(pages);
  } catch (err) {
    console.error("[pdf] extraction failed:", err.message);
    throw new Error("could not read this PDF - it may be damaged or password-protected");
  } finally {
    if (pdf) await pdf.destroy().catch(() => {});
  }
}

export function buildPdfBlocks(pages) {
  // 1. running headers / footers / page numbers
  const norm = (t) => t.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  const pageCount = new Map();
  pages.forEach((lines) => {
    for (const key of new Set(lines.map((l) => norm(l.text)))) pageCount.set(key, (pageCount.get(key) || 0) + 1);
  });
  const repeatThreshold = Math.max(2, Math.ceil(pages.length * 0.6));
  const isNoise = (l) =>
    /^(page\s*)?#(\s*(of|\/)\s*#)?$/.test(norm(l.text)) || (pages.length >= 2 && pageCount.get(norm(l.text)) >= repeatThreshold);
  const cleanPages = pages.map((lines) => lines.filter((l) => !isNoise(l)));

  // 2. body size = the size carrying the most characters
  const charsBySize = new Map();
  cleanPages.flat().forEach((l) => {
    const s = round(l.size);
    charsBySize.set(s, (charsBySize.get(s) || 0) + l.text.length);
  });
  let body = 0;
  let most = -1;
  for (const [s, c] of charsBySize) if (c > most) [body, most] = [s, c];

  // 3. heading candidates by size, then rank sizes into levels
  const bigEnough = (l) => body > 0 && l.size >= body * 1.15;
  const headingish = (t) =>
    t.split(/\s+/).length <= 14 && /[A-Za-z]{2,}/.test(t) && !/[.;,]$/.test(t) && !/\.{3,}|…/.test(t);
  const headingSizes = [
    ...new Set(cleanPages.flat().filter((l) => bigEnough(l) && headingish(l.text)).map((l) => round(l.size))),
  ].sort((a, b) => b - a);
  const levelOfSize = new Map(headingSizes.map((s, i) => [s, i + 1]));
  const numberedBase = headingSizes.length + 1;

  const blocks = [];
  for (const lines of cleanPages) {
    // paragraph reconstruction for body lines: a gap noticeably larger than
    // the page's typical line spacing is a paragraph break
    const gaps = [];
    for (let i = 1; i < lines.length; i++) gaps.push(Math.abs(lines[i - 1].y - lines[i].y));
    const typical = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0;

    let para = "";
    let prev = null;
    let lastHeading = null;
    const flushPara = () => {
      if (para.trim()) blocks.push({ type: "para", text: para.trim() });
      para = "";
    };
    for (const l of lines) {
      let level = null;
      if (bigEnough(l) && headingish(l.text)) level = levelOfSize.get(round(l.size));
      else if (looksLikeHeadingLine(l.text)) {
        const m = l.text.match(/^(\d+(?:\.\d+)*)/);
        level = numberedBase + (m ? m[1].split(".").length : 0);
      }
      if (level) {
        flushPara();
        // a heading that wraps onto a second line at the same size is one heading
        if (lastHeading && prev === lastHeading && lastHeading.level === level && Math.abs(prev.y - l.y) < l.size * 2) {
          lastHeading.text += ` ${l.text}`;
          lastHeading.y = l.y;
        } else {
          lastHeading = { type: "heading", level, text: l.text, y: l.y };
          blocks.push(lastHeading);
        }
        prev = lastHeading;
        continue;
      }
      const gap = prev && prev.y !== undefined ? Math.abs(prev.y - l.y) : 0;
      if (!para) para = l.text;
      else if (typical && gap > typical * 1.5) {
        flushPara();
        para = l.text;
      } else if (para.endsWith("-") && /^[a-z]/.test(l.text)) para = para.slice(0, -1) + l.text;
      else para += ` ${l.text}`;
      prev = l;
    }
    flushPara();
  }
  blocks.forEach((b) => delete b.y);
  return { text: textFromBlocks(blocks), blocks };
}

/**
 * Extract text (and structure) from an uploaded document of the given kind.
 * Returns { text, blocks }.
 */
export async function extractDocument(file, kind) {
  if (kind === "text") {
    const text = tidy(decodeText(file.buffer));
    return { text, blocks: blocksFromPlainText(text) };
  }
  if (kind === "docx") return extractDocx(file.buffer);
  if (kind === "pptx") return extractPptx(file.buffer);
  if (kind === "pdf") return extractPdf(file.buffer);
  throw new Error("unsupported file type");
}

/** Backwards-compatible name: same as extractDocument. */
export const extractTextFromDocument = extractDocument;
