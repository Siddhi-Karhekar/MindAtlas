// Pictures on a theory answer, prepared in the browser before they are sent.
//
// A phone photo of a page is 3-12 MB and 12+ megapixels; the words on it are
// readable at a fraction of that. So before uploading, a picture is drawn
// onto a canvas no larger than MAX_SIDE on its longest side and saved as a
// JPEG: typically 200-600 KB, quick to send on a phone connection, and what
// the reading model needs. Drawing it also drops the photo's metadata (where
// and when it was taken) and applies its rotation.
// The server checks everything again (routes/attempts.js).

export const MAX_SIDE = 1600;
export const ACCEPTED = "image/jpeg,image/png,image/webp,image/heic,image/heif";
export const DEFAULT_IMAGE_LIMITS = { maxPerAnswer: 3, maxMb: 5 };

/** Why a chosen file cannot be attached, or "" when it can. */
export function imageProblem(file, { count = 0, limits = DEFAULT_IMAGE_LIMITS } = {}) {
  const type = String(file?.type || "").toLowerCase();
  const name = String(file?.name || "");
  if (count >= limits.maxPerAnswer) return `An answer can have at most ${limits.maxPerAnswer} pictures - remove one first.`;
  if (!type.startsWith("image/") && !/\.(jpe?g|png|webp|heic|heif)$/i.test(name)) return `"${name || "This file"}" is not a picture - use a JPG, PNG or WebP photo.`;
  if (/heic|heif/.test(type) || /\.(heic|heif)$/i.test(name)) return ""; // converted to JPEG below, where the browser can read it
  if (!/^image\/(jpeg|png|webp)$/.test(type) && !/\.(jpe?g|png|webp)$/i.test(name)) return `"${name}" is a ${type || "picture"} file - use a JPG, PNG or WebP photo.`;
  if (file.size === 0) return `"${name}" is empty.`;
  // very large originals are still accepted: they are shrunk before sending
  if (file.size > 40 * 1024 * 1024) return `"${name}" is larger than 40 MB - take the photo again at a lower resolution.`;
  return "";
}

/** Longest side at most MAX_SIDE, as { width, height }. */
export function fitWithin(width, height, max = MAX_SIDE) {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * The picture shrunk and re-saved as a JPEG Blob. Throws an Error with a
 * message for the student when the browser cannot read it (a HEIC photo in a
 * browser without HEIC support, a damaged file).
 */
export async function shrinkImage(file, { maxBytes = DEFAULT_IMAGE_LIMITS.maxMb * 1024 * 1024 } = {}) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(
      /heic|heif/i.test(file.type || file.name)
        ? "This browser cannot open HEIC photos - share the photo as JPG (on iPhone: Settings → Camera → Formats → Most Compatible), or take it with the camera button."
        : `"${file.name}" could not be opened as a picture - it may be damaged.`
    );
  }
  const { width, height } = fitWithin(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff"; // a transparent PNG would turn black as a JPEG
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  for (const quality of [0.85, 0.7, 0.55]) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (blob && blob.size <= maxBytes) return blob;
  }
  throw new Error(`"${file.name}" is still too large after shrinking - crop it to the answer and try again.`);
}
