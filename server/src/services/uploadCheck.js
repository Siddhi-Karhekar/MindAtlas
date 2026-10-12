// Is an uploaded file what its name says it is, and safe to open?
//
// A file's name and the type the browser reports are both chosen by whoever
// sends it. Before a reader (the PDF parser, the Word and PowerPoint
// unzipper, OCR) is pointed at the bytes, the bytes themselves are checked:
//   - they start the way a file of that kind starts;
//   - a Word or PowerPoint file (a zip archive) does not unpack to something
//     enormous - a few kilobytes can be made to expand to gigabytes and take
//     the server's memory with them - and really contains a document. The
//     parts are unpacked and COUNTED here, because the sizes written in the
//     archive are the sender's word;
//   - a picture's size in pixels can be read and is not so large that
//     decoding it would do the same.
// Files are read from memory and never written to disk or served back, so
// there is no stored file to execute or to overwrite another with.
//
// Every refusal is an Error whose message is meant for the student.

import JSZip from "jszip";

const MB = 1024 * 1024;
const MAX_ZIP_ENTRIES = 5_000;
const MAX_UNPACKED = 150 * MB; // slides carry pictures; text is a small part
const MAX_XML_PART = 25 * MB; // the parts the reader actually opens
const MAX_PIXELS = 50_000_000; // a 50-megapixel photo

const startsWith = (buf, bytes, at = 0) => bytes.every((b, i) => buf[at + i] === b);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

const IMAGE_SIGNATURES = [
  { name: "PNG", test: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { name: "JPEG", test: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  { name: "GIF", test: (b) => startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a")) },
  { name: "WebP", test: (b) => startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8) },
  { name: "BMP", test: (b) => startsWith(b, ascii("BM")) },
  { name: "TIFF", test: (b) => startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a]) },
];

/**
 * Width and height read from a picture's header, or null when the header is
 * cut short or does not follow its format - which the caller treats as "not a
 * picture that can be read", so a size that cannot be known is never waved
 * through to the decoder.
 */
export function imageSize(buf) {
  try {
    // PNG: the size is in the IHDR chunk, which must come first
    if (IMAGE_SIGNATURES[0].test(buf)) {
      return startsWith(buf, ascii("IHDR"), 12) ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : null;
    }
    if (IMAGE_SIGNATURES[2].test(buf)) return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }; // GIF
    if (IMAGE_SIGNATURES[4].test(buf)) {
      // BMP: the old 12-byte header holds 16-bit sizes, every later one 32-bit
      if (buf.readUInt32LE(14) === 12) return { width: buf.readUInt16LE(18), height: buf.readUInt16LE(20) };
      return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
    }
    if (IMAGE_SIGNATURES[1].test(buf)) {
      // JPEG: walk the segments to the frame header (SOF0-SOF15, except the
      // three that are not frame headers), which holds the size
      let at = 2;
      while (at + 9 < buf.length) {
        if (buf[at] !== 0xff) return null;
        while (buf[at + 1] === 0xff) at += 1; // any number of 0xFF fill bytes may precede a marker
        const marker = buf[at + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { width: buf.readUInt16BE(at + 7), height: buf.readUInt16BE(at + 5) };
        }
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) at += 2; // markers with no length
        else at += 2 + buf.readUInt16BE(at + 2);
      }
      return null;
    }
    if (IMAGE_SIGNATURES[3].test(buf)) {
      // WebP: three layouts, named by the chunk after the RIFF header
      const chunk = buf.toString("latin1", 12, 16);
      if (chunk === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (chunk === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (chunk === "VP8L") {
        const bits = buf.readUInt32LE(21);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
      }
      return null;
    }
    if (IMAGE_SIGNATURES[5].test(buf)) {
      // TIFF: the first directory lists ImageWidth (256) and ImageLength (257)
      const le = buf[0] === 0x49;
      const u16 = (at) => (le ? buf.readUInt16LE(at) : buf.readUInt16BE(at));
      const u32 = (at) => (le ? buf.readUInt32LE(at) : buf.readUInt32BE(at));
      const dir = u32(4);
      const count = u16(dir);
      const size = {};
      for (let n = 0; n < Math.min(count, 512); n++) {
        const entry = dir + 2 + n * 12;
        const tag = u16(entry);
        if (tag !== 256 && tag !== 257) continue;
        size[tag] = u16(entry + 2) === 3 ? u16(entry + 8) : u32(entry + 8); // a SHORT or a LONG
      }
      return size[256] && size[257] ? { width: size[256], height: size[257] } : null;
    }
  } catch {
    // a header cut short
  }
  return null;
}

// How many bytes an entry really unpacks to, stopping as soon as `limit` is
// passed. The size an archive DECLARES for an entry is written by whoever
// made the file, so it is not used: a 100 KB file can declare a 1 KB part
// that unpacks to gigabytes. The bytes are counted as they come out and then
// dropped, so nothing large is ever held.
function unpackedSize(entry, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const stream = entry.internalStream("uint8array");
    stream
      .on("data", (chunk) => {
        size += chunk.length;
        if (size > limit) {
          stream.pause();
          resolve(Infinity);
        }
      })
      .on("error", reject)
      .on("end", () => resolve(size))
      .resume();
  });
}

async function checkOfficeFile(buffer, kind) {
  const label = kind === "docx" ? "Word" : "PowerPoint";
  const notOne = `this is not a valid .${kind} file - its contents are not a ${label} document`;
  const damaged = `this ${label} file is damaged and could not be opened`;
  if (!startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])) throw new Error(notOne);
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer); // reads the list of parts; unpacks nothing yet
  } catch {
    throw new Error(damaged);
  }
  const entries = Object.values(zip.files).filter((e) => !e.dir);
  if (entries.length > MAX_ZIP_ENTRIES) throw new Error(`this ${label} file has too many parts to open safely`);
  const main = kind === "docx" ? "word/document.xml" : "ppt/presentation.xml";
  if (!zip.file(main)) throw new Error(notOne);

  const tooLarge = `this ${label} file is too large to open safely once unpacked - split it into smaller files`;
  let total = 0;
  for (const e of entries) {
    // text parts have their own, smaller allowance; everything shares the total
    const allowance = Math.min(/\.(xml|rels)$/i.test(e.name) ? MAX_XML_PART : Infinity, MAX_UNPACKED - total);
    let size;
    try {
      size = await unpackedSize(e, allowance);
    } catch {
      throw new Error(damaged); // a part that does not unpack, or whose checksum is wrong
    }
    if (size > allowance) throw new Error(tooLarge);
    total += size;
  }
}

/**
 * Throws an Error with a message for the student if `file` (multer's:
 * { originalname, buffer }) is not really a file of `kind`, or is unsafe to
 * open. `kind` is what classifyUpload() made of its name: pdf, docx, pptx,
 * image or text.
 */
export async function checkUploadContent(file, kind) {
  const buffer = file.buffer;
  if (!buffer?.length) throw new Error("no readable text found in this file - it is empty");
  if (String(file.originalname || "").length > 255) throw new Error("this file's name is too long");

  if (kind === "pdf") {
    // the standard allows a little junk before the header
    if (!buffer.subarray(0, 1024).includes("%PDF-")) throw new Error("this is not a PDF file - its contents do not match its name");
    return;
  }
  if (kind === "docx" || kind === "pptx") return checkOfficeFile(buffer, kind);
  if (kind === "image") {
    if (!IMAGE_SIGNATURES.some((s) => s.test(buffer))) {
      throw new Error("this is not a picture this app can read - use a PNG, JPEG, WebP, GIF, BMP or TIFF image");
    }
    const size = imageSize(buffer);
    // no readable size: a damaged file, which the decoder must not be left to guess at
    if (!size || !(size.width > 0) || !(size.height > 0)) {
      throw new Error("could not read this image - it may be damaged. Save it again as a PNG or JPEG and upload that");
    }
    if (size.width * size.height > MAX_PIXELS) {
      throw new Error("this picture is too large in pixels to read - resize it below 50 megapixels and upload it again");
    }
    return;
  }
  // text: no zero bytes, unless it says it is UTF-16 (which has them between letters)
  const utf16 = startsWith(buffer, [0xff, 0xfe]) || startsWith(buffer, [0xfe, 0xff]);
  if (!utf16 && buffer.subarray(0, 64 * 1024).includes(0)) throw new Error("this does not look like a text file - its contents do not match its name");
}
