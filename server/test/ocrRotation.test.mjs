// A photo's rotation tag (services/ocr.js). tesseract.js only finds a tag written
// big-endian, in the first 500 bytes of the file, so a photo tagged any other way
// was read on its side. The first part needs no language model. The last part reads
// a real photo, so it needs Tesseract's English model, which is downloaded once and
// cached as server/eng.traineddata; with no network it is skipped.
import { readFileSync } from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { extractTextFromImage, orientationOcrSees, readRotationTag, withRotationOcrCanSee } from "../src/services/ocr.js";
import { checkUploadContent, imageSize } from "../src/services/uploadCheck.js";
import { pooled, scoreReading, withRotationTag } from "../evaluation/lib/ocr.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!cond) failures++;
};

const jpegOf = (paint, width, height, quality = 90) => {
  const canvas = createCanvas(width, height);
  paint(canvas.getContext("2d"));
  return canvas.toBuffer("image/jpeg", quality);
};
const small = jpegOf((ctx) => {
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 40, 20);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, 20, 20);
}, 40, 20);
const pixelsOf = async (file) => {
  const image = await loadImage(file);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  return { width: image.width, height: image.height, data: Buffer.from(ctx.getImageData(0, 0, image.width, image.height).data) };
};

console.log("\n=== Which photos are changed ===");
for (const orientation of [3, 6, 8]) {
  const missed = withRotationTag(small, orientation, "II");
  check(`the library misses a little-endian tag ${orientation}`, orientationOcrSees(missed) === 1);
  const fixed = withRotationOcrCanSee(missed);
  check(`  ...and now finds it`, orientationOcrSees(fixed) === orientation);
  check("  ...the tag itself is still there", readRotationTag(fixed)?.orientation === orientation && readRotationTag(fixed)?.byte_order === "II", JSON.stringify(readRotationTag(fixed)));
  const before = await pixelsOf(missed);
  const after = await pixelsOf(fixed);
  check("  ...and the picture is untouched", before.width === after.width && before.height === after.height && before.data.equals(after.data));
  check("  ...its size still reads the same", imageSize(fixed).width === 40 && imageSize(fixed).height === 20);
  await checkUploadContent({ originalname: "x.jpg", buffer: fixed }, "image"); // throws if refused
  check("  ...and it still passes the upload check", true);
}
for (const orientation of [2, 4, 5, 7]) {
  check(`a little-endian mirror tag ${orientation} is passed on too`, orientationOcrSees(withRotationOcrCanSee(withRotationTag(small, orientation, "II"))) === orientation);
}

const bigEndian = withRotationTag(small, 6, "MM");
check("a big-endian tag the library sees is left alone", withRotationOcrCanSee(bigEndian) === bigEndian);
const app2 = Buffer.alloc(604);
app2.set([0xff, 0xe2, 0x02, 0x5a]); // a 602-byte segment, pushing the tag past byte 500
const farAway = Buffer.concat([bigEndian.subarray(0, 2), app2, bigEndian.subarray(2)]);
check("a big-endian tag past byte 500 is missed by the library", readRotationTag(farAway)?.orientation === 6 && orientationOcrSees(farAway) === 1);
check("  ...and now found", orientationOcrSees(withRotationOcrCanSee(farAway)) === 6);

for (const [label, file] of [
  ["a photo with no tag", small],
  ["a tag saying no turning is needed", withRotationTag(small, 1, "II")],
  ["a tag with an impossible value", withRotationTag(small, 9, "II")],
  ["a picture that is not a JPEG", Buffer.from("\x89PNG\r\n\x1a\n not really", "latin1")],
  ["a JPEG cut short", small.subarray(0, 6)],
  ["a tag cut short", withRotationTag(small, 6, "II").subarray(0, 26)],
  ["an empty file", Buffer.alloc(0)],
]) {
  check(`${label} is left alone`, withRotationOcrCanSee(file) === file);
}

console.log("\n=== Reading a real photo ===");
const photo = await loadImage(readFileSync(new URL("fixtures/notes-photo.jpg", import.meta.url)));
const upright = jpegOf((ctx) => ctx.drawImage(photo, 0, 0), photo.width, photo.height);
// the same pixels as a phone stores them: on its side, with a tag saying to turn it clockwise
const onItsSide = jpegOf((ctx) => {
  ctx.translate(0, photo.width);
  ctx.rotate(-Math.PI / 2);
  ctx.drawImage(photo, 0, 0);
}, photo.height, photo.width);
const asRead = await extractTextFromImage(upright);
if (asRead.ocrFailed) {
  console.log("  SKIP  reading a real photo  -> text recognition unavailable (offline?)");
} else {
  const bigRead = await extractTextFromImage(withRotationTag(onItsSide, 6, "MM"));
  const littleRead = await extractTextFromImage(withRotationTag(onItsSide, 6, "II"));
  const untagged = await extractTextFromImage(onItsSide);
  const error = (reading) => pooled([{ score: scoreReading(asRead.text, reading.text) }]).cer;
  check("the upright photo reads", asRead.text.length > 100, `${asRead.text.length} characters`);
  check("a little-endian tag now reads exactly as a big-endian one", littleRead.text === bigRead.text);
  check("  ...and close to the upright photo", error(littleRead) < 0.1, `${(error(littleRead) * 100).toFixed(1)}% character difference`);
  check("with no tag at all it is still read on its side (nothing else is turning it)", error(untagged) > 0.5, `${(error(untagged) * 100).toFixed(1)}% character difference`);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
