import { createWorker } from "tesseract.js";

/**
 * Extract text from an image buffer via Tesseract OCR. Mirrors the
 * architecture doc's OCR service (Tesseract locally, cloud Vision API as a
 * fallback on low confidence - the fallback is a documented future
 * extension point, not wired up in this dev build). Network access is
 * required the first time to download the language model; if that fails
 * (offline / restricted sandbox), we fail soft and let the caller decide
 * what to do rather than crashing the request.
 */
export async function extractTextFromImage(buffer) {
  let worker;
  try {
    worker = await createWorker("eng");
    const { data } = await worker.recognize(buffer);
    return { text: data.text.trim(), ocrFailed: false };
  } catch (err) {
    console.error("[ocr] failed:", err.message);
    return { text: "", ocrFailed: true, error: err.message };
  } finally {
    if (worker) await worker.terminate();
  }
}
