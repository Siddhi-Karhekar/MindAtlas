// The question-quality layer: classification confidence, question-worthiness,
// computed numerical questions, the unified evaluator (ambiguity, several
// correct options, weak distractors, unsupported claims), the independent AI
// check, and the rule-based writer under the same gate.
// No real AI service is called: a local HTTP server stands in for Groq.
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

delete process.env.GROQ_API_KEY;
process.env.SEMANTIC_MODEL = "off";

const { classifyText, MCQ_MIN_CONFIDENCE } = await import("../src/services/suitability.js");
const { worthinessOf, WORTH_MIN } = await import("../src/services/worthiness.js");
const { parseRelation, relationsIn, numericalItem, recompute } = await import("../src/services/numerical.js");
const { evaluateQuestion, ACCEPT_SCORE, cognitiveLevelOf } = await import("../src/services/questionEvaluator.js");
const { generateQuestions, qualityContext, stripTag } = await import("../src/services/testEngine.js");
const { studyFor, clearStudyCache } = await import("../src/services/keyTerms.js");
const { notesFromFile } = await import("../evaluation/lib/ingest.js");
const { runBenchmark } = await import("../evaluation/benchmark.mjs");

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + String(detail).replace(/\s+/g, " ").slice(0, 220) : ""}`);
  if (!cond) failures++;
};
const here = path.dirname(fileURLToPath(import.meta.url));
const benchDir = path.join(here, "..", "evaluation", "benchmark");

// ---------------------------------------------------------------------------
console.log("\n=== A. Classification: a confidence and a reason for every decision ===");
const def = classifyText("A lock is a mechanism to control concurrent access to a data item.");
check("a definition is MCQ material, with high confidence", def.kind === "definition" && def.mcq && def.confidence >= 0.85 && def.role === "definition", JSON.stringify(def));
const unsure = classifyText("For example, a router may forward 3 or 4 packets at once.");
check("an example that leans on earlier text, hedged and full of numbers, is theory only (the safer type)", !unsure.mcq && unsure.theory && unsure.confidence < MCQ_MIN_CONFIDENCE && /low-confidence/.test(unsure.reason), JSON.stringify(unsure));
const cause = classifyText("In pure ALOHA collisions are frequent because stations transmit whenever they have data.");
check("a cause and its effect is MCQ material, marked as such", cause.mcq && cause.role === "cause-effect", JSON.stringify(cause));
const code = classifyText("for (i = 0; i < n; i++) sum += a[i];");
check("code is theory only, and the decision says why", !code.mcq && code.kind === "code" && /code-features/.test(code.reason) && code.confidence >= 0.7);
check("an ordered list entry is a step, near-certainly", classifyText("Read the next record.", { blockType: "item", ordered: true }).confidence >= 0.9);

// ---------------------------------------------------------------------------
console.log("\n=== B. Question-worthiness ===");
const study = { terms: [{ key: "lock", term: "lock", score: 1, words: 1, marks: ["bold"] }, { key: "data item", term: "data item", score: 0.5, words: 2, marks: [] }] };
const note = { title: "Lock-Based Protocols", content: [] };
const good = worthinessOf({ text: def ? "A lock is a mechanism to control concurrent access to a data item." : "", terms: ["lock", "data item"], suit: def, section: "Locks" }, note, study);
const pointsBack = worthinessOf({ text: "It is held until the transaction commits, etc.", terms: [], suit: classifyText("It is held until the transaction commits, etc."), section: "" }, note, study);
check("a definition of a leading term is worth a question", good.score >= 0.75, JSON.stringify(good));
check("a sentence that points back and trails off is not", pointsBack.score < WORTH_MIN() && pointsBack.issues.includes("refers-back"), JSON.stringify(pointsBack));

// ---------------------------------------------------------------------------
console.log("\n=== C. Numerical questions: computed, never guessed ===");
check("V = I × R and 1/R = 1/R1 + 1/R2 parse", parseRelation("V = I × R")?.target === "V" && parseRelation("1/R = 1/R1 + 1/R2")?.reciprocal === true);
check("a limit, a modulus, a function or the target on both sides do not", !parseRelation("f'(x) = lim h") && !parseRelation("key = 5^9 mod 23") && !parseRelation("y = sin x") && !parseRelation("x = x + 1"));
check("nothing is evaluated as code: words that are not variables stop a formula", relationsIn("Run x = system('rm') now.").length === 0);
const series = relationsIn("For resistors in series the total resistance is R = R1 + R2 + R3, and the same current flows through each resistor.")[0];
const item = numericalItem(series);
check("a series formula gives a question: inputs, the answer and three wrong answers", item && item.distractors.length === 3 && !item.distractors.includes(item.answer), JSON.stringify(item));
check("  ...the same every time (so a re-check gives the same numbers)", JSON.stringify(numericalItem(series)) === JSON.stringify(item));
check("  ...and the answer is what the formula gives", recompute({ formula: series.formula, target: series.target, values: item.values }) === item.answer);
const parallel = numericalItem(relationsIn("For resistors in parallel the total resistance is given by 1/R = 1/R1 + 1/R2, and the same voltage appears.")[0]);
check("the parallel formula's wrong answers include forgetting the reciprocal", parallel?.slips.includes("reciprocal-not-taken") || parallel?.slips.includes("terms-not-inverted"), JSON.stringify(parallel));

// ---------------------------------------------------------------------------
console.log("\n=== D. The evaluator: ambiguity, several right answers, weak options ===");
clearStudyCache();
const bench = await notesFromFile(path.join(benchDir, "notes.md"));
const studies = new Map();
for (const n of bench.notes) studies.set(n, await studyFor(n, { corpus: bench.notes }));
const { evalCtx } = qualityContext(bench.notes, studies);
const udp = "UDP provides connectionless, best-effort delivery of datagrams.";
const mcq = (over) => ({ type: "mcq", prompt: "Which transport protocol provides connectionless, best-effort delivery of datagrams?", options: ["UDP", "TCP", "SCTP", "ARP"], answerKey: "UDP", supportingExcerpt: udp, difficulty: "easy", generatedBy: "llm", ...over });
const codes = (q) => evaluateQuestion(q, evalCtx).problems.filter((p) => p.severity === "hard").map((p) => p.code);
check("a clear question from the notes is accepted, with a score", evaluateQuestion(mcq({}), evalCtx).decision === "accept" && evaluateQuestion(mcq({}), evalCtx).score >= ACCEPT_SCORE());
const best = evaluateQuestion(mcq({ prompt: "Which of the following best describes the delivery UDP provides to datagrams?" }), evalCtx);
check("'best describes' is repaired to 'describes' (decision: revise)", best.decision === "revise" && /following describes/.test(best.question.prompt), best.question.prompt);
check("'most important' has no criterion: rejected", codes(mcq({ prompt: "Which is the most important transport protocol?" })).includes("ambiguity:vague-qualifier"));
check("'best-effort' is not a vague 'best'", !codes(mcq({})).includes("ambiguity:vague-qualifier"));
check("a figure the student is not given: rejected", codes(mcq({ prompt: "In the figure above, which protocol delivers the datagrams?" })).includes("context:missing-material"));
check("an abbreviation the notes never use: rejected", codes(mcq({ prompt: "Which protocol does QUIC replace with UDP?" })).includes("context:undefined-abbreviation"));
check("a name from outside the notes: rejected", codes(mcq({ prompt: "Which protocol did Jon Postel design for datagrams?" })).includes("grounding:unsupported-name"));
check("'A decrypts ...' with A never introduced: rejected", codes(mcq({ prompt: 'Fill in the blank: "A signs the digest with its _____, and B verifies it."', options: ["private key", "session key", "message digest", "secret key"], answerKey: "private key", supportingExcerpt: "A signs the digest with its private key, and B verifies the signature with the public key of A." })).includes("context:unnamed-actor"));
check("a scenario's own names (process P1, resource R2) are fine", !codes(mcq({ prompt: "Process P1 holds resource R1 and requests R2 while P2 holds R2. Which protocol delivers datagrams?" })).some((c) => /unnamed-actor|undefined-abbreviation/.test(c)));
check("two questions in one: rejected", codes(mcq({ prompt: "What is UDP? Which protocol is reliable?" })).includes("clarity:two-questions"));
check("an abbreviation beside what it stands for: two right answers", codes(mcq({ prompt: "Which of the following connects devices within a single building or campus?", options: ["LAN", "local area network", "WAN", "wide area network"], answerKey: "local area network", supportingExcerpt: "A local area network (LAN) connects devices within a single building or campus." })).includes("mcq:equivalent-options"));
check("a wrong option the notes also make true, filled into the blank: rejected", codes(mcq({ prompt: 'Fill in the blank: "_____ provides reliable delivery of a byte stream between applications."', options: ["TCP", "SCTP", "UDP", "ARP"], answerKey: "TCP", supportingExcerpt: "TCP provides reliable delivery of a byte stream between applications." })).includes("mcq:another-option-also-correct"));
check("  ...and asked as a direct question: rejected", codes(mcq({ prompt: "Which protocol provides reliable delivery of a byte stream between applications?", options: ["TCP", "SCTP", "UDP", "ARP"], answerKey: "TCP", supportingExcerpt: "TCP provides reliable delivery of a byte stream between applications." })).includes("mcq:another-option-also-correct"));
check("a wrong option that is the answer's family (SHA-2 beside SHA-512): rejected", codes(mcq({ prompt: 'Fill in the blank: "SHA-256 produces a 256-bit digest and _____ produces a 512-bit digest."', options: ["SHA-512", "SHA-2", "MD5", "SHA-1"], answerKey: "SHA-512", supportingExcerpt: "SHA-256 produces a 256-bit digest and SHA-512 produces a 512-bit digest.", generatedBy: "rule-based-fallback" })).includes("mcq:option-overlaps-answer"));
const weak = evaluateQuestion(mcq({ prompt: "Which transport protocol offers best-effort delivery of datagrams without a connection?", options: ["UDP", "x", "the", "connectionless best-effort datagram delivery protocol for applications"] }), evalCtx);
check("options of another form and length score as weak distractors", weak.criteria.distractors < evaluateQuestion(mcq({}), evalCtx).criteria.distractors, JSON.stringify(weak.criteria));
const wrongNumber = { ...mcq({}), form: "numerical", prompt: "For resistors in series the total resistance is given by $R = R1 + R2$. What is $R$ when $R1 = 4$ and $R2 = 6$?", options: ["10", "24", "4", "6"], answerKey: "24", supportingExcerpt: "For resistors in series the total resistance is R = R1 + R2, and the same current flows through each resistor.", computation: { formula: "R = R1 + R2", target: "R", values: { R1: 4, R2: 6 } } };
check("a numerical key the formula does not give: rejected", codes(wrongNumber).includes("computation:wrong-key"));
check("  ...and the right one is accepted, as an application", evaluateQuestion({ ...wrongNumber, answerKey: "10" }, evalCtx).decision === "accept" && cognitiveLevelOf({ ...wrongNumber }, "mcq") === "apply");
check("the AI checker's different answer rejects", codes(mcq({ verification: { status: "checked", answer: "TCP", defensible: ["TCP"] } })).includes("verify:key-mismatch"));
check("  ...as do two defensible options", codes(mcq({ verification: { status: "checked", answer: "UDP", defensible: ["UDP", "SCTP"] } })).includes("verify:multiple-correct"));
check("  ...and two options it finds absurd", codes(mcq({ options: ["UDP", "banana", "blue", "TCP"], verification: { status: "checked", answer: "UDP", defensible: ["UDP"], implausible: ["banana", "blue"] } })).includes("verify:implausible-distractors"));
check("a copied sentence scores lower on originality than a reworded question", evaluateQuestion(mcq({ prompt: 'Fill in the blank: "_____ provides connectionless, best-effort delivery of datagrams."' }), evalCtx).criteria.originality < evaluateQuestion(mcq({}), evalCtx).criteria.originality);
check("the AI's tag never survives in a quoted excerpt", stripTag("A lock is a mechanism ⟦definition, importance high⟧") === "A lock is a mechanism");

// ---------------------------------------------------------------------------
console.log("\n=== E. The labelled benchmark: old gate against new ===");
const b = await runBenchmark(path.join(benchDir, "mcq_benchmark.json"));
const { old, new: neu } = b.summary;
check("the new gate catches more of the bad questions", neu.recall > old.recall, `old ${old.badCaught}/${old.bad}, new ${neu.badCaught}/${neu.bad}`);
check("  ...at least 85% of them", neu.recall >= 0.85, `${neu.badCaught}/${neu.bad}`);
check("  ...and rejects at most one in ten good ones", neu.falseRejection <= 0.1, `${neu.goodRejected}/${neu.good}`);
const row = (id) => b.rows.find((r) => r.id === id);
check("a computed numerical question is no longer rejected for coming from a formula", row("G4").old === "reject" && row("G4").new === "accept");
check("a wrong computed key is", row("B10").new === "reject");

// ---------------------------------------------------------------------------
console.log("\n=== F. The rule-based writer, under the same gate (no AI) ===");
const fixture = (f) => path.join(here, "fixtures", "subjects", f);
const files = [path.join(benchDir, "notes.md"), fixture("ee_circuits.md"), path.join(here, "..", "evaluation", "samples", "dbms_unit4.md"), path.join(here, "fixtures", "ics_unit3.md")];
const all = [];
for (const f of files) {
  clearStudyCache();
  const doc = await notesFromFile(f);
  const r = await generateQuestions(doc.notes, { mcqCount: 10, theoryCount: 4, marksPerQuestion: 1 });
  all.push({ f: path.basename(f), r });
}
const mcqs = all.flatMap((x) => x.r.accepted.filter((q) => q.type === "mcq"));
check("rule-based MCQs are made", mcqs.length >= 20, `${mcqs.length}`);
check("every accepted question carries the evaluator's decision, score and the source's kind", all.every((x) => x.r.accepted.every((q) => q.quality && q.quality.decision !== "reject" && typeof q.quality.score === "number" && q.sourceKind && q.classification)));
check("  ...at or above the acceptance score", mcqs.every((q) => q.quality.score >= ACCEPT_SCORE()), Math.min(...mcqs.map((q) => q.quality.score)));
check("no answer is a word that is merely said often ('sum', 'device')", !mcqs.some((q) => /^(?:sum|device|devices|stack|function|program|memory|message|nodes|event)$/i.test(q.answerKey)), mcqs.map((q) => q.answerKey).join(" | "));
const numerical = mcqs.filter((q) => q.form === "numerical");
check("a formula gives a numerical question, and its key recomputes", numerical.length >= 1 && numerical.every((q) => recompute(q.computation) === q.answerKey), numerical.map((q) => q.prompt.slice(0, 50)).join(" | "));
check("a list of sibling concepts gives a 'which statement describes' question", mcqs.some((q) => q.form === "describe"), [...new Set(mcqs.map((q) => q.form))].join(","));
check("several forms of question, not one template", new Set(mcqs.map((q) => q.form)).size >= 4, [...new Set(mcqs.map((q) => q.form))].join(","));
const families = (list) => list.filter((q) => list.filter((p) => p !== q && p.options.every((o) => q.options.includes(o))).length >= 2).length;
check("no set of four options is used for more than two questions in a test", all.every((x) => families(x.r.accepted.filter((q) => q.type === "mcq")) === 0));
const rejected = all.flatMap((x) => x.r.discarded).filter((q) => q.quality?.decision === "reject");
check("what the evaluator rejected is stored with its reasons", rejected.every((q) => q.discardReason && q.quality.problems.length), rejected.length);

// ---------------------------------------------------------------------------
console.log("\n=== G. The independent AI check, with a stand-in Groq ===");
const notes = bench.notes;
const AI = [
  { topic: "Transport Layer", concept: "udp", learningObjective: "Identify the connectionless transport protocol", cognitiveLevel: "recall", prompt: "Which transport protocol provides connectionless, best-effort delivery of datagrams?", options: ["UDP", "TCP", "SCTP", "ARP"], correctAnswer: "UDP", distractorReasons: ["reliable", "reliable", "not transport"], explanation: "UDP is connectionless.", supportingExcerpt: "UDP provides connectionless, best-effort delivery of datagrams. ⟦fact, importance high⟧", difficulty: "easy" },
  { topic: "Transport Layer", concept: "transport protocol reliability", prompt: "Which protocol keeps a reliable byte stream between two applications?", options: ["TCP", "UDP", "ARP", "ICMP"], correctAnswer: "TCP", supportingExcerpt: "TCP provides reliable delivery of a byte stream between applications.", difficulty: "easy" },
  { topic: "Transport Layer", concept: "reworded udp", prompt: "Which transport protocol gives connectionless, best-effort delivery of datagrams?", options: ["UDP", "TCP", "SCTP", "ARP"], correctAnswer: "UDP", supportingExcerpt: "UDP provides connectionless, best-effort delivery of datagrams.", difficulty: "easy" },
  { topic: "Hash Functions", concept: "invented", prompt: "Which hash function produces a 64-bit digest?", options: ["MD5", "SHA-256", "SHA-512", "SHA-1"], correctAnswer: "MD5", supportingExcerpt: "MD5 produces a 64-bit digest.", difficulty: "easy" },
];
let verifyMode = "check";
const bodies = [];
const fake = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    bodies.push(body);
    const parsed = JSON.parse(body);
    const system = parsed.messages[0]?.content || "";
    let content = "[]";
    if (/independent examiner/.test(system)) {
      if (verifyMode === "broken") content = "I cannot help with that.";
      else {
        // answer each item from its options: the reliable-stream question has two defensible answers
        const user = parsed.messages[1].content;
        const items = JSON.parse(user.slice(user.indexOf("["), user.lastIndexOf("]") + 1));
        const letterOf = (it, text) => Object.entries(it.options).find(([, v]) => v === text)?.[0] || null;
        content = JSON.stringify(
          items.map((it) =>
            /reliable byte stream/.test(it.question)
              ? { id: it.id, answer: letterOf(it, "TCP"), defensible: [letterOf(it, "TCP"), letterOf(it, "SCTP") || "B"].filter(Boolean), ambiguous: false, format: "mcq" }
              : /UDP|datagrams/.test(it.question)
                ? { id: it.id, answer: letterOf(it, "UDP"), defensible: [letterOf(it, "UDP")], ambiguous: false, format: "mcq", implausible: [] }
                : (() => {
                    // anything else: the option its source names, as a careful examiner would find
                    const hit = Object.entries(it.options).find(([, v]) => it.source.toLowerCase().includes(String(v).toLowerCase()));
                    return hit ? { id: it.id, answer: hit[0], defensible: [hit[0]], ambiguous: false, format: "mcq" } : { id: it.id, answer: null, defensible: [], ambiguous: true, format: "mcq", reason: "no option is supported" };
                  })()
          )
        );
      }
    } else if (/multiple-choice questions/.test(system)) content = JSON.stringify(AI);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});
await new Promise((r) => fake.listen(4603, r));
process.env.GROQ_API_KEY = "test-key";
process.env.LLM_API_URL = "http://localhost:4603/v1/chat/completions";
process.env.LLM_TIMEOUT_MS = "3000";
try {
  clearStudyCache();
  const r = await generateQuestions(notes, { mcqCount: 6, theoryCount: 0, marksPerQuestion: 1 });
  const ai = r.accepted.filter((q) => q.generatedBy === "llm");
  const why = (re) => [...r.accepted, ...r.discarded].find((q) => re.test(q.prompt));
  check("the AI's good question is accepted, checked, and the checker agreed", ai.some((q) => /connectionless, best-effort/.test(q.prompt) && q.verification?.status === "checked" && q.verification.answer === "UDP"), ai.map((q) => q.prompt.slice(0, 40)).join(" | "));
  check("  ...with what it is for, from the AI", ai.some((q) => q.learningObjective && q.cognitiveLevel === "recall" && q.explanation));
  check("  ...and the ⟦tag⟧ it copied into its excerpt does not cost it the grounding check", ai.some((q) => q.supportingExcerpt === "UDP provides connectionless, best-effort delivery of datagrams."));
  check("a question with a second defensible option is rejected by the check", /verify:multiple-correct/.test(why(/reliable byte stream/)?.discardReason || ""), why(/reliable byte stream/)?.discardReason);
  check("a reworded copy of another question is dropped as a duplicate", /duplicate/.test(why(/gives connectionless/)?.discardReason || ""), why(/gives connectionless/)?.discardReason);
  check("an excerpt that is not in the notes (an invented fact) is never accepted", /not-grounded/.test(why(/64-bit/)?.discardReason || ""), why(/64-bit/)?.discardReason);
  check("the rule-based questions behind the AI's were checked too", r.accepted.filter((q) => q.generatedBy !== "llm" && !q.computation).some((q) => q.verification?.status === "checked"), JSON.stringify(r.accepted.map((q) => [q.generatedBy, q.form, q.verification?.status, q.verification?.reason])));
  check("one check request per build", bodies.filter((x) => /independent examiner/.test(x)).length === 1, bodies.length);
  check("the check never sees the answer key", !bodies.filter((x) => /independent examiner/.test(x)).some((x) => /correctAnswer|answerKey/.test(x)));

  verifyMode = "broken";
  bodies.length = 0;
  clearStudyCache();
  const br = await generateQuestions(notes, { mcqCount: 4, theoryCount: 0, marksPerQuestion: 1 });
  check("an unreadable check reply changes nothing: the rules' decision stands", br.accepted.some((q) => q.generatedBy === "llm") && br.accepted.every((q) => q.computation || ["unchecked", undefined].includes(q.verification?.status)));

  process.env.LLM_VERIFY = "off";
  bodies.length = 0;
  clearStudyCache();
  await generateQuestions(notes, { mcqCount: 4, theoryCount: 0, marksPerQuestion: 1 });
  check("LLM_VERIFY=off: no check request", !bodies.some((x) => /independent examiner/.test(x)) && bodies.length >= 1);
} finally {
  fake.close();
  delete process.env.GROQ_API_KEY;
  delete process.env.LLM_API_URL;
  delete process.env.LLM_TIMEOUT_MS;
  delete process.env.LLM_VERIFY;
}

// ---------------------------------------------------------------------------
// The answer fields are never sent while a test is being taken
// (an allowlist: services/questionView.js; both routes use it)
const { questionForAttempt, questionForListing } = await import("../src/services/questionView.js");
const attempts = fs.readFileSync(path.join(here, "..", "src", "routes", "attempts.js"), "utf8");
const tests = fs.readFileSync(path.join(here, "..", "src", "routes", "tests.js"), "utf8");
const stored = { _id: "q", type: "mcq", prompt: "P", options: ["a", "b"], answerKey: "a", supportingExcerpt: "s", keyPoints: ["k"], quality: { ok: true }, verification: { verdict: "a" }, computation: { value: 1 }, explanation: "e", distractorReasons: ["d"], classification: {}, concept: "a", conceptId: "c-1", learningObjective: "know a", cognitiveLevel: "recall", approach: "x", sourceKind: "fact" };
const secret = ["answerKey", "supportingExcerpt", "keyPoints", "quality", "verification", "computation", "explanation", "distractorReasons", "classification", "concept", "conceptId", "learningObjective"];
check(
  "the answer, the quality record, the check, the computation and the concept are kept from the student during a test",
  [questionForAttempt(stored), questionForListing(stored)].every((q) => secret.every((f) => !(f in q))) && /questionForAttempt\(question\)/.test(attempts) && /questions\.map\(questionForListing\)/.test(tests)
);

console.log(failures ? `\n${failures} FAILING CHECK(S)` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
