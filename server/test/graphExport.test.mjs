// Checks for downloading the knowledge graph or a keyword map as a PDF
// (src/services/graphExport/).
//
// The PDFs are read back with the app's own PDF reader, so "the full title is
// in the links table" and "the second page starts the tables" are checked
// against the real file. The last part starts the real server (in-memory
// database, no API keys) on a spare port, like graphRoutes.test.mjs.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { drawnNodeIds, graphModel, keywordMapLayout, keywordMapModel } from "../src/services/graphExport/model.js";
import { exportKeywordMap, readPositions } from "../src/services/graphExport/index.js";
import { renderGraphPdf } from "../src/services/graphExport/pdf.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!cond) failures++;
};
const throws = (fn, status) => {
  try {
    fn();
    return false;
  } catch (err) {
    return err.status === status;
  }
};
const openPdf = async (buffer) => {
  const pdf = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false, verbosity: 0 }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    pages.push(content.items.map((i) => i.str).join(" ").replace(/\s+/g, " "));
  }
  return { pdf, pages };
};

// ---- a subject: three linked notes in one cluster, a split document with two
// subtopics, a note on its own, and a link to another subject's note
const LONG = "Page replacement algorithms: LRU, FIFO and the optimal algorithm";
const node = (id, title, extra = {}) => ({ id, title, keywords: [], clusterId: undefined, parentNoteId: null, childCount: 0, ...extra });
const edge = (source, target, weight, sharedKeywords, extra = {}) => ({ id: `${source}-${target}`, source, target, weight, sharedKeywords, edgeType: "same-subject", meaning: null, ...extra });
const graph = {
  nodes: [
    node("a", "Process scheduling", { clusterId: 1 }),
    node("b", "Round robin", { clusterId: 1 }),
    node("c", LONG, { clusterId: 1 }),
    node("doc", "Unit 3 slides", { childCount: 2 }),
    node("d", "Paging", { clusterId: 2, parentNoteId: "doc", order: 1 }),
    node("e", "Segmentation", { clusterId: 3, parentNoteId: "doc", order: 0 }),
    node("f", "File systems", { clusterId: 4 }),
  ],
  clusters: [
    { id: 1, size: 3, keywords: ["scheduling", "process"] },
    { id: 2, size: 1, keywords: [] },
    { id: 3, size: 1, keywords: [] },
    { id: 4, size: 1, keywords: [] },
  ],
  edges: [edge("a", "b", 0.42, ["scheduling", "quantum"]), edge("a", "c", 0.2, ["process"], { meaning: 0.7 }), edge("b", "c", 0.15, [])],
  containsEdges: [
    { id: "contains-d", source: "doc", target: "d", edgeType: "contains" },
    { id: "contains-e", source: "doc", target: "e", edgeType: "contains" },
  ],
  crossSubjectEdges: [edge("d", "x", 0.3, ["memory", "frame", "page"], { edgeType: "cross-subject" })],
  rejectedEdges: [],
  removedEdges: [],
  externalNodes: [
    { id: "x", title: "Buffer management", subjectName: "Databases" },
    { id: "y", title: "Only a rejected pair", subjectName: "Databases" },
  ],
};
const positions = new Map(drawnNodeIds(graph).map((id, i) => [id, [150 + (i % 4) * 230, 80 + Math.floor(i / 4) * 300]]));
const subject = { name: "Operating Systems" };

console.log("\n=== What the graph download draws ===");
check("draws this subject's notes and only the other subjects' notes it links to", drawnNodeIds(graph).join() === "a,b,c,doc,d,e,f,x");
const links = graphModel({ subject, graph, positions, colorBy: "links", date: "30 Oct 2026" });
const clusters = graphModel({ subject, graph, positions, colorBy: "clusters", date: "30 Oct 2026" });
check("one node per drawn note", links.drawing.nodes.length === 8);
check("every link and document line is drawn", links.drawing.lines.length === 3 + 2 + 1);
const pill = (model, title) => model.drawing.nodes.find((n) => n.lines.some((l) => l.text === title));
check("Links view: the badge counts links, cross-subject ones too", pill(links, "Process scheduling").badge.text === "2" && pill(links, "Paging").badge.text === "1");
check("Clusters view: the badge names the cluster", pill(clusters, "Process scheduling").badge.text === "C1");
check("  ...and a note in no cluster has no badge and a hollow dot", pill(clusters, "File systems").badge === null && !pill(clusters, "File systems").dot.fill);
check("titles are clipped as on the page", pill(links, `${LONG.slice(0, 25)}…`) !== undefined);
check("the summary line counts what is drawn", links.meta.startsWith("6 topics (2 from 1 document)  ·  3 connections  ·  1 cluster  ·  1 across subjects"));
check("the file is named after the subject", links.fileName === "Operating Systems - knowledge graph");
const sectionTitles = links.sections.map((s) => s.title);
check("tables: clusters, links, other subjects, documents", sectionTitles.join("|") === "Clusters|Links between notes|Links to other subjects|Documents split into subtopics");
const linkRows = links.sections[1].rows;
check("links are listed strongest first, with why and how strong", linkRows[0].join("|") === "Process scheduling|Round robin|Shares scheduling, quantum|0.42");
check("  ...a link made by meaning says so", linkRows.some((r) => r[2] === "Close in meaning · shares process"));
check("notes with no link are named under the table", links.sections[1].after.includes("Segmentation") && links.sections[1].after.includes("File systems"));
check("subtopics are listed in document order", links.sections[3].rows[0][1] === "Segmentation  ·  Paging");
check("a link to another subject names the subject", links.sections[2].rows[0].slice(0, 3).join("|") === "Paging|Databases|Buffer management");

console.log("\n=== Positions sent by the page ===");
const ids = Object.fromEntries([...positions].map(([id, p]) => [id, p]));
check("all positions given: read back as a Map", readPositions(ids, graph).get("x").join() === positions.get("x").join());
check("extra ids (a note deleted since) are ignored", readPositions({ ...ids, gone: [1, 2] }, graph).size === 8);
check("not an object -> 400", throws(() => readPositions([1, 2], graph), 400));
check("a position that is not two numbers -> 400", throws(() => readPositions({ ...ids, a: [1, "2"] }, graph), 400) && throws(() => readPositions({ ...ids, a: [1, 2, 3] }, graph), 400));
check("an absurd coordinate -> 400", throws(() => readPositions({ ...ids, a: [1e9, 0] }, graph), 400));
const { a: _dropped, ...withoutA } = ids;
check("a note the page has not drawn -> 409 (the graph changed)", throws(() => readPositions(withoutA, graph), 409));

console.log("\n=== The graph PDF ===");
const { pdf, pages } = await openPdf(await renderGraphPdf(links));
const first = await pdf.getPage(1);
const [, , width, height] = first.view;
check("A4 landscape", Math.round(width) === 842 && Math.round(height) === 595, `${width} x ${height}`);
check("page 1 is the drawing: title, labels and legend", pages[0].includes("Operating Systems") && pages[0].includes("Round robin") && pages[0].includes("Hub (3+ links)"));
check("page 2 starts the tables", pages[1].includes("Clusters") && pages[1].includes("Links between notes"));
check("  ...with full titles, not clipped ones", pages.slice(1).join(" ").includes(LONG));
check("every page says which page it is", pages.every((p, i) => p.includes(`Page ${i + 1} of ${pages.length}`)));
check("nothing printed as a missing-character mark", pages.every((p) => !p.includes("�")));
const outline = (await pdf.getOutline()).map((o) => o.title);
check("bookmarks for the drawing and each table", outline.join("|") === "Knowledge graph|Clusters|Links between notes|Links to other subjects|Documents split into subtopics");

const many = { ...graph, nodes: Array.from({ length: 120 }, (_, i) => node(`n${i}`, `Note number ${i}`)), edges: [], containsEdges: [], crossSubjectEdges: [], clusters: undefined };
const spread = new Map(drawnNodeIds(many).map((id, i) => [id, [(i % 12) * 400 - 2000, Math.floor(i / 12) * 300]]));
const big = await openPdf(await renderGraphPdf(graphModel({ subject, graph: many, positions: spread, colorBy: "clusters", date: "" })));
check("a big, dragged-apart graph still draws on one page", (big.pages[0].match(/Note number \d+/g) || []).length === 120);
check("  ...and an older server's graph with no clusters has no Clusters table", !big.pages.join(" ").includes("Shared keywords"));

console.log("\n=== The keyword map PDF ===");
const keywords = [
  { keyword: "page", weight: 1, subKeywords: ["frame", "fault"], sentences: ["A page is a fixed-size block.", "Pages map to frames."], sentenceCount: 5 },
  { keyword: "frame", weight: 0.5, subKeywords: ["physical"], sentences: ["Memory is split into frames."], sentenceCount: 1 },
  { keyword: "thrashing", weight: 0.2, subKeywords: [], sentences: [], sentenceCount: 0 },
];
const map = keywordMapModel({ note: { title: "Paging" }, subjectName: "Operating Systems", keywords, open: "page", date: "30 Oct 2026" });
check("the open keyword's related words are drawn", map.drawing.nodes.some((n) => n.lines[0].text === "fault"));
check("the layout is the page's", keywordMapLayout(keywords, "page").get("kw:page").join() === "500,150");
const closed = keywordMapModel({ note: { title: "Paging" }, subjectName: "", keywords, open: null, date: "" });
check("with no keyword open, only the keywords are drawn", closed.drawing.nodes.length === 4);
const mapPdf = await openPdf(await renderGraphPdf(map));
check("page 2 lists every keyword with its sentences", mapPdf.pages[1].includes("thrashing") && mapPdf.pages[1].includes("Pages map to frames."));
check("  ...one sentence per line, no missing-character marks", !mapPdf.pages[1].includes("�") && mapPdf.pages[1].includes("2 of 5 sentences shown"));
const note = { _id: "n1", title: "Paging", keywords: ["page", "frame"], vector: { page: 0.4, frame: 0.2 }, rawText: "A page is a block. A frame holds a page." };
const asked = await exportKeywordMap({ note, subjectName: "OS", body: { keyword: "nonsense" } });
check("a keyword the note does not have is drawn closed, not refused", asked.contentType === "application/pdf" && asked.fileName === "Paging - keyword map.pdf");

// ---------------------------------------------------------------------------
console.log("\n=== Through the API ===");
const PORT = 4591;
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
async function call(path, { method = "GET", body, token } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get("content-type") || "";
  return { status: res.status, type, disposition: res.headers.get("content-disposition") || "", data: type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

try {
  let up = false;
  for (let i = 0; i < 300 && !up && server.exitCode === null; i++) {
    try {
      up = (await fetch(`${API}/health`)).ok;
    } catch {
      // not listening yet
    }
    if (!up) await wait(200);
  }
  if (!up) throw new Error(`server did not start\n${serverLog}`);

  const register = async (email) => (await call("/auth/register", { method: "POST", body: { email, password: "river-Kettle-42x" } })).data.token;
  const alice = await register("alice@example.com");
  const bob = await register("bob@example.com");
  const bio = (await call("/subjects", { method: "POST", token: alice, body: { name: "Biology" } })).data.subject._id;
  const empty = (await call("/subjects", { method: "POST", token: alice, body: { name: "Empty" } })).data.subject._id;
  const add = async (title, content) => (await call(`/subjects/${bio}/notes`, { method: "POST", token: alice, body: { title, content } })).data.note._id;
  const cell = await add("Cell structure", "The cell is the basic unit of life. The cell membrane controls what enters and leaves the cell. The nucleus holds DNA.");
  await add("Cell division", "During mitosis the nucleus divides and the DNA is copied so each new cell gets the same DNA. The cell membrane pinches in.");
  const g = (await call(`/subjects/${bio}/graph`, { token: alice })).data;
  const layout = { positions: Object.fromEntries(drawnNodeIds(g).map((id, i) => [id, [200 + i * 300, 320]])), colorBy: "clusters" };

  const res = await call(`/subjects/${bio}/graph/export?tz=Asia/Kolkata`, { method: "POST", token: alice, body: layout });
  check("POST /subjects/:id/graph/export -> a PDF", res.status === 200 && res.type === "application/pdf" && res.data.subarray(0, 5).toString() === "%PDF-");
  check("  ...saved as \"Biology - knowledge graph.pdf\"", res.disposition.includes("filename*=UTF-8''Biology%20-%20knowledge%20graph.pdf"));
  const read = await openPdf(res.data);
  check("  ...drawing the subject's notes", read.pages[0].includes("Cell structure") && read.pages[0].includes("Cell division"));
  check("needs a signed-in user", (await call(`/subjects/${bio}/graph/export`, { method: "POST", body: layout })).status === 401);
  check("another student's subject -> 404", (await call(`/subjects/${bio}/graph/export`, { method: "POST", token: bob, body: layout })).status === 404);
  check("no positions -> 400", (await call(`/subjects/${bio}/graph/export`, { method: "POST", token: alice, body: {} })).status === 400);
  await add("Cells and DNA", "Every cell keeps its DNA in the nucleus.");
  const stale = await call(`/subjects/${bio}/graph/export`, { method: "POST", token: alice, body: layout });
  check("a note added since the page loaded -> 409, with a message to reload", stale.status === 409 && /reload/i.test(stale.data.error));
  check("a subject with no notes -> 404", (await call(`/subjects/${empty}/graph/export`, { method: "POST", token: alice, body: { positions: {} } })).status === 404);

  const mapRes = await call(`/graph/notes/${cell}/keyword-map/export`, { method: "POST", token: alice, body: { keyword: "cell" } });
  check("POST /graph/notes/:id/keyword-map/export -> a PDF", mapRes.status === 200 && mapRes.type === "application/pdf");
  check("  ...saved as \"Cell structure - keyword map.pdf\"", mapRes.disposition.includes("Cell%20structure%20-%20keyword%20map.pdf"));
  check("  ...naming the subject", (await openPdf(mapRes.data)).pages[0].includes("Biology"));
  check("another student's note -> 404", (await call(`/graph/notes/${cell}/keyword-map/export`, { method: "POST", token: bob, body: {} })).status === 404);
  check("a keyword that is not text -> 400", (await call(`/graph/notes/${cell}/keyword-map/export`, { method: "POST", token: alice, body: { keyword: 5 } })).status === 400);
} catch (err) {
  failures++;
  console.log(`  FAIL  ${err.stack || err}`);
} finally {
  server.kill();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
