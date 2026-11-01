// The OCR measurement: how accurately does MindAtlas read text from images?
// docs/measurements/ocr.md has the method, the limits and the results.
//
//   npm run eval:ocr -- [--data <dir>] [--out <dir>] [--seed <n>] [--reps <n>]
//                       [--limit <n>] [--vision-images <n>] [--vision-gap <seconds>] [--save-images <dir>]
//
// Reads images the way a student's upload is read, with the app's own functions:
//   - printed pages: our two PDFs rendered to images, at every damage level in
//     lib/ocr.js, scored against each page's own text layer;
//   - handwriting: the GNHK photos in --data (default
//     evaluation-output/datasets/gnhk, git-ignored and never to be committed),
//     scored against their labels;
//   - answer photos: --vision-images GNHK photos (default 30, 0 for none) shrunk
//     as the browser does, read by the Groq vision model and by the OCR fallback,
//     --vision-gap seconds apart (default 25). This needs GROQ_API_KEY in .env.
// One image is read at a time, so the times are not inflated by the others.
//
// --seed (default 1) fixes the damage and the sample of photos, --reps the
// resamples behind the 95% intervals (default 1000). --limit reads only the
// first n pages of each set, for a trial. --save-images keeps the damaged pages.
//
// Writes into --out (default evaluation-output/ocr-<timestamp>): results.md and
// results.json hold scores only; readings.jsonl holds every reading and every
// page's correct text, so it stays git-ignored and is never shared. A stopped
// run is picked up again from readings.jsonl, but only on the same commit. App
// behaviour does not change.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { fitWithin } from "../../client/src/lib/answerImages.js";
import { uploadMaxMb } from "../src/config.js";
import { readAnswerImages, readingNeedsReview } from "../src/services/answerImages.js";
import { classifyUpload } from "../src/services/documentText.js";
import { visionAvailable, visionModel } from "../src/services/llm.js";
import { extractTextFromImage } from "../src/services/ocr.js";
import { checkUploadContent } from "../src/services/uploadCheck.js";
import {
  confidenceTracking, damage, flagTable, gnhkReference, greyFromRgba, inkShare, LEVELS, normalise, noteReliability, noteTextFrom, orientationOcrSees, pairedDifference, pooled, readRotationTag, scoreReading, seedFor, summarise,
  turn, withRotationTag,
} from "./lib/ocr.js";
import { seededRandom, shuffled } from "./lib/stats.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, "..");
const require = createRequire(import.meta.url);
const STANDARD_FONTS = `${path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts")}/`;

const PRINTED_PDFS = [path.join(SERVER, "..", "sample-notes", "networks_unit2.pdf"), path.join(SERVER, "..", "verify", "fixtures", "os_unit3.pdf")];
const RENDER_DPI = 300;
const JPEG_QUALITY = 90; // what a phone saves, and it keeps a page of grain under the upload limit
const BROWSER_JPEG_QUALITY = 85; // the first quality client/src/lib/answerImages.js tries
const ROTATION_TEST_PAGES = 3;
const ROTATION_TEST_MIN_CHARS = 1000;
const VISION_TRIES = 3;
const VISION_RETRY_WAIT_MS = 65_000;
const VISION_GIVE_UP_AFTER = 3;
const MB = 1024 * 1024;
const GNHK_SOURCE = {
  official: "https://github.com/GoodNotes/GNHK-dataset",
  copy_used: "https://huggingface.co/datasets/aryaman27/goodnotes-handwritten-dataset",
  copy_revision: "904297760a9fec813fdc1ecb5f8055cb1ca03550",
  copy_folder: "test_data/test",
};

function parseArgs(argv) {
  const opts = {};
  const numbers = { "--seed": "seed", "--reps": "reps", "--limit": "limit", "--vision-images": "visionImages", "--vision-gap": "visionGap" };
  const paths = { "--data": "data", "--out": "out", "--save-images": "saveImages" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (paths[a]) opts[paths[a]] = argv[++i];
    else if (numbers[a]) {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 0) throw new Error(`${a} needs a whole number`);
      opts[numbers[a]] = v;
    } else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

function gitCommit() {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: HERE, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const changed = execFileSync("git", ["status", "--porcelain"], { cwd: HERE, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return { commit, uncommitted_changes: changed !== "" };
  } catch {
    return { commit: null, uncommitted_changes: null };
  }
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- images

/** A PDF's pages, each with its text layer and a way to render it. */
async function openPdf(file) {
  const bytes = fs.readFileSync(file);
  const doc = await getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: STANDARD_FONTS, verbosity: 0 }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const { items } = await page.getTextContent();
    pages.push({ n, page, text: items.map((i) => `${i.str}${i.hasEOL ? "\n" : ""}`).join("") });
  }
  return { name: path.basename(file, ".pdf"), bytes, doc, pages };
}

/** A page as grey levels. Refuses a blank render: without its fonts a PDF renders as white paper, and OCR would then be blamed. */
async function renderPage(page, dpi = RENDER_DPI) {
  const viewport = page.getViewport({ scale: dpi / 72 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  const grey = greyFromRgba(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
  if (inkShare(grey) === 0) throw new Error("a page with text rendered blank - its fonts did not load");
  return grey;
}

function jpegOf(page, quality = JPEG_QUALITY) {
  const canvas = createCanvas(page.width, page.height);
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(page.width, page.height);
  for (let i = 0; i < page.data.length; i++) {
    image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = page.data[i];
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toBuffer("image/jpeg", quality);
}

/** A photo as shrinkImage in client/src/lib/answerImages.js sends it: rotation applied, longest side 1600 px, a JPEG with no tags. */
export async function shrinkLikeBrowser(buffer) {
  const image = await loadImage(buffer);
  const { width, height } = fitWithin(image.width, image.height);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);
  return canvas.toBuffer("image/jpeg", BROWSER_JPEG_QUALITY);
}

/** A photo with its rotation tag obeyed, full size, for comparing against the same photo as sent. */
async function turnedUpright(buffer) {
  const image = await loadImage(buffer);
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext("2d").drawImage(image, 0, 0);
  return canvas.toBuffer("image/jpeg", 95);
}

// ---- reading

/**
 * One image through what POST /api/subjects/:id/notes does with a photo: the
 * size limit, the upload check, OCR, then the page rebuilt into the note's text.
 */
async function readAsNote(buffer, name, reference, read) {
  const file = { originalname: name, mimetype: "image/jpeg", buffer };
  const base = { reference, bytes: buffer.length };
  try {
    if (classifyUpload(file) !== "image") throw new Error("not classed as an image");
    if (buffer.length > uploadMaxMb() * MB) throw new Error("over the upload limit");
    await checkUploadContent(file, "image");
  } catch (err) {
    return { ...base, refused: err.message, note_text: "", raw_text: "", ocr_failed: false, confidence: null, score: scoreReading(reference, ""), raw_score: scoreReading(reference, "") };
  }
  const started = Date.now();
  const ocr = await read(buffer);
  const ms = Date.now() - started;
  const noteText = noteTextFrom(ocr);
  const rawText = ocr.text || "";
  const confidence = ocr.confidence ?? null;
  return {
    ...base,
    refused: null,
    ms,
    note_text: noteText,
    raw_text: rawText,
    ocr_failed: Boolean(ocr.ocrFailed),
    confidence,
    score: scoreReading(reference, noteText),
    raw_score: scoreReading(reference, rawText),
    ...(noteText ? noteReliability({ noteText, confidence, ocrFailed: Boolean(ocr.ocrFailed) }) : { reliability: null, reasons: [], flagged: null }),
  };
}

/** Saved readings, and a way to add to them as each image is read. */
function openReadings(file, { commit, seed }) {
  const done = new Map();
  if (fs.existsSync(file)) {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const [meta, ...rows] = lines;
    if (meta?.meta?.commit !== commit || meta?.meta?.seed !== seed) {
      throw new Error(`${file} is from commit ${meta?.meta?.commit} seed ${meta?.meta?.seed}, not ${commit} seed ${seed} - use a new --out`);
    }
    for (const r of rows) done.set(r.key, r);
  } else fs.writeFileSync(file, `${JSON.stringify({ meta: { commit, seed } })}\n`);
  return {
    done,
    add(row) {
      done.set(row.key, row);
      fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
    },
  };
}

function gnhkPhotos(dir, limit) {
  const names = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).filter((n) => fs.existsSync(path.join(dir, `${n}.jpg`))).sort();
  if (!names.length) {
    throw new Error(`no GNHK photos in ${dir}. They are not in this repository: docs/measurements/ocr.md says where they come from, and they must never be committed`);
  }
  return limit ? names.slice(0, limit) : names;
}

function gnhkManifest(dir, names) {
  const lines = [];
  let bytes = 0;
  for (const n of names) {
    for (const f of [`${n}.jpg`, `${n}.json`]) {
      const b = fs.readFileSync(path.join(dir, f));
      bytes += b.length;
      lines.push(`${sha256(b)}  ${f}`);
    }
  }
  return { files: lines.length, bytes, sha256_of_file_list: sha256(lines.join("\n")) };
}

/** Which photos need turning, and whether the OCR library notices. */
function rotationOf(buffer) {
  const tag = readRotationTag(buffer);
  const needsTurning = Boolean(tag && tag.orientation >= 2 && tag.orientation <= 8);
  return { orientation: tag?.orientation ?? null, byte_order: tag?.byte_order ?? null, needs_turning: needsTurning, ocr_sees_it: needsTurning && orientationOcrSees(buffer) === tag.orientation };
}

const LABEL_FIELDS = (ref) => ({ tokens: ref.tokens, left_out: ref.left_out, handwritten_tokens: ref.handwritten_tokens, printed_tokens: ref.printed_tokens });

/** Read everything not already saved. */
async function readEverything(opts, readings, log) {
  const { done, add } = readings;
  const read = opts.readImage;
  const printedInfo = [];

  // printed pages, at every damage level
  const rotationPages = [];
  const openPdfs = [];
  let pagesLeft = opts.limit || Infinity;
  for (const file of opts.pdfs) {
    const pdf = await openPdf(file);
    printedInfo.push({ file: path.basename(file), pages: pdf.pages.length, bytes: pdf.bytes.length, sha256: sha256(pdf.bytes) });
    for (const { n, page, text } of pdf.pages) {
      if (pagesLeft-- <= 0) break;
      const id = `${pdf.name}#p${n}`;
      // ordinary body pages: a contents page's dot leaders would blur the comparison
      if (normalise(text).length >= ROTATION_TEST_MIN_CHARS && !/\.{5}/.test(text) && rotationPages.length < ROTATION_TEST_PAGES) rotationPages.push({ id, page, text });
      if (LEVELS.every((l) => done.has(`printed|${id}|${l.id}`))) continue;
      const clean = await renderPage(page);
      for (const level of LEVELS) {
        const key = `printed|${id}|${level.id}`;
        if (done.has(key)) continue;
        const damaged = damage(clean, level, seededRandom(seedFor(opts.seed, id, level.id)));
        const jpeg = jpegOf(damaged);
        if (opts.saveImages) {
          fs.mkdirSync(opts.saveImages, { recursive: true });
          fs.writeFileSync(path.join(opts.saveImages, `${pdf.name}_p${n}_${level.id}.jpg`), jpeg);
        }
        add({ key, kind: "printed", id, level: level.id, width: damaged.width, height: damaged.height, ...(await readAsNote(jpeg, `${id}.jpg`, text, read)) });
        log(`  ${key} done`);
      }
    }
    openPdfs.push(pdf);
  }

  // a printed page turned on its side, with a rotation tag in each byte order
  const variants = [
    { id: "upright, no tag", make: (p) => jpegOf(p) },
    { id: "on its side, no tag", make: (p) => jpegOf(turn(p, -90)) },
    { id: "on its side, tag in big-endian order", make: (p) => withRotationTag(jpegOf(turn(p, -90)), 6, "MM") },
    { id: "on its side, tag in little-endian order", make: (p) => withRotationTag(jpegOf(turn(p, -90)), 6, "II") },
  ];
  for (const { id, page, text } of rotationPages) {
    if (variants.every((v) => done.has(`rotation_test|${id}|${v.id}`))) continue;
    const clean = await renderPage(page);
    for (const v of variants) {
      const key = `rotation_test|${id}|${v.id}`;
      if (!done.has(key)) add({ key, kind: "rotation_test", id, variant: v.id, ...(await readAsNote(v.make(clean), `${id}.jpg`, text, read)) });
    }
    log(`  rotation test ${id} done`);
  }
  for (const pdf of openPdfs) await pdf.doc.destroy();

  // handwriting: the photos exactly as they are
  const names = gnhkPhotos(opts.data, opts.limit);
  const labels = new Map();
  for (const name of names) {
    const ref = gnhkReference(JSON.parse(fs.readFileSync(path.join(opts.data, `${name}.json`), "utf8")));
    labels.set(name, ref);
    const key = `handwriting|${name}`;
    if (done.has(key)) continue;
    const buffer = fs.readFileSync(path.join(opts.data, `${name}.jpg`));
    add({ key, kind: "handwriting", id: name, rotation: rotationOf(buffer), ...LABEL_FIELDS(ref), ...(await readAsNote(buffer, `${name}.jpg`, ref.text, read)) });
    log(`  ${key} done`);
  }

  // the photos the library would read on their side, turned upright first
  for (const name of names) {
    const row = done.get(`handwriting|${name}`);
    const key = `handwriting_turned|${name}`;
    if (!row?.rotation?.needs_turning || row.rotation.ocr_sees_it || done.has(key)) continue;
    const buffer = await turnedUpright(fs.readFileSync(path.join(opts.data, `${name}.jpg`)));
    add({ key, kind: "handwriting_turned", id: name, ...(await readAsNote(buffer, `${name}.jpg`, labels.get(name).text, read)) });
    log(`  ${key} done`);
  }

  // answer photos: the vision model and the OCR fallback, on the same images
  const vision = { ran: false, reason: null, wanted: opts.visionImages, model: null };
  if (opts.visionImages > 0) {
    if (!opts.visionReady()) vision.reason = "no API key, or the vision model is turned off";
    else {
      vision.ran = true;
      vision.model = opts.visionModelName();
      const sample = shuffled(names, seededRandom(seedFor(opts.seed, "vision"))).slice(0, opts.visionImages);
      let calledBefore = false;
      let failedInARow = 0;
      for (const name of sample) {
        if (failedInARow >= VISION_GIVE_UP_AFTER) {
          vision.stopped = `the model failed on ${failedInARow} photos in a row`;
          break;
        }
        const reference = labels.get(name).text;
        const [fallbackKey, visionKey] = [`vision_ocr|${name}`, `vision|${name}`];
        if (done.has(fallbackKey) && done.get(visionKey)?.by === "vision") continue;
        const images = [{ mime: "image/jpeg", buffer: await shrinkLikeBrowser(fs.readFileSync(path.join(opts.data, `${name}.jpg`))) }];
        if (!done.has(fallbackKey)) {
          const started = Date.now();
          const reading = await opts.readAnswer(images, { vision: false });
          add({ key: fallbackKey, kind: "vision_ocr", id: name, reference, ms: Date.now() - started, ...answerFields(reference, reading) });
        }
        let tries = 0;
        let row = null;
        while (tries < VISION_TRIES && row?.by !== "vision") {
          if (tries > 0) await wait(opts.visionRetryWaitMs);
          else if (calledBefore) await wait(opts.visionGap * 1000);
          tries += 1;
          calledBefore = true;
          const started = Date.now();
          const reading = await opts.readAnswer(images, { vision: true });
          row = { key: visionKey, kind: "vision", id: name, reference, ms: Date.now() - started, tries, ...answerFields(reference, reading) };
        }
        add(row);
        failedInARow = row.by === "vision" ? 0 : failedInARow + 1;
        log(`  ${visionKey} done (${row.by}, ${tries} ${tries === 1 ? "try" : "tries"})`);
      }
      vision.sample = sample;
    }
  }

  return { printedInfo, names, vision };
}

function answerFields(reference, reading) {
  return {
    note_text: reading.text || "",
    by: reading.by,
    legibility: reading.legibility,
    needs_review: readingNeedsReview(reading),
    model: reading.model ?? null,
    score: scoreReading(reference, reading.text || ""),
  };
}

// ---- tables

/** The tables, from the saved readings alone. */
export function scoreReadings(rows, { seed, reps, vision }) {
  const random = seededRandom(seed);
  const options = { reps, random };
  const printed = rows.filter((r) => r.kind === "printed");
  const hand = rows.filter((r) => r.kind === "handwriting");
  const turned = rows.filter((r) => r.kind === "handwriting_turned");
  const needTurning = hand.filter((r) => r.rotation?.needs_turning);
  const missed = needTurning.filter((r) => !r.rotation.ocr_sees_it);
  const pureHandwriting = hand.filter((r) => !r.printed_tokens);

  const leftOut = {};
  for (const r of hand) for (const [token, n] of Object.entries(r.left_out)) leftOut[token] = (leftOut[token] || 0) + n;

  const out = {
    printed: {
      pages: new Set(printed.map((r) => r.id)).size,
      images: printed.length,
      levels: LEVELS.map((l) => ({ id: l.id, label: l.label, what: l.what, ...summarise(printed.filter((r) => r.level === l.id), options) })),
    },
    rotation_test: [...new Set(rows.filter((r) => r.kind === "rotation_test").map((r) => r.variant))].map((variant) => {
      const inside = rows.filter((r) => r.kind === "rotation_test" && r.variant === variant);
      return { variant, pages: inside.length, no_text: inside.filter((r) => !r.note_text).length, ...pooled(inside) };
    }),
    handwriting: {
      labels: {
        photos: hand.length,
        tokens: hand.reduce((n, r) => n + r.tokens, 0),
        left_out: leftOut,
        left_out_total: Object.values(leftOut).reduce((a, b) => a + b, 0),
        handwritten_tokens_kept: hand.reduce((n, r) => n + r.handwritten_tokens, 0),
        printed_tokens_kept: hand.reduce((n, r) => n + r.printed_tokens, 0),
        photos_with_printed_tokens: hand.length - pureHandwriting.length,
      },
      all: summarise(hand, options),
      handwriting_only: summarise(pureHandwriting, options),
      rotation: {
        photos_needing_turning: needTurning.length,
        ocr_sees_the_tag: needTurning.length - missed.length,
        ocr_misses_the_tag: missed.length,
        groups: [
          { label: "No turning needed", ...summarise(hand.filter((r) => !r.rotation?.needs_turning), options) },
          { label: "Needs turning, and the library sees the tag", ...summarise(needTurning.filter((r) => r.rotation.ocr_sees_it), options) },
          { label: "Needs turning, and the library misses the tag", ...summarise(missed, options) },
        ],
        missed_as_sent_vs_turned_first: turned.length ? pairedDifference(missed, turned, options) : null,
        turned_first: turned.length ? summarise(turned, options) : null,
      },
    },
    confidence: {
      printed: confidenceTracking(printed, options), // one page's levels resample together: their id is the page
      handwriting: confidenceTracking(hand, options),
    },
    flags: { printed: flagTable(printed), handwriting: flagTable(hand) },
    vision: { ...vision, sample: undefined },
  };

  const answerVision = rows.filter((r) => r.kind === "vision");
  if (answerVision.length) {
    const byVision = answerVision.filter((r) => r.by === "vision");
    const ids = new Set(byVision.map((r) => r.id));
    const fallback = rows.filter((r) => r.kind === "vision_ocr" && ids.has(r.id));
    out.vision = {
      ...out.vision,
      images: answerVision.length,
      read_by_vision: byVision.length,
      fell_back_to_ocr: answerVision.length - byVision.length,
      took_more_than_one_try: answerVision.filter((r) => r.tries > 1).length,
      vision: summarise(byVision, options),
      ocr_fallback: summarise(fallback, options),
      vision_minus_ocr: pairedDifference(byVision, fallback, options),
      needs_review: { vision: byVision.filter((r) => r.needs_review).length, ocr_fallback: fallback.filter((r) => r.needs_review).length },
      by_legibility: ["clear", "partial", "unreadable"].map((label) => {
        const inside = byVision.filter((r) => r.legibility === label);
        return { label, images: inside.length, cer: pooled(inside)?.cer ?? null, word_f1: pooled(inside)?.word_f1 ?? null };
      }),
    };
  }
  return out;
}

/**
 * Run the measurement. Exported so the tests can call it with made-up files and
 * stand-ins for Tesseract and the vision model. Returns what results.json holds.
 */
export async function runOcrEvaluation(options = {}) {
  const opts = {
    seed: 1,
    reps: 1000,
    limit: 0,
    visionImages: 30,
    visionGap: 25,
    visionRetryWaitMs: VISION_RETRY_WAIT_MS,
    pdfs: PRINTED_PDFS,
    data: path.join("evaluation-output", "datasets", "gnhk"),
    readImage: extractTextFromImage,
    readAnswer: readWithOrWithoutVision,
    visionReady: visionAvailable,
    visionModelName: visionModel,
    quiet: false,
    ...options,
  };
  const log = (...a) => !opts.quiet && console.log(...a);
  if (!fs.existsSync(opts.data)) throw new Error(`${opts.data} not found. GNHK is not in this repository: docs/measurements/ocr.md says where it comes from, and it must never be committed`);

  const started = Date.now();
  const git = gitCommit();
  const outDir = opts.out || path.join("evaluation-output", `ocr-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
  fs.mkdirSync(outDir, { recursive: true });
  const readings = openReadings(path.join(outDir, "readings.jsonl"), { commit: git.commit, seed: opts.seed });
  const { printedInfo, names, vision } = await readEverything(opts, readings, log);

  log("Scoring ...");
  const rows = [...readings.done.values()];
  const modelFile = path.join(process.cwd(), "eng.traineddata");
  const results = {
    created: new Date().toISOString(),
    ...git,
    seed: opts.seed,
    reps: opts.reps,
    limit: opts.limit || null,
    seconds_this_run: Math.round((Date.now() - started) / 1000),
    normalised: "lower case; every run of spacing (spaces, tabs, line breaks) made one space; spacing at the ends removed. Nothing else: punctuation, symbols and accents stay.",
    tesseract: {
      tesseract_js: require("tesseract.js/package.json").version,
      model_file: fs.existsSync(modelFile) ? { bytes: fs.statSync(modelFile).size, sha256: sha256(fs.readFileSync(modelFile)) } : null,
    },
    upload_limit_mb: uploadMaxMb(),
    render: { dpi: RENDER_DPI, jpeg_quality: JPEG_QUALITY },
    datasets: { printed: printedInfo, gnhk: { ...GNHK_SOURCE, ...gnhkManifest(opts.data, names) } },
    ...scoreReadings(rows, { seed: opts.seed, reps: opts.reps, vision }),
  };
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(outDir, "results.md"), resultsMarkdown(results));
  results.outDir = outDir;
  log(resultsMarkdown(results));
  return results;
}

/** The app's own function for answer photos, with the vision model on or (by its own switch) off. */
async function readWithOrWithoutVision(images, { vision }) {
  const before = process.env.LLM_VISION_MODEL;
  if (!vision) process.env.LLM_VISION_MODEL = "off";
  try {
    return await readAnswerImages(images);
  } finally {
    if (before === undefined) delete process.env.LLM_VISION_MODEL;
    else process.env.LLM_VISION_MODEL = before;
  }
}

const pct = (x) => (x === null || x === undefined ? "-" : `${(x * 100).toFixed(1)}%`);
const f2 = (x) => (x === null || x === undefined ? "-" : x.toFixed(2));
const secs = (x) => (x === null || x === undefined ? "-" : `${x.toFixed(1)} s`);
const count = (x) => x.toLocaleString("en-US");
const cell = (s) => (s ? `${pct(s.value)} [${pct(s.ci?.[0])}, ${pct(s.ci?.[1])}]` : "-");
const signed = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}`;
const diffCell = (d) => (d ? `${signed(d.value)} [${signed(d.ci[0])}, ${signed(d.ci[1])}] points` : "-");

const scoreHeader = "| CER, all pages [95%] | WER, all pages [95%] | CER, pages with text [95%] | WER, pages with text [95%] |";
const scoreRule = "| --- | --- | --- | --- |";
const scoreCells = (s) => `| ${cell(s.with_no_text_pages?.cer)} | ${cell(s.with_no_text_pages?.wer)} | ${cell(s.without_no_text_pages?.cer)} | ${cell(s.without_no_text_pages?.wer)} |`;
const noTextCell = (s) => `${count(s.no_text)} of ${count(s.pages)} (${pct(s.no_text_share?.value)} [${pct(s.no_text_share?.ci?.[0])}, ${pct(s.no_text_share?.ci?.[1])}])`;
const wordRow = (label, s) => `| ${label} | ${cell(s?.words_found)} | ${cell(s?.words_right)} | ${cell(s?.word_f1)} |`;

function confidenceLines(label, c) {
  if (!c) return [`${label}: no pages with a confidence.`, ""];
  return [
    `### ${label}`,
    "",
    `${count(c.pages)} readings. Confidence runs from ${f2(c.lowest)} to ${f2(c.highest)}. Spearman correlation with the page's CER: ${f2(c.spearman.value)} [${f2(c.spearman.ci?.[0])}, ${f2(c.spearman.ci?.[1])}].`,
    "",
    "| Confidence | Pages | CER, pooled | CER, median page |",
    "| --- | --- | --- | --- |",
    ...c.bands.map((b) => `| ${b.label} | ${count(b.pages)} | ${pct(b.cer)} | ${pct(b.median_page_cer)} |`),
    "",
  ];
}

function flagLines(label, t) {
  return [
    `### ${label}`,
    "",
    `${count(t.flagged)} of ${count(t.pages_with_text)} pages with text are held back as not read reliably.`,
    "",
    "| Real CER of the page | Pages | Held back | Mean reliability the app gives |",
    "| --- | --- | --- | --- |",
    ...t.bands.map((b) => `| ${b.label} | ${count(b.pages)} | ${count(b.flagged)} | ${f2(b.mean_reliability)} |`),
    "",
  ];
}

/** The results as tables for the report. No label text and no file names. */
export function resultsMarkdown(r) {
  const h = r.handwriting;
  const v = r.vision;
  const lines = [
    "# OCR measurement",
    "",
    `Commit ${r.commit || "unknown"}${r.uncommitted_changes ? " (with uncommitted changes)" : ""}, seed ${r.seed}, ${r.reps} resamples of pages${r.limit ? `, TRIAL: first ${r.limit} pages of each set only` : ""}. tesseract.js ${r.tesseract.tesseract_js}.`,
    "",
    `Normalised before scoring: ${r.normalised}`,
    "",
    "\"All pages\" counts a page with no text as all wrong. \"Pages with text\" leaves those pages out.",
    "",
    "## Printed pages",
    "",
    `${count(r.printed.pages)} pages, ${count(r.printed.images)} images.`,
    "",
    `| Level | What | No text ${scoreHeader}`,
    `| --- | --- | --- ${scoreRule}`,
    ...r.printed.levels.map((l) => `| ${l.label} | ${l.what} | ${noTextCell(l)} ${scoreCells(l)}`),
    "",
    "| Level | CER, Tesseract's text before the rebuild | Median page CER | Time, median | Time, slowest | Mean confidence |",
    "| --- | --- | --- | --- | --- | --- |",
    ...r.printed.levels.map((l) => `| ${l.label} | ${pct(l.tesseract_text?.cer)} | ${pct(l.median_page_cer)} | ${secs(l.seconds?.median)} | ${secs(l.seconds?.slowest)} | ${f2(l.mean_confidence)} |`),
    "",
    "## A printed page with a rotation tag",
    "",
    "| Image | Pages | No text | CER | WER |",
    "| --- | --- | --- | --- | --- |",
    ...r.rotation_test.map((t) => `| ${t.variant} | ${t.pages} | ${t.no_text} | ${pct(t.cer)} | ${pct(t.wer)} |`),
    "",
    "## Handwriting (GNHK)",
    "",
    `${count(h.labels.photos)} photos, ${count(h.labels.tokens)} label tokens. Left out as not real text: ${count(h.labels.left_out_total)} (${Object.entries(h.labels.left_out).map(([t, n]) => `${t} ${count(n)}`).join(", ")}). Kept: ${count(h.labels.handwritten_tokens_kept)} handwritten and ${count(h.labels.printed_tokens_kept)} printed tokens; ${count(h.labels.photos_with_printed_tokens)} photos have printed tokens.`,
    "",
    `| Photos | No text ${scoreHeader}`,
    `| --- | --- ${scoreRule}`,
    `| All ${count(h.all.pages)} | ${noTextCell(h.all)} ${scoreCells(h.all)}`,
    `| The ${count(h.handwriting_only.pages)} with no printed tokens | ${noTextCell(h.handwriting_only)} ${scoreCells(h.handwriting_only)}`,
    "",
    "Word scores that ignore reading order:",
    "",
    "| Photos | Words found [95%] | Words right [95%] | F1 [95%] |",
    "| --- | --- | --- | --- |",
    wordRow(`All ${count(h.all.pages)}, all pages`, h.all.with_no_text_pages),
    wordRow(`All ${count(h.all.pages)}, pages with text`, h.all.without_no_text_pages),
    wordRow(`The ${count(h.handwriting_only.pages)} with no printed tokens, all pages`, h.handwriting_only.with_no_text_pages),
    wordRow(`The ${count(h.handwriting_only.pages)} with no printed tokens, pages with text`, h.handwriting_only.without_no_text_pages),
    "",
    "| Photos | CER, Tesseract's text before the rebuild | Median page CER | Time, median | Time, slowest | Mean confidence |",
    "| --- | --- | --- | --- | --- | --- |",
    `| All ${count(h.all.pages)} | ${pct(h.all.tesseract_text?.cer)} | ${pct(h.all.median_page_cer)} | ${secs(h.all.seconds?.median)} | ${secs(h.all.seconds?.slowest)} | ${f2(h.all.mean_confidence)} |`,
    `| The ${count(h.handwriting_only.pages)} with no printed tokens | ${pct(h.handwriting_only.tesseract_text?.cer)} | ${pct(h.handwriting_only.median_page_cer)} | ${secs(h.handwriting_only.seconds?.median)} | ${secs(h.handwriting_only.seconds?.slowest)} | ${f2(h.handwriting_only.mean_confidence)} |`,
    "",
    "### By rotation tag",
    "",
    `${count(h.rotation.photos_needing_turning)} photos have a tag that says to turn them. The library sees ${count(h.rotation.ocr_sees_the_tag)} and misses ${count(h.rotation.ocr_misses_the_tag)}.`,
    "",
    `| Group | No text ${scoreHeader}`,
    `| --- | --- ${scoreRule}`,
    ...h.rotation.groups.map((g) => `| ${g.label} | ${noTextCell(g)} ${scoreCells(g)}`),
    ...(h.rotation.turned_first ? [`| The missed ones, turned upright first | ${noTextCell(h.rotation.turned_first)} ${scoreCells(h.rotation.turned_first)}`] : []),
    "",
    ...(h.rotation.missed_as_sent_vs_turned_first
      ? [`As sent minus turned first, same photos: CER ${diffCell(h.rotation.missed_as_sent_vs_turned_first.cer)}, WER ${diffCell(h.rotation.missed_as_sent_vs_turned_first.wer)}, F1 ${diffCell(h.rotation.missed_as_sent_vs_turned_first.word_f1)}.`, ""]
      : []),
    "## Does the app's confidence track errors?",
    "",
    ...confidenceLines("Printed pages, every level", r.confidence.printed),
    ...confidenceLines("Handwriting", r.confidence.handwriting),
    "## Are badly read pages flagged?",
    "",
    ...flagLines("Printed pages, every level", r.flags.printed),
    ...flagLines("Handwriting", r.flags.handwriting),
    "## Answer photos: vision model against the OCR fallback",
    "",
  ];
  if (!v.images) lines.push(v.reason ? `Not run: ${v.reason}.` : "Not run.", "");
  else {
    lines.push(
      `Model ${v.model}. ${v.images} photos, shrunk as the browser does; ${v.read_by_vision} read by the model, ${v.fell_back_to_ocr} fell back to OCR, ${v.took_more_than_one_try} took more than one try.${v.stopped ? ` Stopped early: ${v.stopped}.` : ""} Scores below are on the ${v.read_by_vision} read by the model.`,
      "",
      `| Reader | No text ${scoreHeader}`,
      `| --- | --- ${scoreRule}`,
      `| Vision model | ${noTextCell(v.vision)} ${scoreCells(v.vision)}`,
      `| OCR fallback | ${noTextCell(v.ocr_fallback)} ${scoreCells(v.ocr_fallback)}`,
      "",
      "| Reader | Words found [95%] | Words right [95%] | F1 [95%] | Time, median | Time, slowest | Sent for review |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      `| Vision model | ${cell(v.vision.with_no_text_pages?.words_found)} | ${cell(v.vision.with_no_text_pages?.words_right)} | ${cell(v.vision.with_no_text_pages?.word_f1)} | ${secs(v.vision.seconds?.median)} | ${secs(v.vision.seconds?.slowest)} | ${v.needs_review.vision} |`,
      `| OCR fallback | ${cell(v.ocr_fallback.with_no_text_pages?.words_found)} | ${cell(v.ocr_fallback.with_no_text_pages?.words_right)} | ${cell(v.ocr_fallback.with_no_text_pages?.word_f1)} | ${secs(v.ocr_fallback.seconds?.median)} | ${secs(v.ocr_fallback.seconds?.slowest)} | ${v.needs_review.ocr_fallback} |`,
      "",
      `Vision minus OCR, same photos: CER ${diffCell(v.vision_minus_ocr?.cer)}, WER ${diffCell(v.vision_minus_ocr?.wer)}, F1 ${diffCell(v.vision_minus_ocr?.word_f1)}.`,
      "",
      "| The model's own legibility | Photos | CER, pooled | F1 |",
      "| --- | --- | --- | --- |",
      ...v.by_legibility.map((b) => `| ${b.label} | ${b.images} | ${pct(b.cer)} | ${pct(b.word_f1)} |`),
      ""
    );
  }
  return lines.join("\n");
}

const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

// run directly: `node evaluation/ocr.mjs ...`
if (process.argv[1] && samePath(fileURLToPath(import.meta.url), path.resolve(process.argv[1]))) {
  try {
    (await import("dotenv")).config(); // only when run, so the tests can never reach the key
    const results = await runOcrEvaluation(parseArgs(process.argv.slice(2)));
    console.log(`Written to ${path.join(results.outDir, "results.md")}, results.json and readings.jsonl`);
    process.exit(0);
  } catch (err) {
    console.error(`eval:ocr failed: ${err.message}`);
    process.exit(1);
  }
}
