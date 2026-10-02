// Checks for the structure a note keeps for display: `content` (headings,
// paragraphs, bulleted / numbered list entries with their depth, tables and
// bold key terms) and `path` (where a subtopic sits in its document's
// outline). `rawText` - what questions quote - must keep the same words.
//
// The first half needs no server and no files. The second half starts the
// real server (in-memory database, no API keys) on a spare port, like
// graphRoutes.test.mjs and noteUploads.test.mjs, and uploads real files.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import JSZip from "jszip";
import {
  blocksFromPlainText,
  blocksToText,
  inlineMarkdown,
  listLine,
  normalizeContent,
  segmentDocument,
} from "../src/services/documentStructure.js";
import { blocksFromHtml, blocksFromOcrLines, buildPdfBlocks, extractDocument } from "../src/services/documentText.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!cond) failures++;
};
const words = (topic, n = 70) => Array.from({ length: n }, (_, i) => `${topic}${i % 9 === 8 ? "." : ""}`).join(" ") + ".";
const shape = (blocks) =>
  blocks.map((b) => (b.type === "heading" ? `h${b.level}` : b.type === "item" ? `${b.ordered ? "n" : "b"}${b.depth}` : b.type[0])).join(" ");

console.log("\n=== Lists in plain text ===");
check("a dash opens a bullet", listLine("- cheap to install")?.ordered === false);
check("'2)' opens a numbered entry", listLine("2) second step")?.marker === "2)");
check("'1.1 Paging' is not a list entry", listLine("1.1 Paging") === null);
check("'A. Smith' is not a list entry", listLine("A. Smith wrote this") === null);
const lists = blocksFromPlainText(
  "Topologies:\n- Bus: one shared cable\n  - cheap\n  - a break stops everything\n- Star: every node joins a hub\n  that forwards frames\n\nSteps\n\n1. Listen\n2. Send\n3. Wait for the acknowledgement"
);
check("label, bullets with nesting, then numbered steps", shape(lists) === "l b0 b1 b1 b0 l n0 n0 n0", shape(lists));
check("a wrapped line stays with its entry", lists[4].text === "Star: every node joins a hub that forwards frames", lists[4].text);
check("numbered entries keep their own numbers", lists.filter((b) => b.ordered).map((b) => b.marker).join(" ") === "1. 2. 3.");
check("the marker is not part of the text", lists[1].text === "Bus: one shared cable", lists[1].text);

console.log("\n=== Bold terms ===");
const md = inlineMarkdown("A **deadlock** needs *all four* `conditions`.");
check("markdown markers are stripped", md.text === "A deadlock needs all four conditions.", md.text);
check("the bold term is remembered", md.strong.join("|") === "deadlock", md.strong.join("|"));
const boldPara = blocksFromPlainText("**Paging** splits memory into frames.")[0];
check("a paragraph lists its bold terms", boldPara.type === "para" && boldPara.strong?.[0] === "Paging");
check("snake_case is left alone", inlineMarkdown("call read_page_table here").text === "call read_page_table here");

console.log("\n=== Headings in text that has none marked ===");
const numbered = blocksFromPlainText(`1. Framing\n\n${words("frame flag", 30)}\n\n2. Flow Control\n\n${words("window ack", 30)}`);
check("'1. Framing' above prose is a heading, not a list", shape(numbered) === "h3 p h3 p", shape(numbered));
check("  ...and keeps its number", numbered[0].text === "1. Framing", numbered[0].text);
const steps = blocksFromPlainText("To send:\n\n1. Listen\n2. Send\n3. Wait");
check("a real numbered list stays a list", shape(steps) === "l n0 n0 n0", shape(steps));
const titled = blocksFromPlainText(`Types of Networks\n\n${words("lan wan", 30)}\n\nTRANSMISSION MEDIA\n\n${words("fibre copper", 30)}`);
check("title-like lines of their own become headings", shape(titled) === "h8 p h7 p", shape(titled));
const marked = blocksFromPlainText(`# Unit 1\n\nTypes of Networks\n\n${words("lan wan", 30)}`);
check("...but not when the text marks its own headings", shape(marked) === "h1 p p", shape(marked));
const sentence = blocksFromPlainText(`The cat sat on the mat\n\n${words("lan wan", 30)}`);
check("a short plain sentence is not a heading", shape(sentence) === "p p", shape(sentence));

console.log("\n=== Markdown tables and photo bullets ===");
const table = blocksFromPlainText("| State | Next |\n|---|---|\n| Active | Failed |")[0];
check("a markdown table becomes rows of cells", table.type === "table" && table.rows.length === 2 && table.rows[1][1] === "Failed");
const ocr = blocksFromPlainText("e Star topology\n¢ Bus topology\neach node has a tap", { ocr: true });
check("OCR's bullet look-alikes are bullets", shape(ocr) === "b0 b0" && ocr[0].text === "Star topology", shape(ocr));
check("...only for text read from a photo", shape(blocksFromPlainText("e Star topology")) === "p");

console.log("\n=== Word documents (mammoth's HTML) ===");
const html =
  '<h6 class="doctitle">Unit 4</h6><h1>Locks</h1><p>A <strong>lock</strong> controls access.</p>' +
  "<ul><li>Shared<ul><li>read only</li><li>many holders</li></ul></li><li><strong>Exclusive</strong>: read and write</li></ul>" +
  "<ol><li>Request</li><li>Hold</li></ol>" +
  "<table><tr><th><p>Mode</p></th><th><p>Reads</p></th></tr><tr><td><p>S</p></td><td><p>yes</p></td></tr></table>" +
  "<p><strong>Whole line in bold</strong></p><p>Tail &amp; end.</p>";
const docx = blocksFromHtml(html);
check("order and nesting survive", shape(docx) === "t h1 p b0 b1 b1 b0 n0 n0 t p p", shape(docx));
check("nested entries do not leak into their parent", docx[3].text === "Shared", docx[3].text);
check("bold terms are kept per block", docx[2].strong?.[0] === "lock" && docx[6].strong?.[0] === "Exclusive");
check("a table keeps its rows", docx[9].rows?.length === 2 && docx[9].rows[1].join(",") === "S,yes", JSON.stringify(docx[9].rows));
check("a fully bold line is flagged, not a 'term'", docx[10].boldOnly === true && !docx[10].strong);
check("entities are decoded", docx[11].text === "Tail & end.", docx[11].text);

console.log("\n=== Content for display ===");
const content = normalizeContent(
  [
    { type: "title", text: "Unit 4" },
    { type: "heading", level: 3, text: "Locks:" },
    { type: "heading", level: 6, text: "Modes" },
    { type: "item", text: "nested first", depth: 2, ordered: false },
    { type: "item", text: "deeper", depth: 5, ordered: false },
    { type: "item", text: "back out", depth: 2, ordered: false, strong: ["back", "missing"] },
    { type: "para", text: "  tail  " },
  ],
  { title: "Locks" }
);
check("the document title and a heading repeating the note title are dropped", shape(content) === "h1 b0 b1 b0 p", shape(content));
check("heading levels are re-ranked from 1", content[0].level === 1 && content[0].text === "Modes");
check("a list never starts indented or skips a level", content.slice(1, 4).map((b) => b.depth).join("") === "010");
check("bold terms not in the text are dropped", content[3].strong.join("|") === "back");
check("text is trimmed", content[4].text === "tail");

console.log("\n=== Outline: every heading above a subtopic ===");
const deep = [
  { type: "heading", level: 1, text: "DBMS Unit 4" },
  { type: "heading", level: 2, text: "Transactions" },
  { type: "para", text: words("transaction unit work", 40) },
  { type: "heading", level: 3, text: "Concurrency" },
  { type: "heading", level: 4, text: "Locks" },
  { type: "para", text: words("lock shared exclusive", 70) },
  { type: "heading", level: 5, text: "Lock modes" },
  { type: "item", text: "Shared: read only", depth: 0, ordered: false },
  { type: "item", text: "Exclusive: read and write", depth: 0, ordered: false },
  { type: "heading", level: 4, text: "Deadlocks" },
  { type: "para", text: words("deadlock wait cycle", 70) },
  { type: "heading", level: 2, text: "Recovery" },
  { type: "heading", level: 4, text: "Logging" },
  { type: "para", text: words("log redo undo", 70) },
];
const seg = segmentDocument(deep);
const outline = seg.sections.map((s) => [...s.path, s.title].join(" > "));
check("paths run from the outermost heading down", outline.join(" | ") ===
  "Transactions | Transactions > Concurrency > Locks | Transactions > Concurrency > Deadlocks | Recovery > Logging", outline.join(" | "));
check("`group` is still the nearest heading above", seg.sections[1].group === "Concurrency" && seg.sections[3].group === "Recovery");
check("a chapter's own introduction is a subtopic of its own", seg.sections[0].path.length === 0 && seg.sections[0].title === "Transactions");
const locks = seg.sections[1];
check("thin sub-headings stay inside their note", shape(locks.content) === "p h1 b0 b0", shape(locks.content));
check("rawText keeps the same words as content", locks.text === blocksToText(locks.content.map((b) => ({ ...b }))));
check("every subtopic has content", seg.sections.every((s) => s.content.length > 0));

console.log("\n=== A sparse deeper level does not shatter the document ===");
const sparse = [
  { type: "heading", level: 1, text: "A" }, { type: "para", text: words("alpha", 80) },
  { type: "heading", level: 2, text: "A1" }, { type: "item", text: "one two three", depth: 0, ordered: false },
  { type: "heading", level: 2, text: "A2" }, { type: "item", text: "four five six", depth: 0, ordered: false },
  { type: "heading", level: 1, text: "B" }, { type: "para", text: words("beta", 80) },
];
check("splits at the level that has enough text", segmentDocument(sparse).sections.map((s) => s.title).join("|") === "A|B",
  segmentDocument(sparse).sections.map((s) => s.title).join("|"));

console.log("\n=== PDF lines: bullets, nesting, wrapped entries, bold headings ===");
const L = (text, y, x = 50, extra = {}) => ({ text, y, x, size: 10.5, ...extra });
const pdf = buildPdfBlocks([
  [
    L("Network Layer", 760, 50, { size: 16 }),
    L("Routing moves packets hop by hop across the", 730),
    L("network until they reach the destination host.", 716),
    L("Algorithms", 690, 50, { bold: true }),
    L("• Distance vector shares the whole table with", 672, 62),
    L("neighbours only.", 658, 74),
    L("- counts to infinity", 644, 80),
    L("• Link state floods link costs to everyone.", 630, 62),
    L("The choice depends on the size of the network.", 600),
  ],
]);
check("structure is recovered", shape(pdf.blocks) === "h1 p h7 b0 b1 b0 p", shape(pdf.blocks));
check("a hanging line joins its bullet", pdf.blocks[3].text === "Distance vector shares the whole table with neighbours only.", pdf.blocks[3].text);
check("the bullet glyph is not in the text", !/•/.test(pdf.text));
check("a bold line of its own is a heading", pdf.blocks[2].text === "Algorithms");

console.log("\n=== A photographed page (OCR lines) ===");
const photo = blocksFromOcrLines([
  { text: "Checkpoints", x: 82, y: 98, size: 39 },
  { text: "A checkpoint records a point at which all pages", x: 80, y: 168, size: 28.6 },
  { text: "have been written to disk.", x: 82, y: 212, size: 28 },
  { text: "¢ Fuzzy checkpoints let transactions keep", x: 104, y: 286, size: 29 },
  { text: "running.", x: 141, y: 330, size: 28.6 },
  { text: "* The record lists the active transactions.", x: 104, y: 374, size: 29 },
  { text: "Recovery", x: 82, y: 470, size: 38 },
  { text: "The log is replayed from the last checkpoint.", x: 80, y: 540, size: 29 },
]);
check("taller lines are headings; bullets are entries", shape(photo.blocks) === "h1 p b0 b0 h1 p", shape(photo.blocks));
check("both headings are the same level despite measuring differently", photo.blocks[0].level === photo.blocks[4].level);
check("a wrapped bullet is whole again", photo.blocks[2].text === "Fuzzy checkpoints let transactions keep running.", photo.blocks[2].text);

console.log("\n=== PowerPoint: bullet levels and sections ===");
const esc = (t) => t.replace(/&/g, "&amp;");
const para = (t, { lvl = 0, bold = false, none = false } = {}) =>
  `<a:p><a:pPr lvl="${lvl}">${none ? "<a:buNone/>" : ""}</a:pPr><a:r><a:rPr lang="en-US"${bold ? ' b="1"' : ""}/><a:t>${esc(t)}</a:t></a:r></a:p>`;
const slideXml = (titleType, title, body) =>
  `<p:sld><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="${titleType}"/></p:nvPr></p:nvSpPr><p:txBody>${para(title)}</p:txBody></p:sp>` +
  `<p:sp><p:nvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:txBody>${body}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
const deck = [
  ["ctrTitle", "Networks Unit 2", para("Lecture slides"), 1],
  ["title", "Data Link Layer", para("Frames between neighbours."), 3],
  ["title", "Framing", para("Marks where a frame starts and ends.") + para("Byte stuffing", { lvl: 1 }) + para("Bit stuffing", { lvl: 1 }) + para(words("frame flag", 60)), 2],
  ["title", "Error Control", para("Methods", { bold: true }) + para("Parity", { lvl: 1 }) + para("CRC", { lvl: 1 }) + para(words("crc parity", 60)), 2],
  ["title", "Network Layer", para("Packets between networks."), 3],
  ["title", "Routing", para("Chooses a path.") + para(words("route hop", 70)), 2],
];
const zip = new JSZip();
zip.file("ppt/presentation.xml", `<p:presentation><p:sldIdLst>${deck.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("")}</p:sldIdLst></p:presentation>`);
zip.file("ppt/_rels/presentation.xml.rels", `<Relationships>${deck.map((_, i) => `<Relationship Id="rId${i + 1}" Target="slides/slide${i + 1}.xml"/>`).join("")}</Relationships>`);
for (const n of [1, 2, 3]) zip.file(`ppt/slideLayouts/slideLayout${n}.xml`, `<p:sldLayout type="${{ 1: "title", 2: "obj", 3: "secHead" }[n]}"/>`);
deck.forEach(([type, title, body, layout], i) => {
  zip.file(`ppt/slides/slide${i + 1}.xml`, slideXml(type, title, body));
  zip.file(`ppt/slides/_rels/slide${i + 1}.xml.rels`, `<Relationships><Relationship Id="rId1" Target="../slideLayouts/slideLayout${layout}.xml"/></Relationships>`);
});
const pptx = await extractDocument({ originalname: "deck.pptx", buffer: await zip.generateAsync({ type: "nodebuffer" }) }, "pptx");
const pseg = segmentDocument(pptx.blocks);
check("section-header slides give the deck a middle level", pseg.sections.map((s) => [...s.path, s.title].join(" > ")).join(" | ") ===
  "Data Link Layer > Framing | Data Link Layer > Error Control | Network Layer > Routing", pseg.sections.map((s) => [...s.path, s.title].join(" > ")).join(" | "));
check("the cover slide names the document", pseg.docTitle === "Networks Unit 2", pseg.docTitle);
check("the section slide's line opens its first topic; outline levels become nested bullets",
  shape(pseg.sections[0].content) === "p b0 b1 b1 b0", shape(pseg.sections[0].content));
check("a bold line on a slide is a label over its bullets", shape(pseg.sections[1].content) === "l b0 b0 b0", shape(pseg.sections[1].content));
check("a slide's lines stay together in rawText", /ends\.\nByte stuffing\nBit stuffing\n/.test(pseg.sections[0].text), JSON.stringify(pseg.sections[0].text.slice(0, 70)));

// ---------------------------------------------------------------------------
// Through the API
// ---------------------------------------------------------------------------
const PORT = 4597;
const API = `http://localhost:${PORT}/api`;
const server = spawn(process.execPath, ["src/index.js"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, PORT: String(PORT), MONGODB_URI: "", DB_FILE: "memory", GROQ_API_KEY: "", NODE_ENV: "development" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let up = false;
  for (let i = 0; i < 300 && !up && server.exitCode === null; i++) {
    try {
      up = (await fetch(`${API}/health`)).ok;
    } catch {
      await wait(200);
    }
  }
  if (!up) throw new Error(`API did not start on port ${PORT}\n${serverLog}`);

  const json = async (path, { method = "GET", body, token } = {}) => {
    const res = await fetch(API + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
  const { token } = await json("/auth/register", { method: "POST", body: { email: `content${Date.now()}@example.com`, password: "password123" } });
  const { subject } = await json("/subjects", { method: "POST", body: { name: "Networks" }, token });
  const upload = async (name, buffer, fields = {}) => {
    const form = new FormData();
    form.append("file", new Blob([buffer]), name);
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const res = await fetch(`${API}/subjects/${subject._id}/notes`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };

  console.log("\n=== API: a typed note ===");
  let r = await json(`/subjects/${subject._id}/notes`, {
    method: "POST",
    token,
    body: { title: "CSMA/CD", content: "Used by classic **Ethernet**.\n\nSteps:\n1. Listen before sending\n2. Send\n3. On a collision, back off" },
  });
  check("typed note is saved with content", r.status === 201 && shape(r.note.content) === "p l n0 n0 n0", r.note ? shape(r.note.content) : r.error);
  check("  ...its rawText is exactly what was typed", r.note?.rawText.startsWith("Used by classic **Ethernet**."));
  check("  ...bold terms are marked", r.note?.content[0].strong?.[0] === "Ethernet");
  check("  ...and it has an empty path", Array.isArray(r.note?.path) && r.note.path.length === 0);

  console.log("\n=== API: a Word file with a list and a table ===");
  r = await upload("enzymes.docx", readFileSync(new URL("fixtures/notes.docx", import.meta.url)));
  const kinds = new Set((r.note?.content || []).map((b) => b.type));
  check("bullets and the table reach the note", r.status === 201 && kinds.has("item") && kinds.has("table"), [...kinds].join(","));
  check("  ...rawText still has the list and table words", /optimum pH/.test(r.note?.rawText) && /Amylase/.test(r.note?.rawText));

  console.log("\n=== API: a long document is split along its outline ===");
  const longMd =
    `# Unit 2\n\n## Data Link Layer\n\n### Framing\n\n${words("frame flag", 70)}\n\n- byte stuffing\n- bit stuffing\n\n` +
    `### Flow Control\n\n${words("window ack", 70)}\n\n## Network Layer\n\n### Routing\n\n${words("route hop", 70)}\n`;
  r = await upload("unit2.md", Buffer.from(longMd));
  check("three subtopics", r.status === 201 && r.children?.length === 3, `HTTP ${r.status} ${r.children?.length}`);
  check("  ...each with its path", r.children?.map((c) => c.path.join(">")).join("|") === "Data Link Layer|Data Link Layer|Network Layer",
    r.children?.map((c) => c.path.join(">")).join("|"));
  check("  ...and formatted content", shape(r.children?.[0].content || []) === "p b0 b0", shape(r.children?.[0].content || []));
  check("  ...the parent holds the whole document, title heading dropped", shape(r.note?.content || []).startsWith("h1 h2 p b0 b0 h2 p h1 h2 p"), shape(r.note?.content || []));

  r = await upload("unit2.md", Buffer.from(longMd), { split: "false" });
  check("split=false keeps one note, still formatted", r.status === 201 && r.children.length === 0 && shape(r.note.content).includes("h3 p b0 b0"), shape(r.note?.content || []));

  const form = new FormData();
  form.append("file", new Blob([Buffer.from(longMd)]), "unit2.md");
  const pres = await fetch(`${API}/subjects/${subject._id}/notes/preview`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
  const preview = await pres.json();
  check("the upload preview reports each subtopic's path", preview.sections?.[2]?.path?.[0] === "Network Layer", JSON.stringify(preview.sections?.[2]?.path));

  console.log("\n=== API: listing notes ===");
  r = await json(`/subjects/${subject._id}/notes`, { token });
  check("every note comes back with content and a path", r.notes?.length > 0 && r.notes.every((n) => Array.isArray(n.content) && n.content.length && Array.isArray(n.path)));

  console.log("\n=== API: old Office formats ===");
  r = await upload("slides.ppt", Buffer.from("not really a ppt"));
  check(".ppt is refused with how to fix it", r.status === 400 && /Save As/.test(r.error) && /\.pptx/.test(r.error), r.error);
  r = await upload("notes.doc", Buffer.from("not really a doc"));
  check(".doc is refused with how to fix it", r.status === 400 && /\.docx/.test(r.error), r.error);
} catch (err) {
  console.log(`  FAIL  ${err.message}`);
  failures++;
} finally {
  server.kill();
}

console.log(failures ? `\n${failures} FAILING CHECK(S)` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
