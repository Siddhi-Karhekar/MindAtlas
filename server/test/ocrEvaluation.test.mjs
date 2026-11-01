// Checks for the OCR measurement (evaluation/ocr.mjs, evaluation/lib/ocr.js,
// docs/measurements/ocr.md). Its numbers go in front of faculty, so an error here
// would misreport the app. Covered: the scores against values worked out by hand,
// the correct text of a labelled photo, what the app does with a reading, the
// page damage, rotation tags, resampling, and whole runs on made-up files with
// stand-ins for Tesseract and the vision model. It needs no dataset, no network
// and no Tesseract model. Every word here is made up: labels from the real
// dataset must never be copied into a test.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import PDFDocument from "pdfkit";
import {
  blur, confidenceTracking, damage, editDistance, flagTable, gnhkReference, greyFromRgba, inkShare, LEVELS, noise, normalise, noteReliability, noteTextFrom, NOT_TEXT, orientationOcrSees, pairedDifference, pooled, readRotationTag,
  resampled, scoreReading, seedFor, shadow, shrink, spearman, summarise, turn, withRotationTag, wordsInCommon,
} from "../evaluation/lib/ocr.js";
import { resultsMarkdown, runOcrEvaluation, shrinkLikeBrowser } from "../evaluation/ocr.mjs";
import { seededRandom } from "../evaluation/lib/stats.js";
import { checkUploadContent } from "../src/services/uploadCheck.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!cond) failures++;
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mindatlas-ocr-"));

console.log("\n=== Scoring one reading ===");
check("only case and spacing are tidied", normalise("  Hello,\n\tWorld!  ") === "hello, world!", normalise("  Hello,\n\tWorld!  "));
check("punctuation and accents stay", normalise("Café: x=1.") === "café: x=1.");
check("Levenshtein by hand: kitten to sitting is 3", editDistance([..."kitten"], [..."sitting"]) === 3);
check("Levenshtein: one side empty costs the other's length", editDistance([], [..."abc"]) === 3 && editDistance([..."abc"], []) === 3);
check("Levenshtein: the same text costs nothing", editDistance([..."same"], [..."same"]) === 0);

const same = pooled([{ score: scoreReading("The cell Divides", "the  cell\ndivides") }]);
check("sanity: the same text scores 0% error", same.cer === 0 && same.wer === 0 && same.words_found === 1 && same.words_right === 1 && same.word_f1 === 1, JSON.stringify(same));
const nothing = pooled([{ score: scoreReading("the cell divides", "") }]);
check("sanity: an empty reading scores 100% error", nothing.cer === 1 && nothing.wer === 1 && nothing.words_found === 0 && nothing.words_right === null && nothing.word_f1 === 0, JSON.stringify(nothing));
const oneOff = scoreReading("abcd efgh", "abcd efgx");
check("one wrong letter: 1 of 9 characters, 1 of 2 words", oneOff.char_edits === 1 && oneOff.ref_chars === 9 && oneOff.word_edits === 1 && oneOff.ref_words === 2, JSON.stringify(oneOff));
const junk = pooled([{ score: scoreReading("ab", "ab cd ef gh") }]);
check("junk added can take the error past 100%", near(junk.cer, 9 / 2) && near(junk.wer, 3), JSON.stringify(junk));
check("a page with no correct text is refused, not scored", (() => {
  try {
    scoreReading("  ", "x");
    return false;
  } catch {
    return true;
  }
})());

const long = { score: scoreReading("a".repeat(90), "a".repeat(90)) };
const short = { score: scoreReading("b".repeat(10), "") };
check("over pages, a longer page counts for more (pooled, not an average of pages)", near(pooled([long, short]).cer, 10 / 100), String(pooled([long, short]).cer));

const swapped = pooled([{ score: scoreReading("first line here\nsecond line there", "second line there\nfirst line here") }]);
check("swapped lines: the plain scores call it wrong, the order-free ones do not", swapped.cer > 0.4 && swapped.wer > 0.6 && swapped.words_found === 1 && swapped.words_right === 1, JSON.stringify(swapped));
check("order-free matching counts repeats", wordsInCommon(["a", "a", "b"], ["a", "c", "a", "a"]) === 2);
const halfFound = pooled([{ score: scoreReading("one two three four", "one two extra") }]);
check("words found and words right, by hand", near(halfFound.words_found, 2 / 4) && near(halfFound.words_right, 2 / 3) && near(halfFound.word_f1, 2 * (1 / 2) * (2 / 3) / (1 / 2 + 2 / 3)), JSON.stringify(halfFound));

console.log("\n=== The correct text of a labelled photo ===");
const box = (x, y = 0, w = 10) => ({ x0: x, y0: y, x1: x + w, y1: y, x2: x + w, y2: y + 5, x3: x, y3: y + 5 });
const made = [
  { text: "world", polygon: box(50), line_idx: 0, type: "H" },
  { text: "%math%", polygon: box(30), line_idx: 0, type: "H" },
  { text: "last", polygon: box(5, 20), line_idx: 1, type: "H" },
  { text: "hello", polygon: box(10), line_idx: 0, type: "H" },
  { text: "70%", polygon: box(50, 20), line_idx: 1, type: "P" },
  { text: "%NA%", polygon: box(70, 20), line_idx: 1, type: "H" },
  { text: "%SC%", polygon: box(80, 20), line_idx: 1, type: "H" },
];
const ref = gnhkReference(made);
check("put in reading order: by line, then left to right", ref.text === "hello world\nlast 70%", JSON.stringify(ref.text));
check("tokens that are not text are left out and counted", ref.left_out["%math%"] === 1 && ref.left_out["%NA%"] === 1 && ref.left_out["%SC%"] === 1 && ref.tokens === 7, JSON.stringify(ref.left_out));
check("a real token holding a % stays", ref.text.includes("70%") && !NOT_TEXT.test("70%") && !NOT_TEXT.test("%"));
check("handwritten and printed tokens are counted apart", ref.handwritten_tokens === 3 && ref.printed_tokens === 1);

console.log("\n=== What the app does with a reading ===");
const body = "Enzymes speed up reactions in the cell by lowering the energy they need, and they are not used up.";
const lines = [
  { text: "Enzymes", x: 10, y: 10, size: 30 },
  { text: body, x: 10, y: 60, size: 12 },
  { text: "Page 3", x: 400, y: 800, size: 12 },
];
const rebuilt = noteTextFrom({ text: `Enzymes\n${body}\nPage 3`, lines });
check("the note's text is the page rebuilt from its lines", rebuilt.includes(body) && rebuilt !== `Enzymes\n${body}\nPage 3`, JSON.stringify(rebuilt));
check("the rebuild drops a page-number line, as the app does", !/page 3/i.test(rebuilt));
check("with no lines, the note's text is Tesseract's own", noteTextFrom({ text: "  plain words here ", lines: [] }) === "plain words here");
check("no text gives an empty note", noteTextFrom({ text: "", ocrFailed: false }) === "");

const fine = noteReliability({ noteText: `${body} ${body}`, confidence: 0.95 });
check("a clean reading is not held back", !fine.flagged && fine.reliability === 0.95, JSON.stringify(fine));
const garbled = "Tbe rnernory rnanagernent unit rnaps vlrtual addresses to pbysical frarnes. A pagc tablc stores thc mapping for cach proccss wbich tbe systcm callcd and tbat is fixcd. ";
const misread = noteReliability({ noteText: garbled + garbled, confidence: 0.9 });
check("a misread page is held back, by the app's own rule", misread.flagged && misread.reliability < 0.5, JSON.stringify(misread));
check("the lowest confidence OCR can report (0.6) does not hold a page back by itself", !noteReliability({ noteText: `${body} ${body}`, confidence: 0.6 }).flagged);
check("a failed reading is held back", noteReliability({ noteText: body, confidence: null, ocrFailed: true }).flagged);

console.log("\n=== Damage to a page ===");
const flat = (width, height, v) => ({ width, height, data: new Uint8ClampedArray(width * height).fill(v) });
const dotted = flat(30, 30, 255);
dotted.data[15 * 30 + 15] = 0;
const blurred = blur(dotted, 2);
check("blur spreads a dot and leaves the same size of page", blurred.width === 30 && blurred.data[15 * 30 + 15] > 0 && blurred.data[15 * 30 + 16] < 255);
check("blur leaves a flat page flat", blur(flat(20, 20, 200), 3).data.every((v) => v === 200));
const small = shrink({ width: 4, height: 2, data: Uint8ClampedArray.from([0, 100, 200, 200, 0, 100, 200, 200]) }, 2);
check("shrinking by 2 averages each block, by hand", small.width === 2 && small.height === 1 && small.data[0] === 50 && small.data[1] === 200, Array.from(small.data).join());
const leftBlack = { width: 2, height: 1, data: Uint8ClampedArray.from([0, 255]) };
const clockwise = turn(leftBlack, 90);
check("turned 90 degrees clockwise: left goes to the top", clockwise.width === 1 && clockwise.height === 2 && clockwise.data[0] === 0 && clockwise.data[1] === 255, Array.from(clockwise.data).join());
const anti = turn(leftBlack, -90);
check("turned 90 degrees back: left goes to the bottom", anti.data[0] === 255 && anti.data[1] === 0, Array.from(anti.data).join());
const tilted = turn(flat(100, 100, 0), 5);
check("a tilted page grows to hold its corners, and the new space is white", tilted.width > 100 && tilted.data[0] === 255);
const dim = shadow(flat(11, 11, 200), 0.4, 0);
check("a shadow keeps one corner and falls to its darkest at the opposite one", dim.data[0] === 200 && dim.data[120] === 80, `${dim.data[0]}, ${dim.data[120]}`);
const otherCorner = shadow(flat(11, 11, 200), 0.4, 3);
check("the corner can be chosen", otherCorner.data[120] === 200 && otherCorner.data[0] === 80);
const grainy = noise(flat(200, 200, 128), 30, seededRandom(1));
const grainMean = grainy.data.reduce((a, b) => a + b, 0) / grainy.data.length;
const grainSd = Math.sqrt(grainy.data.reduce((a, b) => a + (b - grainMean) ** 2, 0) / grainy.data.length);
check("grain has about the mean and spread asked for", Math.abs(grainMean - 128) < 1.5 && Math.abs(grainSd - 30) < 1.5, `mean ${grainMean.toFixed(1)}, sd ${grainSd.toFixed(1)}`);
const pageOf = () => {
  const p = flat(60, 60, 255);
  for (let i = 0; i < 400; i += 3) p.data[1000 + i] = 0;
  return p;
};
const levelOf = (id) => LEVELS.find((l) => l.id === id);
check("the seven levels asked for are all there", LEVELS.map((l) => l.id).join() === "clean,low_resolution,blur,tilt,shadow,noise,combination");
check("a clean page is untouched", damage(pageOf(), levelOf("clean"), seededRandom(1)).data.every((v, i) => v === pageOf().data[i]));
const again = (seed) => Buffer.from(damage(pageOf(), levelOf("combination"), seededRandom(seed)).data).toString("hex");
check("the same seed gives the same damage, another seed different", again(5) === again(5) && again(5) !== again(6));
check("one image's seed does not depend on the others", seedFor(1, "a#p1", "blur") === seedFor(1, "a#p1", "blur") && seedFor(1, "a#p1", "blur") !== seedFor(1, "a#p1", "tilt") && seedFor(1, "a#p1", "blur") !== seedFor(2, "a#p1", "blur"));
check("a blank page shows no ink, so a failed render can be caught", inkShare(flat(10, 10, 255)) === 0 && inkShare(pageOf()) > 0);
check("grey from canvas pixels", greyFromRgba(Uint8ClampedArray.from([255, 255, 255, 255, 0, 0, 0, 255]), 2, 1).data.join() === "255,0");

console.log("\n=== Rotation tags ===");
const jpegWith = (paint, width = 40, height = 20) => {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  paint(ctx);
  return canvas.toBuffer("image/jpeg", 95);
};
const halfBlack = jpegWith((ctx) => {
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 40, 20);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, 20, 20); // the left half
});
for (const order of ["MM", "II"]) {
  const tagged = withRotationTag(halfBlack, 6, order);
  const tag = readRotationTag(tagged);
  check(`a tag in ${order} order reads back`, tag?.orientation === 6 && tag?.byte_order === order, JSON.stringify(tag));
  await checkUploadContent({ originalname: "x.jpg", buffer: tagged }, "image");
  const shown = await loadImage(tagged);
  const canvas = createCanvas(shown.width, shown.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(shown, 0, 0);
  const at = (x, y) => ctx.getImageData(x, y, 1, 1).data[0];
  // orientation 6: turn 90 degrees clockwise to show it, so the left half becomes the top
  check(`the image loader obeys a tag in ${order} order`, shown.width === 20 && shown.height === 40 && at(10, 5) < 60 && at(10, 35) > 200, `${shown.width}x${shown.height}`);
}
check("a photo with no tag has none", readRotationTag(halfBlack) === null);
check("a picture that is not a JPEG has none", readRotationTag(Buffer.from("not a picture")) === null);
check("the OCR library's own test sees a big-endian tag", orientationOcrSees(withRotationTag(halfBlack, 6, "MM")) === 6);
check("the OCR library's own test misses a little-endian tag", orientationOcrSees(withRotationTag(halfBlack, 6, "II")) === 1);
const big = jpegWith((ctx) => {
  ctx.fillStyle = "#888";
  ctx.fillRect(0, 0, 2000, 1000);
}, 2000, 1000);
const sent = await shrinkLikeBrowser(big);
const sentImage = await loadImage(sent);
check("a photo is shrunk as the browser does: longest side 1600, no tag", sentImage.width === 1600 && sentImage.height === 800 && readRotationTag(sent) === null, `${sentImage.width}x${sentImage.height}`);

console.log("\n=== Intervals and tables ===");
check("Spearman by hand: same order 1, opposite order -1", near(spearman([1, 2, 3, 4], [10, 20, 30, 90]), 1) && near(spearman([1, 2, 3, 4], [9, 7, 3, 1]), -1));
check("Spearman by hand, with a tie", near(spearman([1, 2, 2, 4], [1, 2, 3, 4]), 0.9486832980505138), String(spearman([1, 2, 2, 4], [1, 2, 3, 4])));
check("Spearman: no variation gives no answer", spearman([1, 1, 1], [1, 2, 3]) === null);

const page = (id, reference, reading, extra = {}) => ({ id, note_text: reading, score: scoreReading(reference, reading), ms: 1000, ...extra });
const groups = resampled([page("a", "x", "x"), page("a", "y", "y"), page("b", "z", "")], (r) => r.id, 200, seededRandom(3));
check("resampling keeps a group's rows together", groups.every((d) => d.filter((r) => r.id === "a").length % 2 === 0), String(groups[0].length));
check("resampling is repeatable", JSON.stringify(resampled([page("a", "x", "x"), page("b", "y", "")], (r) => r.id, 5, seededRandom(9)).map((d) => d.map((r) => r.id))) === JSON.stringify(resampled([page("a", "x", "x"), page("b", "y", "")], (r) => r.id, 5, seededRandom(9)).map((d) => d.map((r) => r.id))));

const mixed = [page("p1", "abcd", "abcd", { ms: 1000 }), page("p2", "abcd", "abcx", { ms: 3000 }), page("p3", "abcd", "", { ms: 8000 })];
const summary = summarise(mixed, { reps: 200, random: seededRandom(2) });
check("with no-text pages: an empty page counts as all wrong", near(summary.with_no_text_pages.cer.value, 5 / 12), String(summary.with_no_text_pages.cer.value));
check("without them: it is left out of both sides", near(summary.without_no_text_pages.cer.value, 1 / 8), String(summary.without_no_text_pages.cer.value));
check("how often no text came back", summary.no_text === 1 && near(summary.no_text_share.value, 1 / 3));
check("an interval holds its point", summary.with_no_text_pages.cer.ci[0] <= summary.with_no_text_pages.cer.value && summary.with_no_text_pages.cer.value <= summary.with_no_text_pages.cer.ci[1], JSON.stringify(summary.with_no_text_pages.cer));
check("time: the median and the slowest", summary.seconds.median === 3 && summary.seconds.slowest === 8, JSON.stringify(summary.seconds));

const tracked = confidenceTracking([page("a", "abcd", "abcd", { confidence: 0.95 }), page("b", "abcd", "abcx", { confidence: 0.85 }), page("c", "abcd", "abxx", { confidence: 0.75 }), page("d", "abcd", "xxxx", { confidence: 0.65 }), page("e", "abcd", "", { confidence: null })], { reps: 100, random: seededRandom(4) });
check("confidence that falls as errors rise scores near -1, and a page with none is left out", near(tracked.spearman.value, -1) && tracked.pages === 4, JSON.stringify(tracked.spearman));
check("the confidence bands add up", tracked.bands.reduce((n, b) => n + b.pages, 0) === 4 && tracked.bands[3].pages === 1 && tracked.bands[3].cer === 0);

const flags = flagTable([page("a", "abcd", "abcd", { flagged: false, reliability: 0.9 }), page("b", "abcd", "xxxx", { flagged: true, reliability: 0.3 }), page("c", "abcd", "wxyz", { flagged: false, reliability: 0.8 }), page("d", "abcd", "", { flagged: null, reliability: null })]);
check("flags are counted by how badly the page was really read, and a page with no text is not one", flags.pages_with_text === 3 && flags.flagged === 1 && flags.bands[0].pages === 1 && flags.bands[3].pages === 2 && flags.bands[3].flagged === 1, JSON.stringify(flags.bands));

const better = [page("a", "abcd", "abcd"), page("b", "abcd", "abcd")];
const worse = [page("a", "abcd", "abcx"), page("b", "abcd", "xxxx")];
const diff = pairedDifference(better, worse, { reps: 100, random: seededRandom(5) });
check("a paired difference, by hand", diff.pairs === 2 && near(diff.cer.value, -5 / 8), JSON.stringify(diff.cer));

console.log("\n=== Whole runs, on made-up files ===");
const PRINTED_WORDS = "Enzymes speed up reactions in the cell by lowering the energy they need. ".repeat(16).trim();
await new Promise((resolve, reject) => {
  const doc = new PDFDocument({ size: [420, 300], margin: 20 });
  const stream = fs.createWriteStream(path.join(tmp, "made_up.pdf"));
  doc.pipe(stream);
  doc.font("Helvetica").fontSize(6).text(PRINTED_WORDS); // Helvetica is not embedded, like our notes
  doc.end();
  stream.on("finish", resolve);
  stream.on("error", reject);
});
const gnhk = path.join(tmp, "gnhk");
fs.mkdirSync(gnhk);
const photo = (name, tokens, tag) => {
  const jpeg = jpegWith((ctx) => {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 60, 40);
  }, 60, 40);
  fs.writeFileSync(path.join(gnhk, `${name}.jpg`), tag ? withRotationTag(jpeg, tag[0], tag[1]) : jpeg);
  fs.writeFileSync(path.join(gnhk, `${name}.json`), JSON.stringify(tokens));
};
photo("made_a", [{ text: "zebrafish", polygon: box(1), line_idx: 0, type: "H" }, { text: "stripes", polygon: box(20), line_idx: 0, type: "H" }, { text: "%math%", polygon: box(40), line_idx: 0, type: "H" }]);
photo("made_b", [{ text: "zebrafish", polygon: box(1), line_idx: 0, type: "H" }, { text: "stripes", polygon: box(20), line_idx: 0, type: "P" }], [6, "II"]);
photo("made_c", [{ text: "zebrafish", polygon: box(1), line_idx: 0, type: "H" }, { text: "stripes", polygon: box(20), line_idx: 0, type: "H" }, { text: "%NA%", polygon: box(40), line_idx: 0, type: "H" }], [6, "MM"]);

let reads = 0;
const perfect = async (buffer) => {
  reads += 1;
  const isPhoto = buffer.length < 3000; // the made-up photos are tiny next to a rendered page
  return { text: isPhoto ? "zebrafish stripes" : PRINTED_WORDS, ocrFailed: false, lines: [], confidence: 0.9 };
};
const fakeAnswer = async (images, { vision }) => {
  check.answers = (check.answers || 0) + 1;
  return vision ? { text: "zebrafish stripes", legibility: "clear", by: "vision", model: "made-up-model" } : { text: "zebrafish", legibility: "partial", by: "ocr", model: null };
};
const runOptions = { pdfs: [path.join(tmp, "made_up.pdf")], data: gnhk, reps: 50, quiet: true, readImage: perfect, readAnswer: fakeAnswer, visionReady: () => true, visionModelName: () => "made-up-model", visionImages: 2, visionGap: 0, visionRetryWaitMs: 0 };
const out = path.join(tmp, "run");
const results = await runOcrEvaluation({ ...runOptions, out });
const clean = results.printed.levels.find((l) => l.id === "clean");
check("a page renders and its text layer is the correct text: a perfect reader scores 0% at every level", results.printed.levels.length === 7 && results.printed.levels.every((l) => l.with_no_text_pages.cer.value === 0 && l.no_text === 0), JSON.stringify(clean.with_no_text_pages.cer));
check("every level went through the app's upload check", results.printed.levels.every((l) => l.refused === 0));
check("the rotation test covers its four images", results.rotation_test.length === 4 && results.rotation_test.every((t) => t.cer === 0), JSON.stringify(results.rotation_test.map((t) => t.variant)));
check("label tokens are counted over all photos", results.handwriting.labels.left_out_total === 2 && results.handwriting.labels.left_out["%math%"] === 1 && results.handwriting.labels.left_out["%NA%"] === 1 && results.handwriting.labels.printed_tokens_kept === 1);
check("handwriting scores 0% with a perfect reader, and the pure-handwriting group has 2 photos", results.handwriting.all.with_no_text_pages.cer.value === 0 && results.handwriting.handwriting_only.pages === 2);
check("rotation groups: one tag seen, one missed, and only the missed one is read again turned", results.handwriting.rotation.ocr_sees_the_tag === 1 && results.handwriting.rotation.ocr_misses_the_tag === 1 && results.handwriting.rotation.turned_first.pages === 1);
check("vision and the fallback are scored on the same photos", results.vision.read_by_vision === 2 && results.vision.vision_minus_ocr.pairs === 2 && results.vision.vision.with_no_text_pages.cer.value === 0 && results.vision.ocr_fallback.with_no_text_pages.cer.value > 0);
check("a clean vision reading skips review, and the fallback never does", results.vision.needs_review.vision === 0 && results.vision.needs_review.ocr_fallback === 2);

const saved = fs.readFileSync(path.join(out, "results.json"), "utf8");
const table = fs.readFileSync(path.join(out, "results.md"), "utf8");
check("results.json and results.md hold no label text and no file names", !/zebrafish|stripes|made_a/.test(saved + table));
check("the readings keep the text, for the separate check (this file stays git-ignored)", /zebrafish/.test(fs.readFileSync(path.join(out, "readings.jsonl"), "utf8")));
check("the tables print every level", LEVELS.every((l) => table.includes(`| ${l.label} |`)) && table.includes("made-up-model"));
check("the tables can be drawn again from results.json", resultsMarkdown(JSON.parse(saved)) === table);

const before = reads;
const resumed = await runOcrEvaluation({ ...runOptions, out });
check("a second run on the same commit reads nothing again and gets the same scores", reads === before && JSON.stringify(resumed.printed) === JSON.stringify(results.printed), `${reads - before} new reads`);
let refused = "";
try {
  await runOcrEvaluation({ ...runOptions, out, seed: 2 });
} catch (err) {
  refused = err.message;
}
check("readings from another seed or commit are never mixed in", /use a new --out/.test(refused), refused);

const blank = await runOcrEvaluation({ ...runOptions, out: path.join(tmp, "blank"), visionImages: 0, readImage: async () => ({ text: "", ocrFailed: false }) });
check("a reader that finds nothing: every page is no text, and all wrong", blank.handwriting.all.no_text === 3 && blank.handwriting.all.with_no_text_pages.cer.value === 1 && blank.printed.levels.every((l) => l.no_text === 1));
check("with every page empty, there is no score without them", blank.handwriting.all.without_no_text_pages === null);
check("with vision off, the report says it did not run", blank.vision.ran === false && resultsMarkdown(blank).includes("Not run."));
const noKey = await runOcrEvaluation({ ...runOptions, out: path.join(tmp, "no-key"), visionReady: () => false });
check("with no key the vision part says why it did not run", noKey.vision.ran === false && /no API key/.test(noKey.vision.reason), noKey.vision.reason);

let visionCalls = 0;
const flaky = await runOcrEvaluation({
  ...runOptions,
  out: path.join(tmp, "flaky"),
  readAnswer: async (images, { vision }) => {
    if (!vision) return { text: "zebrafish", legibility: "partial", by: "ocr", model: null };
    visionCalls += 1;
    return visionCalls === 1 ? { text: "zebrafish", legibility: "partial", by: "ocr", model: null } : { text: "zebrafish stripes", legibility: "clear", by: "vision", model: "made-up-model" };
  },
});
check("a vision call that falls back is tried again, and not scored as vision", flaky.vision.read_by_vision === 2 && flaky.vision.took_more_than_one_try === 1 && flaky.vision.vision.with_no_text_pages.cer.value === 0);
const gaveUp = await runOcrEvaluation({ ...runOptions, out: path.join(tmp, "gave-up"), visionImages: 3, readAnswer: async () => ({ text: "zebrafish", legibility: "partial", by: "ocr", model: null }) });
check("a model that keeps failing is reported, not scored", gaveUp.vision.read_by_vision === 0 && gaveUp.vision.fell_back_to_ocr === 3 && gaveUp.vision.vision.pages === 0);

let missing = "";
try {
  await runOcrEvaluation({ ...runOptions, out: path.join(tmp, "none"), data: path.join(tmp, "no-such-folder") });
} catch (err) {
  missing = err.message;
}
check("a missing dataset is explained, and says never to commit it", /not found/.test(missing) && /never be committed/.test(missing), missing);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
