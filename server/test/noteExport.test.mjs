// Checks for downloading notes as a PDF or a Word file
// (src/services/noteExport/).
//
// The files are opened again here and read back: the Word file with the app's
// own Word reader, the PDF with its own PDF reader. So "the heading is there",
// "the contents list links to it" and "the page number printed beside it is
// the page it is on" are checked against the real file, not assumed.
//
// The last part starts the real server (in-memory database, no API keys) on a
// spare port, like noteContent.test.mjs.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import JSZip from "jszip";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import * as fmt from "../src/services/noteExport/format.js";
import { cleanText, dateLabel, documentModel, noteModel, safeFileName, subjectModel } from "../src/services/noteExport/model.js";
import { renderDocx } from "../src/services/noteExport/docx.js";
import { renderPdf } from "../src/services/noteExport/pdf.js";
import { parseFormat } from "../src/services/noteExport/index.js";
import { notesFromFile } from "../evaluation/lib/ingest.js";
import { extractDocument } from "../src/services/documentText.js";
import { blocksFromPlainText, normalizeContent } from "../src/services/documentStructure.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!cond) failures++;
};
const SAMPLE = fileURLToPath(new URL("../evaluation/samples/dbms_unit4.md", import.meta.url));

// ---- the notes used throughout: one split document and one typed note
const dbms = await notesFromFile(SAMPLE);
const parent = { _id: "doc1", title: dbms.title, childCount: dbms.notes.length, createdAt: "2026-09-01" };
const children = dbms.notes.map((n) => ({ ...n, parentNoteId: "doc1", createdAt: "2026-09-01" }));
const typedText =
  "# Framing\n\nA **frame** is the unit the data link layer sends.\n\nMethods:\n- Byte stuffing\n  - adds an escape byte\n- Bit stuffing\n\n" +
  "# Flow Control\n\nStop-and-wait: the sender waits for each acknowledgement (≤ 1 frame; α → β).\n\n1. Send\n2. Wait\n";
const typed = {
  _id: "typed1", title: "Data Link Layer", rawText: typedText, keywords: ["frame", "sender"], sourceType: "typed", createdAt: "2026-09-02",
  content: normalizeContent(blocksFromPlainText(typedText), { title: "Data Link Layer" }),
};
const subject = { _id: "s1", name: "Semester 7" };

console.log("\n=== Same formatting rules as the screen ===");
const clientLib = new URL("../../client/src/lib/", import.meta.url);
if (fs.existsSync(new URL("noteFormat.js", clientLib))) {
  const clientFormat = await import(new URL("noteFormat.js", clientLib).href);
  const clientNotes = await import(new URL("notes.js", clientLib).href);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const all = [...children, typed];
  check(
    "the same words are marked as key terms",
    all.every((n) => same(fmt.layoutContent(n.content, n.keywords.slice(0, 8)), clientFormat.layoutContent(n.content, n.keywords.slice(0, 8))))
  );
  check(
    "sections get the same colours",
    all.every((n) => {
      const blocks = fmt.layoutContent(n.content, n.keywords);
      return same(fmt.colorSections(blocks, { baseIndex: 2, bySection: true }), clientFormat.colorSections(blocks, { baseIndex: 2, bySection: true }));
    })
  );
  check("a note keeps the colour it has on screen", ["a", "typed1", "6ac20118e2b7618a44790673"].every((id) => fmt.stableColorIndex(id) === clientFormat.stableColorIndex(id)));
  const strip = (nodes) => nodes.map((n) => ({ title: n.title, depth: n.depth, colorIndex: n.colorIndex, note: n.item?._id ?? null, children: strip(n.children) }));
  check("a document's outline is built the same way", same(strip(fmt.outlineTree(children)), strip(clientNotes.outlineTree(children))));
  // the topic colours are the light theme's, since paper is white
  const css = fs.readFileSync(new URL("../../client/src/index.css", import.meta.url), "utf8");
  const light = css.slice(0, css.indexOf("html.dark"));
  const fromCss = [1, 2, 3, 4, 5, 6].map((i) => light.match(new RegExp(`--c-topic-${i}:\\s*(#[0-9a-f]{6})`, "i"))?.[1].toLowerCase());
  check("the six topic colours match the light theme", same(fromCss, fmt.TOPIC_HEX), fromCss.join(" "));
  check("...and so do the text colours", [["on-surface", fmt.INK], ["on-surface-variant", fmt.MUTED], ["primary", fmt.PRIMARY]].every(([name, hex]) => light.match(new RegExp(`--c-${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1].toLowerCase() === hex));
} else {
  console.log("  SKIP  client source is not beside the server here");
}

console.log("\n=== What goes into a download ===");
const date = dateLabel(new Date("2026-10-04T20:00:00Z"), "Asia/Kolkata");
check("the date is the student's, not the server's", date === "5 Oct 2026" && dateLabel(new Date("2026-10-04T20:00:00Z")) === "4 Oct 2026", date);
check("an unknown time zone falls back instead of failing", dateLabel(new Date("2026-10-04T20:00:00Z"), "Not/AZone") === "4 Oct 2026");
check("file names lose what Windows refuses", safeFileName('Unit 4: A/B <test>?.. ') === "Unit 4 A B test" && safeFileName("???") === "notes" && safeFileName("x".repeat(200)).length === 80);
check("control characters and line breaks are cleaned", cleanText("a\u0000b\u000c\nc\td") === "ab c d");
check("only pdf and docx are formats", parseFormat("PDF") === "pdf" && parseFormat("word") === "docx" && parseFormat(undefined) === "pdf" && parseFormat("exe") === null);

const docModel = documentModel({ parent, children, subject, date });
const heads = docModel.elements.filter((e) => e.kind === "heading");
check("a document lists every topic in its index, nested as in the original",
  docModel.index.map((e) => `${e.level}:${e.text}`).join("|") ===
    "0:Transactions|1:ACID Properties|1:Transaction States|0:Concurrency Control|1:Lock-Based Protocols|1:Deadlock Handling|0:Recovery|1:Log-Based Recovery|1:Checkpoints",
  docModel.index.map((e) => `${e.level}:${e.text}`).join("|"));
check("each main topic has its own colour, shared by what is under it",
  docModel.index.map((e) => fmt.TOPIC_HEX.indexOf(e.color)).join("") === "000111222", docModel.index.map((e) => fmt.TOPIC_HEX.indexOf(e.color)).join(""));
check("main topics are the largest headings, subtopics smaller, headings inside a topic smaller still",
  heads.find((h) => h.text === "Concurrency Control").size === 1 && heads.find((h) => h.text === "Lock-Based Protocols").size === 2 && heads.find((h) => h.text === "Lock modes").size === 3,
  JSON.stringify(heads.filter((h) => /Concurrency|Lock/.test(h.text)).map((h) => [h.text, h.size])));
check("every index entry points at a heading", docModel.index.every((e) => heads.some((h) => h.id === e.id && h.text === e.text)));
check("headings inside a topic are not in the index", !docModel.index.some((e) => e.text === "Lock modes"));
check("body text is plain; only marked terms carry the colour", docModel.elements.filter((e) => e.kind === "para").every((p) => p.segments.every((s) => typeof s.mark === "boolean")) && docModel.elements.some((e) => e.kind === "para" && e.segments.some((s) => s.mark)));
check("lists keep their nesting and tables their rows", docModel.elements.some((e) => e.kind === "list" && e.items.some((i) => i.children.length)) && docModel.elements.find((e) => e.kind === "table").rows.length === 4);
check("the summary line counts topics and words", /^8 topics {2}· {2}\d+ words {2}· {2}5 Oct 2026$/.test(docModel.meta) && docModel.kicker === "Semester 7", docModel.meta);

const subModel = noteModel({ note: children[4], parent, siblings: children, subject, date });
check("a subtopic downloads alone, in its main topic's colour", subModel.title === "Lock-Based Protocols" && subModel.titleColor === fmt.TOPIC_HEX[1] && subModel.elements.every((e) => !e.color || e.color === fmt.TOPIC_HEX[1]), subModel.titleColor);
check("  ...and says where it comes from", subModel.kicker === `Semester 7  ›  ${dbms.title}  ›  Concurrency Control`, subModel.kicker);
check("  ...its own headings are its index", subModel.index.map((e) => e.text).join("|") === "Lock modes|Two-phase locking", subModel.index.map((e) => e.text).join("|"));

const typedModel = noteModel({ note: typed, subject, date });
const typedHeads = typedModel.elements.filter((e) => e.kind === "heading");
check("a typed note with two topics is coloured topic by topic", typedHeads.length === 2 && typedHeads[0].color !== typedHeads[1].color && typedModel.titleColor === fmt.INK, typedHeads.map((h) => h.color).join(" "));
check("  ...and a note with one heading gets no index", noteModel({ note: { ...typed, content: typed.content.slice(0, 3) }, subject }).index.length === 0);

const all = [parent, ...children, typed];
const subjModel = subjectModel({ subject, notes: all, date });
check("a subject lists its notes, then each document's topics", subjModel.index.slice(0, 3).map((e) => `${e.level}:${e.text}`).join("|") === `0:${dbms.title}|1:Transactions|2:ACID Properties` && subjModel.index.at(-1).text === "Data Link Layer",
  subjModel.index.slice(0, 3).map((e) => `${e.level}:${e.text}`).join("|"));
check("  ...each note after the first starts a new page", subjModel.elements.filter((e) => e.pageBreak).map((e) => e.text).join("|") === "Data Link Layer");
check("  ...a document's main topics keep their colours one level down", subjModel.index.filter((e) => e.level === 1 && e.strong).map((e) => fmt.TOPIC_HEX.indexOf(e.color)).join("") === "012");
check("  ...and the summary counts notes", /^2 notes/.test(subjModel.meta), subjModel.meta);

// ---------------------------------------------------------------------------
console.log("\n=== Word file ===");
const docx = await renderDocx(docModel);
const zip = await JSZip.loadAsync(docx);
const xml = await zip.file("word/document.xml").async("string");
check("it is a Word file with its parts", docx.subarray(0, 2).toString() === "PK" && ["word/styles.xml", "word/numbering.xml", "word/footer1.xml", "docProps/core.xml"].every((f) => zip.file(f)));
const bookmarks = [...xml.matchAll(/<w:bookmarkStart[^>]*w:name="([^"]+)"/g)].map((m) => m[1]);
const anchors = [...xml.matchAll(/<w:hyperlink[^>]*w:anchor="([^"]+)"/g)].map((m) => m[1]);
check("the contents list links to a bookmark on every topic", anchors.length === docModel.index.length && anchors.every((a) => bookmarks.includes(a)), `${anchors.length} links, ${bookmarks.length} bookmarks`);
check("topics use Word's own heading styles", ["Heading1", "Heading2", "Heading3"].every((s) => xml.includes(`<w:pStyle w:val="${s}"/>`)) && xml.includes('<w:pStyle w:val="Title"/>'));
check("the three topic colours are in the text", fmt.TOPIC_HEX.slice(0, 3).every((c) => xml.includes(`w:val="${c.slice(1).toUpperCase()}"`)));
check("bullets are real lists, one per colour", (await zip.file("word/numbering.xml").async("string")).match(/<w:abstractNum /g).length >= 3 && /<w:numPr>/.test(xml));
check("the page number is in the footer", /PAGE/.test(await zip.file("word/footer1.xml").async("string")) && /NUMPAGES/.test(await zip.file("word/footer1.xml").async("string")));
check("the text starts on a new page after the contents", /<w:pageBreakBefore\/>/.test(xml));
// eslint-disable-next-line no-control-regex
check("nothing in it that makes Word refuse the file", !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml) && !xml.includes("updateFields"));
const countBullets = (items) => items.reduce((n, it) => n + (it.ordered ? 0 : 1) + countBullets(it.children || []), 0);
const bulletCount = docModel.elements.filter((e) => e.kind === "list").reduce((n, l) => n + countBullets(l.items), 0);
const reread = await extractDocument({ originalname: "x.docx", buffer: docx }, "docx");
const rereadHeads = reread.blocks.filter((b) => b.type === "heading").map((b) => b.text);
check("read back by the app: every topic is still a heading", docModel.index.every((e) => rereadHeads.includes(e.text)), rereadHeads.join("|"));
check("  ...list entries are still list entries, nested ones still nested", reread.blocks.filter((b) => b.type === "item").length === bulletCount && reread.blocks.some((b) => b.type === "item" && b.depth === 1), `${reread.blocks.filter((b) => b.type === "item").length} of ${bulletCount}`);
check("  ...numbered entries keep the numbers the author gave them", reread.blocks.some((b) => /^1\. Active: the initial state/.test(b.text)) && reread.blocks.some((b) => /^5\. Committed/.test(b.text)));
check("  ...and the table is still a table", reread.blocks.some((b) => b.type === "table" && b.rows.length === 4 && b.rows[0][0] === "State"));
check("  ...with every word of the notes in it", children.every((c) => c.rawText.split(/\n+/).filter((l) => l.split(" ").length > 6).every((l) => reread.text.replace(/\s+/g, " ").includes(l.replace(/^(\d+[.)]|[-*])\s+/, "").replace(/\s+/g, " ").trim().slice(0, 60)))));

const messy = noteModel({ note: { ...typed, title: "Odd \u0001 chars", rawText: "x", content: [{ type: "para", text: "form\u000cfeed and 😀 emoji, हिन्दी, a\u0000b" }] }, subject });
const messyXml = await (await JSZip.loadAsync(await renderDocx(messy))).file("word/document.xml").async("string");
// eslint-disable-next-line no-control-regex
check("characters from a scan that Word cannot hold are dropped, the rest kept", !/[\u0000-\u0008\u000b\u000c]/.test(messyXml) && messyXml.includes("formfeed") && messyXml.includes("😀") && messyXml.includes("ab"));

// ---------------------------------------------------------------------------
console.log("\n=== PDF ===");
const openPdf = async (buffer) => {
  const pdf = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false, verbosity: 0 }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    // text pieces gathered into rows by their height on the page
    const rows = new Map();
    for (const item of content.items) {
      if (!item.str) continue;
      const key = Math.round(item.transform[5]);
      rows.set(key, [...(rows.get(key) || []), item]);
    }
    pages.push([...rows.entries()].sort((a, b) => b[0] - a[0]).map(([, items]) => items.sort((a, b) => a.transform[4] - b.transform[4]).map((i) => i.str).join(" ").replace(/\s+/g, " ").trim()));
  }
  return { pdf, pages };
};
const pdfBuffer = await renderPdf(docModel);
const { pdf, pages } = await openPdf(pdfBuffer);
check("it is a PDF of several A4 pages", pdfBuffer.subarray(0, 5).toString() === "%PDF-" && pdf.numPages >= 3, `${pdf.numPages} pages`);
const size = (await pdf.getPage(1)).view;
check("  ...A4", Math.round(size[2]) === 595 && Math.round(size[3]) === 842, size.join(","));
check("every page says which page it is", pages.every((rows, i) => rows.some((r) => r.endsWith(`Page ${i + 1} of ${pdf.numPages}`))));
const contents = pages[0];
check("the first page has the title and the contents list", contents.some((r) => r.includes("Contents")) && contents.join(" ").includes("Database Management Systems"));
const dests = await pdf.getDestinations();
let pagesRight = true;
let detail = "";
for (const entry of docModel.index) {
  const dest = dests[entry.id];
  const actual = dest ? (await pdf.getPageIndex(dest[0])) + 1 : null; // where the heading really is
  const row = contents.find((r) => r.startsWith(entry.text));
  const printed = Number(row?.match(/(\d+)$/)?.[1]); // what the contents list says
  const onPage = actual ? pages[actual - 1].some((r) => r === entry.text) : false;
  if (!(actual && printed === actual && onPage)) {
    pagesRight = false;
    detail += `${entry.text}: printed ${printed}, link ${actual}, heading on that page ${onPage}; `;
  }
}
check("each contents line prints the page its topic is on, and links to it", pagesRight, detail);
const links = (await (await pdf.getPage(1)).getAnnotations()).filter((a) => a.subtype === "Link");
check("  ...every line is clickable", links.length === docModel.index.length && links.every((l) => typeof l.dest === "string" && dests[l.dest]), `${links.length} links`);
const bookmarksPdf = await pdf.getOutline();
check("the reader's sidebar has the topics as bookmarks", bookmarksPdf.map((o) => o.title).join("|") === "Transactions|Concurrency Control|Recovery" && bookmarksPdf[1].items.map((o) => o.title).join("|") === "Lock-Based Protocols|Deadlock Handling");
check("the text is real text, with every topic's words", children.every((c) => pages.flat().join(" ").includes(c.rawText.split(/\s+/).slice(0, 5).join(" "))));
const meta = await pdf.getMetadata();
check("the file carries its title", meta.info.Title === dbms.title && meta.info.Author === "Mind Atlas");
await pdf.destroy();

// a long note: page breaks inside paragraphs, lists and a table
const para = (i) => ({ type: "para", text: `Paragraph ${i} explains paging in detail. ` + "Each page table entry maps a virtual page to a physical frame and records whether the page is present. ".repeat(4) });
const long = {
  _id: "long1", title: "Virtual Memory", rawText: "x", keywords: ["paging", "frame"], sourceType: "file",
  content: [
    { type: "heading", level: 1, text: "Paging" },
    ...Array.from({ length: 14 }, (_, i) => para(i + 1)),
    { type: "heading", level: 1, text: "Page Replacement" },
    { type: "table", rows: [["Algorithm", "Idea"], ...Array.from({ length: 60 }, (_, i) => [`Policy ${i + 1}`, "Evicts the page that " + "has not been used for the longest time ".repeat(1 + (i % 3))])] },
    { type: "heading", level: 2, text: "Thrashing" },
    ...Array.from({ length: 40 }, (_, i) => ({ type: "item", text: `Cause ${i + 1}: too many processes compete for too few frames.`, depth: i % 3 === 2 ? 1 : 0, ordered: false })),
    { type: "para", text: "A_very_long_identifier_" + "that_never_breaks_".repeat(12) + "end." },
  ],
};
const longModel = noteModel({ note: long, subject, date });
const longPdf = await openPdf(await renderPdf(longModel));
check("a long note runs over several pages", longPdf.pdf.numPages >= 4, `${longPdf.pdf.numPages} pages`);
check("  ...a table that crosses a page repeats its head there", longPdf.pages.filter((rows) => rows.some((r) => r.startsWith("Algorithm") && r.includes("Idea"))).length >= 2);
check("  ...no row is lost", Array.from({ length: 60 }, (_, i) => `Policy ${i + 1}`).every((p) => longPdf.pages.flat().some((r) => r.startsWith(`${p} `) || r === p)));
const missing = [...Array.from({ length: 40 }, (_, i) => `Cause ${i + 1}:`), ...Array.from({ length: 14 }, (_, i) => `Paragraph ${i + 1} explains`)].filter((t) => !longPdf.pages.flat().some((r) => r.replace(/ :/g, ":").startsWith(t))); // a bold term and its colon are two pieces of text
check("  ...nor any list entry or paragraph", missing.length === 0, missing.join(" | "));
const lastRows = longPdf.pages.map((rows) => rows.filter((r) => !/Page \d+ of \d+$/.test(r)).at(-1));
check("  ...no heading is left alone at the foot of a page", !lastRows.some((r) => ["Paging", "Page Replacement", "Thrashing"].includes(r)), lastRows.join(" | "));
check("  ...a word wider than the page is cut, not run off it", longPdf.pages.flat().some((r) => r.startsWith("A_very_long_identifier_")) && longPdf.pages.flat().some((r) => r.endsWith("end.")));
const longDests = await longPdf.pdf.getDestinations();
const replacementPage = (await longPdf.pdf.getPageIndex(longDests[longModel.index[1].id][0])) + 1;
check("  ...and the index still has the right page for a later topic", longPdf.pages[0].find((r) => r.startsWith("Page Replacement"))?.endsWith(` ${replacementPage}`) && replacementPage > 1, `page ${replacementPage}`);
await longPdf.pdf.destroy();

const odd = await openPdf(await renderPdf(messy));
check("characters the font lacks do not stop the PDF", odd.pdf.numPages === 1 && odd.pages.flat().some((r) => r.includes("emoji")));
await odd.pdf.destroy();
const maths = await openPdf(await renderPdf(typedModel));
check("Greek letters and maths signs survive", maths.pages.flat().join(" ").includes("≤ 1 frame; α → β"));
await maths.pdf.destroy();
const subjPdf = await openPdf(await renderPdf(subjModel));
const typedPage = (await subjPdf.pdf.getPageIndex((await subjPdf.pdf.getDestinations())[subjModel.index.at(-1).id][0])) + 1;
check("in a subject, each note starts its own page", subjPdf.pages[typedPage - 1][0] === "Data Link Layer" && typedPage > 2, `page ${typedPage}: ${subjPdf.pages[typedPage - 1][0]}`);
await subjPdf.pdf.destroy();

// ---------------------------------------------------------------------------
// Through the API
// ---------------------------------------------------------------------------
const PORT = 4594;
const API = `http://localhost:${PORT}/api`;
const server = spawn(process.execPath, ["src/index.js"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, PORT: String(PORT), MONGODB_URI: "", DB_FILE: "memory", GROQ_API_KEY: "", SEMANTIC_MODEL: "off", NODE_ENV: "development" },
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
  const json = async (route, { method = "GET", body, token } = {}) => {
    const res = await fetch(API + route, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
  const file = async (route, token, headers = {}) => {
    const res = await fetch(API + route, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } });
    return { status: res.status, type: res.headers.get("content-type"), disposition: res.headers.get("content-disposition"), exposed: res.headers.get("access-control-expose-headers"), cache: res.headers.get("cache-control"), body: Buffer.from(await res.arrayBuffer()) };
  };
  const { token } = await json("/auth/register", { method: "POST", body: { email: `export${Date.now()}@example.com`, password: "password123" } });
  const other = await json("/auth/register", { method: "POST", body: { email: `export-other${Date.now()}@example.com`, password: "password123" } });
  const { subject: subj } = await json("/subjects", { method: "POST", body: { name: "Databases" }, token });
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(SAMPLE)]), "dbms_unit4.md");
  const uploaded = await (await fetch(`${API}/subjects/${subj._id}/notes`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form })).json();
  const note = (await json(`/subjects/${subj._id}/notes`, { method: "POST", token, body: { title: "Résumé of “Locks”", content: typedText } })).note;

  console.log("\n=== API: downloading ===");
  let r = await file(`/notes/${uploaded.note._id}/export?format=pdf&tz=Asia/Kolkata`, token);
  check("a document downloads as a PDF", r.status === 200 && r.type === "application/pdf" && r.body.subarray(0, 5).toString() === "%PDF-", `HTTP ${r.status} ${r.type}`);
  check("  ...named after the document", r.disposition === `attachment; filename="${dbms.title}.pdf"; filename*=UTF-8''${encodeURIComponent(`${dbms.title}.pdf`)}`, r.disposition);
  check("  ...and not kept by shared caches", /no-store/.test(r.cache || ""));
  const apiPdf = await openPdf(r.body);
  check("  ...with all eight topics in it", (await apiPdf.pdf.getOutline()).length === 3 && apiPdf.pages.flat().includes("Checkpoints"));
  await apiPdf.pdf.destroy();
  r = await file(`/notes/${uploaded.note._id}/export?format=docx`, token);
  check("  ...and as a Word file", r.status === 200 && /wordprocessingml/.test(r.type) && r.body.subarray(0, 2).toString() === "PK" && /\.docx"/.test(r.disposition), `HTTP ${r.status} ${r.type}`);
  r = await file(`/notes/${uploaded.children[4]._id}/export?format=word`, token);
  const one = await extractDocument({ originalname: "x.docx", buffer: r.body }, "docx");
  check("one subtopic downloads alone ('word' is understood)", r.status === 200 && one.text.includes("Lock-Based Protocols") && !one.text.includes("Checkpoints"));
  r = await file(`/notes/${note._id}/export`, token);
  check("PDF is the default; a name with accents and quotes is sent safely", r.status === 200 && r.type === "application/pdf" && r.disposition.includes('filename="R_sum_ of _Locks_.pdf"') && decodeURIComponent(r.disposition.split("UTF-8''")[1]) === "Résumé of “Locks”.pdf", r.disposition);
  r = await file(`/subjects/${subj._id}/export?format=pdf`, token);
  const whole = r.status === 200 ? await openPdf(r.body) : null;
  check("a whole subject downloads as one file", r.status === 200 && /filename="Databases\.pdf"/.test(r.disposition) && whole.pages.flat().includes("Checkpoints") && whole.pages.flat().some((row) => row.includes("Locks")), `HTTP ${r.status}`);
  await whole?.pdf.destroy();
  r = await file(`/subjects/${subj._id}/export?format=docx`, token);
  check("  ...as Word too", r.status === 200 && r.body.subarray(0, 2).toString() === "PK");
  r = await file(`/notes/${note._id}/export?format=pdf`, token, { Origin: "http://localhost:5173" });
  check("the web client is allowed to read the file name", /content-disposition/i.test(r.exposed || ""), r.exposed);

  console.log("\n=== API: refusals ===");
  r = await file(`/notes/${note._id}/export?format=exe`, token);
  check("an unknown format is refused", r.status === 400 && /pdf or docx/.test(r.body.toString()), r.body.toString());
  r = await file(`/notes/${note._id}/export?format=pdf`, other.token);
  check("someone else's note is 'not found'", r.status === 404);
  r = await file(`/subjects/${subj._id}/export?format=pdf`, other.token);
  check("...and so is their subject", r.status === 404);
  r = await file(`/notes/${note._id}/export?format=pdf`, null);
  check("no download without signing in", r.status === 401);
  const empty = (await json("/subjects", { method: "POST", body: { name: "Empty" }, token })).subject;
  r = await file(`/subjects/${empty._id}/export?format=pdf`, token);
  check("a subject with no notes says so", r.status === 404 && /no notes/.test(r.body.toString()), r.body.toString());
} catch (err) {
  console.log(`  FAIL  ${err.stack || err.message}`);
  failures++;
} finally {
  server.kill();
}

console.log(failures ? `\n${failures} FAILING CHECK(S)` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
