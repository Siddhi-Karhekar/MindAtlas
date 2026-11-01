import { createWorker } from "tesseract.js";

// A photo only counts as having readable text if Tesseract is confident in at
// least a few real words. Measured on sample photos: legible notes, even
// blurry or tilted ones, give 3+ words at 60%+ confidence; a photo with no
// text gives either nothing or a spray of junk ("Sal en I OE es Ap ae") in
// which no word gets past 60%, and that junk would otherwise become a note.
const MIN_WORD_CONFIDENCE = 60;
const MIN_CONFIDENT_WORDS = 3;

// Phones often store a photo on its side, with an EXIF tag saying which way to
// turn it. tesseract.js obeys the tag, but finds it with a byte pattern that only
// matches big-endian order, in the first 500 bytes of the file. A tag written
// little-endian is missed and the page is read on its side: on printed notes, 0.4%
// character errors became 91.7% (docs/measurements/ocr.md).

/** A JPEG's EXIF orientation and the byte order it is written in, or null if it has none. */
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
 * The orientation tesseract.js finds in a file: its own test, from
 * tesseract.js/src/worker-script/utils/setImage.js.
 */
export const orientationOcrSees = (buf) => parseInt(Array.from(buf.subarray(0, 500)).join(" ").match(/1 18 0 3 0 0 0 1 0 (\d)/)?.[1], 10) || 1;

/**
 * The photo with its rotation tag where tesseract.js will find it, if it would
 * miss it otherwise: the tag's bytes, in the order it looks for, in a JPEG comment
 * at the very start. Decoders skip comments, so the picture is untouched, and the
 * reading is the one a big-endian tag gets. recognize()'s rotateRadians option is
 * no use here: it keeps the page's size, so a quarter turn cuts the page off.
 */
export function withRotationOcrCanSee(buffer) {
  const tag = readRotationTag(buffer);
  if (!tag || tag.orientation < 2 || tag.orientation > 8 || orientationOcrSees(buffer) === tag.orientation) return buffer;
  const comment = Buffer.from([0xff, 0xfe, 0x00, 0x0c, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, tag.orientation]);
  return Buffer.concat([buffer.subarray(0, 2), comment, buffer.subarray(2)]);
}

/**
 * Extract text from an image buffer via Tesseract OCR. Mirrors the
 * architecture doc's OCR service (Tesseract locally, cloud Vision API as a
 * fallback on low confidence - the fallback is a documented future
 * extension point, not wired up in this dev build). Network access is
 * required the first time to download the language model; if that fails
 * (offline / restricted sandbox), we fail soft and let the caller decide
 * what to do rather than crashing the request.
 *
 * Returns { text, ocrFailed, lines }: ocrFailed means OCR could not run at all
 * (a damaged image, or no language model); empty text with ocrFailed false
 * means it ran and found no readable text. `lines` is the same text line by
 * line with each line's position and letter height.
 */
export async function extractTextFromImage(buffer) {
  let worker;
  try {
    // Two tesseract.js 5 failure modes get past try/catch unless handled:
    // without an errorHandler a failed job is also re-thrown from the
    // worker's message handler, which crashes the whole server (e.g. on a
    // corrupt image); and a failed language download inside
    // createWorker("eng") leaves createWorker pending forever. Starting with
    // no language and loading it with reinitialize() gives a promise that
    // rejects instead, and a worker we can always terminate.
    worker = await createWorker([], 1, { errorHandler: () => {} });
    await worker.reinitialize("eng");
    const { data } = await worker.recognize(withRotationOcrCanSee(buffer));
    const confidentWords = (data.words || []).filter(
      (w) => w.confidence >= MIN_WORD_CONFIDENCE && /[a-z]{2}/i.test(w.text)
    );
    if (data.words && confidentWords.length < MIN_CONFIDENT_WORDS) {
      return { text: "", ocrFailed: false };
    }
    // Where each line sits and how tall its letters are: the same clues a PDF
    // gives, so headings and list nesting can be recovered from a photo too
    // (see blocksFromOcrLines in documentText.js).
    const lines = (data.lines || [])
      .map((l) => ({
        text: String(l.text || "").replace(/\s+/g, " ").trim(),
        x: l.bbox?.x0,
        y: l.baseline ? (l.baseline.y0 + l.baseline.y1) / 2 : l.bbox?.y1,
        size: l.rowAttributes?.row_height || (l.bbox ? l.bbox.y1 - l.bbox.y0 : 0),
      }))
      .filter((l) => l.text);
    // the mean confidence of the words kept, 0-1: how sure the reading is
    const confidence = confidentWords.length ? confidentWords.reduce((t, w) => t + w.confidence, 0) / confidentWords.length / 100 : null;
    return { text: data.text.trim(), ocrFailed: false, lines, confidence };
  } catch (err) {
    // tesseract.js rejects with a plain string, not an Error, for job failures
    const message = String(err?.message || err);
    console.error("[ocr] failed:", message);
    return { text: "", ocrFailed: true, error: message };
  } finally {
    if (worker) await worker.terminate().catch(() => {});
  }
}
