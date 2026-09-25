import { createWorker } from "tesseract.js";

// A photo only counts as having readable text if Tesseract is confident in at
// least a few real words. Measured on sample photos: legible notes, even
// blurry or tilted ones, give 3+ words at 60%+ confidence; a photo with no
// text gives either nothing or a spray of junk ("Sal en I OE es Ap ae") in
// which no word gets past 60%, and that junk would otherwise become a note.
const MIN_WORD_CONFIDENCE = 60;
const MIN_CONFIDENT_WORDS = 3;

/**
 * Extract text from an image buffer via Tesseract OCR. Mirrors the
 * architecture doc's OCR service (Tesseract locally, cloud Vision API as a
 * fallback on low confidence - the fallback is a documented future
 * extension point, not wired up in this dev build). Network access is
 * required the first time to download the language model; if that fails
 * (offline / restricted sandbox), we fail soft and let the caller decide
 * what to do rather than crashing the request.
 *
 * Returns { text, ocrFailed }: ocrFailed means OCR could not run at all (a
 * damaged image, or no language model); empty text with ocrFailed false
 * means it ran and found no readable text.
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
    const { data } = await worker.recognize(buffer);
    const confidentWords = (data.words || []).filter(
      (w) => w.confidence >= MIN_WORD_CONFIDENCE && /[a-z]{2}/i.test(w.text)
    );
    if (data.words && confidentWords.length < MIN_CONFIDENT_WORDS) {
      return { text: "", ocrFailed: false };
    }
    return { text: data.text.trim(), ocrFailed: false };
  } catch (err) {
    // tesseract.js rejects with a plain string, not an Error, for job failures
    const message = String(err?.message || err);
    console.error("[ocr] failed:", message);
    return { text: "", ocrFailed: true, error: message };
  } finally {
    if (worker) await worker.terminate().catch(() => {});
  }
}
