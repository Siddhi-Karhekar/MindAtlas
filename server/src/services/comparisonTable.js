// Comparison tables that a PDF reader has flattened into a run of text,
// put back into rows. No imports, so the note formatter
// (documentStructure.js) and the question classifier (suitability.js) can
// both use it.

// Slides and notes often carry a two-column comparison:
//   BASIS FOR COMPARISON | LINKER                        | LOADER
//   Basic                | It generates the executable  | It loads the executable
//                        | module of a source program.  | module to the main memory.
// A PDF reader gives that back as one run of text: "BASIS FOR COMPARISON
// LINKER LOADER Basic It generates ... It loads ... Input It takes ...". Read as
// sentences, every row turns into a nonsense blank ("_____ FOR COMPARISON
// LINKER LOADER Basic It generates ..."). Here the run is recognised and put
// back into rows, so it is shown as a table and asked about as a comparison.

const TABLE_HEADER = /^(?:basis|bases|parameters?|points?|grounds?)\s+(?:for|of)\s+(?:comparison|difference|distinction)\s+|^(?:parameters?|features?|criteria|criterion|aspects?|properties|property|points? of difference|differences?|comparison)\s+(?=[A-Z])/i;
// a row: a label of one to three words, then the first cell, which opens with
// a pronoun or article for the thing compared ("It", "They", "The")
const ROW_START = /^((?:[A-Z][\w/&().-]*)(?:\s+(?:[A-Z][\w/&().-]*|of|and|in|to)){0,2})\s+(?=(?:It|They|Its|Their|This|These|Both|The|A|An)\b)/;
const SLASH_LABEL = /^([A-Z][\w-]*\/[\w-]+)\s+(?=[A-Z])/;
const sentencesOf = (text) => String(text).split(/(?<=[.!?])\s+(?=[A-Z])/).map((s) => s.trim()).filter(Boolean);

/** The two (or more) things a header names: "LINKER LOADER" -> ["Linker", "Loader"]. */
function namesFrom(words) {
  const tidy = (w) => (/^[A-Z0-9/+-]+$/.test(w) && w.length > 4 ? w[0] + w.slice(1).toLowerCase() : w);
  if (words.length === 2) return words.map(tidy);
  if (words.length === 4) return [words.slice(0, 2), words.slice(2)].map((p) => p.map(tidy).join(" "));
  if (words.length === 6) return [words.slice(0, 3), words.slice(3)].map((p) => p.map(tidy).join(" "));
  return null;
}

/**
 * A flattened comparison table back as { names: [a, b], rows: [{ label, cells: [x, y] }] },
 * or null when the text is not one (or cannot be read back with confidence).
 */
export function parseFlattenedComparison(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  const head = t.match(TABLE_HEADER);
  if (!head) return null;
  let rest = t.slice(head[0].length);
  // the names: the words in capitals (or Title Case) before the first row
  // ...in capitals when the header is ("LINKER LOADER", "STATIC LINKING DYNAMIC LINKING")
  let nameWords = [];
  for (const w of rest.split(" ")) {
    if (!/^[A-Z0-9/+-]{2,}$/.test(w) || nameWords.length >= 6) break;
    nameWords.push(w);
  }
  if (nameWords.length < 2) {
    nameWords = [];
    for (const w of rest.split(" ")) {
      if (ROW_START.test(rest.split(" ").slice(nameWords.length).join(" ")) && nameWords.length >= 2) break;
      if (!/^[A-Z][A-Za-z0-9/+-]*$/.test(w) || nameWords.length >= 6) break;
      nameWords.push(w);
    }
  }
  rest = rest.split(" ").slice(nameWords.length).join(" ");
  const names = namesFrom(nameWords);
  if (!names) return null;
  const rows = [];
  for (const s of sentencesOf(rest)) {
    const start = s.match(ROW_START) || s.match(SLASH_LABEL);
    if (start && (rows.length === 0 || rows[rows.length - 1].parts.length >= 2)) {
      rows.push({ label: start[1].trim(), parts: [s.slice(start[0].length).trim()] });
    } else if (rows.length) {
      rows[rows.length - 1].parts.push(s);
    } else {
      return null; // text before the first row that is no row
    }
  }
  const complete = rows.filter((r) => r.parts.length >= 2);
  if (complete.length < 2 || complete.length !== rows.length) return null;
  return {
    names,
    rows: rows.map((r) => {
      const half = Math.ceil(r.parts.length / 2);
      return { label: r.label, cells: [r.parts.slice(0, half).join(" "), r.parts.slice(half).join(" ")] };
    }),
  };
}

/** A comparison table as a table block: a header row, then one row per point. */
export function comparisonToTable(parsed) {
  const rows = [["Basis", ...parsed.names], ...parsed.rows.map((r) => [r.label, ...r.cells])];
  return { type: "table", rows, text: rows.map((r) => r.join(" | ")).join("\n"), comparison: true };
}


/** Quick test before the full parse: does the text open like a comparison table's header? */
export const opensLikeComparison = (text) => TABLE_HEADER.test(String(text || "").trim());
