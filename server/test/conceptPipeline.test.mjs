// The note-to-test pipeline through CONCEPT RECORDS: the machine-readable
// side of a note (conceptRecords.js), the plan built from them
// (conceptSelection.js), and both writers - the rules and a stand-in Groq -
// following that plan; then the records kept with each note through the API.
// No real AI service is called.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

delete process.env.GROQ_API_KEY;
process.env.SEMANTIC_MODEL = "off";

const { blocksFromPlainText, normalizeContent } = await import("../src/services/documentStructure.js");
const { computeTfidf } = await import("../src/services/tfidf.js");
const { studyFor, clearStudyCache } = await import("../src/services/keyTerms.js");
const { quotableText } = await import("../src/services/studyText.js");
const te = await import("../src/services/testEngine.js");
const { CONCEPTS_VERSION, extractionConfidence, termConceptId } = await import("../src/services/conceptRecords.js");
const { selectConcepts } = await import("../src/services/conceptSelection.js");
const { notesFromFile } = await import("../evaluation/lib/ingest.js");

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + String(detail).replace(/\s+/g, " ").slice(0, 220) : ""}`);
  if (!cond) failures++;
};
const here = path.dirname(fileURLToPath(import.meta.url));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const noteOf = (id, title, text, extra = {}) => ({ _id: id, title, rawText: text, content: normalizeContent(blocksFromPlainText(text), { title }), keywords: computeTfidf(text, []).keywords, path: [], ...extra });

async function recordsOf(notes) {
  clearStudyCache();
  const studies = new Map();
  for (const n of notes) studies.set(n, await studyFor(n, { corpus: notes }));
  te.qualityContext(notes, studies);
  return new Map(notes.map((n) => [n, te.conceptsOfNote(n, studies.get(n), studies.relations)]));
}

// ---------------------------------------------------------------------------
console.log("\n=== A. Concept records: what each concept is, can be asked as, matters ===");
const bench = await notesFromFile(path.join(here, "..", "evaluation", "benchmark", "notes.md"));
const spos = await notesFromFile(path.join(here, "fixtures", "subjects", "spos_linker_loader.txt"));
const built = await recordsOf(bench.notes);
const all = [...built.values()].flatMap((b) => b.records);
const byTitle = (t) => all.find((r) => r.title.toLowerCase() === t.toLowerCase());
check("every record has a stable id, a label, importance, difficulty and its passages", all.length > 10 && all.every((r) => /^c-[0-9a-f]{10}$/.test(r.id) && r.suitability.label && typeof r.importance.score === "number" && r.difficulty.level && r.source.passages.length));
const again = await recordsOf(bench.notes);
check("  ...the same ids when built again", JSON.stringify([...again.values()].flatMap((b) => b.records.map((r) => r.id))) === JSON.stringify(all.map((r) => r.id)));
const quoted = bench.notes.map((n) => quotableText(n).replace(/\s+/g, " ")).join("\n");
check("every passage is in the notes word for word (provenance)", all.every((r) => r.source.passages.every((p) => quoted.includes(p.replace(/\s+/g, " ")))));
check("a defined concept is a definition, MCQ and theory both", byTitle("deadlock")?.type === "definition" && byTitle("deadlock")?.suitability.label === "both", JSON.stringify(byTitle("deadlock")?.suitability));
check("the ACID properties are recorded as siblings", byTitle("isolation")?.relations.siblings.length === 3);
check("a family the notes name is a parent (SHA-256 in the SHA-2 family)", byTitle("SHA-256")?.relations.parents.length >= 1);
check("an acronym the notes spell out is one concept with its expansion", !byTitle("LAN") && Boolean(byTitle("local area network")));
const ohm = all.find((r) => r.kind === "formula" && /V = I/.test(r.title));
check("a formula is its own record: theory, and MCQ only as a computed numerical", ohm && ohm.suitability.label === "both" && ohm.suitability.reasons.includes("numerical-only-mcq"), JSON.stringify(ohm?.suitability));
const sposBuilt = await recordsOf(spos.notes);
const sposAll = [...sposBuilt.values()].flatMap((b) => b.records);
check("the steps of an algorithm are a process record, theory only", sposAll.some((r) => r.kind === "process" && r.suitability.label === "theory" && r.steps?.length >= 3), sposAll.filter((r) => r.kind !== "term").map((r) => `${r.kind}:${r.title}`).join(" | "));
check("a comparison table is a comparison record with its rows", sposAll.some((r) => r.kind === "comparison" && r.rows?.length >= 3));
const excluded = [...built.values()].flatMap((b) => b.excluded);
check("words merely repeated, or with nothing to ask, are excluded with the reason", excluded.length > 0 && excluded.every((r) => r.exclusion));

const noisy = noteOf("ocr", "Scanned page", "Tbe rnernory rnanagernent unit rnaps vlrtual addresses to pbysical frarnes. A pagc tablc stores thc mapping for cach proccss. Thc TLB cachcs rcccnt translations for spccd.", { sourceType: "image", ocrConfidence: 0.42 });
const noisyBuilt = (await recordsOf([noisy])).get(noisy);
check("a misread photo is detected: low reading confidence", noisyBuilt.extraction.confidence < 0.5, JSON.stringify(noisyBuilt.extraction));
check("  ...and none of it may be asked", noisyBuilt.records.length === 0 && noisyBuilt.excluded.every((r) => r.suitability.label === "unsuitable"));
check("a clean typed note reads with full confidence", extractionConfidence(bench.notes[0]).confidence === 1);
// (the term in the leaning sentences is "CPU": an everyday word such as
// "processor" is not a key term unless the note defines or marks it - keyTerms.js, "common")
const leaning = noteOf("ctx", "Spooling", "Spooling is the process of placing jobs in a buffer on disk so that a slow device can read them later. It lets the CPU carry on with other work. This keeps the printer busy while the CPU is free. It also allows several jobs to queue for one printer at a time.");
const leanRec = [...(await recordsOf([leaning])).get(leaning).records];
check("a record knows which of its sentences lean on the one before", leanRec.some((r) => r.statements.some((s) => s.leansOnContext)));

const compact = te.compactConcepts(built.get(bench.notes[2]));
const round = te.expandConcepts(compact);
check("stored records (each passage once) expand back to the same records", JSON.stringify(round.records) === JSON.stringify(built.get(bench.notes[2]).records) && compact.passages.length > 0);
check("  ...and say which rules built them", compact.version === CONCEPTS_VERSION && /^[0-9a-f]{16}$/.test(compact.fingerprint));

// ---------------------------------------------------------------------------
console.log("\n=== B. Selection: the plan follows the records ===");
const plan = selectConcepts(new Map([...built].map(([n, b]) => [n, b.records])));
const planned = (type) => [...plan[type].values()].flat().map((e) => e.record);
check("MCQs are planned only from concepts the records allow as MCQs", planned("mcq").every((r) => r.suitability.mcq));
check("  ...theory only from concepts allowed as theory", planned("theory").every((r) => r.suitability.theory));
check("a structure (steps, a comparison) is never planned as an MCQ", !planned("mcq").some((r) => ["process", "comparison", "list"].includes(r.kind)));
const isolation = byTitle("isolation");
const fresh = selectConcepts(new Map([[bench.notes[3], [isolation, byTitle("atomicity")]]]));
const seen = selectConcepts(new Map([[bench.notes[3], [isolation, byTitle("atomicity")]]]), { history: new Map([[isolation.id, { count: 1, recent: true, approaches: new Set(["describe"]) }]]) });
const firstOf = (p) => p.mcq.get(bench.notes[3])[0].record.title;
check("a concept tested in the last test drops behind one never tested", firstOf(fresh) !== firstOf(seen) || firstOf(seen) === "atomicity", `${firstOf(fresh)} -> ${firstOf(seen)}`);
check("the plan reports what it considered and left out", plan.stats.considered === all.length && typeof plan.stats.eligible.mcq === "number");

// ---------------------------------------------------------------------------
console.log("\n=== C. The rule-based writer consumes the plan ===");
clearStudyCache();
const gen = await te.generateQuestions(bench.notes, { mcqCount: 10, theoryCount: 5, marksPerQuestion: 1 });
const recById = new Map([...built.values()].flatMap((b) => [...b.records, ...b.excluded]).map((r) => [r.id, r]));
check("every accepted question names the concept it tests", gen.accepted.every((q) => recById.has(q.conceptId)), gen.accepted.filter((q) => !recById.has(q.conceptId)).map((q) => q.prompt.slice(0, 40)).join(" | "));
check("  ...every MCQ's concept allows MCQs; every theory question's allows theory", gen.accepted.every((q) => (q.type === "mcq" ? recById.get(q.conceptId).suitability.mcq : recById.get(q.conceptId).suitability.theory)));
check("every question carries an explanation from the notes and its approach", gen.accepted.every((q) => q.explanation && q.approach));
check("the build reports the plan per type", gen.generation.mcq.concepts.considered > 0 && gen.generation.mcq.concepts.used > 0 && gen.generation.theory.concepts.used > 0, JSON.stringify(gen.generation.mcq.concepts));
const unread = noteOf("bad", "Scanned", noisy.rawText + " " + noisy.rawText, { sourceType: "image", ocrConfidence: 0.3 });
clearStudyCache();
const none = await te.generateQuestions([unread], { mcqCount: 4, theoryCount: 2, marksPerQuestion: 1 });
check("records that say the text was misread mean no questions (not guesses)", none.accepted.length === 0);
// the same chapter again, told how it was asked: concepts that come back come a new way
clearStudyCache();
const firstTest = gen.accepted.filter((q) => q.type === "mcq");
const approachHistory = new Map();
for (const q of firstTest) approachHistory.set(q.concept, new Set([q.approach]));
const conceptHistory = new Map(firstTest.map((q) => [q.concept, { count: 1, last: 0 }]));
const second = await te.generateQuestions(bench.notes, { mcqCount: 10, theoryCount: 0, marksPerQuestion: 1, avoid: firstTest.map((q) => q.prompt), conceptHistory, recentConcepts: new Set(conceptHistory.keys()), approachHistory });
const backSameWay = second.accepted.filter((q) => approachHistory.get(q.concept)?.has(q.approach));
const back = second.accepted.filter((q) => approachHistory.has(q.concept));
check("a concept asked again in the next test is mostly asked a different way", back.length === 0 || backSameWay.length < back.length, `${backSameWay.length} of ${back.length} the same way`);

// legacy notes: saved before content or records existed
const legacyText = "Paging is a memory management scheme that permits the physical address space of a process to be noncontiguous. Physical memory is broken into fixed sized blocks called frames and logical memory into blocks of the same size called pages. The page table maps each page of a process to a frame in physical memory. A translation lookaside buffer is a small fast cache that stores recent page table entries. Segmentation divides a program into variable-sized logical units called segments. A segmentation fault occurs when a process accesses memory outside its segment limit.";
const legacy = { _id: "old", title: "Memory management", rawText: legacyText, keywords: computeTfidf(legacyText, []).keywords, path: [] };
clearStudyCache();
const old = await te.generateQuestions([legacy], { mcqCount: 2, theoryCount: 1, marksPerQuestion: 1 });
check("a note saved before content and records existed still gives questions", old.accepted.length >= 2 && old.accepted.every((q) => q.conceptId), old.accepted.map((q) => q.prompt.slice(0, 40)).join(" | "));
const stored = [];
clearStudyCache();
await te.generateQuestions([legacy], { mcqCount: 1, theoryCount: 0, marksPerQuestion: 1, onConcepts: (n, c) => stored.push([n._id, c]) });
check("  ...and its records are handed back to be stored (migration on use)", stored.length === 1 && stored[0][1].records.length > 0 && stored[0][1].version === CONCEPTS_VERSION);

// ---------------------------------------------------------------------------
console.log("\n=== D. Groq writes from the plan, and its concept references are checked ===");
const hashRec = byTitle("hash function");
const steps = sposAll.find((r) => r.kind === "process");
let mode = "ok";
const bodies = [];
const fake = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    bodies.push(body);
    const sys = JSON.parse(body).messages[0]?.content || "";
    let content = "[]";
    if (/independent examiner/.test(sys)) content = "[]";
    else if (/multiple-choice questions/.test(sys)) {
      content =
        mode === "malformed"
          ? JSON.stringify([{ prompt: "Which of the following maps a message of any length to a fixed-length digest?", options: ["hash function"], conceptId: hashRec.id }])
          : JSON.stringify([
              { conceptId: hashRec.id, concept: "hash function", prompt: "Which of the following maps a message of any length to a fixed-length message digest?", options: ["hash function", "digital signature", "private key", "session key"], correctAnswer: "hash function", supportingExcerpt: "A hash function maps a message of any length to a fixed-length message digest.", explanation: "A hash function maps a message of any length to a fixed-length message digest.", difficulty: "easy" },
              { conceptId: "c-0000000000", concept: "made up", prompt: "Which protocol provides connectionless, best-effort delivery of datagrams?", options: ["UDP", "TCP", "SCTP", "ARP"], correctAnswer: "UDP", supportingExcerpt: "UDP provides connectionless, best-effort delivery of datagrams.", difficulty: "easy" },
              { conceptId: termConceptId("transport layer"), concept: "transport layer", prompt: "Which layer uses port numbers to deliver data to the correct application on a host?", options: ["transport layer", "network layer", "data link layer", "physical layer"], correctAnswer: "transport layer", supportingExcerpt: "The transport layer uses port numbers to deliver data to the correct application on a host.", explanation: "Quantum tunnelling explains it according to Feynman.", difficulty: "easy" },
              { concept: "durability", prompt: "A database confirms a committed transfer, then loses power; after the restart the transfer is still there. Which ACID property does this show?", options: ["durability", "atomicity", "isolation", "consistency"], correctAnswer: "durability", supportingExcerpt: "Durability: after a transaction commits, its changes persist even if the system fails.", difficulty: "medium" },
            ]);
    } else if (/theory \(short-answer\)/.test(sys)) {
      content = JSON.stringify([
        { conceptId: hashRec.id, prompt: "Define the term “hash function”.", modelAnswer: "A hash function maps a message of any length to a fixed-length message digest.", keyPoints: ["any length", "fixed-length message digest"], supportingExcerpt: "A hash function maps a message of any length to a fixed-length message digest.", difficulty: "easy" },
        { conceptId: hashRec.id, prompt: "Explain how a hash function resists quantum attacks.", modelAnswer: "Grover's algorithm halves the effective security of a hash, so longer digests resist quantum computers.", keyPoints: ["Grover's algorithm", "quantum computers"], supportingExcerpt: "A hash function maps a message of any length to a fixed-length message digest.", difficulty: "hard" },
      ]);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});
await new Promise((r) => fake.listen(4611, r));
process.env.GROQ_API_KEY = "test-key";
process.env.LLM_API_URL = "http://localhost:4611/v1/chat/completions";
process.env.LLM_TIMEOUT_MS = "3000";
try {
  clearStudyCache();
  const r = await te.generateQuestions(bench.notes, { mcqCount: 6, theoryCount: 3, marksPerQuestion: 1 });
  const find = (re) => [...r.accepted, ...r.discarded].find((q) => q.generatedBy === "llm" && re.test(q.prompt));
  const mcqAsk = bodies.find((b) => /multiple-choice questions/.test(b)) || "";
  check("the AI is sent concepts with their ids and labels, not loose text", /⟦concept c-[0-9a-f]{10} \| [^|]+ \| \w+/.test(mcqAsk) && mcqAsk.includes(hashRec.id));
  check("  ...for MCQs never a concept the records keep for theory (the steps, a table)", !/⟦concept [^⟧]*theory only/.test(mcqAsk));
  check("an AI question with a valid concept id is accepted with that id", find(/fixed-length message digest\?/)?.status === "accepted" && find(/fixed-length message digest\?/)?.conceptId === hashRec.id);
  check("an AI question citing a concept that does not exist is refused", find(/connectionless, best-effort/)?.discardReason === "concept:invalid-reference");
  check("an AI question with no concept id is matched to one by its quote", find(/committed transfer/)?.conceptId === byTitle("durability")?.id, find(/committed transfer/)?.discardReason);
  check("an explanation that adds facts not in the notes is replaced by the notes' own", /notes say/.test(find(/port numbers/)?.explanation || "") && find(/port numbers/)?.quality?.problems.some((p) => p.code === "explanation:unsupported-replaced"), find(/port numbers/)?.explanation);
  check("a theory answer from outside the notes is refused", /theory:(answer|key-point)-unsupported/.test(find(/quantum attacks/)?.discardReason || ""), find(/quantum attacks/)?.discardReason);
  check("  ...one from the concept's own sentences is accepted", find(/Define the term “hash function”/)?.status === "accepted");
  // an MCQ on a theory-only concept, by id
  const rr = te.gateDraft(
    { conceptId: steps.id, prompt: "Which of the following is the first step of pass 1 of a two-pass linker?", options: ["Read each object module and note its length", "Assign a start address", "Build the symbol table", "Relocate the code"], correctAnswer: "Read each object module and note its length", supportingExcerpt: "Read each object module and note its length.", difficulty: "easy" },
    { type: "mcq", notes: spos.notes, contextText: spos.notes.map(quotableText).join("\n"), generatedBy: "llm", records: new Map(sposAll.map((x) => [x.id, x])), eligible: new Set(sposAll.filter((x) => x.suitability.mcq).map((x) => x.id)) }
  );
  check("an AI MCQ on a concept the records keep for theory is refused, by its id", /^concept:not-eligible-for-mcq|^suitability:step/.test(rr.discarded?.discardReason || ""), rr.discarded?.discardReason);
  mode = "malformed";
  clearStudyCache();
  const bad = await te.generateQuestions(bench.notes, { mcqCount: 4, theoryCount: 0, marksPerQuestion: 1 });
  check("malformed AI output (missing options, no answer) never reaches a test: the rules fill it from the same plan", bad.accepted.length >= 3 && bad.accepted.every((q) => q.generatedBy !== "llm" && q.conceptId), `${bad.accepted.length} ${bad.generation.mcq.status}`);
} finally {
  fake.close();
  delete process.env.GROQ_API_KEY;
  delete process.env.LLM_API_URL;
  delete process.env.LLM_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
console.log("\n=== E. Through the server: records kept with the note ===");
const PORT = 4613;
const API = `http://localhost:${PORT}/api`;
const server = spawn(process.execPath, ["src/index.js"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, PORT: String(PORT), MONGODB_URI: "", DB_FILE: "memory", GROQ_API_KEY: "", NODE_ENV: "development" },
  stdio: "ignore",
});
try {
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(`${API}/health`)).ok) break;
    } catch {
      await wait(200);
    }
  }
  let cookie = "";
  const call = async (p, { method = "GET", body } = {}) => {
    const r = await fetch(API + p, { method, headers: { "Content-Type": "application/json", Cookie: cookie, Origin: "http://localhost:5173" }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  await call("/auth/register", { method: "POST", body: { email: `concepts${Date.now()}@example.com`, password: "river-Kettle-42x" } });
  const { subject } = await call("/subjects", { method: "POST", body: { name: "Security" } });
  const text = fs.readFileSync(path.join(here, "..", "evaluation", "benchmark", "notes.md"), "utf8");
  const made = await call(`/subjects/${subject._id}/notes`, { method: "POST", body: { title: "Benchmark notes", content: text } });
  const child = made.children?.[0] || made.note;
  check("a saved note does not send its records with the note list", made.status === 201 && !("concepts" in child));
  const got = await call(`/notes/${child._id}/concepts`);
  check("GET /notes/:id/concepts gives the records built when it was saved", got.status === 200 && got.records?.length > 0 && got.version === CONCEPTS_VERSION, got.error);
  const edited = await call(`/notes/${child._id}`, { method: "PATCH", body: { content: "A deadlock is a situation in which every process in a set is waiting for an event that can be caused only by another process in the set. Deadlock prevention ensures that at least one of the necessary conditions cannot hold." } });
  const after = await call(`/notes/${child._id}/concepts`);
  check("editing the note rebuilds its records from the new text", edited.status === 200 && after.fingerprint !== got.fingerprint && after.records.some((r) => r.title === "deadlock"));
  const other = await call(`/notes/${child._id}/concepts`, { method: "GET" });
  check("the records are the same until the text changes", other.fingerprint === after.fingerprint);
  const test = await call(`/subjects/${subject._id}/tests`, { method: "POST", body: { title: "Concepts", noteIds: (made.children || [made.note]).map((c) => c._id), mcqCount: 4, theoryCount: 1, marksPerQuestion: 1 } });
  check("a test built through the API reports its concept plan", test.status === 201 && test.generation?.mcq?.concepts?.considered > 0, test.error);
} finally {
  server.kill();
}

console.log(failures ? `\n${failures} FAILING CHECK(S)` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
