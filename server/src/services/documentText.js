// Turn an uploaded file into note text. Images go through OCR (ocr.js);
// everything handled here is a "born-digital" document, where the text can be
// read straight out of the file with no OCR: plain text / markdown, Word
// (.docx), PowerPoint (.pptx) and PDF.
//
// Each extractor returns { text, blocks }:
//   - `text` is the whole document as plain paragraphs (what a note stores as
//     `rawText`, and what questions quote from),
//   - `blocks` is the same content with its structure kept - headings (with a
//     level), paragraphs, list entries (bulleted or numbered, with their
//     nesting depth), tables and the terms the author set in bold.
//     documentStructure.js uses the headings to split a long document into one
//     child note per subtopic, and the rest becomes each note's formatted
//     `content` (the block shapes are listed at the top of that file).
// Errors are thrown with a message that is safe to show to the student.

import mammoth from "mammoth";
import JSZip from "jszip";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { blocksFromPlainText, blocksToText, inferHeadings, listLine, looksLikeHeadingLine } from "./documentStructure.js";

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

// Trailing spaces are cut line by line with trimEnd, not with a pattern such
// as /[ \t]+\n/: on a long run of spaces that is not followed by a line break
// a pattern like that retries from every space, and a 200 KB file of spaces
// held the server for half a minute.
const trimLineEnd = (line) => {
  let end = line.length;
  while (end > 0 && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end -= 1;
  return end === line.length ? line : line.slice(0, end);
};
function tidy(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(trimLineEnd)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function textFromBlocks(blocks) {
  return tidy(blocksToText(blocks));
}

// A bold run only counts as a key term when it is a term: a few words, not a
// whole bold sentence.
const MAX_TERM_WORDS = 6;
const isTerm = (t) => t.length >= 2 && t.split(/\s+/).length <= MAX_TERM_WORDS && /[A-Za-z0-9]/.test(t);
const uniqueTerms = (terms) => [...new Set(terms.map((t) => t.replace(/\s+/g, " ").replace(/^[\s:,.;-]+|[\s:,.;-]+$/g, "")).filter(isTerm))];
const lettersOf = (t) => String(t || "").replace(/\s+/g, "").length;

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
/**
 * Walk mammoth's HTML in order, keeping what the old tag-stripping lost: which
 * lines are list entries and how deeply they are nested, which cells belong to
 * one table, and which words are bold.
 */
export function blocksFromHtml(html) {
  const blocks = [];
  const lists = []; // open <ul>/<ol>, outermost first
  let leaf = null; // the block that text is currently collected into
  let table = null;
  let row = null;
  let cell = null;
  let boldDepth = 0;
  let boldRun = "";

  const squash = (t) => t.replace(/\s+/g, " ").trim();
  const close = () => {
    if (!leaf) return;
    const text = squash(leaf.text);
    if (text) {
      const allBold = leaf.boldChars >= lettersOf(text) && leaf.boldChars > 0;
      const strong = allBold ? [] : uniqueTerms(leaf.strong);
      if (leaf.kind === "title") blocks.push({ type: "title", text });
      else if (leaf.kind === "heading") blocks.push({ type: "heading", level: leaf.level, text });
      else if (leaf.kind === "item") {
        blocks.push({ type: "item", text, depth: leaf.depth, ordered: leaf.ordered, ...(strong.length ? { strong } : {}) });
      } else blocks.push({ type: "para", text, ...(strong.length ? { strong } : {}), ...(allBold ? { boldOnly: true } : {}) });
    }
    leaf = null;
  };
  const open = (init) => {
    close();
    leaf = { text: "", strong: [], boldChars: 0, ...init };
  };

  const re = /<(\/?)([a-z][a-z0-9]*)\b([^>]*)>|([^<]+)/gi;
  let m;
  while ((m = re.exec(html))) {
    if (m[4] !== undefined) {
      const t = decodeEntities(m[4]);
      if (cell) cell.text += t;
      else if (leaf) {
        leaf.text += t;
        if (boldDepth) {
          boldRun += t;
          leaf.boldChars += lettersOf(t);
        }
      }
      continue;
    }
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      if (closing) close();
      else open(/class="doctitle"/.test(m[3]) ? { kind: "title" } : { kind: "heading", level: Number(tag[1]) });
    } else if (tag === "p") {
      if (cell) cell.text += " ";
      else if (leaf?.kind === "item") leaf.text += " "; // a paragraph inside a list entry
      else if (closing) close();
      else open({ kind: "para" });
    } else if (tag === "ul" || tag === "ol") {
      close(); // an entry's own text ends where its nested list begins
      if (closing) lists.pop();
      else lists.push({ ordered: tag === "ol" });
    } else if (tag === "li") {
      if (closing) close();
      else open({ kind: "item", depth: Math.max(0, lists.length - 1), ordered: Boolean(lists[lists.length - 1]?.ordered) });
    } else if (tag === "table") {
      close();
      if (!closing) table = { rows: [] };
      else if (table) {
        const rows = table.rows.filter((r) => r.some(Boolean));
        // one paragraph per cell, as before, so the stored text is unchanged
        if (rows.length) blocks.push({ type: "table", rows, text: rows.flat().filter(Boolean).join("\n\n") });
        table = null;
      }
    } else if (tag === "tr") {
      if (!closing) row = [];
      else if (table && row) table.rows.push(row);
    } else if (tag === "td" || tag === "th") {
      if (!closing) cell = { text: "" };
      else if (cell) {
        if (row) row.push(squash(cell.text));
        cell = null;
      }
    } else if (tag === "strong" || tag === "b") {
      if (!closing) {
        if (boldDepth++ === 0) boldRun = "";
      } else if (boldDepth > 0 && --boldDepth === 0 && leaf) leaf.strong.push(boldRun);
    } else if (tag === "br") {
      if (cell) cell.text += " ";
      else if (leaf) leaf.text += " ";
    }
  }
  close();
  return blocks;
}

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
  const blocks = blocksFromHtml(html);
  const hasHeadings = blocks.some((b) => b.type === "heading");
  for (const b of blocks) {
    if (b.type !== "para") continue;
    const t = b.text;
    const shortLine = t.split(/\s+/).length <= 10 && !/[.?!;,]$/.test(t);
    if (b.boldOnly && shortLine) {
      // No heading styles at all: a short bold line is the author's heading.
      // In a document that does use them it is a run-in label ("Advantages").
      Object.assign(b, hasHeadings ? { type: "label" } : { type: "heading", level: 7 });
    } else if (!hasHeadings && looksLikeHeadingLine(t)) Object.assign(b, { type: "heading", level: 8 });
  }
  blocks.forEach((b) => delete b.boldOnly);
  return { text: textFromBlocks(blocks), blocks };
}

// ---------------------------------------------------------------------------
// PPTX: a zip of one XML file per slide. The slide's title placeholder is the
// natural subtopic name; everything else on the slide is its body. Slides are
// read in presentation order (presentation.xml), not file-name order.
// ---------------------------------------------------------------------------
// One <a:p> of a slide: its text, outline level, bullet setting and bold runs.
function paragraphsFromXml(xml) {
  const paras = [];
  const re = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g;
  let m;
  while ((m = re.exec(xml))) {
    const inner = m[1];
    const pPr = inner.match(/<a:pPr\b([^>]*?)(?:\/>|>([\s\S]*?)<\/a:pPr>)/);
    const level = Number(pPr?.[1].match(/\blvl="(\d+)"/)?.[1] || 0);
    const props = pPr?.[2] || "";
    const bullet = /<a:buNone\b/.test(props) ? "none" : /<a:buAutoNum\b/.test(props) ? "number" : /<a:buChar\b/.test(props) ? "char" : null;
    let text = "";
    let boldChars = 0;
    const strong = [];
    for (const r of inner.matchAll(/<a:(r|fld)\b[^>]*>([\s\S]*?)<\/a:\1>|<a:br\b[^>]*\/?>/g)) {
      if (!r[1]) {
        text += " ";
        continue;
      }
      const t = [...r[2].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((x) => decodeEntities(x[1])).join("");
      text += t;
      if (/<a:rPr\b[^>]*\bb="1"/.test(r[2])) {
        boldChars += lettersOf(t);
        // neighbouring bold runs are one term ("Three-" + "way handshake")
        if (strong.length && text.endsWith(strong[strong.length - 1] + t)) strong[strong.length - 1] += t;
        else strong.push(t);
      }
    }
    text = text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const allBold = boldChars > 0 && boldChars >= lettersOf(text);
    paras.push({ text, level, bullet, strong: allBold ? [] : uniqueTerms(strong), allBold });
  }
  return paras;
}

// A table on a slide: rows of cells.
function tableFromXml(shape) {
  const rows = [...shape.matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g)].map((tr) =>
    [...tr[1].matchAll(/<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/g)].map((tc) =>
      paragraphsFromXml(tc[1])
        .map((p) => p.text)
        .join(" ")
    )
  );
  return rows.filter((r) => r.some(Boolean));
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

// Slides that open a new part of the deck. Two ways an author says so:
// PowerPoint's own sections (the names in the slide sorter), or a slide built
// on the "Section Header" layout. Either gives the deck a middle level -
// deck > section > slide - instead of one long flat run of slides.
async function deckSections(zip, slides) {
  const sectionAt = new Map(); // slide file -> section name that starts there
  const dividers = new Set(); // slide files using the Section Header layout
  try {
    const pres = (await zip.file("ppt/presentation.xml")?.async("string")) || "";
    const rels = (await zip.file("ppt/_rels/presentation.xml.rels")?.async("string")) || "";
    const targetById = new Map();
    for (const r of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = r[0].match(/\bId="([^"]+)"/)?.[1];
      const target = r[0].match(/\bTarget="([^"]+)"/)?.[1];
      if (id && target) targetById.set(id, `ppt/${target.replace(/^\.?\//, "").replace(/^\.\.\//, "")}`);
    }
    const fileBySlideId = new Map(
      [...pres.matchAll(/<p:sldId\b[^>]*>/g)].map((x) => [x[0].match(/\bid="(\d+)"/)?.[1], targetById.get(x[0].match(/\br:id="([^"]+)"/)?.[1])])
    );
    const named = [...pres.matchAll(/<p14:section\b([^>]*)>([\s\S]*?)<\/p14:section>/g)]
      .map((x) => ({
        name: decodeEntities(x[1].match(/\bname="([^"]*)"/)?.[1] || "").trim(),
        first: fileBySlideId.get(x[2].match(/<p14:sldId\b[^>]*\bid="(\d+)"/)?.[1]),
      }))
      .filter((x) => x.first && x.name && !/^(default|untitled) section$/i.test(x.name));
    if (named.length >= 2) for (const x of named) sectionAt.set(x.first, x.name);
  } catch {
    // no usable section list: fall through to layouts
  }
  for (const name of slides) {
    try {
      const rel = await zip.file(name.replace(/slides\/(slide\d+\.xml)$/, "slides/_rels/$1.rels"))?.async("string");
      const layout = rel?.match(/Target="\.\.\/(slideLayouts\/slideLayout\d+\.xml)"/)?.[1];
      const xml = layout && (await zip.file(`ppt/${layout}`)?.async("string"));
      if (xml && /<p:sldLayout\b[^>]*\btype="secHead"/.test(xml)) dividers.add(name);
    } catch {
      // unreadable layout: treat as an ordinary slide
    }
  }
  return { sectionAt, dividers };
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
  const { sectionAt, dividers } = await deckSections(zip, slides);
  const useNamed = sectionAt.size > 0;
  // with sections, ordinary slides sit one level below them
  const slideLevel = useNamed || dividers.size > 0 ? 3 : 2;
  const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

  const blocks = [];
  for (const name of slides) {
    const xml = await zip.file(name).async("string");
    const shapes = xml.match(/<p:(sp|graphicFrame)\b[\s\S]*?<\/p:\1>/g) || [];
    let title = null;
    let isCoverSlide = false;
    const body = [];
    for (const shape of shapes) {
      const ph = shape.match(/<p:ph\b([^>]*)>/);
      const type = ph ? ph[1].match(/\btype="([^"]+)"/)?.[1] || "body" : null;
      if (type === "sldNum" || type === "dt" || type === "ftr") continue; // slide number, date, footer: repeated noise
      if (/<a:tbl\b/.test(shape)) {
        const rows = tableFromXml(shape);
        if (rows.length) body.push({ type: "table", rows, text: rows.flat().filter(Boolean).join("\n") });
        continue;
      }
      const paras = paragraphsFromXml(shape);
      if (!paras.length) continue;
      if ((type === "title" || type === "ctrTitle") && !title) {
        title = paras.map((p) => p.text).join(" ");
        if (type === "ctrTitle") isCoverSlide = true;
        continue;
      }
      // Content placeholders are bulleted unless the slide says otherwise; a
      // lone paragraph in one is prose, not a one-entry list. Text boxes and
      // subtitles are bulleted only when they ask for it.
      const outline = (type === "body" || type === "obj") && paras.length > 1;
      for (const p of paras) {
        const listed = p.bullet === "number" || p.bullet === "char" || (outline && p.bullet !== "none");
        const strong = p.strong.length ? { strong: p.strong } : {};
        // a short all-bold line, bulleted or not, is a heading inside the slide
        if (p.allBold && p.text.split(/\s+/).length <= 8 && !/[.?!;,]$/.test(p.text)) body.push({ type: "label", text: p.text });
        else if (listed) body.push({ type: "item", text: p.text, depth: p.level, ordered: p.bullet === "number", ...strong });
        else body.push({ type: "para", text: p.text, ...strong });
      }
    }
    // the lines of one slide stay together in the stored text
    body.forEach((b, i) => {
      if (i > 0) b.tight = true;
    });

    if (useNamed && sectionAt.has(name)) blocks.push({ type: "heading", level: 2, text: sectionAt.get(name) });
    if (title) {
      // A cover slide's title is the deck's title (level 1); a section divider
      // opens a section (level 2); ordinary slide titles are the subtopics.
      const divider = dividers.has(name);
      if (isCoverSlide && !divider) blocks.push({ type: "heading", level: 1, text: title });
      else if (useNamed && sectionAt.has(name) && (divider || same(title, sectionAt.get(name)))) {
        // the divider slide just repeats the section name: no second heading
      } else if (divider && !useNamed) blocks.push({ type: "heading", level: 2, text: title });
      else blocks.push({ type: "heading", level: slideLevel, text: title });
    }
    blocks.push(...body);
  }
  const text = textFromBlocks(blocks);
  if (!text) throw new Error("no readable text found in this PowerPoint file");
  return { text, blocks };
}

// ---------------------------------------------------------------------------
// PDF: no semantic structure, so headings are recovered from typography.
// Lines set noticeably larger than the body text are headings (bigger = higher
// level); body-size lines only count when they carry explicit numbering
// ("2.3 Paging", "Unit 4 ...") or are a bold line of their own. Running
// headers/footers and page numbers that repeat on most pages are dropped
// before anything else, otherwise a course name printed at the top of every
// slide would look like 20 identical headings.
// Lists are recovered the same way: a line that opens with a bullet glyph or a
// number is a list entry, its left edge gives the nesting depth, and wrapped
// lines hanging under it belong to it.
// ---------------------------------------------------------------------------
const round = (x) => Math.round(x * 2) / 2;

// `boldFonts` holds the ids of the page's bold fonts (empty if unknown).
function pageLines(content, boldFonts = new Set()) {
  const lines = [];
  let text = "";
  let y = null;
  let x;
  let size = 0;
  let chars = 0;
  let boldChars = 0;
  let strong = [];
  let lastBold = false;
  const flush = () => {
    if (text.trim()) {
      const bold = chars > 0 && boldChars >= chars;
      lines.push({ text: text.replace(/\s+/g, " ").trim(), y, x, size, bold, strong: bold ? [] : strong });
    }
    text = "";
    size = 0;
    x = undefined;
    chars = 0;
    boldChars = 0;
    strong = [];
    lastBold = false;
  };
  for (const item of content.items) {
    if (!("str" in item)) continue;
    const t = item.transform || [];
    const iy = t[5];
    if (y !== null && iy !== undefined && Math.abs(iy - y) > 2) flush();
    if (iy !== undefined) y = iy;
    text += item.str;
    if (item.str.trim()) {
      if (x === undefined) x = t[4];
      size = Math.max(size, Math.hypot(t[2] || 0, t[3] || 0) || item.height || 0);
      const n = lettersOf(item.str);
      chars += n;
      const isBold = boldFonts.has(item.fontName);
      if (isBold) {
        boldChars += n;
        if (lastBold && strong.length) strong[strong.length - 1] += item.str;
        else strong.push(item.str);
      }
      lastBold = isBold;
    } else if (lastBold && strong.length) strong[strong.length - 1] += item.str;
    if (item.hasEOL) flush();
  }
  flush();
  return lines;
}

// Which of a page's fonts are bold. pdf.js only knows a font's real name once
// the page's drawing commands are loaded; if that fails the page simply has no
// bold information, which costs emphasis and nothing else.
async function boldFontsOf(page, content) {
  const bold = new Set();
  try {
    await page.getOperatorList();
    for (const id of new Set(content.items.map((i) => i.fontName).filter(Boolean))) {
      const name = page.commonObjs.has(id) ? page.commonObjs.get(id)?.name : "";
      if (/bold|black|heavy|semibold|demi/i.test(name || "")) bold.add(id);
    }
  } catch {
    // no font names available
  }
  return bold;
}

// Parsing is done page by page on the one thread every request shares, so a
// very long PDF would hold everyone else up.
const MAX_PDF_PAGES = 400;
class TooLong extends Error {
  constructor(pages) {
    super("too many pages");
    this.pages = pages;
  }
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
    if (pdf.numPages > MAX_PDF_PAGES) throw new TooLong(pdf.numPages);
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      pages.push(pageLines(content, await boldFontsOf(page, content)));
      page.cleanup();
    }
    return buildPdfBlocks(pages);
  } catch (err) {
    if (err instanceof TooLong) {
      throw new Error(`this PDF has ${err.pages} pages - the limit is ${MAX_PDF_PAGES}. Upload it in parts`);
    }
    console.error("[pdf] extraction failed:", err.message);
    throw new Error("could not read this PDF - it may be damaged or password-protected");
  } finally {
    if (pdf) await pdf.destroy().catch(() => {});
  }
}

/**
 * Lines with positions and sizes -> blocks.
 * `headingRatio`: how much larger than body text a line must be to count as a
 * heading. `sizeTolerance`: sizes this close together (as a fraction) are one
 * heading level - 0 for a PDF, where sizes are exact; a photo needs some give,
 * since the same handwriting or print never measures identically twice.
 */
export function buildPdfBlocks(pages, { headingRatio = 1.15, sizeTolerance = 0 } = {}) {
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
  const bigEnough = (l) => body > 0 && l.size >= body * headingRatio;
  const headingish = (t) =>
    t.split(/\s+/).length <= 14 && /[A-Za-z]{2,}/.test(t) && !/[.;,]$/.test(t) && !/\.{3,}|…/.test(t);
  const headingSizes = [
    ...new Set(cleanPages.flat().filter((l) => bigEnough(l) && headingish(l.text)).map((l) => round(l.size))),
  ].sort((a, b) => b - a);
  const levelOfSize = new Map();
  let levelCount = 0;
  let levelTop = null; // the largest size in the current level
  for (const s of headingSizes) {
    if (levelTop === null || s < levelTop * (1 - sizeTolerance)) {
      levelCount += 1;
      levelTop = s;
    }
    levelOfSize.set(s, levelCount);
  }
  const numberedBase = levelCount + 1;

  const blocks = [];
  // joins a wrapped line onto the text before it, undoing end-of-line hyphens
  const joinLine = (text, next) => (text.endsWith("-") && /^[a-z]/.test(next) ? text.slice(0, -1) + next : `${text} ${next}`);
  for (const lines of cleanPages) {
    // paragraph reconstruction for body lines: a gap noticeably larger than
    // the page's typical line spacing is a paragraph break
    const gaps = [];
    for (let i = 1; i < lines.length; i++) gaps.push(Math.abs(lines[i - 1].y - lines[i].y));
    const typical = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0;

    let para = null; // { text, lines, bold, strong }
    let item = null; // the open list entry
    let prev = null;
    let lastHeading = null;
    const flushPara = () => {
      if (para?.text.trim()) {
        const b = { type: "para", text: para.text.trim() };
        if (para.lines === 1) b.alone = true;
        if (para.bold && para.lines === 1) b.boldLine = true;
        else if (!para.bold && para.strong.length) b.strong = uniqueTerms(para.strong);
        blocks.push(b);
      }
      para = null;
    };
    const closeItem = () => {
      if (item) {
        const strong = uniqueTerms(item.strongRuns);
        if (strong.length) item.strong = strong;
        if (item.lines === 1) item.alone = true;
        delete item.strongRuns;
        delete item.lines;
      }
      item = null;
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
        closeItem();
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
      const bigGap = Boolean(typical && gap > typical * 1.5);
      const li = listLine(l.text);
      if (li) {
        flushPara();
        closeItem();
        item = {
          type: "item",
          text: li.text,
          depth: 0,
          ordered: li.ordered,
          ...(li.marker ? { marker: li.marker } : {}),
          x: l.x,
          lines: 1,
          strongRuns: l.bold ? [] : [...(l.strong || [])],
        };
        blocks.push(item);
        prev = l;
        continue;
      }
      // a wrapped line of a list entry hangs to the right of its bullet
      if (item && !bigGap && (l.x === undefined || item.x === undefined || l.x > item.x + body * 0.3)) {
        item.text = joinLine(item.text, l.text);
        item.lines += 1;
        if (!l.bold) item.strongRuns.push(...(l.strong || []));
        prev = l;
        continue;
      }
      closeItem();
      // A short bold line and the plain text around it are separate blocks even
      // with no extra spacing: it is a run-in heading, not part of the sentence.
      const shortBold = (t) => t.split(/\s+/).length <= 10 && !/[.?!;,]$/.test(t);
      const boldTurn =
        para && ((para.bold && para.lines === 1 && !l.bold && shortBold(para.text)) || (!para.bold && l.bold && shortBold(l.text)));
      if (para && (bigGap || boldTurn)) flushPara();
      if (!para) para = { text: l.text, lines: 1, bold: Boolean(l.bold), strong: [...(l.strong || [])] };
      else {
        para.text = joinLine(para.text, l.text);
        para.lines += 1;
        para.bold = para.bold && Boolean(l.bold);
        para.strong.push(...(l.strong || []));
      }
      prev = l;
    }
    flushPara();
    closeItem();
  }

  // list nesting from the left edge: every distinctly different bullet indent
  // is a level (edges less than about a letter-and-a-half apart are the same)
  const edges = [];
  for (const x of blocks.filter((b) => b.type === "item" && b.x !== undefined).map((b) => b.x).sort((a, b) => a - b)) {
    if (!edges.length || x - edges[edges.length - 1] > body * 0.6) edges.push(x);
  }
  blocks.forEach((b) => {
    if (b.type === "item" && b.x !== undefined) b.depth = Math.max(0, edges.findLastIndex((e) => e <= b.x + 0.01));
    delete b.y;
    delete b.x;
  });
  // body-size structure: "1. Introduction" lines and bold lines of their own
  inferHeadings(blocks, {
    numberedLevel: numberedBase + 1,
    boldLevel: numberedBase + 5,
    capsLevel: numberedBase + 6,
    titleLevel: numberedBase + 7,
  });
  return { text: textFromBlocks(blocks), blocks };
}

// What Tesseract makes of a bullet glyph at the start of a line.
const OCR_BULLET = /^(?:[e¢©®°«»>]|[*+~])\s+(?=[A-Z0-9(])/;

/**
 * A photographed page -> { text, blocks }, from the lines OCR found (ocr.js).
 * A photo has the same clues as a PDF page - taller lines are headings, a
 * bullet or number opens a list entry, an indented line continues one - so it
 * goes through the same reconstruction. The thresholds are looser because
 * measurements off a photo are noisier than a PDF's exact font sizes.
 */
export function blocksFromOcrLines(lines) {
  const page = (lines || []).map((l) => ({ ...l, text: l.text.replace(OCR_BULLET, "\u2022 ") }));
  return buildPdfBlocks([page], { headingRatio: 1.25, sizeTolerance: 0.12 });
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
