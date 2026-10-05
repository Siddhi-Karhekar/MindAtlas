// API test for editing and deleting notes, changing a password and deleting an
// account (routes/noteItems.js, services/noteLifecycle.js, routes/auth.js).
//
// What must hold:
//   - an edit changes the note's text, formatted content, keywords and links,
//     and never touches a test already built from it;
//   - a delete removes the note with its links and mastery, takes a split
//     document's subtopics with it, and removes a document whose last subtopic
//     is deleted;
//   - nobody can read, edit or delete someone else's note;
//   - deleting an account leaves nothing of it behind.
// Starts the real server (in-memory database, no API keys) on a spare port,
// like the other API tests.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { blocksFromPlainText, normalizeContent } from "../src/services/documentStructure.js";
import { composeDocument } from "../src/services/noteLifecycle.js";
import { contentToEditText } from "../src/services/noteView.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + String(detail).replace(/\s+/g, " ").slice(0, 170) : ""}`);
  if (!cond) failures++;
};
const shape = (blocks) =>
  blocks.map((b) => (b.type === "heading" ? `h${b.level}` : b.type === "item" ? `${b.ordered ? "n" : "b"}${b.depth}` : b.type[0])).join(" ");
const words = (topic, n = 70) => Array.from({ length: n }, (_, i) => `${topic}${i % 9 === 8 ? "." : ""}`).join(" ") + ".";

console.log("\n=== Content <-> editable text ===");
const source =
  "# Locks\n\nA **lock** controls access to a data item.\n\nLock modes:\n- **Shared lock** (S): read only\n  - many holders\n- Exclusive lock: read and write\n\n## Steps\n\n1. Request\n2. Hold\n\n| Mode | Reads |\n|---|---|\n| S | yes |";
const original = normalizeContent(blocksFromPlainText(source));
const editable = contentToEditText(original);
check("content written out as text reads back as the same content", JSON.stringify(normalizeContent(blocksFromPlainText(editable))) === JSON.stringify(original));
check("headings, bullets, numbers, bold and tables are all written", /^# Locks/m.test(editable) && /^ {2}- many holders/m.test(editable) && /^1\. Request/m.test(editable) && /\*\*lock\*\*/.test(editable) && /^\| Mode \| Reads \|/m.test(editable));
check("the longer bold term is not split by the shorter", /\*\*Shared lock\*\*/.test(editable) && !/\*\*Shared \*\*/.test(editable));

console.log("\n=== A document rebuilt from its subtopics ===");
const para = (text) => normalizeContent(blocksFromPlainText(text));
const doc = composeDocument([
  { title: "Memory", path: [], content: para("Memory is managed by the operating system.") },
  { title: "Paging", path: ["Memory"], content: para("Paging splits memory into frames.\n\n## TLB\n\nCaches translations.") },
  { title: "Segmentation", path: ["Memory"], content: para("Segments vary in size.") },
  { title: "Deadlocks", path: [], content: para("A deadlock is a circular wait.") },
]);
check("subtopics sit under their chapter, sub-headings one level further down", shape(doc.content) === "h1 p h2 p h3 p h2 p h1 p", shape(doc.content));
check("a chapter's introduction does not repeat the chapter heading", doc.content.filter((b) => b.type === "heading" && b.text === "Memory").length === 1);
check("its text is the subtopics' text, in order", /managed by the operating system[\s\S]*Paging[\s\S]*frames[\s\S]*Segments vary[\s\S]*circular wait/.test(doc.rawText));

// ---------------------------------------------------------------------------
const PORT = 4596;
const API = `http://localhost:${PORT}/api`;
const server = spawn(process.execPath, ["src/index.js"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, PORT: String(PORT), MONGODB_URI: "", DB_FILE: "memory", GROQ_API_KEY: "", SEMANTIC_MODEL: "off", NODE_ENV: "development", RATE_LIMIT_AUTH_MAX: "500" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
server.on("error", (err) => (serverLog += `\nspawn error: ${err.message}`));
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

  const call = async (path, { method = "GET", body, token } = {}) => {
    const res = await fetch(API + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
  const signUp = async (name) => {
    const email = `${name}${Date.now()}@example.com`;
    const r = await call("/auth/register", { method: "POST", body: { email, password: "river-Kettle-42x" } });
    return { email, token: r.token };
  };
  const me = await signUp("owner");
  const other = await signUp("other");
  const { subject } = await call("/subjects", { method: "POST", body: { name: "Operating Systems" }, token: me.token });
  const add = (title, content, token = me.token, sid = subject._id) => call(`/subjects/${sid}/notes`, { method: "POST", token, body: { title, content } });
  const graph = () => call(`/subjects/${subject._id}/graph`, { token: me.token });
  const linked = (g, a, b) => g.edges.some((e) => [String(e.source), String(e.target)].sort().join() === [String(a), String(b)].sort().join());

  const paging = (await add("Paging", "Paging splits memory into fixed frames and pages. The page table maps each page to a frame, and the TLB caches recent page table entries.")).note;
  const tlb = (await add("TLB", "The TLB caches recent page table entries so that a page lookup avoids the page table. A TLB miss walks the page table to find the frame.")).note;
  const osmosis = (await add("Scheduling", "The scheduler picks the next process to run on the processor. Round robin gives each process a quantum of processor time in turn.")).note;

  console.log("\n=== Reading a note for editing ===");
  let r = await call(`/notes/${paging._id}`, { token: me.token });
  check("the owner gets the note and its editable text", r.status === 200 && r.editText.startsWith("Paging splits memory") && Array.isArray(r.note.content));
  r = await call(`/notes/${paging._id}`, { token: other.token });
  check("someone else gets 404, as if it did not exist", r.status === 404, `HTTP ${r.status}`);
  check("no token, no note", (await call(`/notes/${paging._id}`)).status === 401);

  console.log("\n=== Editing ===");
  check("Paging and TLB start out linked", linked(await graph(), paging._id, tlb._id));
  r = await call(`/tests`.replace("/tests", `/subjects/${subject._id}/tests`), {
    method: "POST",
    token: me.token,
    body: { title: "Before the edit", noteIds: [paging._id, tlb._id], mcqCount: 2, theoryCount: 0, marksPerQuestion: 1, durationMinutes: 5 },
  });
  const testId = r.test?._id;
  const questionsBefore = JSON.stringify((await call(`/tests/${testId}`, { token: me.token })).questions);
  check("a test is built from the notes before they change", r.status === 201 && r.accepted > 0, `HTTP ${r.status} ${r.error || ""}`);

  r = await call(`/notes/${paging._id}`, {
    method: "PATCH",
    token: me.token,
    body: { title: "Round Robin", content: "# Round robin\n\nRound robin gives each process a **quantum** of processor time.\n\n- the scheduler picks the next process\n- a short quantum costs more context switches" },
  });
  check("the edit is saved", r.status === 200 && r.note.title === "Round Robin" && /of processor time/.test(r.note.rawText), `HTTP ${r.status} ${r.error || ""}`);
  check("  ...with formatted content rebuilt from the new text", shape(r.note.content) === "p b0 b0" || shape(r.note.content) === "h1 p b0 b0", shape(r.note?.content || []));
  check("  ...a typed note keeps exactly what was typed", r.note.rawText.includes("**quantum**"));
  check("  ...its keywords follow the new text", r.note.keywords.includes("quantum") && !r.note.keywords.includes("tlb"), r.note?.keywords?.join(", "));
  check("  ...it is marked as edited", Boolean(r.note.editedAt));
  let g = await graph();
  check("the old link is gone and the note is linked by its new words", !linked(g, paging._id, tlb._id) && linked(g, paging._id, osmosis._id), JSON.stringify(g.edges.map((e) => [e.source, e.target])));
  check("the test built earlier is untouched", JSON.stringify((await call(`/tests/${testId}`, { token: me.token })).questions) === questionsBefore);

  r = await call(`/notes/${tlb._id}`, { method: "PATCH", token: me.token, body: { title: "Translation lookaside buffer" } });
  check("a title alone can be changed, text and links stay", r.status === 200 && r.note.title === "Translation lookaside buffer" && /TLB caches/.test(r.note.rawText) && !r.note.editedAt);
  check("an empty title is refused", (await call(`/notes/${tlb._id}`, { method: "PATCH", token: me.token, body: { title: "  " } })).status === 400);
  check("empty text is refused, with a pointer to delete", /delete it instead/.test((await call(`/notes/${tlb._id}`, { method: "PATCH", token: me.token, body: { content: "   " } })).error || ""));
  check("nothing to change is a 400", (await call(`/notes/${tlb._id}`, { method: "PATCH", token: me.token, body: {} })).status === 400);
  check("someone else cannot edit it", (await call(`/notes/${tlb._id}`, { method: "PATCH", token: other.token, body: { title: "Mine now" } })).status === 404);

  console.log("\n=== A link the student removed stays removed after an edit ===");
  const a = (await add("Semaphores", "A semaphore is an integer variable accessed only through the wait and signal operations. A counting semaphore guards a pool of resources.")).note;
  const b = (await add("Monitors", "A monitor wraps shared data with the operations on it. A semaphore can implement a monitor, using wait and signal on a condition.")).note;
  g = await graph();
  const edge = g.edges.find((e) => [String(e.source), String(e.target)].sort().join() === [String(a._id), String(b._id)].sort().join());
  check("the two notes are linked", Boolean(edge));
  await call(`/graph/edges/${edge.id}/correct`, { method: "POST", token: me.token, body: { action: "remove" } });
  await call(`/notes/${a._id}`, { method: "PATCH", token: me.token, body: { content: "A semaphore is an integer variable accessed only through the wait and signal operations. A binary semaphore is also called a mutex lock." } });
  g = await graph();
  check("relinking does not bring it back", !linked(g, a._id, b._id) && g.removedEdges.some((e) => String(e.id) === String(edge.id)), `removed: ${g.removedEdges?.length}`);

  console.log("\n=== Editing and deleting inside a split document ===");
  const longDoc =
    `# Unit 3\n\n## Memory\n\n### Paging\n\n${words("frame page offset", 70)}\n\n### Segmentation\n\n${words("segment base limit", 70)}\n\n` +
    `## Deadlocks\n\n### Avoidance\n\n${words("banker safe state", 70)}\n`;
  r = await add("Unit 3", longDoc);
  const parent = r.note;
  const kids = r.children;
  check("a long typed note is split into three subtopics", r.status === 201 && kids.length === 3, `${kids?.length}`);
  r = await call(`/notes/${parent._id}`, { method: "PATCH", token: me.token, body: { content: "replacement" } });
  check("a split document's text is edited through its subtopics", r.status === 400 && /subtopic/.test(r.error), r.error);
  check("...but it can be renamed", (await call(`/notes/${parent._id}`, { method: "PATCH", token: me.token, body: { title: "Unit 3 - OS" } })).note?.title === "Unit 3 - OS");

  r = await call(`/notes/${kids[0]._id}`, { method: "PATCH", token: me.token, body: { content: "Paging divides memory into frames.\n\n- the page table maps pages to frames\n- a TLB caches translations" } });
  check("a subtopic can be edited", r.status === 200 && shape(r.note.content) === "p b0 b0", `HTTP ${r.status} ${r.error || ""}`);
  check("  ...and its document's full text follows", /Paging divides memory into frames/.test(r.parent?.rawText) && !/frame page offset frame/.test(r.parent.rawText) && /segment base limit/.test(r.parent.rawText));
  check("  ...keeping the outline: chapter, subtopic, then its text", shape(r.parent.content).startsWith("h1 h2 p b0 b0 h2 p h1 h2 p"), shape(r.parent?.content || []));
  check("  ...the subtopic keeps its place", r.note.parentNoteId === parent._id && r.note.order === 0 && r.note.path[0] === "Memory");

  r = await call(`/notes/${kids[1]._id}`, { method: "DELETE", token: me.token });
  check("deleting one subtopic keeps the document", r.status === 200 && r.parentDeleted === false && r.deletedIds.length === 1, JSON.stringify(r).slice(0, 120));
  check("  ...which now has two subtopics and no trace of the third", r.parent.childCount === 2 && !/segment base limit/.test(r.parent.rawText));
  let list = (await call(`/subjects/${subject._id}/notes`, { token: me.token })).notes;
  check("  ...and the subtopic is gone from the subject", !list.some((n) => n._id === kids[1]._id) && list.filter((n) => n.parentNoteId === parent._id).length === 2);

  r = await call(`/notes/${parent._id}`, { method: "DELETE", token: me.token });
  check("deleting a document takes its subtopics with it", r.status === 200 && r.deletedIds.length === 3, `${r.deletedIds?.length} deleted`);
  list = (await call(`/subjects/${subject._id}/notes`, { token: me.token })).notes;
  check("  ...none of them remain", !list.some((n) => n._id === parent._id || n.parentNoteId === parent._id));

  r = await add("Unit 4", longDoc.replace("Unit 3", "Unit 4"));
  for (const c of r.children.slice(0, 2)) await call(`/notes/${c._id}`, { method: "DELETE", token: me.token });
  const last = await call(`/notes/${r.children[2]._id}`, { method: "DELETE", token: me.token });
  check("deleting the last subtopic removes the empty document too", last.parentDeleted === true && last.deletedIds.includes(r.note._id));

  console.log("\n=== Deleting a note cleans up after it ===");
  const builtFrom = (await add("Virtual memory", "Virtual memory lets a process use more memory than is physically present. Demand paging loads a page only when the process first uses it.")).note;
  const t = await call(`/subjects/${subject._id}/tests`, {
    method: "POST",
    token: me.token,
    body: { title: "VM", noteIds: [builtFrom._id], mcqCount: 1, theoryCount: 0, marksPerQuestion: 1, durationMinutes: 5 },
  });
  const attempt = await call(`/tests/${t.test._id}/attempts`, { method: "POST", token: me.token });
  let step = attempt;
  for (let i = 0; i < 5 && step.question; i++) {
    step = await call(`/attempts/${attempt.attempt._id}/responses`, { method: "POST", token: me.token, body: { questionId: step.question._id, answer: step.question.options?.[0] || "x", timeMs: 1000 } });
  }
  await call(`/attempts/${attempt.attempt._id}/submit`, { method: "POST", token: me.token });
  let progress = await call(`/subjects/${subject._id}/progress`, { token: me.token });
  const hasMastery = (p) => JSON.stringify(p).includes(String(builtFrom._id));
  check("taking a test records mastery for the note", hasMastery(progress), JSON.stringify(progress).slice(0, 120));

  check("someone else cannot delete it", (await call(`/notes/${builtFrom._id}`, { method: "DELETE", token: other.token })).status === 404);
  r = await call(`/notes/${builtFrom._id}`, { method: "DELETE", token: me.token });
  check("the owner can", r.status === 200 && r.deletedIds[0] === String(builtFrom._id));
  check("it is gone: a second delete is a 404", (await call(`/notes/${builtFrom._id}`, { method: "DELETE", token: me.token })).status === 404);
  g = await graph();
  check("no link still points at it", ![...g.edges, ...(g.removedEdges || [])].some((e) => [String(e.source), String(e.target)].includes(String(builtFrom._id))) && !g.nodes.some((n) => String(n.id) === String(builtFrom._id)));
  progress = await call(`/subjects/${subject._id}/progress`, { token: me.token });
  check("its mastery record is gone", !hasMastery(progress));
  const kept = await call(`/tests/${t.test._id}`, { token: me.token });
  check("the test taken on it is still there, questions intact", kept.status === 200 && kept.questions.length > 0);
  check("...and so is its feedback", (await call(`/attempts/${attempt.attempt._id}/feedback`, { token: me.token })).status === 200);

  console.log("\n=== Changing the password ===");
  const pw = (body, token = me.token) => call("/auth/password", { method: "POST", token, body });
  check("the current password must be right", (await pw({ currentPassword: "wrong", newPassword: "another-pass-1" })).status === 401);
  check("the new one must be at least 8 characters", (await pw({ currentPassword: "river-Kettle-42x", newPassword: "short" })).status === 400);
  check("...and different from the current one", (await pw({ currentPassword: "river-Kettle-42x", newPassword: "river-Kettle-42x" })).status === 400);
  const oldToken = me.token;
  const changed = await pw({ currentPassword: "river-Kettle-42x", newPassword: "another-pass-1" });
  check("a valid change is accepted", changed.ok === true && typeof changed.token === "string");
  check("every session from before the change stops working", (await call("/subjects", { token: oldToken })).status === 401);
  me.token = changed.token; // the session that made the change carries on
  check("...and the one that made it carries on", (await call("/subjects", { token: me.token })).status === 200);
  check("the old password no longer signs in", (await call("/auth/login", { method: "POST", body: { email: me.email, password: "river-Kettle-42x" } })).status === 401);
  check("the new one does", Boolean((await call("/auth/login", { method: "POST", body: { email: me.email, password: "another-pass-1" } })).token));
  check("it needs a signed-in user", (await call("/auth/password", { method: "POST", body: { currentPassword: "a", newPassword: "bbbbbbbbb" } })).status === 401);

  console.log("\n=== Deleting the account ===");
  const theirSubject = (await call("/subjects", { method: "POST", body: { name: "Chemistry" }, token: other.token })).subject;
  const theirNote = (await add("Atoms", "An atom has a nucleus of protons and neutrons, surrounded by electrons in shells around it.", other.token, theirSubject._id)).note;
  check("the password is required", (await call("/auth/me", { method: "DELETE", token: me.token, body: { password: "nope" } })).status === 401);
  r = await call("/auth/me", { method: "DELETE", token: me.token, body: { password: "another-pass-1" } });
  check("with it, the account and its data are removed", r.ok === true && r.removed.users === 1 && r.removed.notes >= 4 && r.removed.subjects === 1 && r.removed.tests >= 2, JSON.stringify(r.removed));
  check("...including questions, attempts, responses and feedback", r.removed.questions > 0 && r.removed.attempts === 1 && r.removed.responses > 0 && r.removed.feedback_reports === 1, JSON.stringify(r.removed));
  check("signing in no longer works", (await call("/auth/login", { method: "POST", body: { email: me.email, password: "another-pass-1" } })).status === 401);
  check("the old session sees none of the data", ((await call("/subjects", { token: me.token })).subjects || []).length === 0 && (await call("/auth/me", { token: me.token })).status === 401);
  check("the same email can sign up afresh", (await call("/auth/register", { method: "POST", body: { email: me.email, password: "river-Kettle-42x" } })).status === 201);
  const theirs = await call(`/subjects/${theirSubject._id}/notes`, { token: other.token });
  check("nobody else's data was touched", theirs.notes?.length === 1 && theirs.notes[0]._id === theirNote._id);
} catch (err) {
  console.log(`  FAIL  ${err.message}`);
  failures++;
} finally {
  server.kill();
}

console.log(failures ? `\n${failures} FAILING CHECK(S)` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
