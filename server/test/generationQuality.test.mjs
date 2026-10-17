// Checks for the October 2026 round of question, provider, upload and
// formatting fixes. Each section names the requirement it guards.
//
//   A. MCQ quality: ambiguous and negative stems, weak options, answer positions
//   B. multi-word key terms blanked whole, matched on word boundaries
//   C. diversity: consecutive tests, concept rotation, near-duplicates
//   D. provider status: Groq ok / rate-limited / quota / bad key / timeout /
//      server error / nonsense / all rejected / mixed - with a stand-in Groq
//   E. the client's wording of those states
//   F. through the real server: a build that makes nothing, upload limits
//   G. key terms shown and highlighted
//   H. notes formatting: one bullet per line, nesting, paragraphs after lists
//
// No real AI service is called: a local HTTP server stands in for Groq.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { notesFromFile } from "../evaluation/lib/ingest.js";
import { isNegativeStem, validateQuestion } from "../src/services/questionQuality.js";
import { balanceAnswerPositions, generateQuestions, pickFresh, sameQuestion, spreadByTopic } from "../src/services/testEngine.js";
import { conceptOf } from "../src/services/questionQuality.js";
import { keyTermsFor, termPattern } from "../src/services/keyTerms.js";
import { blocksFromPlainText, normalizeContent } from "../src/services/documentStructure.js";
import { withContent } from "../src/services/noteView.js";
import { computeTfidf } from "../src/services/tfidf.js";
import { describeGeneration, generationBadge } from "../../client/src/lib/generation.js";
import { layoutContent, markText } from "../../client/src/lib/noteFormat.js";
import { fileProblem } from "../../client/src/lib/uploads.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!cond) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const file = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const noteOf = (title, rawText, id) => ({
  _id: id || title.toLowerCase().replace(/[^a-z]/g, "").padEnd(24, "0").slice(0, 24),
  title,
  rawText,
  keywords: computeTfidf(rawText, []).keywords,
  content: normalizeContent(blocksFromPlainText(rawText)),
});

// keep the server log quiet but inspectable
const logged = [];
const realLog = console.log;
const realErr = console.error;
const realWarn = console.warn;
const capture = () => {
  console.log = (...a) => (/^\s*(PASS|FAIL)|^\n?===/.test(String(a[0])) ? realLog(...a) : logged.push(a.join(" ")));
  console.error = (...a) => logged.push(a.join(" "));
  console.warn = (...a) => logged.push(a.join(" "));
};
const release = () => {
  console.log = realLog;
  console.error = realErr;
  console.warn = realWarn;
};
capture();

// ---------------------------------------------------------------------------
console.log("\n=== A. MCQ quality ===");
const BLOCK = "A block cipher has a fixed block size, uses a secret key, and applies several rounds of substitution and permutation.";
const CONTEXT = `${BLOCK} A stream cipher encrypts one bit or byte at a time. Information technology infrastructure includes hardware, software and networks.`;
const mcq = (over) => ({ options: ["a", "b", "c", "d"], answerKey: "a", difficulty: "medium", ...over });
const ok = (q) => validateQuestion(q, { type: "mcq", contextText: CONTEXT });

let r = ok(mcq({ prompt: 'Fill in the blank: "IT does not contain _____."', options: ["printers", "hardware", "software", "networks"], answerKey: "printers", supportingExcerpt: "Information technology infrastructure includes hardware, software and networks." }));
check('"IT does not contain _____." is rejected', !r.ok, r.reasons.join(","));
r = ok(mcq({ prompt: "Which of the following is not a feature?", options: ["fixed block size", "secret key", "rounds", "one bit at a time"], answerKey: "one bit at a time", supportingExcerpt: BLOCK }));
check('"Which of the following is not a feature?" is rejected for naming no subject', !r.ok && r.reasons.includes("clarity:names-no-subject"), r.reasons.join(","));
r = ok(mcq({ prompt: 'Fill in the blank: "It consists of _____."', options: ["rounds", "keys", "bits", "bytes"], answerKey: "rounds", supportingExcerpt: BLOCK }));
check('"It consists of _____." is rejected', !r.ok && r.reasons.includes("context:refers-back"), r.reasons.join(","));
r = ok(mcq({ prompt: "Which of the following is not a property of a block cipher?", options: ["fixed block size", "secret key", "substitution and permutation", "encrypts one bit at a time"], answerKey: "encrypts one bit at a time", supportingExcerpt: BLOCK }));
check("a negative question is kept when the notes state every wrong option and not the answer", r.ok, r.reasons.join(","));
check("  ...with NOT written in capitals", /\bNOT\b/.test(r.question.prompt), r.question.prompt);
r = ok(mcq({ prompt: "Which of the following is NOT a property of a block cipher?", options: ["fixed block size", "secret key", "substitution and permutation", "rounds"], answerKey: "rounds", supportingExcerpt: BLOCK }));
check("  ...and rejected when the 'odd one out' is in the notes too (two answers)", !r.ok && r.reasons.includes("mcq:negative-not-verifiable"), r.reasons.join(","));
check("a stem that asks something negative only by chance is not treated as a NOT question", !isNegativeStem("What happens when a frame cannot be delivered?") && isNegativeStem("All of the following are block ciphers EXCEPT:"));
r = ok(mcq({ prompt: 'Fill in the blank: "A switch does not repeat frames; it forwards them by _____ address."', options: ["MAC", "IP", "port", "socket"], answerKey: "MAC", supportingExcerpt: "A switch does not repeat frames; it forwards them by MAC address." }));
check("a negation in another clause does not reject a blank", !r.reasons.includes("blank:negative-statement"), r.reasons.join(","));
r = ok(mcq({ prompt: "Which cipher encrypts one bit or byte at a time?", options: ["stream cipher", "block cipher", "system", "the"], answerKey: "stream cipher", supportingExcerpt: "A stream cipher encrypts one bit or byte at a time." }));
check("a lone generic or function word as an option is rejected", !r.ok && r.reasons.includes("mcq:weak-option"), r.reasons.join(","));
r = ok(mcq({ prompt: "Which cipher encrypts one bit or byte at a time?", options: ["stream cipher", "block cipher", "Caesar cipher", "public key"], answerKey: "stream cipher", supportingExcerpt: "A stream cipher encrypts one bit or byte at a time." }));
check("a clear direct question with plausible options passes", r.ok, r.reasons.join(","));

const pool = Array.from({ length: 40 }, (_, i) => ({ prompt: `q${i}`, options: ["w", "x", "y", "z"], answerKey: "w" }));
balanceAnswerPositions(pool);
const at = [0, 0, 0, 0];
for (const q of pool) at[q.options.indexOf(q.answerKey)]++;
check("answer positions are spread evenly over A-D across a pool", at.every((n) => n === 10), at.join("/"));
check("  ...and every question still has its answer exactly once", pool.every((q) => q.options.filter((o) => o === q.answerKey).length === 1 && q.options.length === 4));

// ---------------------------------------------------------------------------
console.log("\n=== B. Multi-word terms blanked whole ===");
const DEADLOCK = noteOf(
  "Deadlocks",
  [
    "Deadlock detection is a technique in which the operating system periodically examines the wait-for graph for cycles.",
    "Deadlock prevention is a strategy that ensures at least one of the four necessary conditions can never hold.",
    "Deadlock avoidance is a strategy that grants a resource request only if the system stays in a safe state.",
    "A safe state is a state in which the system can allocate resources to every process in some order without deadlock.",
    "The wait-for graph is a directed graph whose nodes are processes and whose edges show which process waits for which.",
    "The banker's algorithm is a deadlock avoidance algorithm that checks every request against the maximum claims of all processes.",
    "Circular wait is the condition in which each process holds a resource that the next process in a cycle is waiting for.",
    "Mutual exclusion is the condition that at least one resource is held in a non-shareable mode.",
  ].join(" ")
);
// Wrong options are partly chosen at random, which changes which question
// forms get built, so several builds are checked together.
const dl = { accepted: [] };
for (let run = 0; run < 6; run++) dl.accepted.push(...(await generateQuestions([DEADLOCK], { mcqCount: 8, theoryCount: 0, marksPerQuestion: 1 })).accepted);
const multi = dl.accepted.filter((q) => q.type === "mcq" && /_____/.test(q.prompt) && q.answerKey.split(/\s+/).length > 1);
const halves = multi.filter((q) => {
  const words = q.answerKey.toLowerCase().split(/\s+/);
  const p = q.prompt.toLowerCase();
  return words.some((w) => new RegExp(`(?:\\b${w}\\s+_____|_____\\s+${w}\\b)`).test(p));
});
check("fill-in-the-blank questions with multi-word answers are made", multi.length >= 1, [...new Set(dl.accepted.map((q) => q.answerKey))].join(", "));
check("a word too broad to test anything is never a blank's answer ('system', 'data')", !dl.accepted.some((q) => /_____/.test(q.prompt) && /^(?:system|data|information|item)s?$/i.test(q.answerKey)));
check("no blank hides only part of a multi-word term ('Deadlock _____', '_____ detection')", halves.length === 0, halves.map((q) => q.prompt).join(" | "));
check("every blank's answer is a whole key term (one to four words)", dl.accepted.filter((q) => /_____/.test(q.prompt)).every((q) => q.answerKey.split(/\s+/).length <= 4));
check("term matching respects word boundaries: 'net' is not found in 'network'", !termPattern("net", "i").test("a network of hosts") && termPattern("net", "i").test("the .net runtime is a net"));
check("  ...and a plural is the same term ('deadlock detections')", termPattern("deadlock detection", "i").test("several deadlock detections"));

// ---------------------------------------------------------------------------
console.log("\n=== C. Diversity ===");
const unit = await notesFromFile(file("../../sample-notes/networks_unit2.md"));
const chapter = unit.notes.slice(0, 8);
// what routes/tests.js builds from a student's history
function historyOf(tests) {
  const avoid = tests.flat().map((q) => q.prompt);
  const recent = new Set(tests.slice(-2).flat().map((q) => conceptOf(q, q.type)));
  const conceptHistory = new Map();
  tests.forEach((qs, ti) => {
    for (const q of qs) {
      const c = conceptOf(q, q.type);
      const h = conceptHistory.get(c) || { count: 0, last: -1 };
      if (h.last !== ti) h.count++;
      h.last = ti;
      conceptHistory.set(c, h);
    }
  });
  return { avoid, recentConcepts: recent, conceptHistory };
}
const rulesTests = [];
for (let t = 0; t < 4; t++) {
  const out = await generateQuestions(chapter, { mcqCount: 8, theoryCount: 3, marksPerQuestion: 1, mcqTarget: 5, theoryTarget: 2, ...historyOf(rulesTests) });
  rulesTests.push(out.accepted);
}
const repeatsPerTest = rulesTests.map((qs, i) => qs.filter((q) => rulesTests.slice(0, i).flat().some((p) => sameQuestion(p.prompt, q.prompt))).length);
check("rules only: four consecutive tests on one chapter repeat no question", repeatsPerTest.every((n) => n === 0), repeatsPerTest.join(", "));
const conceptsOf = (qs) => new Set(qs.map((q) => conceptOf(q, q.type)));
const overlapNext = rulesTests.slice(1).map((qs, i) => [...conceptsOf(qs)].filter((c) => conceptsOf(rulesTests[i]).has(c)).length);
check("  ...and consecutive tests share at most one concept", overlapNext.every((n) => n <= 1), overlapNext.join(", "));

// a chapter too small for new concepts every time: the least recently tested come back first
const small = noteOf("Framing", "A frame is the unit the data link layer sends. Byte stuffing is a method that adds an escape byte before a flag byte inside the data. Bit stuffing is a method that inserts a zero after five consecutive ones in the data. A flag byte is a special byte that marks where a frame starts and ends.");
const smallTests = [];
for (let t = 0; t < 4; t++) {
  const out = await generateQuestions([small], { mcqCount: 2, theoryCount: 0, marksPerQuestion: 1, mcqTarget: 2, ...historyOf(smallTests) });
  smallTests.push(out.accepted);
}
const sig = (qs) => qs.map((q) => q.prompt).sort().join("|");
check("a small chapter still gives each test a set of questions", smallTests.every((qs) => qs.length >= 1), smallTests.map((qs) => qs.length).join(","));
check("  ...and no two consecutive tests are the same set", smallTests.slice(1).every((qs, i) => sig(qs) !== sig(smallTests[i])), smallTests.map(sig).join("  ##  "));

const item = (prompt, concept, topicId = "t1", generatedBy = "rule-based-fallback") => ({ prompt, concept, topicId, generatedBy });
const hist = new Map([["alpha", { count: 3, last: 2 }], ["beta", { count: 1, last: 0 }], ["gamma", { count: 1, last: 1 }]]);
const picked = pickFresh([item("Define alpha in networks.", "alpha"), item("Define gamma in networks.", "gamma"), item("Define beta in networks.", "beta"), item("Define delta in networks.", "delta")], [], 4, 4, null, { conceptHistory: hist });
check("a concept never tested comes first, then the least often and longest-ago tested", picked.chosen.map((q) => q.concept).join(",") === "delta,beta,gamma,alpha", picked.chosen.map((q) => q.concept).join(","));
const spread = spreadByTopic([item("a1", "a1", "A"), item("a2", "a2", "A"), item("a3", "a3", "A"), item("b1", "b1", "B"), item("c1", "c1", "C")]);
check("questions are spread across topics, each topic keeping its own order", spread.map((q) => q.prompt).join(",") === "a1,b1,c1,a2,a3", spread.map((q) => q.prompt).join(","));
check("near-duplicates are caught: reworded direct question", sameQuestion("Which of the following carries data as pulses of light?", "What carries data as light pulses?"));
check("  ...re-blanked copy of one sentence", sameQuestion('Fill in the blank: "A _____ forwards packets between networks using a routing table."', 'Fill in the blank: "A router forwards packets between _____ using a routing table."'));
check("  ...case, punctuation and spacing ignored", sameQuestion("Define the term “Paging”.", "define the term  'paging'"));
check("  ...but different questions are not merged", !sameQuestion("What does CIDR stand for?", "What does NAT stand for?") && !sameQuestion("Define the term “paging”.", "Define the term “segmentation”."));

// ---------------------------------------------------------------------------
console.log("\n=== D. Provider status with a stand-in Groq ===");
const topo = "A network topology describes the arrangement of nodes and links in a network.";
const GOOD_MCQ = [{ prompt: "What does a network topology describe?", options: ["the arrangement of nodes and links in a network", "the speed of each link in a network", "the protocols used at each layer", "the cost of cabling a building"], correctAnswer: "the arrangement of nodes and links in a network", supportingExcerpt: topo, difficulty: "easy", concept: "network topology" }];
const BAD_MCQ = [{ prompt: "It connects each device to how many neighbours?", options: ["two", "one", "three", "four"], correctAnswer: "two", supportingExcerpt: topo, difficulty: "easy" }];
let mode = "ok";
let calls = 0;
const fake = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    calls++;
    const json = (status, obj, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(obj));
    };
    if (mode === "rate") return json(429, { error: { type: "tokens", code: "rate_limit_exceeded" } }, { "retry-after": "0" });
    if (mode === "quota") return json(429, { error: { type: "insufficient_quota", code: "insufficient_quota" } });
    if (mode === "auth") return json(401, { error: { type: "invalid_request_error", code: "invalid_api_key" } });
    if (mode === "down") return json(503, { error: { type: "server_error" } });
    if (mode === "slow") {
      await wait(1500);
      return json(200, { choices: [{ message: { content: "[]" } }] });
    }
    if (mode === "nonsense") return json(200, { choices: [{ message: { content: "Sorry, I cannot help with that." } }] });
    const theory = /theory \(short-answer\)/.test(body);
    const content = theory ? "[]" : JSON.stringify(mode === "bad" ? BAD_MCQ : GOOD_MCQ);
    json(200, { choices: [{ message: { content } }] });
  });
});
await new Promise((res) => fake.listen(4591, res));
process.env.GROQ_API_KEY = "gsk_test_SECRET_KEY_123";
process.env.LLM_API_URL = "http://localhost:4591/v1/chat/completions";
process.env.LLM_TIMEOUT_MS = "1000";
const notes6 = unit.notes.slice(0, 6);
try {
  const cases = [
    ["ok", "mixed", null, "the AI's questions are used and the rules fill the pool: 'mixed'"],
    ["rate", "rule-based-fallback", "rate-limited", "429 rate limit: rules, reason rate-limited"],
    ["quota", "rule-based-fallback", "quota", "quota used up: rules, reason quota"],
    ["auth", "rule-based-fallback", "auth", "bad key (401): rules, reason auth"],
    ["down", "rule-based-fallback", "server-error", "provider error (503): rules, reason server-error"],
    ["slow", "rule-based-fallback", "timeout", "no answer in time: rules, reason timeout"],
    ["nonsense", "rule-based-fallback", "invalid-response", "a reply that is not questions: rules, reason invalid-response"],
    ["bad", "rule-based-fallback", "llm-questions-rejected", "every AI question fails the checks: rules, reason llm-questions-rejected"],
  ];
  for (const [m, status, reason, label] of cases) {
    mode = m;
    calls = 0;
    const out = await generateQuestions(notes6, { mcqCount: 4, theoryCount: 0, marksPerQuestion: 1 });
    const g = out.generation.mcq;
    check(label, g.status === status && g.fallbackReason === reason && out.accepted.length > 0, `${g.status} / ${g.fallbackReason} / ${out.accepted.length} questions`);
    if (m === "ok") check("  ...the counts say who wrote what", g.byLlm >= 1 && g.byRules >= 1 && g.byLlm + g.byRules === out.accepted.length && g.provider === "an outside AI service", JSON.stringify(g));
    if (m === "auth") check("  ...a bad key is not retried", calls === 1, `${calls} calls`);
    if (m === "rate") check("  ...a rate limit is retried once", calls === 2, `${calls} calls`);
    if (m !== "ok") check("  ...and the AI is never credited", out.accepted.every((q) => q.generatedBy !== "llm") && out.mcqGeneratedBy === status);
  }
  mode = "ok";
  const onlyTheory = await generateQuestions(notes6, { mcqCount: 0, theoryCount: 2, marksPerQuestion: 1 });
  check("a type not asked for is 'none'", onlyTheory.generation.mcq.status === "none" && onlyTheory.mcqGeneratedBy === "none");
  delete process.env.GROQ_API_KEY;
  const noKey = await generateQuestions(notes6, { mcqCount: 3, theoryCount: 0, marksPerQuestion: 1 });
  check("no key configured: rules, reason not-configured, the AI not tried", noKey.generation.mcq.status === "rule-based-fallback" && noKey.generation.mcq.fallbackReason === "not-configured" && !noKey.generation.mcq.llmAttempted);
  const nothing = await generateQuestions([noteOf("Empty", "Lecture 4. Prepared by the department. Page 1 of 2.")], { mcqCount: 3, theoryCount: 0, marksPerQuestion: 1 });
  check("notes with nothing to ask about: status 'failed'", nothing.generation.mcq.status === "failed" && nothing.accepted.length === 0, nothing.generation.mcq.status);
  const all = logged.join("\n");
  check("the server log records provider, outcome, reason and timing for each build", /\[testgen\] mcq: status=rule-based-fallback provider=\S.* llm=failed fallbackReason=rate-limited .*llmMs=\d+ totalMs=\d+/.test(all));
  check("  ...and never the API key or an Authorization header", !all.includes("SECRET_KEY") && !/Bearer/i.test(all));
} finally {
  fake.close();
  delete process.env.GROQ_API_KEY;
  delete process.env.LLM_API_URL;
  delete process.env.LLM_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
console.log("\n=== E. What the student is told ===");
const say = (generation) => describeGeneration(generation).map((l) => l.text).join(" | ");
check("Groq only", say({ mcq: { status: "llm", provider: "Groq" } }) === "MCQs: written by AI (Groq)");
check("rules, with the plain reason", say({ mcq: { status: "rule-based-fallback", fallbackReason: "rate-limited" } }) === "MCQs: written by MindAtlas's built-in rules — the AI writer's usage limit was reached for now", say({ mcq: { status: "rule-based-fallback", fallbackReason: "rate-limited" } }));
check("mixed, with the counts", /MCQs: 3 written by AI \(Groq\), 5 by MindAtlas's built-in rules/.test(say({ mcq: { status: "mixed", provider: "Groq", byLlm: 3, byRules: 5 } })));
check("failed", /^Theory: could not be made/.test(say({ theory: { status: "failed", fallbackReason: "not-configured" } })));
check("no status code or error text reaches the student", !/\d{3}|error|exception/i.test(say({ mcq: { status: "rule-based-fallback", fallbackReason: "server-error" } })));
check("the list badge: AI / AI + rules / Rules", generationBadge({ mcq: { status: "llm" } }) === "AI" && generationBadge({ mcq: { status: "llm" }, theory: { status: "rule-based-fallback" } }) === "AI + rules" && generationBadge({ mcq: { status: "rule-based-fallback" } }) === "Rules");
check("a result from before this change still reads (legacy fields)", say(undefined) === "" && describeGeneration(null, { mcqGeneratedBy: "llm", theoryGeneratedBy: "none" }).length === 1);

// ---------------------------------------------------------------------------
console.log("\n=== F. Through the server: failed builds, upload limits ===");
{
  const port = 4592;
  const API = `http://localhost:${port}/api`;
  const server = spawn(process.execPath, ["src/index.js"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, PORT: String(port), MONGODB_URI: "", DB_FILE: "memory", NODE_ENV: "development", GROQ_API_KEY: "", UPLOAD_MAX_MB: "1" },
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
    const call = async (path, { method = "GET", body, form } = {}) => {
      const headers = { Cookie: cookie, Origin: "http://localhost:5173", ...(form ? {} : { "Content-Type": "application/json" }) };
      const res = await fetch(API + path, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      return { status: res.status, ...(await res.json().catch(() => ({}))) };
    };
    await call("/auth/register", { method: "POST", body: { email: `gq${Date.now()}@example.com`, password: "river-Kettle-42x" } });
    const config = await call("/auth/config");
    check("the upload limits are published for the client", config.uploads?.maxMb === 1 && config.uploads.maxPdfPages === 400 && config.uploads.types.some((t) => t.extensions.includes(".pdf")), JSON.stringify(config.uploads).slice(0, 120));
    const { subject } = await call("/subjects", { method: "POST", body: { name: "Limits" } });
    const big = new FormData();
    big.append("file", new Blob([Buffer.alloc(2 * 1024 * 1024, 65)], { type: "text/plain" }), "big.txt");
    const tooBig = await call(`/subjects/${subject._id}/notes`, { method: "POST", form: big });
    check("a file over the limit is refused by the server with 413 and the limit", tooBig.status === 413 && tooBig.code === "file_too_large" && /1 MB/.test(tooBig.error), `${tooBig.status} ${tooBig.error}`);
    const fine = new FormData();
    fine.append("file", new Blob(["A frame is the unit the data link layer sends."], { type: "text/plain" }), "small.txt");
    check("  ...and a file under it is accepted", (await call(`/subjects/${subject._id}/notes`, { method: "POST", form: fine })).status === 201);
    const { note } = await call(`/subjects/${subject._id}/notes`, { method: "POST", body: { title: "Cover", content: "Lecture 4\n\nPrepared by the Department\n\nPage 1 of 2" } });
    const before = (await call(`/subjects/${subject._id}/tests`)).tests.length;
    const failed = await call(`/subjects/${subject._id}/tests`, { method: "POST", body: { title: "Nothing", noteIds: [note._id], mcqCount: 3 } });
    check("a build that makes no question answers 422 with the reason", failed.status === 422 && failed.code === "generation_failed" && failed.generation?.mcq?.status === "failed", `${failed.status} ${JSON.stringify(failed.generation)}`);
    check("  ...and leaves no empty test behind", (await call(`/subjects/${subject._id}/tests`)).tests.length === before);
  } finally {
    server.kill();
  }
}
const mb = 1024 * 1024;
check("the browser refuses a file over the limit, saying the size and what to do", /over the 10 MB limit\. Split it/.test(fileProblem({ name: "notes.pdf", size: 12 * mb, type: "application/pdf" })));
check("  ...uses the server's limit when it has it", fileProblem({ name: "notes.pdf", size: 3 * mb, type: "application/pdf" }, { maxMb: 2 }) !== "" && fileProblem({ name: "notes.pdf", size: 3 * mb, type: "application/pdf" }) === "");
check("  ...and explains old Office formats and unsupported types", /Save As \.docx/.test(fileProblem({ name: "a.doc", size: 10, type: "" })) && /Unsupported type/.test(fileProblem({ name: "a.exe", size: 10, type: "" })));

// ---------------------------------------------------------------------------
console.log("\n=== G. Key terms shown and highlighted ===");
const net = await notesFromFile(file("../../sample-notes/networks_unit2.md"));
const whole = { _id: "n".repeat(24), title: "Computer Networks - Unit 2", rawText: net.raw || net.notes.map((n) => n.rawText).join("\n\n") };
whole.content = normalizeContent(blocksFromPlainText(whole.rawText));
const shown = keyTermsFor(whole, [], 16);
check("broad words are not highlighted as key terms (data, system, device, message)", !shown.some((t) => ["data", "system", "device", "message", "item"].includes(t.toLowerCase())), shown.join(" | "));
check("  ...multi-word terms and acronyms lead", shown.slice(0, 16).filter((t) => t.includes(" ") || /^[A-Z0-9]{2,}$/.test(t)).length >= 10, shown.join(" | "));
// (three unmarked single words at most; words the author set in bold or as a
// lead-in are not counted, so a few more can appear)
check("  ...and only a few single everyday words", shown.filter((t) => !t.includes(" ") && !/^[A-Z0-9]{2,}$/.test(t)).length <= 5, shown.join(" | "));
const rpc = { _id: "r".repeat(24), title: "RPC", rawText: "Remote Procedure Call (RPC) lets a program run a procedure on another machine. A Remote Procedure Call hides the network. Remote Procedure Call frameworks generate stubs. The sender's private key signs the message. The sender's private key is kept secret. A private key is never shared." };
const rpcTerms = keyTermsFor(rpc, [], 10);
check("a piece of a longer term never used alone is not shown ('Remote Procedure')", !rpcTerms.some((t) => t === "Remote Procedure") && rpcTerms.some((t) => /Remote Procedure Call/i.test(t)), rpcTerms.join(" | "));
check("a possessive is not a term ('sender's private key')", !rpcTerms.some((t) => /['’]s\b/.test(t)), rpcTerms.join(" | "));
const marked = (text, opts) => markText(text, opts).filter((s) => s.mark).map((s) => s.text);
check('a real lead-in term is highlighted ("Atomicity: ...")', marked("Atomicity: a transaction happens completely or not at all.").join() === "Atomicity");
check('labels shaped like lead-ins are not ("Note:", "For example:", "Step 2:", "Advantages:")', ["Note: read this first.", "For example: a hub repeats frames.", "Step 2: send the frame.", "Advantages: cheap and simple."].every((t) => marked(t).length === 0));
check('a clause before a colon is not a term ("The sender waits: ...")', marked("The sender waits: until the ACK arrives.").length === 0);
check("a bold term is matched as a whole word ('IP' not inside 'SHIP')", marked("A SHIP carries IP packets.", { strong: ["IP"] }).join() === "IP");
check("a multi-word key term is highlighted whole, once", marked("The data link layer frames bits. The data link layer detects errors.", { keywords: ["data link layer", "layer"], used: new Set() }).join("|") === "data link layer");

// ---------------------------------------------------------------------------
console.log("\n=== H. Notes formatting ===");
const view = (text) => normalizeContent(blocksFromPlainText(text)).map((b) => `${b.type}${b.type === "item" ? b.depth : ""}:${b.text}`);
check("bullets run together on one line become one entry each", view("Features: • Fast • Cheap • Reliable").join(" / ") === "label:Features: / item0:Fast / item0:Cheap / item0:Reliable", view("Features: • Fast • Cheap • Reliable").join(" / "));
check("  ...including inside a list entry", view("- Main point\n  - detail one • detail two").join(" / ") === "item0:Main point / item1:detail one / item1:detail two");
check("  ...but hyphenated words are never split ('client-server', 'A - B')", view("Client-server model - a server answers clients.").length === 1);
check("a sibling after a deeper entry returns to its own level (4-space indents)", view("- A\n    - B\n        - C\n    - D\n- E").join(" / ") === "item0:A / item1:B / item2:C / item1:D / item0:E", view("- A\n    - B\n        - C\n    - D\n- E").join(" / "));
check("lists are capped at three levels", Math.max(...normalizeContent(blocksFromPlainText("- a\n  - b\n    - c\n      - d\n        - e")).map((b) => b.depth)) === 2);
check("a paragraph after a list is not glued to the last bullet", view("- Star topology uses a hub.\nThe hub is a single point of failure.").join(" / ") === "item0:Star topology uses a hub. / para:The hub is a single point of failure.");
check("  ...while a wrapped entry still joins up", view("- A long entry that wraps\nonto the next line here.").join(" / ") === "item0:A long entry that wraps onto the next line here.");
check("headings stay separate from their lists", view("## Topologies\n- Bus\n- Star").join(" / ") === "heading:Topologies / item0:Bus / item0:Star");
const oldNote = withContent({ _id: "o".repeat(24), title: "Old", rawText: "x", content: [{ type: "para", text: "Media: • Copper • Fibre • Radio" }, { type: "item", text: "deep", depth: 3, ordered: false }] });
check("notes saved before the fix are shown with one bullet per line", oldNote.content.filter((b) => b.type === "item").length === 4 && oldNote.content.every((b) => (b.depth ?? 0) <= 2));
const tree = layoutContent(normalizeContent(blocksFromPlainText("- Main\n  - Supporting\n    - Example\n- Next")), []);
const list = tree.find((b) => b.type === "list");
check("the reading pane nests them: main point > supporting detail > example", list.items.length === 2 && list.items[0].children[0].children[0].text === "Example" && list.items[1].children.length === 0, JSON.stringify(list.items.map((i) => i.text)));

release();
console.log(failures ? `\n${failures} FAILING CHECK(S)` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
