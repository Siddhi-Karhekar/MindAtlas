// The working parts of the OCR measurement (evaluation/ocr.mjs,
// docs/measurements/ocr.md): how a reading is scored against the correct text,
// the correct text of a GNHK photo, the damage done to printed pages, and the
// tables built from the saved readings. Nothing here reads a file or runs
// Tesseract, so all of it can be tested with made-up data.
import { blocksFromOcrLines } from "../../src/services/documentText.js";
import { buildConceptRecords, extractionConfidence } from "../../src/services/conceptRecords.js";
import { interval, quartiles } from "./mastery.js";

// ---------------------------------------------------------------------------
// Scoring one reading
// ---------------------------------------------------------------------------

/** The only tidying before scoring: lower case, and every run of spacing becomes one space. */
export const normalise = (text) => String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** Levenshtein distance: the fewest single-item insertions, deletions and swaps from a to b. */
export function editDistance(a, b) {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let before = new Uint32Array(b.length + 1);
  let now = new Uint32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) before[j] = j;
  for (let i = 1; i <= a.length; i++) {
    now[0] = i;
    for (let j = 1; j <= b.length; j++) {
      now[j] = Math.min(before[j] + 1, now[j - 1] + 1, before[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [before, now] = [now, before];
  }
  return before[b.length];
}

const wordsOf = (normalised) => (normalised ? normalised.split(" ") : []);

/** How many words the two lists share, counting repeats, in any order. */
export function wordsInCommon(a, b) {
  const left = new Map();
  for (const w of a) left.set(w, (left.get(w) || 0) + 1);
  let shared = 0;
  for (const w of b) {
    const n = left.get(w) || 0;
    if (n) {
      shared += 1;
      left.set(w, n - 1);
    }
  }
  return shared;
}

/** The counts behind every score, for one reading of one page. */
export function scoreReading(reference, reading) {
  const ref = normalise(reference);
  const got = normalise(reading);
  if (!ref) throw new Error("a page with no correct text cannot be scored");
  const refWords = wordsOf(ref);
  const gotWords = wordsOf(got);
  const refChars = [...ref];
  return {
    ref_chars: refChars.length,
    char_edits: editDistance(refChars, [...got]),
    ref_words: refWords.length,
    word_edits: editDistance(refWords, gotWords),
    read_words: gotWords.length,
    words_matched: wordsInCommon(refWords, gotWords),
  };
}

/** Scores over many pages: all the errors divided by all the correct text, so a longer page counts for more. */
export function pooled(rows, field = "score") {
  const sum = { ref_chars: 0, char_edits: 0, ref_words: 0, word_edits: 0, read_words: 0, words_matched: 0 };
  for (const r of rows) for (const k of Object.keys(sum)) sum[k] += r[field][k];
  if (!sum.ref_chars) return null;
  const found = sum.words_matched / sum.ref_words;
  const right = sum.read_words ? sum.words_matched / sum.read_words : null;
  return {
    cer: sum.char_edits / sum.ref_chars,
    wer: sum.word_edits / sum.ref_words,
    words_found: found,
    words_right: right,
    word_f1: found && right ? (2 * found * right) / (found + right) : 0,
  };
}

// ---------------------------------------------------------------------------
// What the app does with a reading
// ---------------------------------------------------------------------------

/**
 * The note's text from an OCR result, as readUploadOfKind in routes/notes.js
 * chooses it: the page rebuilt from its lines, else Tesseract's own text.
 */
export function noteTextFrom(ocr) {
  if (!ocr?.text) return "";
  const page = ocr.lines?.length ? blocksFromOcrLines(ocr.lines) : null;
  return (page?.text || ocr.text).trim();
}

// A concept record with no words of its own, so that only the reading decides
// whether it is kept. The app's real rule says which side it lands on, and no
// threshold is copied here.
const PROBE = { kind: "list", key: "probe", title: "probe", passages: ["probe"] };

/** How reliable the app takes a photo's note to be, and whether its questions are held back. */
export function noteReliability({ noteText, confidence, ocrFailed = false }) {
  const note = { sourceType: "image", ocrFailed, ocrConfidence: confidence ?? null, rawText: noteText };
  const { confidence: reliability, reasons } = extractionConfidence(note);
  return { reliability, reasons, flagged: buildConceptRecords(note, null, { structures: [PROBE] }).excluded.length === 1 };
}

// ---------------------------------------------------------------------------
// The correct text of a GNHK photo
// ---------------------------------------------------------------------------

// Stand-ins, not writing, as the GNHK paper defines them: %math% is maths that
// ASCII cannot write, %SC% an illegible scribble, %NA% something labelled as text
// that is not text. A real token can hold a % ("70%"), so only a whole token of
// this shape goes.
export const NOT_TEXT = /^%[A-Za-z]+%$/;

const middleX = (token) => (token.polygon.x0 + token.polygon.x1 + token.polygon.x2 + token.polygon.x3) / 4;

/**
 * The labels are not stored in reading order, so they are put in order here:
 * by line_idx, then left to right within a line.
 */
export function gnhkReference(tokens) {
  const leftOut = {};
  const kept = [];
  for (const t of tokens) {
    if (NOT_TEXT.test(t.text)) leftOut[t.text] = (leftOut[t.text] || 0) + 1;
    else kept.push(t);
  }
  const ordered = kept.map((t, i) => ({ t, i, x: middleX(t) })).sort((a, b) => a.t.line_idx - b.t.line_idx || a.x - b.x || a.i - b.i);
  const lines = [];
  let line = null;
  for (const { t } of ordered) {
    if (line === null || t.line_idx !== line.idx) {
      line = { idx: t.line_idx, words: [] };
      lines.push(line);
    }
    line.words.push(t.text);
  }
  return {
    text: lines.map((l) => l.words.join(" ")).join("\n"),
    tokens: tokens.length,
    left_out: leftOut,
    handwritten_tokens: kept.filter((t) => t.type === "H").length,
    printed_tokens: kept.filter((t) => t.type === "P").length,
  };
}

// ---------------------------------------------------------------------------
// A photo's rotation tag
// ---------------------------------------------------------------------------

/** The EXIF orientation of a JPEG and the byte order it is written in, or null if it has none. */
export function readRotationTag(buf) {
  try {
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    let at = 2;
    while (at + 4 < buf.length) {
      if (buf[at] !== 0xff) return null;
      while (buf[at + 1] === 0xff) at += 1;
      const marker = buf[at + 1];
      if (marker === 0xda || marker === 0xd9) return null; // the picture itself starts: no tag before it
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        at += 2;
        continue;
      }
      const length = buf.readUInt16BE(at + 2);
      if (marker === 0xe1 && buf.toString("latin1", at + 4, at + 10) === "Exif\0\0") {
        const tiff = at + 10;
        const little = buf.toString("latin1", tiff, tiff + 2) === "II";
        const u16 = (p) => (little ? buf.readUInt16LE(p) : buf.readUInt16BE(p));
        const u32 = (p) => (little ? buf.readUInt32LE(p) : buf.readUInt32BE(p));
        const dir = tiff + u32(tiff + 4);
        for (let n = 0; n < u16(dir); n++) {
          const entry = dir + 2 + n * 12;
          if (u16(entry) === 0x0112) return { orientation: u16(entry + 8), byte_order: little ? "II" : "MM" };
        }
        return null;
      }
      at += 2 + length;
    }
  } catch {
    // a header cut short counts as no tag
  }
  return null;
}

/**
 * The orientation tesseract.js finds in a file. This is its own test, from
 * tesseract.js/src/worker-script/utils/setImage.js, kept word for word so the
 * tables say what the library really does. The pattern is the tag's bytes in
 * big-endian order, so a little-endian tag is not seen.
 */
export const orientationOcrSees = (buf) => parseInt(Array.from(buf.subarray(0, 500)).join(" ").match(/1 18 0 3 0 0 0 1 0 (\d)/)?.[1], 10) || 1;

/** A JPEG with a rotation tag put in front of its picture, written in the given byte order. */
export function withRotationTag(jpeg, orientation, byteOrder) {
  const little = byteOrder === "II";
  const tiff = Buffer.alloc(26);
  tiff.write(little ? "II" : "MM", 0, "latin1");
  const put16 = (v, at) => (little ? tiff.writeUInt16LE(v, at) : tiff.writeUInt16BE(v, at));
  const put32 = (v, at) => (little ? tiff.writeUInt32LE(v, at) : tiff.writeUInt32BE(v, at));
  put16(42, 2);
  put32(8, 4); // the directory comes straight after this header
  put16(1, 8); // one entry
  put16(0x0112, 10); // orientation
  put16(3, 12); // a SHORT
  put32(1, 14); // one of them
  put16(orientation, 18);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), head, body, jpeg.subarray(2)]);
}

// ---------------------------------------------------------------------------
// Damage to a printed page
// ---------------------------------------------------------------------------
// A page here is { width, height, data }, data holding one grey level (0-255)
// per pixel. Printed notes are black on white, so nothing is lost without colour.

/** Grey levels from a canvas's RGBA pixels. */
export function greyFromRgba(rgba, width, height) {
  const data = new Uint8ClampedArray(width * height);
  for (let i = 0; i < data.length; i++) data[i] = Math.round(0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]);
  return { width, height, data };
}

/** The share of a page's pixels that are dark. A blank render scores 0, so it can be caught. */
export function inkShare(page) {
  let dark = 0;
  for (let i = 0; i < page.data.length; i++) if (page.data[i] < 128) dark += 1;
  return dark / page.data.length;
}

/** Smaller by a whole factor, each new pixel the average of the ones it covers, as a camera's sensor does. */
export function shrink(page, factor) {
  const width = Math.floor(page.width / factor);
  const height = Math.floor(page.height / factor);
  const data = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let total = 0;
      for (let v = 0; v < factor; v++) {
        const row = (y * factor + v) * page.width + x * factor;
        for (let u = 0; u < factor; u++) total += page.data[row + u];
      }
      data[y * width + x] = Math.round(total / (factor * factor));
    }
  }
  return { width, height, data };
}

/** Gaussian blur, sigma in pixels. Past the edge of the page the edge pixel repeats. */
export function blur(page, sigma) {
  const radius = Math.ceil(sigma * 3);
  const kernel = [];
  for (let i = -radius; i <= radius; i++) kernel.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const total = kernel.reduce((a, b) => a + b, 0);
  const weights = kernel.map((k) => k / total);
  const { width, height } = page;
  const across = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 0;
      for (let i = -radius; i <= radius; i++) v += weights[i + radius] * page.data[y * width + Math.min(width - 1, Math.max(0, x + i))];
      across[y * width + x] = v;
    }
  }
  const data = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 0;
      for (let i = -radius; i <= radius; i++) v += weights[i + radius] * across[Math.min(height - 1, Math.max(0, y + i)) * width + x];
      data[y * width + x] = Math.round(v);
    }
  }
  return { width, height, data };
}

/** Turned clockwise by `degrees`, on a page grown to hold every corner, the new space white. */
export function turn(page, degrees) {
  const angle = (degrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const clean = (v) => (Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v) : v); // cos 90 is not quite 0
  const width = Math.ceil(clean(Math.abs(page.width * cos) + Math.abs(page.height * sin)));
  const height = Math.ceil(clean(Math.abs(page.width * sin) + Math.abs(page.height * cos)));
  const data = new Uint8ClampedArray(width * height).fill(255);
  const [fromX, fromY] = [(page.width - 1) / 2, (page.height - 1) / 2];
  const [toX, toY] = [(width - 1) / 2, (height - 1) / 2];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // each new pixel looks back to where it came from on the old page
      const dx = x - toX;
      const dy = y - toY;
      const sx = clean(fromX + dx * cos + dy * sin);
      const sy = clean(fromY - dx * sin + dy * cos);
      if (sx < 0 || sy < 0 || sx > page.width - 1 || sy > page.height - 1) continue;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(page.width - 1, x0 + 1);
      const y1 = Math.min(page.height - 1, y0 + 1);
      const [fx, fy] = [sx - x0, sy - y0];
      const top = page.data[y0 * page.width + x0] * (1 - fx) + page.data[y0 * page.width + x1] * fx;
      const bottom = page.data[y1 * page.width + x0] * (1 - fx) + page.data[y1 * page.width + x1] * fx;
      data[y * width + x] = Math.round(top * (1 - fy) + bottom * fy);
    }
  }
  return { width, height, data };
}

/** A soft shadow: full brightness at one corner, falling smoothly to `darkest` at the opposite one. */
export function shadow(page, darkest, corner) {
  const { width, height } = page;
  const data = new Uint8ClampedArray(width * height);
  const [flipX, flipY] = [corner % 2 === 1, corner >= 2];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = (flipX ? width - 1 - x : x) / Math.max(1, width - 1);
      const v = (flipY ? height - 1 - y : y) / Math.max(1, height - 1);
      const t = (u + v) / 2;
      const smooth = t * t * (3 - 2 * t);
      data[y * width + x] = Math.round(page.data[y * width + x] * (1 - (1 - darkest) * smooth));
    }
  }
  return { width, height, data };
}

/** Grain: a random amount added to every pixel, sigma in grey levels. */
export function noise(page, sigma, random) {
  const data = new Uint8ClampedArray(page.data.length);
  for (let i = 0; i < data.length; i++) {
    const n = Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
    data[i] = Math.round(page.data[i] + sigma * n);
  }
  return { width: page.width, height: page.height, data };
}

// Fixed before any page was scored, by looking at the pages: a person can still
// read each of them. The combination is milder at each step, as a real photo
// has a little of everything. Sizes are for a page rendered at 300 DPI.
export const LEVELS = [
  { id: "clean", label: "Clean", what: "300 DPI, nothing added", steps: [] },
  { id: "low_resolution", label: "Low resolution", what: "100 DPI", steps: [{ shrink: 3 }] },
  { id: "blur", label: "Blur", what: "Gaussian blur, sigma 3 pixels", steps: [{ blur: 3 }] },
  { id: "tilt", label: "Tilt", what: "turned 5 degrees", steps: [{ turn: 5 }] },
  { id: "shadow", label: "Shadow", what: "a soft shadow, 40% brightness at the far corner", steps: [{ shadow: 0.4 }] },
  { id: "noise", label: "Noise", what: "grain, sigma 30 grey levels", steps: [{ noise: 30 }] },
  {
    id: "combination",
    label: "Combination",
    what: "shadow to 60%, turned 3 degrees, blur sigma 2, 150 DPI, grain sigma 15",
    steps: [{ shadow: 0.6 }, { turn: 3 }, { blur: 2 }, { shrink: 2 }, { noise: 15 }],
  },
];

/** A page with a level's damage done. `random` picks the way it tilts, the shadow's corner and the grain. */
export function damage(page, level, random) {
  let out = page;
  for (const step of level.steps) {
    if (step.shrink) out = shrink(out, step.shrink);
    if (step.blur) out = blur(out, step.blur);
    if (step.turn) out = turn(out, random() < 0.5 ? step.turn : -step.turn);
    if (step.shadow) out = shadow(out, step.shadow, Math.floor(random() * 4));
    if (step.noise) out = noise(out, step.noise, random);
  }
  return out;
}

/** A seed for one image, the same whatever order images are read in or how many are left out (FNV-1a). */
export function seedFor(...parts) {
  let hash = 0x811c9dc5;
  for (const ch of parts.join("|")) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// ---------------------------------------------------------------------------
// Intervals and tables
// ---------------------------------------------------------------------------

/** `reps` resamples of the groups (pages), drawn with repeats. A group drawn twice counts twice. */
export function resampled(rows, groupOf, reps, random) {
  const groups = new Map();
  for (const r of rows) {
    const key = groupOf(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const list = [...groups.values()];
  return Array.from({ length: reps }, () => {
    const draw = [];
    for (let i = 0; i < list.length; i++) draw.push(...list[Math.floor(random() * list.length)]);
    return draw;
  });
}

const withCi = (value, draws) => ({ value, ci: interval(draws) });
const SCORES = ["cer", "wer", "words_found", "words_right", "word_f1"];
const median = (xs) => (xs.length ? quartiles(xs)[1] : null);

function scoresWithCi(rows, field, groupOf, reps, random) {
  const point = pooled(rows, field);
  if (!point) return null;
  const draws = resampled(rows, groupOf, reps, random).map((d) => pooled(d, field));
  return Object.fromEntries(SCORES.map((s) => [s, point[s] === null ? null : withCi(point[s], draws.map((d) => d?.[s] ?? null))]));
}

const pageCer = (r, field = "score") => r[field].char_edits / r[field].ref_chars;

/** Everything reported for one group of readings, with and without the pages that gave no text. */
export function summarise(rows, { groupOf = (r) => r.id, reps, random, text = (r) => r.note_text }) {
  const gave = rows.filter((r) => text(r));
  const noTextDraws = resampled(rows, groupOf, reps, random).map((d) => (d.length ? d.filter((r) => !text(r)).length / d.length : null));
  const seconds = rows.filter((r) => typeof r.ms === "number").map((r) => r.ms / 1000);
  const confidence = gave.map((r) => r.confidence).filter((c) => typeof c === "number");
  return {
    pages: rows.length,
    no_text: rows.length - gave.length,
    ocr_failed: rows.filter((r) => r.ocr_failed).length,
    refused: rows.filter((r) => r.refused).length,
    no_text_share: rows.length ? withCi((rows.length - gave.length) / rows.length, noTextDraws) : null,
    with_no_text_pages: scoresWithCi(rows, "score", groupOf, reps, random),
    without_no_text_pages: gave.length ? scoresWithCi(gave, "score", groupOf, reps, random) : null,
    tesseract_text: rows[0]?.raw_score ? pooled(rows, "raw_score") : null,
    median_page_cer: median(rows.map((r) => pageCer(r))),
    seconds: seconds.length ? { median: median(seconds), slowest: Math.max(...seconds) } : null,
    mean_confidence: confidence.length ? confidence.reduce((a, b) => a + b, 0) / confidence.length : null,
  };
}

function ranks(xs) {
  const order = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(xs.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j < order.length && order[j][0] === order[i][0]) j += 1;
    for (let k = i; k < j; k++) out[order[k][1]] = (i + j + 1) / 2; // tied values share their mean rank
    i = j;
  }
  return out;
}

/** Spearman's rank correlation: 1 means the two rise together, -1 that one falls as the other rises. Null with no variation. */
export function spearman(xs, ys) {
  if (xs.length < 3) return null;
  const [a, b] = [ranks(xs), ranks(ys)];
  const mean = (a.length + 1) / 2;
  let [top, left, right] = [0, 0, 0];
  for (let i = 0; i < a.length; i++) {
    top += (a[i] - mean) * (b[i] - mean);
    left += (a[i] - mean) ** 2;
    right += (b[i] - mean) ** 2;
  }
  return left && right ? top / Math.sqrt(left * right) : null;
}

const CONFIDENCE_BANDS = [[0, 0.7, "below 0.70"], [0.7, 0.8, "0.70 to 0.79"], [0.8, 0.9, "0.80 to 0.89"], [0.9, 1.01, "0.90 and above"]];

/** Does the app's `confidence` follow the real errors? Pages that gave text only: the rest have no confidence. */
export function confidenceTracking(rows, { groupOf = (r) => r.id, reps, random }) {
  const usable = rows.filter((r) => typeof r.confidence === "number");
  if (!usable.length) return null;
  const rho = (list) => spearman(list.map((r) => r.confidence), list.map((r) => pageCer(r)));
  return {
    pages: usable.length,
    lowest: Math.min(...usable.map((r) => r.confidence)),
    highest: Math.max(...usable.map((r) => r.confidence)),
    spearman: withCi(rho(usable), resampled(usable, groupOf, reps, random).map(rho)),
    bands: CONFIDENCE_BANDS.map(([low, high, label]) => {
      const inside = usable.filter((r) => r.confidence >= low && r.confidence < high);
      return { label, pages: inside.length, cer: pooled(inside)?.cer ?? null, median_page_cer: median(inside.map((r) => pageCer(r))) };
    }),
  };
}

const ERROR_BANDS = [[0, 0.05, "below 5%"], [0.05, 0.2, "5% to 19%"], [0.2, 0.5, "20% to 49%"], [0.5, Infinity, "50% and above"]];

/** How many of the pages read well or badly does the app hold back as "not read reliably"? */
export function flagTable(rows) {
  const gave = rows.filter((r) => r.note_text);
  return {
    pages_with_text: gave.length,
    flagged: gave.filter((r) => r.flagged).length,
    bands: ERROR_BANDS.map(([low, high, label]) => {
      const inside = gave.filter((r) => pageCer(r) >= low && pageCer(r) < high);
      return {
        label,
        pages: inside.length,
        flagged: inside.filter((r) => r.flagged).length,
        mean_reliability: inside.length ? inside.reduce((a, r) => a + r.reliability, 0) / inside.length : null,
      };
    }),
  };
}

/** Two readings of the same pages: A's score minus B's, with the interval over the same resamples. */
export function pairedDifference(a, b, { reps, random, scores = ["cer", "wer", "word_f1"] }) {
  const other = new Map(b.map((r) => [r.id, r]));
  const pairs = a.filter((r) => other.has(r.id));
  if (!pairs.length) return null;
  const left = pairs.map((r) => ({ ...r, other: other.get(r.id) }));
  const draws = resampled(left, (r) => r.id, reps, random);
  const diff = (rows) => {
    const [x, y] = [pooled(rows), pooled(rows.map((r) => r.other))];
    return Object.fromEntries(scores.map((s) => [s, x[s] - y[s]]));
  };
  const point = diff(left);
  const all = draws.map(diff);
  return { pairs: pairs.length, ...Object.fromEntries(scores.map((s) => [s, withCi(point[s], all.map((d) => d[s]))])) };
}
