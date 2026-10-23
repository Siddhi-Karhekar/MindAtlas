// Key terms beyond the note's own wording: the part-of-speech tagger
// (posTags.js), terms the student adds or removes, the subject's syllabus
// (keyTermSignals.js) and terms the AI suggests when a note is saved
// (aiKeyTerms.js) - unit checks, then through the API with a stand-in AI
// service. No real AI service is called.
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

delete process.env.GROQ_API_KEY;
process.env.SEMANTIC_MODEL = "off";

const { blocksFromPlainText, normalizeContent } = await import("../src/services/documentStructure.js");
const { computeTfidf } = await import("../src/services/tfidf.js");
const { extractTerms, keyTermDetailsFor, studyFor, clearStudyCache } = await import("../src/services/keyTerms.js");
const { candidateSentences } = await import("../src/services/studyText.js");
const { posAvailable } = await import("../src/services/posTags.js");
const { parseSyllabus, signalsOf, signalsFingerprint, textFingerprint, withSyllabus } = await import("../src/services/keyTermSignals.js");
const { checkTerms } = await import("../src/services/aiKeyTerms.js");
const { notesFingerprint } = await import("../src/services/conceptRecords.js");

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + String(detail).replace(/\s+/g, " ").slice(0, 220) : ""}`);
  if (!cond) failures++;
};
const here = path.dirname(fileURLToPath(import.meta.url));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (list, term) => list.some((t) => String(t.term ?? t).toLowerCase() === term.toLowerCase());
const noteOf = (id, title, text, extra = {}) => ({ _id: id, title, rawText: text, content: normalizeContent(blocksFromPlainText(text), { title }), path: [], ...extra });
const termsOf = (note, corpus = [note]) => extractTerms(note, candidateSentences(note), corpus);

const LINKER = `A linker is a system program that combines object modules produced by the assembler into a single executable program. A loader is a system program that places the executable program into main memory. Address binding maps a logical address to a physical address. Relocation is the process of modifying the addresses in a program so that it can run from a different memory location.

Algorithm for pass 1 of a two-pass linker:
1. Read each object module and note its length.
2. Build the global symbol table with the address of every external symbol.

The relocation register holds the start address of the program, and the base register holds the base address.`;
const CALC = `The derivative of a function measures how fast its value changes. A function is differentiable at a point when its derivative exists at that point. The derivative is the limit of the difference quotient. We solve the equation by setting the derivative equal to zero.`;

console.log("\n=== The part-of-speech tagger ===");
check("the tagger loads (wink-nlp, English model)", posAvailable());
const linker = noteOf("l", "Linkers and Loaders", LINKER);
let terms = termsOf(linker);
check("a compound noun said once is a key term", has(terms, "global symbol table") && has(terms, "relocation register"), terms.map((t) => t.term).join(", "));
const calc = noteOf("c", "Differentiation", CALC);
terms = termsOf(calc);
check("a noun that ends like an adjective is a key term ('derivative')", has(terms, "derivative"), terms.map((t) => t.term).join(", "));
check("a word the note uses as a verb is not ('solve', 'measures')", !has(terms, "solve") && !terms.some((t) => /measure/.test(t.term)), terms.map((t) => t.term).join(", "));
check("a variable or a size is no part of a term said once", !termsOf(noteOf("v", "Keys", "User A sends user B a 128-bit message digest. The primitive root alpha is public. The session key is shared.")).some((t) => /\buser b\b|128|alpha/i.test(t.term)));
const kw = computeTfidf("Paging avoids external fragmentation because any free frame can hold any page. Pages are called frames.").keywords;
check("TF-IDF keywords leave out words used as function words or verbs ('any', 'called')", !kw.includes("any") && !kw.includes("called") && kw.includes("fragmentation"), kw.join(", "));
check("...but the vector, which links are made from, keeps every word", "any" in computeTfidf("Paging avoids any page fault.").vector);
const off = spawnSync(process.execPath, ["-e", `import("./src/services/keyTerms.js").then(async (k) => { const s = await import("./src/services/studyText.js"); const d = await import("./src/services/documentStructure.js"); const t = ${JSON.stringify(LINKER)}; const n = { _id: "x", title: "L", rawText: t, content: d.normalizeContent(d.blocksFromPlainText(t), { title: "L" }), path: [] }; console.log(JSON.stringify(k.extractTerms(n, s.candidateSentences(n), [n]).map((x) => x.term))); })`], { cwd: path.join(here, ".."), env: { ...process.env, KEYTERMS_POS: "off" }, encoding: "utf8" });
const offTerms = JSON.parse(off.stdout || "[]");
check("KEYTERMS_POS=off: the rules work alone, as before (no compound said once)", off.status === 0 && offTerms.length > 0 && !offTerms.some((t) => t.toLowerCase() === "global symbol table"), off.stderr || offTerms.join(", "));

console.log("\n=== The syllabus ===");
const phrases = parseSyllabus("Unit 3: Memory Management - paging, page table, TLB; segmentation.\nUnit 4: Deadlocks (prevention, detection and recovery), banker's algorithm");
check("a syllabus is read as topic phrases, numbering and punctuation taken off", ["Memory Management", "paging", "page table", "TLB", "segmentation", "banker's algorithm"].every((p) => phrases.includes(p)), phrases.join(" | "));
check("...a short phrase with 'and' stays whole ('detection and recovery'), its parts still count inside it", phrases.includes("detection and recovery") && phrases.includes("prevention"), phrases.join(" | "));
const plain = keyTermDetailsFor(linker, [linker]);
const withSyl = keyTermDetailsFor(withSyllabus([linker], { syllabus: "Unit 5: Linkers and loaders - address binding, relocation, two-pass linker design" })[0], [linker]);
check("a term the syllabus names is marked as from the syllabus", withSyl.some((t) => t.term.toLowerCase() === "address binding" && t.sources.includes("syllabus")), withSyl.map((t) => `${t.term}[${t.sources}]`).join(", "));
const rank = (list, term) => list.findIndex((t) => t.term.toLowerCase() === term);
check("...and ranks higher than without it", rank(withSyl, "address binding") >= 0 && (rank(plain, "address binding") < 0 || rank(withSyl, "address binding") < rank(plain, "address binding")), `${rank(plain, "address binding")} -> ${rank(withSyl, "address binding")}`);

console.log("\n=== The student's own key terms ===");
const marked = { ...linker, termMarks: { add: ["memory location"], remove: ["main memory"] } };
const details = keyTermDetailsFor(marked, [marked]);
check("a term the student added is shown first, marked as theirs", details[0]?.term.toLowerCase() === "memory location" && details[0].sources.includes("you"), details.map((t) => `${t.term}[${t.sources}]`).join(", "));
check("a term the student removed is gone everywhere", !has(details, "main memory") && !has(termsOf(marked), "main memory"));
clearStudyCache();
const study = await studyFor(marked, { corpus: [marked] });
check("...and from what test generation uses", has(study.terms, "memory location") && !has(study.terms, "main memory"), study.terms.map((t) => t.term).join(", "));
check("the student's marks change the concept-records fingerprint", notesFingerprint(marked) !== notesFingerprint(linker) && signalsFingerprint(linker) === "");

console.log("\n=== Terms the AI suggests ===");
const aiNote = { ...linker, aiTerms: { version: 1, fingerprint: textFingerprint(LINKER), terms: [{ term: "address binding", importance: 3 }, { term: "external symbol", importance: 1 }] } };
const aiDetails = keyTermDetailsFor(aiNote, [aiNote]);
check("AI terms for the note's current text are marked as from the AI", aiDetails.some((t) => t.term.toLowerCase() === "address binding" && t.sources.includes("ai")), aiDetails.map((t) => `${t.term}[${t.sources}]`).join(", "));
const stale = { ...aiNote, rawText: `${LINKER} An overlay keeps only the needed instructions in memory.` };
check("once the text changes, they stop counting until asked for again", signalsOf(stale).ai.length === 0 && signalsOf(aiNote).ai.length === 2);
const checked = checkTerms(linker, [
  { term: "Global Symbol Table", importance: 3 },
  { term: "quantum entanglement", importance: 3 },
  { term: "system", importance: 2 },
  { term: "EA = base + displacement" },
  { term: "a very long phrase of more than six words here" },
  { term: "global symbol table", importance: 1 },
  "relocation register",
  { term: 42 },
]);
check("a suggested term is kept only when the note contains it word for word", has(checked.kept, "Global Symbol Table") && !has(checked.kept, "quantum entanglement"), JSON.stringify(checked));
check("...and not a single generic word, a formula, a long phrase or a repeat", checked.kept.length === 2 && checked.dropped === 6, JSON.stringify(checked));
check("...with an importance of 1-3 (2 when none is given)", checked.kept.find((t) => t.term === "relocation register")?.importance === 2);

// ---------------------------------------------------------------------------
console.log("\n=== Key-term fixes (keyTerms.js KEYTERM_FIXES) ===");
{
  const { keytermFixes, DEFAULT_FIXES } = await import("../src/services/keyTerms.js");
  const termsOf = (title, text, env = undefined) => {
    const before = process.env.KEYTERMS_FIXES;
    if (env === undefined) delete process.env.KEYTERMS_FIXES;
    else process.env.KEYTERMS_FIXES = env;
    const n = { _id: `fx-${title}-${env}`, title, rawText: text, content: normalizeContent(blocksFromPlainText(text), { title }), path: [] };
    const explain = new Map();
    const out = extractTerms(n, candidateSentences(n), [], { explain }).map((t) => t.term.toLowerCase());
    if (before === undefined) delete process.env.KEYTERMS_FIXES;
    else process.env.KEYTERMS_FIXES = before;
    return { out, explain };
  };
  check("the default fixes are the ones that helped on the labelled set", DEFAULT_FIXES.join(",") === "common,rare,shapes,formula" && keytermFixes().has("common"));
  const spool = "Spooling is the process of placing jobs in a buffer on disk so that a slow device can read them later. It lets the processor carry on with other work. This keeps the printer busy while the processor is free.";
  const sp = termsOf("Spooling", spool);
  check("an everyday word is no key term without evidence ('processor', 'printer')", !sp.out.includes("processor") && !sp.out.includes("printer") && sp.out.includes("spooling"), sp.out.join(", "));
  check("...and the reason is recorded", sp.explain.get("processor") === "single-word-everyday");
  check("...but every fix can be switched off", termsOf("Spooling", spool, "off").out.includes("processor"));
  const defined = termsOf("Circuits", "Electric current is the rate of flow of electric charge through a conductor. The current in a series circuit is the same at every point. A resistor limits the current that flows in a circuit.");
  check("an everyday word the note defines is a key term ('current')", defined.out.includes("current"), defined.out.join(", "));
  const laws = termsOf("Circuits", "Kirchhoff's current law states that the currents entering a junction add up to the currents leaving it. Ohm's law relates voltage, current and resistance in a conductor.");
  check("a named law is one term ('kirchhoff's current law', 'ohm's law')", laws.out.some((t) => /kirchhoff.s current law/.test(t)) && laws.out.some((t) => /ohm.s law/.test(t)), laws.out.join(", "));
  const deriv = termsOf("Differentiation", "The second derivative of a function measures how fast its slope changes. A stationary point is a minimum when the second derivative there is positive.");
  check("an ordinal opens a term ('second derivative')", deriv.out.includes("second derivative"), deriv.out.join(", "));
  const listed = termsOf("Deadlocks", "A deadlock is a situation in which processes wait forever for resources held by each other. Four conditions must hold for a deadlock: mutual exclusion, hold and wait, no preemption and circular wait.");
  check("the items of a list after a colon are terms ('hold and wait', 'circular wait')", ["hold and wait", "no preemption", "circular wait"].every((t) => listed.out.includes(t)), listed.out.join(", "));
  const ing = termsOf("Distributed systems", "Marshalling packs the arguments of a remote call into a message for the network. The client stub performs marshalling before the message is sent.");
  check("an uncommon -ing noun is a term ('marshalling')", ing.out.includes("marshalling"), ing.out.join(", "));
  const rare = termsOf("Scheduling", "Priority scheduling can cause starvation of low-priority jobs. Round robin scheduling gives each job a fixed time quantum in turn.");
  check("an uncommon noun said once is a term ('starvation')", rare.out.includes("starvation"), rare.out.join(", "));
  const formula = termsOf("Differentiation", "The power rule gives the derivative of $x^{n}$ as $n x^{n-1}$, written \\frac{d}{dx} x^n = n x^{n-1}. The derivative of $\\alpha x$ is the constant alpha.");
  check("formula commands and Greek letter names are no terms ('frac', 'alpha')", !formula.out.includes("frac") && !formula.out.includes("alpha"), formula.out.join(", "));
}

console.log("\n=== YAKE, TextRank and RAKE (keyphraseScores.js) ===");
{
  const { yake, textrank, rake, enabledScorers, keyphraseSignal } = await import("../src/services/keyphraseScores.js");
  const { contentRuns, termKey } = await import("../src/services/keyTerms.js");
  const text = [
    "A translation lookaside buffer is a small cache of page table entries.",
    "The page table maps each page to a frame.",
    "On a miss in the translation lookaside buffer, the page table is read from memory.",
    "Each page table entry holds a frame number.",
  ];
  const runs = text.map((t) => contentRuns(t));
  const keys = ["translation lookaside buffer", "page table", "frame", "memory"];
  const wk = (w) => termKey([w]);
  for (const [name, fn] of [["yake", yake], ["textrank", textrank], ["rake", rake]]) {
    const m = fn(runs, keys, wk);
    check(`${name}: every phrase asked about gets a score from 0 to 1`, keys.every((k) => m.get(k) >= 0 && m.get(k) <= 1), JSON.stringify([...m]));
  }
  check("rake ranks a long recurring term above a single word", rake(runs, keys, wk).get("translation lookaside buffer") > rake(runs, keys, wk).get("memory"));
  check("textrank ranks the central phrase above a word said once", textrank(runs, keys, wk).get("page table") > textrank(runs, keys, wk).get("memory"));
  const before = process.env.KEYTERMS_SCORERS;
  delete process.env.KEYTERMS_SCORERS;
  check("the scorers are off by default (they did not help on the labelled set)", enabledScorers().length === 0);
  process.env.KEYTERMS_SCORERS = "yake, rake, nonsense";
  check("KEYTERMS_SCORERS picks known scorers only", enabledScorers().join(",") === "yake,rake");
  check("with none enabled the signal is empty, so rankings do not change", keyphraseSignal(runs, keys, wk, []).size === 0);
  if (before === undefined) delete process.env.KEYTERMS_SCORERS;
  else process.env.KEYTERMS_SCORERS = before;
}

console.log("\n=== BM25 link weighting (tfidf.js) ===");
{
  const a = "Paging divides memory into frames. Frames hold pages. Frames frames frames.";
  const corpus = ["Segmentation divides a program into segments.", "A deadlock is a wait for resources held by others."];
  const t = computeTfidf(a, corpus).vector;
  const b = computeTfidf(a, corpus, { weighting: "bm25" }).vector;
  check("TF-IDF stays the default weighting", JSON.stringify(t) === JSON.stringify(computeTfidf(a, corpus, { weighting: "tfidf" }).vector));
  check("BM25 gives every word a positive weight", Object.values(b).every((x) => x > 0), JSON.stringify(b));
  // saturation: five uses of "frames" against one of "memory"
  check("BM25 saturates repetition more than TF-IDF does", b.frames / b.memory < t.frames / t.memory, `${(b.frames / b.memory).toFixed(2)} vs ${(t.frames / t.memory).toFixed(2)}`);
  check("the keywords are the same kind of list either way", computeTfidf(a, corpus, { weighting: "bm25" }).keywords.length > 0);
}

console.log("\n=== Through the API, with a stand-in AI service ===");
const requests = [];
let failNext = false;
const fake = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    const system = parsed.messages?.find((m) => m.role === "system")?.content || "";
    const user = parsed.messages?.find((m) => m.role === "user")?.content || "";
    requests.push({ system, user });
    if (failNext) {
      res.writeHead(503, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { type: "server_error" } }));
    }
    const ids = [...user.matchAll(/<section id="(s\d+)"/g)].map((m) => m[1]);
    const reply = { sections: ids.map((id) => ({ id, terms: [{ term: "translation lookaside buffer", importance: 3 }, { term: "segment table", importance: 2 }, { term: "quantum entanglement", importance: 3 }] })) };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
  });
});
await new Promise((r) => fake.listen(4641, r));

const PORT = 4643;
const API = `http://localhost:${PORT}/api`;
const server = spawn(process.execPath, ["src/index.js"], {
  cwd: path.join(here, ".."),
  env: { ...process.env, PORT: String(PORT), MONGODB_URI: "", DB_FILE: "memory", GROQ_API_KEY: "test-key", LLM_API_URL: "http://localhost:4641/v1/chat/completions", LLM_TIMEOUT_MS: "3000", NODE_ENV: "development", RATE_LIMIT_AUTH_MAX: "500" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
try {
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(`${API}/health`)).ok) break;
    } catch {
      await wait(100);
    }
  }
  const as = (token) => async (p, { method = "GET", body } = {}) => {
    const r = await fetch(API + p, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  const signup = async (email) => (await (await fetch(`${API}/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "river-Kettle-42x" }) })).json()).token;
  const call = as(await signup(`keyterms${Date.now()}@example.com`));
  const stranger = as(await signup(`stranger${Date.now()}@example.com`));
  const { subject } = await call("/subjects", { method: "POST", body: { name: "Operating systems" } });
  const NOTE = `# Memory management

## Paging

Paging divides physical memory into fixed-size blocks called frames and logical memory into pages of the same size. The page table maps each page of a process to a frame. A translation lookaside buffer is a small fast cache that stores recent page table entries, so most address translations do not need a memory access. A page fault occurs when a process uses a page that is not in memory. The operating system then loads the missing page from the disk into a free frame and restarts the instruction that caused the fault. Paging avoids external fragmentation because any free frame can hold any page, but the last page of a process may waste part of its frame.

## Segmentation

Segmentation divides a program into variable-sized logical units called segments, such as code, data and stack. Each segment has a base address and a limit, kept in the segment table. A segmentation fault occurs when a process accesses memory outside its segment limit. Segmentation suffers from external fragmentation because segments vary in size. Paging and segmentation can be combined, so that each segment is divided into pages and every segment has its own page table.`;
  const before = requests.length;
  const made = await call(`/subjects/${subject._id}/notes`, { method: "POST", body: { title: "Memory management", content: NOTE } });
  check("a note is saved without waiting for the AI", made.status === 201 && made.children?.length === 2, made.error || `${made.status} children=${made.children?.length}`);
  if (!made.children?.length) throw new Error("the note was not split into subtopics");
  // the suggestion runs after the response; wait for it to land
  let paging = null;
  for (let i = 0; i < 60; i++) {
    paging = (await call(`/notes/${made.children[0]._id}`)).note;
    if (paging?.keyTermDetails?.some((t) => t.sources.includes("ai"))) break;
    await wait(100);
  }
  check("one request asked about both subtopics", requests.length - before === 1 && (requests[before]?.user.match(/<section id=/g) || []).length === 2, `${requests.length - before} requests`);
  check("...with the rules in the system message and the notes as tagged data", /You pick the key terms/.test(requests[before]?.system || "") && /<sections>/.test(requests[before]?.user || ""));
  const pagingTerms = paging?.keyTermDetails || [];
  check("an AI term the note contains is a key term, marked as from the AI", pagingTerms.some((t) => /translation lookaside buffer/i.test(t.term) && t.sources.includes("ai")), pagingTerms.map((t) => `${t.term}[${t.sources}]`).join(", "));
  check("...one the note does not contain is not ('quantum entanglement', 'segment table' in Paging)", !has(pagingTerms, "quantum entanglement") && !has(pagingTerms, "segment table"));
  check("the AI's raw terms are not sent to the client", paging && !("aiTerms" in paging) && !("syllabus" in paging));
  const seg = (await call(`/notes/${made.children[1]._id}`)).note;
  check("...and each subtopic keeps only its own", has(seg.keyTermDetails, "segment table") && !has(seg.keyTermDetails, "translation lookaside buffer"), seg.keyTermDetails.map((t) => t.term).join(", "));

  // the student's own key terms
  const bad = await call(`/notes/${made.children[0]._id}/key-terms`, { method: "PUT", body: { add: ["quantum computing"] } });
  check("a key term that is not in the note is refused, saying which", bad.status === 400 && bad.code === "not_in_note" && bad.missing?.[0] === "quantum computing", JSON.stringify(bad));
  const tooMany = await call(`/notes/${made.children[0]._id}/key-terms`, { method: "PUT", body: { add: Array.from({ length: 31 }, (_, i) => `t${i}`) } });
  check("at most 30 terms at once", tooMany.status === 400);
  const both = await call(`/notes/${made.children[0]._id}/key-terms`, { method: "PUT", body: { add: ["page fault"], remove: ["Page fault"] } });
  check("a term cannot be added and removed at once", both.status === 400);
  const set = await call(`/notes/${made.children[0]._id}/key-terms`, { method: "PUT", body: { add: ["page fault"], remove: ["frame"] } });
  check("the student's terms are saved", set.status === 200 && set.note?.keyTermMarks?.add?.[0] === "page fault", JSON.stringify(set).slice(0, 200));
  check("...the added term is shown first, as theirs", set.note?.keyTerms?.[0]?.toLowerCase() === "page fault" && set.note.keyTermDetails[0].sources.includes("you"), (set.note?.keyTerms || []).join(", "));
  check("...the removed one is gone", !has(set.note?.keyTerms || [], "frame"));
  const concepts = await call(`/notes/${made.children[0]._id}/concepts`);
  check("...and the concept records test generation uses have them", concepts.records?.some((r) => r.key === "page fault") && !concepts.records?.some((r) => r.key === "frame"), (concepts.records || []).map((r) => r.key).join(", "));
  const theirs = await stranger(`/notes/${made.children[0]._id}/key-terms`, { method: "PUT", body: { add: ["page fault"] } });
  check("another student cannot change them", theirs.status === 404);
  const parentPut = await call(`/notes/${made.note._id}/key-terms`, { method: "PUT", body: { add: ["paging"] } });
  check("a split document's key terms are set on its subtopics", parentPut.status === 400);
  const cleared = await call(`/notes/${made.children[0]._id}/key-terms`, { method: "PUT", body: { add: [], remove: [] } });
  check("an empty list clears them", cleared.status === 200 && cleared.note.keyTermMarks.add.length === 0 && cleared.note.keyTermMarks.remove.length === 0 && !cleared.note.keyTermDetails.some((t) => t.sources.includes("you")), (cleared.note?.keyTerms || []).join(", "));

  // the syllabus
  const syl = await call(`/subjects/${subject._id}`, { method: "PATCH", body: { syllabus: "Unit 3: Memory management - paging, page fault, segmentation, external fragmentation." } });
  check("a subject's syllabus is saved", syl.status === 200 && /page fault/.test(syl.subject?.syllabus || ""));
  const listed = await call(`/subjects/${subject._id}/notes`);
  const segListed = listed.notes.find((n) => String(n._id) === String(made.children[1]._id));
  check("terms the syllabus names are marked as from the syllabus", segListed?.keyTermDetails?.some((t) => /external fragmentation/i.test(t.term) && t.sources.includes("syllabus")), (segListed?.keyTermDetails || []).map((t) => `${t.term}[${t.sources}]`).join(", "));
  const tooLong = await call(`/subjects/${subject._id}`, { method: "PATCH", body: { syllabus: "x".repeat(20_001) } });
  check("a syllabus over 20,000 characters is refused", tooLong.status === 400);
  const graphPage = await call(`/subjects/${subject._id}/graph`);
  const nodeWithTerms = (graphPage.nodes || []).find((n) => n.parentNoteId && n.keyTerms?.length);
  check("the graph page gets each topic's key terms, as the reading pane shows them", Boolean(nodeWithTerms) && nodeWithTerms.keyTerms.some((t) => t.includes(" ")), JSON.stringify(nodeWithTerms?.keyTerms));
  check("...and keeps the single-word keywords for clusters and the keyword map", (graphPage.nodes || []).every((n) => Array.isArray(n.keywords)));
  const noSyl = await call(`/subjects/${subject._id}`, { method: "PATCH", body: { syllabus: "" } });
  check("an empty syllabus clears it", noSyl.status === 200 && noSyl.subject.syllabus === null);

  // an edit asks again; an AI failure never fails a save
  const asked = requests.length;
  const edited = await call(`/notes/${made.children[1]._id}`, { method: "PATCH", body: { content: `${segListed.rawText}\n\nThe segment table is held in memory.` } });
  for (let i = 0; i < 40 && requests.length === asked; i++) await wait(100);
  check("editing a note's text asks the AI again", edited.status === 200 && requests.length === asked + 1);
  failNext = true;
  const second = await call(`/subjects/${subject._id}/notes`, { method: "POST", body: { title: "TLB", content: "A translation lookaside buffer caches page table entries. A TLB miss costs a memory access to the page table." } });
  for (let i = 0; i < 40 && !/\[keyterms\] ai: .*failed=/.test(log); i++) await wait(100);
  const secondNote = (await call(`/notes/${second.note._id}`)).note;
  check("when the AI fails, the note is saved and the rules give its key terms", second.status === 201 && secondNote.keyTerms.length > 0 && !secondNote.keyTermDetails.some((t) => t.sources.includes("ai")), secondNote.keyTerms.join(", "));
  check("...and the log says so, without note text", /\[keyterms\] ai: notes=1 .*failed=server-error/.test(log) && !/translation lookaside/i.test(log.split("\n").filter((l) => l.includes("[keyterms]")).join("\n")));
} finally {
  server.kill("SIGTERM");
  fake.close();
}

console.log(failures ? `\n${failures} FAILING CHECK(S)` : "\nAll key-term signal checks passed.");
process.exit(failures ? 1 : 0);
