// Split a long uploaded document (a whole unit's notes as one PDF / .docx /
// .md) into one note per top-level section. Every note is a "topic" to the
// rest of the app - the test generator draws questions per note and the
// mastery engine tracks each note separately - so a 20-page unit uploaded as
// a single note would collapse the whole unit into one topic and one graph
// node. Splitting on the document's own headings keeps topics at the
// granularity the student (or teacher) wrote them in.
//
// Rule-based on purpose (see CONTRIBUTING.md §0): a line is a top-level
// heading when it is
//   - a markdown heading ("# Title" / "## Title"), or
//   - a numbered heading written in capitals ("3. COMPONENTS OF SYSTEM
//     SOFTWARE") whose number is higher than the previous heading's - the
//     capitals rule keeps ordinary numbered list items ("1. Convert symbolic
//     op codes...") from being mistaken for headings, and the rising-number
//     rule stops a list that restarts at 1 from doing the same.
// Sub-headings ("3a. Assembler") stay inside their parent section.

import { joinLines } from "./documentText.js";

const MIN_SECTION_CHARS = 150;
const SMALL_WORDS = new Set(["of", "and", "or", "the", "a", "an", "in", "on", "for", "to", "vs", "with", "by", "at"]);

function upperRatio(s) {
  const letters = s.replace(/[^A-Za-z]/g, "");
  if (!letters.length) return 0;
  return letters.replace(/[^A-Z]/g, "").length / letters.length;
}

/** "DESIGN OF 2-PASS ASSEMBLER (ALP)" -> "Design of 2-Pass Assembler (ALP)" */
export function tidyHeading(raw) {
  const s = raw.replace(/\s+/g, " ").trim();
  if (upperRatio(s) < 0.8) return s;
  return s
    .split(" ")
    .map((w, i) => {
      if (/^\([A-Z0-9]{2,6}\)$/.test(w)) return w; // acronyms in brackets: (ALP), (DLL)
      const lower = w.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      if (/^[A-Z]{2,4}$/.test(w) && !/[AEIOU]/.test(w.slice(1))) return w; // MDT, MNT, ALA-style acronyms
      return lower.replace(/(^|[-/(])([a-z])/g, (_, p, c) => p + c.toUpperCase());
    })
    .join(" ");
}

/** Structural lines like "UNIT II — ..." or "PART B — LOADERS" - dropped, not sections. */
function isStructural(text) {
  return /^(unit|part|chapter|module)\s+[A-Z0-9IVX]+\b/i.test(text) && upperRatio(text) > 0.8;
}

function headingOf(text, lastNumber) {
  const md = text.match(/^#{1,2}\s+(.+)$/);
  if (md) return { title: md[1].trim(), number: lastNumber };
  const num = text.match(/^(\d{1,2})\.\s+(.{3,90})$/);
  if (num && upperRatio(num[2]) >= 0.7 && Number(num[1]) > lastNumber) {
    return { title: num[2].trim(), number: Number(num[1]) };
  }
  return null;
}

function bodyText(lines) {
  // PDF lines carry a y position, so paragraphs can be rebuilt from gaps;
  // plain-text lines are already one paragraph/line each.
  if (lines.length && lines.every((l) => typeof l.y === "number")) return joinLines(lines).trim();
  return lines
    .map((l) => l.text)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * lines: [{ text, y }] in reading order (see extractDocumentLines).
 * Returns [{ title, text }] with at least two sections, or null when the
 * document has no usable heading structure - the caller then keeps it as a
 * single note.
 */
export function splitIntoSections(lines) {
  const sections = [];
  let current = { title: null, lines: [] };
  let lastNumber = 0;

  for (const line of lines) {
    const text = line.text.trim();
    if (!text) {
      current.lines.push(line);
      continue;
    }
    if (isStructural(text)) continue;
    const heading = headingOf(text, lastNumber);
    if (heading) {
      sections.push(current);
      current = { title: tidyHeading(heading.title), lines: [] };
      lastNumber = heading.number;
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);

  const built = sections
    .map((s) => ({ title: s.title, text: bodyText(s.lines) }))
    .filter((s) => s.title || s.text.length >= MIN_SECTION_CHARS); // drop a title-only preamble

  if (built.filter((s) => s.title).length < 2) return null;

  // A preamble with real content before the first heading becomes its own note.
  for (const s of built) if (!s.title) s.title = "Introduction";

  // Fold tiny sections (a heading with a line or two under it) into the
  // previous one so they don't become near-empty topics.
  const merged = [];
  for (const s of built) {
    const prev = merged[merged.length - 1];
    if (prev && s.text.length < MIN_SECTION_CHARS) {
      prev.text = `${prev.text}\n\n${s.title}\n${s.text}`.trim();
    } else {
      merged.push({ ...s });
    }
  }
  return merged.length >= 2 ? merged : null;
}
