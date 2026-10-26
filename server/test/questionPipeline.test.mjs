// Checks for the question pipeline as a whole: the shared quality gate
// (services/questionQuality.js), the question forms, duplicate and concept
// tracking across tests, and the same behaviour with an AI and without one.
//
//   A. the quality gate on hand-made bad and good questions
//   B. duplicates: exact, reworded, same meaning, same concept
//   C. the rule-based generator on four different subjects
//   D. an AI that writes bad questions, an AI that fails, an AI that answers
//      nonsense (a local stand-in for the Groq API)
//   E. through the real server: consecutive tests, two tests asked for at the
//      same moment, a request larger than the notes can supply
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { notesFromFile } from "../evaluation/lib/ingest.js";
import { conceptOf, opensWithReference, shuffleOptions, validateQuestion } from "../src/services/questionQuality.js";
import { generateQuestions, pickFresh, sameQuestion } from "../src/services/testEngine.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!cond) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const file = (rel) => fileURLToPath(new URL(rel, import.meta.url));

const NOTES = [
  "A switch connects devices in a star topology and forwards frames by MAC address.",
  "A hub connects devices in a star topology and repeats every frame to every port.",
  "A router forwards packets between networks using a routing table.",
  "The data link layer organises bits into frames and detects transmission errors.",
].join(" ");
const mcq = (over) => ({
  prompt: 'Fill in the blank: "A _____ forwards packets between networks using a routing table."',
  options: ["router", "switch", "hub", "bridge"],
  answerKey: "router",
  supportingExcerpt: "A router forwards packets between networks using a routing table.",
  difficulty: "medium",
  ...over,
});
const reasons = (q, type = "mcq") => validateQuestion(q, { type, contextText: NOTES }).reasons;
const fails = (q, code, type) => reasons(q, type).some((r) => r.startsWith(code));

console.log("\n=== A. The quality gate ===");
check("a sound fill-in-the-blank passes", reasons(mcq()).length === 0, reasons(mcq()).join(","));
check("missing context: a sentence opening with 'It' is refused", fails(mcq({ prompt: 'Fill in the blank: "It has _____ feature that forwards packets between networks."' }), "context:refers-back"));
check("  ...and with 'IT has' (the bad example)", fails(mcq({ prompt: 'Fill in the blank: "IT has _____ feature that forwards packets between networks."' }), "context:refers-back"));
check("  ...and a direct question opening with 'These'", fails(mcq({ prompt: "These forward packets using which table?", options: ["routing table", "MAC table", "ARP cache", "hosts file"], answerKey: "routing table" }), "context:refers-back"));
check("  ...but IT the abbreviation, and 'Thermal' starting with 'The', are fine", !opensWithReference("IT governance sets the rules for technology use.") && !opensWithReference("Thermal noise limits the signal.") && !opensWithReference("The router forwards packets."));
check("a meaningless blank (an article) is refused", fails(mcq({ prompt: 'Fill in the blank: "A router forwards packets between networks using _____ routing table."', options: ["the", "a", "an", "one"], answerKey: "the" }), "blank:meaningless"));
check("  ...and a generic word", fails(mcq({ options: ["used", "made", "given", "shown"], answerKey: "used" }), "blank:meaningless"));
check("  ...and an adverb", fails(mcq({ options: ["quickly", "slowly", "rarely", "often"], answerKey: "quickly" }), "blank:meaningless"));
check("two defensible answers: a wrong option the notes also put in the blank", fails(mcq({ prompt: 'Fill in the blank: "A _____ connects devices in a star topology."', options: ["switch", "hub", "router", "bridge"], answerKey: "switch", supportingExcerpt: "A switch connects devices in a star topology and forwards frames by MAC address." }), "mcq:another-option-also-correct"));
check("duplicate options are refused", fails(mcq({ options: ["router", "Router ", "hub", "bridge"] }), "mcq:duplicate-options"));
check("one option inside another is refused", fails(mcq({ options: ["router", "switch", "edge router", "bridge"] }), "mcq:overlapping-options"));
check("'all of the above' is refused", fails(mcq({ options: ["router", "switch", "hub", "All of the above"] }), "mcq:all-or-none"));
check("an answer that is not one of the options is refused", fails(mcq({ answerKey: "gateway" }), "mcq:answer-not-an-option"));
const repaired = validateQuestion(mcq({ answerKey: "Router", options: ["router", "switch", "hub", "bridge", "repeater"] }), { type: "mcq", contextText: NOTES });
check("an answer differing only in case, and a fifth option, are repaired", repaired.ok && repaired.question.answerKey === "router" && repaired.question.options.length === 4 && repaired.question.options.includes("router"), JSON.stringify(repaired.question.options));
check("three options are refused", fails(mcq({ options: ["router", "switch", "hub"] }), "mcq:not-four-options"));
check("an answer much longer than the others is refused", fails(mcq({ options: ["a router that forwards packets between separate networks", "hub", "switch", "bridge"], answerKey: "a router that forwards packets between separate networks", prompt: "Which device forwards packets between networks using a routing table?" }), "mcq:answer-stands-out"));
check("an answer of a different form from all the others is refused", fails(mcq({ prompt: "Which of the following forwards packets between networks using a routing table?", options: ["IPv4 router", "switch", "hub", "bridge"], answerKey: "IPv4 router" }), "mcq:answer-stands-out-by-form"));
check("the answer printed in the question is refused", fails(mcq({ prompt: "Which device, the router, forwards packets between networks?" }), "mcq:answer-in-question"));
check("a direct question whose answer is not in its passage is refused", fails(mcq({ prompt: "Which device forwards packets between networks?", options: ["gateway", "switch", "hub", "bridge"], answerKey: "gateway" }), "correctness"));
check("an answer that does not fill the blank back into its passage is refused", fails(mcq({ prompt: 'Fill in the blank: "A _____ repeats every frame to every port in a star topology."', options: ["router", "switch", "hub", "bridge"], answerKey: "router" }), "correctness"));
check("a direct question that is not a question is refused", fails(mcq({ prompt: "Routers forward packets between networks", options: ["router", "switch", "hub", "bridge"] }), "clarity:not-a-question"));
let lost = 0;
for (let i = 0; i < 300; i++) {
  const shuffled = shuffleOptions(["router", "switch", "hub", "bridge"], "router");
  if (shuffled.filter((o) => o === "router").length !== 1 || shuffled.length !== 4) lost++;
}
check("shuffling 300 times never loses or duplicates the answer", lost === 0);
let threw = false;
try {
  shuffleOptions(["switch", "hub", "bridge", "repeater"], "router");
} catch {
  threw = true;
}
check("  ...and refuses to shuffle options that lack the answer", threw);

const theory = (over) => ({
  prompt: "Differentiate between a switch and a hub in a star topology.",
  answerKey: "A switch forwards frames by MAC address, while a hub repeats every frame to every port.",
  keyPoints: ["MAC address", "repeats every frame"],
  supportingExcerpt: "A hub connects devices in a star topology and repeats every frame to every port.",
  difficulty: "hard",
  ...over,
});
check("a sound theory question passes", reasons(theory(), "theory").length === 0, reasons(theory(), "theory").join(","));
check("a vague theory question is refused ('Explain the differences.')", fails(theory({ prompt: "Explain the differences." }), "theory:vague", "theory"));
check("one with no command word is refused", fails(theory({ prompt: "Switches and hubs in a star topology." }), "theory:no-command-word", "theory"));
check("one that names nothing is refused ('Describe it.')", fails(theory({ prompt: "Describe it." }), "theory", "theory"));
check("one pointing at a missing diagram's subject is refused ('This shows ...')", fails(theory({ prompt: "Explain how this works in the figure above." }), "theory", "theory") || fails(theory({ prompt: "This device: explain it." }), "context", "theory"));
check("one with no model answer is refused", fails(theory({ answerKey: "Yes." }), "theory:no-model-answer", "theory"));
check("one with no key points is refused", fails(theory({ keyPoints: [] }), "theory:no-key-points", "theory"));

console.log("\n=== B. Duplicates ===");
check("exact duplicates are the same question", sameQuestion("Define the term “router”.", "define the term  “router”."));
check("a reworded copy is the same question", sameQuestion('Fill in the blank: "A _____ forwards packets between networks using a routing table."', 'Fill in the blank: "The _____ forwards packets between networks using a routing table."'));
check("different questions are not", !sameQuestion("Define the term “router”.", "Define the term “switch”."));
const items = (prompts, concept = null) => prompts.map((p, i) => ({ prompt: p, concept: concept ? concept(i) : null }));
const meaning = (a, b) => /which device forwards packets/i.test(a) && /what forwards packets/i.test(b);
const sem = pickFresh(items(["What forwards packets between networks?", "Define the term “hub”."]), ["Which device forwards packets between networks?"], 2, 2, null, { similar: (a, b) => meaning(a, b) || meaning(b, a) });
check("a paraphrase with few shared words is caught by meaning (embedding model)", sem.repeatsUsed === 1 && sem.chosen[0].prompt.startsWith("Define"), JSON.stringify(sem.chosen.map((q) => q.prompt)));
const twice = pickFresh(items(["Define the term “router”.", "Explain how a “router” forwards packets.", "Define the term “hub”."], (i) => (i < 2 ? "router" : "hub")), [], 3, 3);
check("two questions on one concept in one test: the second is dropped", twice.chosen.length === 2 && twice.duplicates[0]?.discardReason === "duplicate-concept");
const recent = pickFresh(items(["Define the term “router”.", "Define the term “hub”."], (i) => (i === 0 ? "router" : "hub")), [], 1, 1, null, { recentConcepts: new Set(["router"]) });
check("a concept from the last tests gives way to an untested one", recent.chosen[0].prompt.includes("hub"));
const onlyRecent = pickFresh(items(["Define the term “router”."], () => "router"), [], 1, 1, null, { recentConcepts: new Set(["router"]) });
check("  ...but is still used when nothing untested is left", onlyRecent.chosen.length === 1 && onlyRecent.repeatsUsed === 0);
check("the concept of an MCQ is its answer, of a theory question the term it names", conceptOf({ answerKey: "Routers" }, "mcq") === "router" && conceptOf({ prompt: "Differentiate between “shared lock” and “exclusive lock”." }, "theory") === "exclusive lock | shared lock");

console.log("\n=== C. The rule-based generator on four subjects ===");
const subjects = [
  ["networks", file("../../sample-notes/networks_unit2.md")],
  ["databases", file("../evaluation/samples/dbms_unit4.md")],
  ["security", file("./fixtures/ics_unit3.md")],
  ["distributed systems", file("../evaluation/samples/distributed_systems_unit1.txt")],
];
const forms = new Set();
const theoryForms = new Set();
const tiers = new Set();
for (const [name, path] of subjects) {
  const doc = await notesFromFile(path);
  const contextText = doc.notes.map((n) => n.rawText).join("\n");
  const r = await generateQuestions(doc.notes, { mcqCount: 10, theoryCount: 5, marksPerQuestion: 1 });
  const all = r.accepted;
  const again = all.map((q) => validateQuestion(q, { type: q.type, contextText }));
  check(`${name}: questions were made (${all.filter((q) => q.type === "mcq").length} MCQ, ${all.filter((q) => q.type === "theory").length} theory)`, all.filter((q) => q.type === "mcq").length >= 5 && all.some((q) => q.type === "theory"));
  check(`${name}: every question passes the gate`, again.every((v) => v.ok), again.filter((v) => !v.ok).map((v) => v.reasons.join(",")).join(" | "));
  check(`${name}: no question leans on a sentence the student cannot see`, all.every((q) => !opensWithReference((q.prompt.match(/"([^"]+)"/)?.[1] ?? q.prompt))));
  check(`${name}: every MCQ has four distinct options, the answer among them once`, all.filter((q) => q.type === "mcq").every((q) => q.options.length === 4 && new Set(q.options.map((o) => o.toLowerCase())).size === 4 && q.options.filter((o) => o === q.answerKey).length === 1));
  const concepts = all.map((q) => `${q.type}|${q.concept}`);
  check(`${name}: no concept is asked twice in one test`, new Set(concepts).size === concepts.length);
  all.forEach((q) => (q.type === "mcq" ? forms : theoryForms).add(q.form));
  all.forEach((q) => tiers.add(q.difficulty));
}
check("MCQs come in more than one form (direct questions, blanks, abbreviations)", forms.size >= 2, [...forms].join(", "));
check("theory questions come in at least four forms", theoryForms.size >= 4, [...theoryForms].join(", "));
check("easy, medium and hard questions are all made", ["easy", "medium", "hard"].every((t) => tiers.has(t)));

console.log("\n=== D. With an AI, and when it fails ===");
const doc = await notesFromFile(file("../../sample-notes/networks_unit2.md"));
const notes = doc.notes.slice(0, 6);
const topo = "A network topology describes the arrangement of nodes and links in a network.";
const ring = "A ring topology connects each device to exactly two neighbours so that data travels around the ring in one direction, often using a token to decide who may transmit.";
const BAD_AND_GOOD_MCQ = [
  // good: a direct question with its passage
  { prompt: "What does a network topology describe?", options: ["the arrangement of nodes and links in a network", "the speed of each link in a network", "the protocols used at each layer", "the cost of cabling a building"], correctAnswer: "the arrangement of nodes and links in a network", supportingExcerpt: topo, difficulty: "easy", concept: "network topology" },
  // bad: missing context
  { prompt: "It connects each device to how many neighbours?", options: ["two", "one", "three", "four"], correctAnswer: "two", supportingExcerpt: ring, difficulty: "easy" },
  // bad: duplicate options
  { prompt: "Which topology connects each device to exactly two neighbours?", options: ["ring topology", "Ring topology", "star topology", "bus topology"], correctAnswer: "ring topology", supportingExcerpt: ring, difficulty: "medium" },
  // bad: answer mapping wrong
  { prompt: "Which topology uses a token to decide who may transmit?", options: ["star topology", "bus topology", "mesh topology", "hybrid topology"], correctAnswer: "ring topology", supportingExcerpt: ring, difficulty: "medium" },
  // bad: not in the notes
  { prompt: "Which company invented Ethernet?", options: ["Xerox", "IBM", "Cisco", "Intel"], correctAnswer: "Xerox", supportingExcerpt: "Ethernet was invented at Xerox PARC in 1973.", difficulty: "hard" },
  // bad: all of the above
  { prompt: "Which of the following describes a ring topology?", options: ["each device has two neighbours", "data travels in one direction", "a token decides who transmits", "All of the above"], correctAnswer: "All of the above", supportingExcerpt: ring, difficulty: "hard" },
];
const BAD_AND_GOOD_THEORY = [
  { prompt: "Explain the differences.", guidance: "", modelAnswer: ring, keyPoints: ["two neighbours"], supportingExcerpt: ring, difficulty: "hard" },
  { prompt: "Explain how a ring topology decides which device may transmit.", guidance: "Two sentences.", modelAnswer: ring, keyPoints: ["token", "two neighbours"], supportingExcerpt: ring, difficulty: "medium", concept: "ring topology" },
  { prompt: "Describe the history of the Internet.", guidance: "", modelAnswer: "The Internet grew out of ARPANET in the 1960s and 1970s.", keyPoints: ["ARPANET"], supportingExcerpt: "The Internet grew out of ARPANET.", difficulty: "medium" },
];
let mode = "mixed";
let calls = 0;
const fake = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    calls++;
    if (mode === "down") {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { type: "server_error" } }));
    }
    const theoryAsked = /theory \(short-answer\)/.test(body);
    const content = mode === "nonsense" ? "Sorry, I cannot help with that." : JSON.stringify(theoryAsked ? BAD_AND_GOOD_THEORY : BAD_AND_GOOD_MCQ);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});
await new Promise((r) => fake.listen(4582, r));
process.env.GROQ_API_KEY = "test-key";
process.env.LLM_API_URL = "http://localhost:4582/v1/chat/completions";
process.env.LLM_TIMEOUT_MS = "3000";
try {
  const r = await generateQuestions(notes, { mcqCount: 6, theoryCount: 3, marksPerQuestion: 1 });
  const byAi = r.accepted.filter((q) => q.generatedBy === "llm");
  check("the AI was asked", calls >= 2);
  check("its sound MCQ and theory question are used", byAi.some((q) => q.prompt === BAD_AND_GOOD_MCQ[0].prompt) && byAi.some((q) => q.prompt === BAD_AND_GOOD_THEORY[1].prompt), byAi.map((q) => q.prompt).join(" | "));
  check("none of its faulty questions reaches the test", !r.accepted.some((q) => [...BAD_AND_GOOD_MCQ.slice(1), BAD_AND_GOOD_THEORY[0], BAD_AND_GOOD_THEORY[2]].some((b) => b.prompt === q.prompt)));
  const why = Object.fromEntries(r.discarded.filter((q) => q.generatedBy === "llm").map((q) => [q.prompt.slice(0, 30), q.discardReason]));
  check("  ...each stored with why it was dropped", Object.values(why).some((w) => /refers-back/.test(w)) && Object.values(why).some((w) => /duplicate-options/.test(w)) && Object.values(why).some((w) => /answer-not-an-option/.test(w)) && Object.values(why).some((w) => /not-grounded/.test(w)) && Object.values(why).some((w) => /all-or-none/.test(w)) && Object.values(why).some((w) => /vague/.test(w)), JSON.stringify(why));
  check("rule-written questions take the dropped ones' places, so the test keeps its length", r.accepted.filter((q) => q.type === "mcq").length === 6 && r.accepted.filter((q) => q.type === "theory").length === 3, `${r.accepted.length}`);
  check("  ...and the test says it is a mix", r.mcqGeneratedBy === "mixed" && r.theoryGeneratedBy === "mixed", `${r.mcqGeneratedBy} / ${r.theoryGeneratedBy}`);
  const contextText = notes.map((n) => n.rawText).join("\n");
  check("every question kept passes the gate", r.accepted.every((q) => validateQuestion(q, { type: q.type, contextText }).ok));

  mode = "down";
  const down = await generateQuestions(notes, { mcqCount: 6, theoryCount: 3, marksPerQuestion: 1 });
  check("when the AI fails, the rules write the whole test", down.mcqGeneratedBy === "rule-based-fallback" && down.theoryGeneratedBy === "rule-based-fallback" && down.accepted.length === 9, `${down.mcqGeneratedBy} ${down.accepted.length}`);
  check("  ...and every question still passes the gate", down.accepted.every((q) => validateQuestion(q, { type: q.type, contextText }).ok));

  mode = "nonsense";
  const odd = await generateQuestions(notes, { mcqCount: 4, theoryCount: 2, marksPerQuestion: 1 });
  check("an answer that is not questions at all also falls back to the rules", odd.mcqGeneratedBy === "rule-based-fallback" && odd.accepted.length === 6);
} finally {
  fake.close();
  delete process.env.GROQ_API_KEY;
  delete process.env.LLM_API_URL;
  delete process.env.LLM_TIMEOUT_MS;
}

console.log("\n=== E. Through the server ===");
const PORT = 4581;
const API = `http://localhost:${PORT}/api`;
const server = spawn(process.execPath, ["src/index.js"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  // TEST_REVEAL_KEYS: the stored questions in full (?keys=1, never in
  // production) - a student gets only what questionView.js allows
  env: { ...process.env, PORT: String(PORT), MONGODB_URI: "", DB_FILE: "memory", GROQ_API_KEY: "", NODE_ENV: "development", TEST_REVEAL_KEYS: "1" },
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
  const call = async (path, { method = "GET", body } = {}) => {
    const r = await fetch(API + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie, Origin: "http://localhost:5173" }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  await call("/auth/register", { method: "POST", body: { email: `pipeline${Date.now()}@example.com`, password: "river-Kettle-42x" } });
  const { subject } = await call("/subjects", { method: "POST", body: { name: "Networks" } });
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(file("../../sample-notes/networks_unit2.md"))]), "networks_unit2.md");
  const up = await (await fetch(`${API}/subjects/${subject._id}/notes`, { method: "POST", headers: { Cookie: cookie, Origin: "http://localhost:5173" }, body: form })).json();
  const build = (title, n = 6) => call(`/subjects/${subject._id}/tests`, { method: "POST", body: { title, noteIds: [up.note._id], mcqCount: n, theoryCount: 2 } });
  // what a student can be given: the accepted questions (a draft the quality
  // gate rejects is stored as discarded in each build that drafted it)
  const questionsOf = async (r) => ((await call(`/tests/${r.test._id}?keys=1`)).questions || []).filter((q) => q.status === "accepted");

  // two tests asked for at the same moment (two tabs, a double click on two forms)
  const [a, b] = await Promise.all([build("Morning"), build("Evening")]);
  const qa = await questionsOf(a);
  const qb = await questionsOf(b);
  const shared = qb.filter((q) => qa.some((p) => sameQuestion(p.prompt, q.prompt)));
  check("two tests built at the same moment share no question", a.status === 201 && b.status === 201 && shared.length === 0, `${shared.length} shared`);

  // consecutive tests: the next one is about other concepts
  const c = await build("Third");
  const qc = await questionsOf(c);
  const conceptsOf = (qs) => new Set(qs.map((q) => q.concept).filter(Boolean));
  // only questions a student can be asked count (rejected drafts are stored
  // too, with their concept, for the admin page)
  const asked = (qs) => qs.filter((q) => q.status === "accepted");
  const before = new Set([...conceptsOf(asked(qa)), ...conceptsOf(asked(qb))]);
  const overlap = [...conceptsOf(asked(qc))].filter((x) => before.has(x)).length;
  check("a third test asks about concepts the first two did not", asked(qc).length >= 8 && overlap <= 1, `${overlap} of ${conceptsOf(asked(qc)).size} concepts seen before`);
  check("every stored question records its concept and form", [...qa, ...qb, ...qc].every((q) => q.concept && "form" in q), [...qa, ...qb, ...qc].filter((q) => !(q.concept && "form" in q)).map((q) => `${q.status} ${q.discardReason} ${q.prompt}`).join(" | "));

  // a request larger than the notes can supply
  const { subject: small } = await call("/subjects", { method: "POST", body: { name: "Tiny" } });
  const tiny = await call(`/subjects/${small._id}/notes`, { method: "POST", body: { title: "Frames", content: "A frame is the unit the data link layer sends. Byte stuffing adds an escape byte before a flag byte inside the data. Bit stuffing inserts a zero after five consecutive ones in the data." } });
  const big = await call(`/subjects/${small._id}/tests`, { method: "POST", body: { title: "Too long", noteIds: [tiny.note._id], mcqCount: 12, theoryCount: 8 } });
  const qs = big.test ? await questionsOf(big) : [];
  check("asked for more than the notes hold: a shorter test, and the student is told", big.status === 201 && big.shortfall && big.deliverable < 20, JSON.stringify(big.shortfall));
  check("  ...with no question twice and no padding", new Set(qs.map((q) => q.prompt)).size === qs.length && !qs.some((q) => (q.options || []).some((o) => /related term/.test(o))));
} finally {
  server.kill();
}

console.log(failures ? `\n${failures} FAILING CHECK(S)` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
