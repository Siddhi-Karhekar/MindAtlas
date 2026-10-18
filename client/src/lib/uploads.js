// What may be uploaded as a note, checked in the browser before anything is
// sent. The server checks the same things again (routes/notes.js,
// middleware/upload.js) - this is so a student hears about a file that is too
// large or of the wrong kind at once, not after waiting for it to upload.

// What the server accepts (GET /api/auth/config -> uploads). These defaults
// match the server's own (server/src/config.js) and are used until it
// answers, or if it cannot.
export const DEFAULT_LIMITS = { maxMb: 10, maxPdfPages: 400, maxImageMegapixels: 50, maxWords: 250000 };
export const ACCEPT = ".pdf,.docx,.pptx,.txt,.md,.markdown,.csv,image/*";
const EXT_OK = /\.(pdf|docx|pptx|txt|md|markdown|text|csv|png|jpe?g|gif|webp|bmp|tiff?)$/i;

export function prettySize(n) {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Why `f` (a File, or { name, size, type }) cannot be uploaded, or "" when it can. */
export function fileProblem(f, limits = DEFAULT_LIMITS) {
  const type = f.type || "";
  // the pre-2007 Office formats can't be read; say how to get past it
  if (/\.doc$/i.test(f.name)) return "Old Word format (.doc) — open it in Word and Save As .docx, then upload that";
  if (/\.ppt$/i.test(f.name)) return "Old PowerPoint format (.ppt) — open it in PowerPoint and Save As .pptx, then upload that";
  if (!(EXT_OK.test(f.name) || type.startsWith("image/") || type.startsWith("text/")))
    return "Unsupported type — use PDF, Word (.docx), PowerPoint (.pptx), text/markdown or an image";
  if (f.size > limits.maxMb * 1024 * 1024)
    return `${prettySize(f.size)} — over the ${limits.maxMb} MB limit. Split it into smaller files (or compress its pictures) and upload those`;
  if (f.size === 0) return "This file is empty";
  return "";
}
