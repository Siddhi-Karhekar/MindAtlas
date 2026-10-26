// Settings read from the environment, in one place, for the parts of the
// server that have to agree with each other (CORS, the origin check, cookies,
// links in emails).

export const isProduction = () => process.env.NODE_ENV === "production";

/** The browser origins allowed to call this API from another address. */
export function allowedOrigins() {
  const configured = (process.env.CORS_ORIGIN || "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  if (configured.length) return configured;
  // Unset: the local Vite dev server outside production, nobody in production.
  return isProduction() ? [] : ["http://localhost:5173", "http://127.0.0.1:5173"];
}

/**
 * The address of the web app, for links in emails. Never taken from the
 * request: a forged Host header would otherwise put an attacker's address
 * into a password-reset email. APP_URL wins; otherwise the first allowed
 * origin (a separately hosted client), then the address Render gives the
 * service, then the local dev server.
 */
export function appUrl() {
  const url = process.env.APP_URL?.trim() || allowedOrigins()[0] || process.env.RENDER_EXTERNAL_URL?.trim() || "http://localhost:5173";
  return url.replace(/\/+$/, "");
}

/** True when the web app's address comes from a setting, not from the local-development default. */
export const hasKnownAppUrl = () => Boolean(process.env.APP_URL?.trim() || allowedOrigins()[0] || process.env.RENDER_EXTERNAL_URL?.trim());

/**
 * The accounts that may open the admin page: ADMIN_USER_IDS, a comma-separated
 * list of account ids (shown on each student's Settings page). Ids, not email
 * addresses: an address can be signed up by anyone before its owner, an id
 * only exists once the account does.
 */
export const adminIds = () =>
  (process.env.ADMIN_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[0-9a-f]{24}$/.test(s));

/** Where students can write for help or with a complaint (SUPPORT_EMAIL), if set. */
export const supportEmail = () => {
  const e = (process.env.SUPPORT_EMAIL || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
};

/** A positive number from the environment, or the default. */
export const envNumber = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// ---------------------------------------------------------------------------
// Upload limits: one place, read by the upload routes, the readers and the
// client (GET /api/auth/config sends them, so the upload screen states the
// same numbers the server enforces).
// ---------------------------------------------------------------------------

// Largest file accepted, in MB (UPLOAD_MAX_MB, default 10). Files are held in
// memory while they are read, and the free hosting plan has 512 MB for
// everything, so the setting is capped at 25.
export const uploadMaxMb = () => Math.min(25, envNumber("UPLOAD_MAX_MB", 10));
// A PDF longer than this is refused before its pages are read.
export const MAX_PDF_PAGES = 400;
// A photo larger than this many pixels is refused before it is decoded.
export const MAX_IMAGE_PIXELS = 50_000_000;
// Text one upload may produce (about 250,000 words). Past this, splitting,
// key-term extraction and linking hold up every other student's requests.
export const MAX_UPLOAD_TEXT = 1_500_000;

/** The upload limits as the client shows them. */
export function uploadLimits() {
  return {
    maxMb: uploadMaxMb(),
    maxPdfPages: MAX_PDF_PAGES,
    maxImageMegapixels: MAX_IMAGE_PIXELS / 1_000_000,
    maxWords: Math.round(MAX_UPLOAD_TEXT / 6 / 1000) * 1000,
    readTimeoutSeconds: envNumber("EXTRACT_TIMEOUT_SECONDS", 25),
    types: [
      { label: "PDF", extensions: [".pdf"], note: `up to ${MAX_PDF_PAGES} pages; text PDFs only (a scanned PDF has no text - upload its pages as photos)` },
      { label: "Word", extensions: [".docx"], note: "not the old .doc format - Save As .docx first" },
      { label: "PowerPoint", extensions: [".pptx"], note: "not the old .ppt format - Save As .pptx first" },
      { label: "Text / Markdown", extensions: [".txt", ".md", ".markdown", ".csv"], note: null },
      { label: "Photo (OCR)", extensions: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff"], note: `up to ${MAX_IMAGE_PIXELS / 1_000_000} megapixels; printed text reads best` },
    ],
  };
}

// ---------------------------------------------------------------------------
// Pictures attached to theory answers (handwritten working, formulas,
// diagrams). The browser shrinks a photo before sending it (longest side
// 1600 px, JPEG), so a page of handwriting is usually 200-600 KB; the limit
// is for files sent some other way.
// ---------------------------------------------------------------------------
export const answerImageLimits = () => ({
  maxPerAnswer: 3, // also the most a vision model is sent at once (Groq: 3)
  maxMb: Math.min(10, envNumber("ANSWER_IMAGE_MAX_MB", 5)),
  // every answer picture a student has, across all tests: a ceiling on storage.
  // Pictures are kept in the database (base64), so 100 x 5 MB is already
  // about 0.7 GB for one student - more than a free database holds. Raise it
  // only with storage to match.
  maxPerStudent: envNumber("ANSWER_IMAGES_MAX_PER_STUDENT", 100),
  types: ["image/jpeg", "image/png", "image/webp"],
});
