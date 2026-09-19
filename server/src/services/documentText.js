// Turn an uploaded file into plain note text. Images go through OCR (ocr.js);
// everything handled here is a "born-digital" document, where the text can be
// read straight out of the file with no OCR: plain text / markdown, Word
// (.docx) and PDF. Each extractor returns { text } or throws an Error whose
// message is safe to show to the student.

import mammoth from "mammoth";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const TEXT_EXT = new Set([".txt", ".md", ".markdown", ".text", ".csv"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"]);

function extOf(name = "") {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

/** "image" | "text" | "docx" | "pdf" | null (unsupported) for an uploaded file. */
export function classifyUpload(file) {
  const ext = extOf(file.originalname);
  const mime = (file.mimetype || "").toLowerCase();
  if (mime.startsWith("image/") || IMAGE_EXT.has(ext)) return "image";
  if (ext === ".pdf" || mime === "application/pdf") return "pdf";
  if (ext === ".docx" || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
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

export async function extractTextFromDocument(file, kind) {
  if (kind === "text") {
    return { text: tidy(file.buffer.toString("utf8")) };
  }
  if (kind === "docx") {
    try {
      const { value } = await mammoth.extractRawText({ buffer: file.buffer });
      return { text: tidy(value) };
    } catch {
      throw new Error("could not read this Word file - is it a valid .docx?");
    }
  }
  if (kind === "pdf") {
    let pdf;
    try {
      pdf = await getDocument({
        data: new Uint8Array(file.buffer),
        useSystemFonts: true,
        isEvalSupported: false,
        verbosity: 0,
      }).promise;
      const pages = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        const content = await page.getTextContent();
        // Rebuild lines from the positioned text runs (a change of vertical
        // position starts a new line), then join lines back into paragraphs:
        // an unusually large vertical gap is a paragraph break, anything else
        // is just a wrapped line and is joined with a space.
        const lines = [];
        let text = "";
        let y = null;
        const flush = () => {
          if (text.trim()) lines.push({ text: text.trim(), y });
          text = "";
        };
        for (const item of content.items) {
          if (!("str" in item)) continue;
          const iy = item.transform?.[5];
          if (y !== null && iy !== undefined && Math.abs(iy - y) > 2) flush();
          if (iy !== undefined) y = iy;
          text += item.str;
          if (item.hasEOL) flush();
        }
        flush();
        const gaps = [];
        for (let i = 1; i < lines.length; i++) gaps.push(Math.abs(lines[i - 1].y - lines[i].y));
        const typical = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0;
        let out = "";
        lines.forEach((l, i) => {
          if (i === 0) out = l.text;
          else {
            const gap = Math.abs(lines[i - 1].y - l.y);
            if (typical && gap > typical * 1.5) out += "\n\n" + l.text;
            else if (out.endsWith("-") && /^[a-z]/.test(l.text)) out = out.slice(0, -1) + l.text;
            else out += " " + l.text;
          }
        });
        pages.push(out);
        page.cleanup();
      }
      return { text: tidy(pages.join("\n\n")) };
    } catch (err) {
      console.error("[pdf] extraction failed:", err.message);
      throw new Error("could not read this PDF - it may be damaged or password-protected");
    } finally {
      if (pdf) await pdf.destroy().catch(() => {});
    }
  }
  throw new Error("unsupported file type");
}
