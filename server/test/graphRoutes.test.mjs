// API test for the link-correction loop, POST /api/graph/edges/:id/correct,
// and how GET /api/subjects/:id/graph reflects it. Starts the real server
// (in-memory database, no API keys) on a spare port and talks HTTP to it, so
// routing, auth and ownership checks are exercised exactly as the client
// sees them.
import { spawn } from "node:child_process";

const PORT = 4598;
const API = `http://localhost:${PORT}/api`;
const server = spawn(process.execPath, ["src/index.js"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), MONGODB_URI: "", DB_FILE: "memory", GROQ_API_KEY: "", NODE_ENV: "development" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!cond) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(path, { method = "GET", body, token } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const correct = (edgeId, action, token) => call(`/graph/edges/${edgeId}/correct`, { method: "POST", token, body: { action } });

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { up = (await fetch(`${API}/health`)).ok; } catch { await wait(200); }
  }
  if (!up) throw new Error(`server did not start:\n${serverLog}`);

  const register = async (email) => (await call("/auth/register", { method: "POST", body: { email, password: "password123" } })).data.token;
  const alice = await register("alice@example.com");
  const bob = await register("bob@example.com");
  const subject = async (name) => (await call("/subjects", { method: "POST", token: alice, body: { name } })).data.subject._id;
  const bio = await subject("Biology");
  const chem = await subject("Chemistry");
  const note = async (sid, title, content) =>
    (await call(`/subjects/${sid}/notes`, { method: "POST", token: alice, body: { title, content } })).data.note._id;
  const cellStructure = await note(bio, "Cell structure", "The cell is the basic unit of life. The cell membrane controls what enters and leaves the cell. The nucleus holds DNA, and mitochondria release energy through respiration. Plant cells also have a cell wall and chloroplasts.");
  const cellDivision = await note(bio, "Cell division", "During mitosis the nucleus divides and the DNA is copied so each new cell gets the same DNA. The cell membrane then pinches in and two daughter cells form.");
  await note(bio, "Osmosis and diffusion", "Diffusion is the movement of particles from a high concentration to a low concentration. Osmosis is the diffusion of water across a partially permeable membrane. The concentration gradient drives both processes, and the cell membrane is partially permeable.");
  await note(chem, "Diffusion in gases and liquids", "Diffusion is the net movement of particles from a region of high concentration to a region of low concentration. The rate of diffusion increases with temperature and a steeper concentration gradient. Diffusion is faster in gases than liquids.");
  await note(chem, "Electrochemical cells", "An electrochemical cell converts chemical energy into electrical energy. Oxidation happens at the anode and reduction at the cathode. A salt bridge completes the circuit between the two half cells.");

  const graph = async (sid) => (await call(`/subjects/${sid}/graph`, { token: alice })).data;
  const pairOf = (e) => [String(e.source), String(e.target)].sort().join();
  const cellPairKey = [cellStructure, cellDivision].map(String).sort().join();
  let g = await graph(bio);
  const sameLink = g.edges.find((e) => pairOf(e) === cellPairKey);
  const crossLink = g.crossSubjectEdges[0];
  const rejected = g.rejectedEdges[0];
  if (!sameLink || !crossLink || !rejected) throw new Error("fixture did not produce a same-subject, cross-subject and rejected edge");

  console.log("\n=== Validation and ownership ===");
  check("needs a signed-in user", (await correct(sameLink.id, "remove")).status === 401);
  check("rejects an unknown action", (await correct(sameLink.id, "delete", alice)).status === 400);
  check("unknown link -> 404", (await correct("0".repeat(24), "remove", alice)).status === 404);
  check("another student's link -> 404", (await correct(sameLink.id, "remove", bob)).status === 404);
  check("  ...and it stays linked", (await graph(bio)).edges.some((e) => e.id === sameLink.id));
  check("a pair that was never linked cannot be corrected", (await correct(rejected.id, "remove", alice)).status === 400);

  console.log("\n=== Removing a same-subject link ===");
  const before = await graph(bio);
  const removed = await correct(sameLink.id, "remove", alice);
  check("remove succeeds", removed.status === 200 && removed.data.edge?.removed === true);
  check("removing twice is harmless", (await correct(sameLink.id, "remove", alice)).status === 200);
  g = await graph(bio);
  check("it leaves `edges` (which Home and the subject page count)",
    !g.edges.some((e) => e.id === sameLink.id) && g.edges.length === before.edges.length - 1);
  check("it is listed in removedEdges", g.removedEdges.some((e) => e.id === sameLink.id));
  const clusterOf = (id) => g.nodes.find((n) => String(n.id) === String(id)).clusterId;
  check("its two notes are no longer in one cluster", clusterOf(cellStructure) !== clusterOf(cellDivision));

  await note(bio, "Cells and DNA", "Every cell keeps its DNA in the nucleus, and the cell membrane surrounds the cell. When a cell divides by mitosis the DNA is copied first.");
  g = await graph(bio);
  check("adding a new related note does not bring it back",
    !g.edges.some((e) => e.id === sameLink.id) && g.removedEdges.some((e) => e.id === sameLink.id));

  const restored = await correct(sameLink.id, "restore", alice);
  g = await graph(bio);
  check("restore brings it back", restored.status === 200 && restored.data.edge?.removed === false
    && g.edges.some((e) => e.id === sameLink.id) && !g.removedEdges.some((e) => e.id === sameLink.id));

  console.log("\n=== Removing a cross-subject link ===");
  await correct(crossLink.id, "remove", alice);
  const [gb, gc] = [await graph(bio), await graph(chem)];
  check("it leaves both subjects' crossSubjectEdges",
    !gb.crossSubjectEdges.some((e) => e.id === crossLink.id) && !gc.crossSubjectEdges.some((e) => e.id === crossLink.id));
  check("both subjects list it in removedEdges",
    gb.removedEdges.some((e) => e.id === crossLink.id) && gc.removedEdges.some((e) => e.id === crossLink.id));
  const farEnd = [String(crossLink.source), String(crossLink.target)].find((id) => !gb.nodes.some((n) => String(n.id) === id));
  check("the other subject's note is still described, so it can be named when restoring",
    gb.externalNodes.some((n) => String(n.id) === farEnd));
  await correct(crossLink.id, "restore", alice);
  check("restore brings it back", (await graph(bio)).crossSubjectEdges.some((e) => e.id === crossLink.id));

  console.log("\n=== Keyword map ===");
  const mapOf = (noteId, token) => call(`/graph/notes/${noteId}/keyword-map`, { token });
  check("needs a signed-in user", (await mapOf(cellStructure)).status === 401);
  check("another student's note -> 404", (await mapOf(cellStructure, bob)).status === 404);
  check("unknown note -> 404", (await mapOf("0".repeat(24), alice)).status === 404);
  const m = await mapOf(cellStructure, alice);
  const cellEntry = m.data.keywords?.find((k) => k.keyword === "cell");
  check("returns the note and its keywords", m.status === 200 && m.data.note?.title === "Cell structure" && m.data.keywords.length > 0,
    `${m.data.keywords?.length} keywords`);
  check("each keyword has a weight, related words and sentences",
    m.data.keywords.every((k) => typeof k.weight === "number" && Array.isArray(k.subKeywords) && Array.isArray(k.sentences))
    && cellEntry?.sentences.length > 0);
} catch (err) {
  console.error("FAILED:", err.message);
  failures++;
} finally {
  server.kill();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
