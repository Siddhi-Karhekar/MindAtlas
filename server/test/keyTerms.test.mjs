// Checks for key terms as students see them: the terms highlighted in a note
// and listed under its title, and the key points of a theory question.
//
// What was wrong before: the highlights were TF-IDF keywords, which are single
// words, so "data link layer" was shown as "layer", whole terms like "bus
// topology" were never found, and words said in passing ("air", "bottom")
// were marked as if they mattered. Questions' key points were topped up with
// single words the same way.
//
// The last part starts the real server (in-memory database, no API keys) on a
// spare port, like noteContent.test.mjs.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { notesFromFile } from "../evaluation/lib/ingest.js";
import { candidateSentences, isQuestionWorthy } from "../src/services/studyText.js";
import { keyTermsFor, phrasesIn } from "../src/services/keyTerms.js";
import { markText } from "../src/services/noteExport/format.js";
import { generateQuestions } from "../src/services/testEngine.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!cond) failures++;
};
const NETWORKS = fileURLToPath(new URL("../../sample-notes/networks_unit2.md", import.meta.url));
const DBMS = fileURLToPath(new URL("../evaluation/samples/dbms_unit4.md", import.meta.url));

const net = await notesFromFile(NETWORKS);
const dbms = await notesFromFile(DBMS);
const termsOf = (doc, title) => {
  const note = doc.notes.find((n) => n.title.includes(title));
  return note ? keyTermsFor(note, doc.notes) : [];
};
const has = (list, ...want) => want.every((w) => list.some((t) => t.toLowerCase() === w.toLowerCase()));

console.log("\n=== Key terms are whole terms ===");
let t = termsOf(net, "Network Topologies");
check("kinds of one thing, each said once, are found", has(t, "bus topology", "star topology", "ring topology", "mesh topology"), t.join(" · "));
check("  ...and the words around them are not glued on", !t.some((x) => /every|device$/.test(x) && x.includes(" ")), t.join(" · "));
check("  ...and 'mesh' is not listed beside 'mesh topology'", !has(t, "mesh") && !has(t, "star"), t.join(" · "));
t = termsOf(net, "Transmission Media");
check("a term a sentence opens with is found", has(t, "coaxial cable", "optical fibre"), t.join(" · "));
check("  ...words said in passing are not key terms", !["air", "room", "sight", "cancels", "insulation"].some((w) => has(t, w)), t.join(" · "));
check("  ...nor a subject glued to its verb", !t.some((x) => /transmit$/i.test(x)), t.join(" · "));
t = termsOf(net, "Congestion Control");
check("a noun that is also a verb stays in its term ('slow start')", has(t, "slow start", "congestion window"), t.join(" · "));
t = termsOf(net, "Three-Way Handshake");
check("a term ending in a common noun is whole ('initial sequence number')", has(t, "initial sequence number") && !has(t, "initial sequence"), t.join(" · "));
t = termsOf(net, "Flow Control");
check("'the sender retransmits that frame' gives no term 'sender retransmits'", !t.some((x) => /retransmits/i.test(x)), t.join(" · "));
t = termsOf(net, "Medium Access Control");
check("a name keeps its capitals", has(t, "Carrier Sense Multiple Access") && t.includes("Carrier Sense Multiple Access"), t.join(" · "));
t = termsOf(net, "Types of Networks");
check("terms spelled out before an acronym are found", has(t, "local area network", "wide area network", "LAN"), t.join(" · "));
t = termsOf(dbms, "Lock-Based");
check("a term the author set in bold is found ('shared lock')", has(t, "shared lock", "exclusive lock", "two-phase locking"), t.join(" · "));
t = termsOf(dbms, "Deadlock");
check("'younger one' is no term", !t.some((x) => /\bone$/.test(x)), t.join(" · "));
const allShown = [...net.notes, ...dbms.notes].flatMap((n) => keyTermsFor(n, net.notes.includes(n) ? net.notes : dbms.notes));
check("most shown terms are phrases or acronyms", allShown.filter((x) => x.includes(" ") || /^[A-Z0-9/.-]+$/.test(x)).length / allShown.length >= 0.6,
  `${allShown.filter((x) => x.includes(" ") || /^[A-Z0-9/.-]+$/.test(x)).length} of ${allShown.length}`);
check("at most ten per note", [...net.notes, ...dbms.notes].every((n) => keyTermsFor(n, net.notes).length <= 10));
const swap = (v) => JSON.parse(JSON.stringify(v).replace(/bus topology/gi, "line topology"));
const edited = { ...net.notes[0], rawText: swap(net.notes[0].rawText), content: swap(net.notes[0].content) };
check("an edited note gets new terms, not the old ones from memory", has(keyTermsFor(edited, net.notes), "line topology") && !has(keyTermsFor(edited, net.notes), "bus topology"));

console.log("\n=== Highlighting marks whole terms ===");
const show = (segments) => segments.map((s) => (s.mark ? `[${s.text}]` : s.text)).join("");
let used = new Set();
const kw = ["layer", "data link layer", "network layer", "local area network", "ring topology", "point-to-point link"];
let out = show(markText("The data link layer organises bits; the network layer routes. Each layer is separate.", { keywords: kw, used }));
check("a term of three words is marked whole, not one word of it", out.includes("[data link layer]") && out.includes("[network layer]"), out);
check("  ...and a shorter term inside it is marked where it stands alone", out.includes("Each [layer]"), out);
out = show(markText("A local area network (LAN) and two ring topologies with a point to point link.", { keywords: kw, used }));
check("the acronym after a term is marked with it", out.includes("[local area network (LAN)]"), out);
check("a plural is marked ('ring topologies')", out.includes("[ring topologies]"), out);
check("a hyphen or a space between words both match", out.includes("[point to point link]"), out);
out = show(markText("The data link layer again.", { keywords: kw, used }));
check("a term is marked the first time only", !out.includes("["), out);
used = new Set();
out = show(markText("A **frame** here", { keywords: ["frame"], strong: ["frame"], used }) && markText("the frame there", { keywords: ["frame"], used }));
check("a term the author set in bold counts as introduced", !out.includes("["), out);

const clientLib = new URL("../../client/src/lib/noteFormat.js", import.meta.url);
if (fs.existsSync(clientLib)) {
  const client = await import(clientLib.href);
  const sample = "The data link layer and the network layer (NL); ring topologies; a point-to-point link.";
  const same = JSON.stringify(client.markText(sample, { keywords: kw })) === JSON.stringify(markText(sample, { keywords: kw }));
  check("the screen and the downloads mark the same words", same);
  check("the screen uses whole terms when the server sends them", client.termsOf({ keyTerms: ["bus topology"], keywords: ["bus"] })[0] === "bus topology" && client.termsOf({ keywords: ["bus"] })[0] === "bus");
}

console.log("\n=== Theory key points are whole terms ===");
check("noun phrases come whole ('insulated copper wires')", phrasesIn("Twisted pair cable twists two insulated copper wires together.").includes("insulated copper wires"));
check("  ...and not with their verb ('data travels')", !phrasesIn("Data travels around the ring in one direction.").some((p) => /travels/.test(p)));
const { accepted: questions } = await generateQuestions(net.notes.slice(0, 10), { mcqCount: 0, theoryCount: 10, marksPerQuestion: 1 });
const points = questions.filter((q) => Array.isArray(q.keyPoints)).flatMap((q) => q.keyPoints.map((p) => ({ p, q })));
check("theory questions were made", points.length > 10, `${points.length} key points`);
const piece = points.filter(({ p, q }) => q.keyPoints.some((o) => o !== p && o.toLowerCase().split(/\s+/).includes(p.toLowerCase())));
check("no key point is one word of another key point", piece.length === 0, piece.map(({ p }) => p).join(", "));
check("most key points are phrases or acronyms", points.filter(({ p }) => p.includes(" ") || /^[A-Z0-9/.-]+$/.test(p)).length / points.length >= 0.5,
  `${points.filter(({ p }) => p.includes(" ") || /^[A-Z0-9/.-]+$/.test(p)).length} of ${points.length}`);
const named = points.filter(({ p, q }) => (q.prompt.match(/“([^”]+)”/g) || []).some((m) => m.slice(1, -1).toLowerCase() === p.toLowerCase()) && !/Differentiate/.test(q.prompt));
check("a key point is never the term the question names", named.length === 0, named.map(({ p }) => p).join(", "));

console.log("\n=== Questions stay on the subject, with options of one kind ===");
// a unit's slides as a student uploaded them: a class line with a usage
// notice under it, worked numbers, and subscripts the PDF reader split off
const ICS = fileURLToPath(new URL("./fixtures/ics_unit3.md", import.meta.url));
const ics = await notesFromFile(ICS);
check("the batch / semester line is not a subtopic", !ics.notes.some((n) => /batch|semester/i.test(n.title)), ics.notes.map((n) => n.title).join(" | "));
for (const [text, why] of [
  ["The slides should be used only for preparing notes, academic purposes (e.g. in teaching a class), and should not be used for commercial purposes.", "a usage notice"],
  ["Some of the figures and text are adapted from standard textbooks and their authors are gratefully acknowledged.", "thanks to the sources"],
  ["ii. If A has private key 9 what is A's public key? iii.", "a numbered exercise question"],
  ["A computes key = 5^9 mod 23 and B computes key = 5^4 mod 23.", "a worked calculation"],
  ["The public key PU e is published so that anyone can encrypt a message for its owner.", "a split subscript"],
]) check(`not asked about: ${why}`, !isQuestionWorthy(text));
check("  ...while a formula in a statement stays", isQuestionWorthy("The kinetic energy of a body is given by E = 1/2 mv^2 in classical mechanics."));
check("a subtopic saved before this, named after the batch, gives no sentences",
  candidateSentences({ title: "B. Tech CSE Batch 2023-2027 Semester-VII (AY 2026-27)", rawText: "The slides should be used only for preparing notes on cryptography and hashing in class." }).length === 0);
const icsTest = await generateQuestions(ics.notes, { mcqCount: 12, theoryCount: 4, marksPerQuestion: 1 });
const icsMcq = icsTest.accepted.filter((q) => Array.isArray(q.options));
check("multiple-choice questions were made", icsMcq.length >= 6, `${icsMcq.length}`);
// (a direct question ends in "?"; the exercise questions were a "?" inside a quoted sentence)
const offTopic = icsTest.accepted.filter((q) => /slides|commercial|acknowledged|batch|semester|private key 9|mod 23/i.test(q.prompt) || /"[^"]*\?[^"]*"/.test(q.prompt));
check("none is about the class, the usage notice or the worked numbers", offTopic.length === 0, offTopic.map((q) => q.prompt).join(" || "));
check("no question is set on the paperwork 'topic'", !icsTest.accepted.some((q) => /batch|semester/i.test(q.topic || "")));
const garbled = icsMcq.flatMap((q) => q.options).filter((o) => /(^|\s)[a-z]$|^[A-Z]{1,2}\s[a-z]$|\bcomputes\b|\bagree\b/.test(o));
check("no option is a split subscript or a phrase glued to its verb", garbled.length === 0, garbled.join(", "));
const shapeOf = (o) => (/\d/.test(o) || /^[A-Z0-9/+.-]{2,}$/.test(o) ? "code" : o.trim().includes(" ") ? "phrase" : "word");
const mixed = icsMcq.filter((q) => new Set(q.options.map(shapeOf)).size > 1);
check("the four options of a question are of one kind", mixed.length <= 1, mixed.map((q) => q.options.join(" / ")).join(" || "));
const keyQ = icsMcq.find((q) => /key/.test(q.correctAnswer || q.answerKey || "") && / key$/.test(q.correctAnswer || q.answerKey || ""));
check("beside a kind of key, the wrong options are other kinds of key", !keyQ || keyQ.options.filter((o) => / key$/.test(o)).length >= 3, keyQ?.options.join(" / "));

// ---------------------------------------------------------------------------
// Through the API
// ---------------------------------------------------------------------------
const PORT = 4593;
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
  console.log("\n=== API ===");
  const { token } = await json("/auth/register", { method: "POST", body: { email: `terms${Date.now()}@example.com`, password: "river-Kettle-42x" } });
  const { subject } = await json("/subjects", { method: "POST", body: { name: "Networks" }, token });
  const text = net.notes[0].rawText;
  const made = await json(`/subjects/${subject._id}/notes`, { method: "POST", token, body: { title: "Network Topologies", content: text } });
  check("a note is saved", made.status === 201, `HTTP ${made.status}`);
  const list = await json(`/subjects/${subject._id}/notes`, { token });
  const listed = list.notes?.[0]?.keyTerms || [];
  check("the notes list carries whole key terms", has(listed, "bus topology", "star topology"), listed.join(" · "));
  check("  ...and still the TF-IDF keywords the graph links by", Array.isArray(list.notes?.[0]?.keywords) && list.notes[0].keywords.length > 0);
  const one = await json(`/notes/${made.note._id}`, { token });
  check("one note read alone has the same terms", JSON.stringify(one.note?.keyTerms) === JSON.stringify(listed), (one.note?.keyTerms || []).join(" · "));
  const changed = await json(`/notes/${made.note._id}`, { method: "PATCH", token, body: { content: text.replace(/bus topology/gi, "line topology") } });
  check("an edit sends back the new terms", has(changed.note?.keyTerms || [], "line topology") && !has(changed.note?.keyTerms || [], "bus topology"), (changed.note?.keyTerms || []).join(" · "));
} finally {
  server.kill();
}

console.log(failures ? `\n${failures} FAILING CHECK(S)` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
