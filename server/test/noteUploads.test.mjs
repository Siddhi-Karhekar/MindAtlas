// API test for note uploads, POST /api/subjects/:id/notes with a file: one
// real file of each supported type, plus the ways an upload can go wrong
// (locked / damaged / text-less files, a photo with no text, a file over the
// size limit). Each bad file must come back as a 400/413 with a message the
// student can act on - never a crash, a generic 500, or a junk note.
//
// Starts the real server (in-memory database, no API keys) on a spare port,
// like graphRoutes.test.mjs. The image checks need Tesseract's English model,
// which is downloaded once and cached as server/eng.traineddata; with no
// network they are skipped, but a damaged image must still not crash the
// server.
//
// fixtures/: notes.pdf (a text PDF), notes-password.pdf (the same PDF locked
// with the password "secret"), notes.docx (headings, a bulleted list and a
// table) and notes-photo.jpg (a tilted, noisy phone photo of a notes page).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const PORT = 4599;
const API = `http://localhost:${PORT}/api`;
const server = spawn(process.execPath, ["src/index.js"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), MONGODB_URI: "", GROQ_API_KEY: "", NODE_ENV: "development" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
let serverExited = false;
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
server.on("exit", () => (serverExited = true));

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!cond) failures++;
};
const skip = (label) => console.log(`  SKIP  ${label}  -> text recognition unavailable (offline?)`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fixture = (name) => readFileSync(new URL(`fixtures/${name}`, import.meta.url));

async function call(path, { method = "GET", body, token } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

// A 24-bit BMP from a pixel(x, y) -> grey level function. BMP needs no
// compression, so test images can be made here with no image library.
function bmp(width, height, pixel) {
  const row = Math.ceil((width * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + row * height);
  buf.write("BM");
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(row * height, 34);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = 54 + (height - 1 - y) * row + x * 3;
      buf.fill(pixel(x, y), at, at + 3);
    }
  }
  return buf;
}

// A valid one-page PDF with nothing on the page - what a scanned PDF looks
// like to text extraction.
function blankPdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

let seed = 7;
const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const newtonText =
  "Newton's laws of motion\n\nFirst law: an object stays at rest or keeps moving at constant velocity unless a " +
  "resultant force acts on it.\n\nSecond law: force equals mass times acceleration. A bigger resultant force " +
  "gives a bigger acceleration.\n";

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { up = (await fetch(`${API}/health`)).ok; } catch { await wait(200); }
  }
  if (!up) throw new Error(`server did not start:\n${serverLog}`);

  const token = (await call("/auth/register", { method: "POST", body: { email: "uploader@example.com", password: "password123" } })).data.token;
  const subjectId = (await call("/subjects", { method: "POST", token, body: { name: "Science" } })).data.subject._id;
  let expectedNotes = 0;

  async function upload(name, bytes) {
    const form = new FormData();
    form.append("file", new Blob([bytes]), name);
    const res = await fetch(`${API}/subjects/${subjectId}/notes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 201) expectedNotes++;
    return { status: res.status, data, note: data.note, error: data.error || "" };
  }

  console.log("\n=== One real file of each type ===");
  let r = await upload("mitochondria.pdf", fixture("notes.pdf"));
  check("text PDF -> note", r.status === 201 && r.note.sourceType === "file" && r.note.title === "mitochondria", `HTTP ${r.status} ${r.error}`);
  check("  ...with the PDF's text and keywords",
    /Krebs cycle runs in the mitochondrial matrix/.test(r.note?.rawText) && r.note.keywords.includes("atp"),
    r.note?.keywords.slice(0, 5).join(", "));

  r = await upload("enzymes.docx", fixture("notes.docx"));
  check("Word file -> note", r.status === 201 && r.note.sourceType === "file", `HTTP ${r.status} ${r.error}`);
  check("  ...including its bullet list and table", /optimum pH/.test(r.note?.rawText) && /Amylase/.test(r.note?.rawText));

  r = await upload("newton.txt", Buffer.from(newtonText));
  check("UTF-8 .txt -> note", r.status === 201 && r.note.rawText.startsWith("Newton's laws"), `HTTP ${r.status} ${r.error}`);

  r = await upload("newton.md", Buffer.from("# Newton\n\n## Second law\n\n**F = ma**: force, mass and acceleration.\n"));
  check("markdown -> note", r.status === 201 && /force, mass and acceleration/.test(r.note?.rawText), `HTTP ${r.status} ${r.error}`);

  r = await upload("photosynthesis.jpg", fixture("notes-photo.jpg"));
  const ocrAvailable = !/unavailable/.test(r.error);
  if (ocrAvailable) {
    check("phone photo -> note via OCR", r.status === 201 && r.note.sourceType === "image", `HTTP ${r.status} ${r.error}`);
    check("  ...with the photo's words", /chloroplasts/.test(r.note?.rawText) && /Calvin cycle/.test(r.note?.rawText),
      JSON.stringify(r.note?.rawText.slice(0, 60)));
  } else {
    skip("phone photo -> note via OCR");
  }

  console.log("\n=== Documents that can't be read ===");
  r = await upload("locked.pdf", fixture("notes-password.pdf"));
  check("password-protected PDF -> 400 saying so", r.status === 400 && /password-protected/.test(r.error), r.error);
  r = await upload("cut-off.pdf", fixture("notes.pdf").subarray(0, 700));
  check("damaged PDF -> 400 saying so", r.status === 400 && /damaged/.test(r.error), r.error);
  r = await upload("scan.pdf", blankPdf());
  check("PDF with no text layer -> 400 suggesting photos", r.status === 400 && /scanned PDF/.test(r.error), r.error);
  r = await upload("broken.docx", Buffer.from("this is not a zip file at all"));
  check("damaged Word file -> 400 saying so", r.status === 400 && /valid \.docx/.test(r.error), r.error);
  r = await upload("empty.txt", Buffer.alloc(0));
  check("empty text file -> 400 saying it is empty", r.status === 400 && /it is empty/.test(r.error), r.error);
  r = await upload("unsupported.exe", Buffer.from("MZ"));
  check("unsupported type -> 400 listing what is supported", r.status === 400 && /unsupported file type/.test(r.error), r.error);

  console.log("\n=== Text encodings ===");
  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(newtonText, "utf16le")]);
  r = await upload("notepad-unicode.txt", utf16le);
  check("UTF-16 text (Notepad \"Unicode\") is decoded", r.status === 201 && r.note.rawText.startsWith("Newton's laws") && !r.note.rawText.includes("\0"),
    `HTTP ${r.status} ${r.error}`);
  check("  ...and gets real keywords", r.note?.keywords.includes("force"), r.note?.keywords.slice(0, 5).join(", "));
  const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(newtonText, "utf16le").swap16()]);
  r = await upload("big-endian.txt", utf16be);
  check("UTF-16 big-endian text is decoded", r.status === 201 && r.note.rawText.startsWith("Newton's laws"), `HTTP ${r.status} ${r.error}`);
  r = await upload("bom.txt", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(newtonText)]));
  check("UTF-8 with a BOM -> no stray BOM in the note", r.status === 201 && r.note.rawText.startsWith("Newton's laws"), `HTTP ${r.status} ${r.error}`);
  r = await upload("renamed.txt", Buffer.from(Array.from({ length: 3000 }, () => Math.floor(random() * 256))));
  check("binary data named .txt -> 400, not a junk note", r.status === 400 && /does not look like a text file/.test(r.error), r.error);

  console.log("\n=== Size limit ===");
  r = await upload("huge.txt", Buffer.alloc(10 * 1024 * 1024 + 1, "a"));
  check("file over 10 MB -> 413 naming the limit (not a 500)", r.status === 413 && /10 MB/.test(r.error), `HTTP ${r.status} ${r.error}`);

  console.log("\n=== Images with no readable text ===");
  r = await upload("broken.png", Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(2000, 0xab)]));
  check("damaged image -> 400 saying it could not be read", r.status === 400 && /could not read this image/.test(r.error), `HTTP ${r.status} ${r.error}`);
  await wait(300);
  check("  ...and the server is still running", !serverExited && (await fetch(`${API}/health`).then((x) => x.ok, () => false)));
  if (ocrAvailable) {
    r = await upload("blank-page.bmp", bmp(800, 600, () => 244));
    check("photo of a blank page -> 400 'no readable text'", r.status === 400 && /no readable text found in this image/.test(r.error), r.error);
    // Noise that Tesseract reads as ~190 "words", none of them confidently.
    const noise = bmp(1000, 700, (x, y) =>
      (x * y) % 7 < 3 ? [20, 60, 200, 240][Math.floor(random() * 4)] : Math.floor(random() * 256));
    r = await upload("carpet.bmp", noise);
    check("photo with no text but OCR junk -> 400, not a junk note",
      r.status === 400 && /no readable text found in this image/.test(r.error),
      r.note ? JSON.stringify(r.note.rawText.slice(0, 50)) : r.error);
  } else {
    skip("photo of a blank page -> 400 'no readable text'");
    skip("photo with no text but OCR junk -> 400, not a junk note");
  }

  console.log("\n=== Nothing slipped through ===");
  const notes = (await call(`/subjects/${subjectId}/notes`, { token })).data.notes;
  check("only the readable files became notes", notes.length === expectedNotes, `${notes.length} notes, expected ${expectedNotes}`);
} catch (err) {
  console.error("FAILED:", err.message);
  failures++;
} finally {
  if (failures && serverLog) console.log(`\n--- server log ---\n${serverLog}`);
  server.kill();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
