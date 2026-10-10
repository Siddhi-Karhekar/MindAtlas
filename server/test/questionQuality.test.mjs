// Checks for what a question is built from and how it is worded:
//   - only subject matter is asked about (studyText.js): never the college
//     name, an administrative line, an exercise or a contents entry;
//   - key terms are whole terms (keyTerms.js), so a blank hides
//     "distributed computing" and never leaves "distributed _____";
//   - theory questions read like a question paper (testEngine.js);
//   - the embedding model is optional (embeddings.js): everything works
//     without it, and with it relevance is judged by meaning.
// Runs with no server, no network and no model: a small stand-in embedder
// exercises the model path. If the real model is installed
// (`npm run semantic:install`), one extra section runs against it.
import { blocksFromPlainText, normalizeContent } from "../src/services/documentStructure.js";
import { candidateSentences, isQuestionWorthy, keepRelevant, quotableText } from "../src/services/studyText.js";
import { clearStudyCache, contentRuns, extractTerms, studyFor, termKey, termPattern } from "../src/services/keyTerms.js";
import { centroid, cosine, getEmbedder, semanticStatus, setEmbedderForTests } from "../src/services/embeddings.js";
import { generateQuestions } from "../src/services/testEngine.js";
import { computeTfidf } from "../src/services/tfidf.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + String(detail).replace(/\s+/g, " ").slice(0, 160) : ""}`);
  if (!cond) failures++;
};
// Questions the grounding gate refused. (Others are left out as repeats of
// one already in the test, and carry a discardReason: see testEngine.pickFresh.)
const gateFailures = (r) => r.discarded.filter((q) => !q.discardReason).length;

const noteFrom = (id, title, text, extra = {}) => ({
  _id: id,
  title,
  rawText: text,
  content: normalizeContent(blocksFromPlainText(text), { title }),
  keywords: computeTfidf(text, []).keywords,
  path: [],
  ...extra,
});

// A note the way students actually upload them: a cover block, the subject,
// stray administrative lines, then the exercises and references.
const MESSY = `Pune Institute of Computer Technology
Department of Computer Engineering
Distributed Systems - Unit 1
Prepared by Prof. A. B. Kulkarni for Semester VII students of the 2026-27 batch.

Introduction to Distributed Computing

A distributed system is a collection of independent computers that appears to its users as a single coherent system. Distributed computing divides a large problem into smaller tasks that are solved by many computers communicating over a network. The computers in a distributed system coordinate their actions only by passing messages.

Students should bring their own laptops to every laboratory session and sign the attendance sheet before leaving.

Characteristics

- Resource sharing: hardware, software and data are shared among the nodes of the system.
- Concurrency: several processes execute at the same time on different nodes.
- Fault tolerance: the distributed system continues to operate correctly when some of its nodes fail.
- Scalability: the system can grow by adding more nodes without a loss of performance.

Message Passing

In message passing, processes communicate by sending and receiving messages over a communication channel. Synchronous message passing blocks the sender until the receiver has accepted the message. Asynchronous message passing lets the sender continue immediately, and the message is stored in a buffer until the receiver is ready.

Remote Procedure Call (RPC) hides message passing behind an ordinary procedure call. A client stub packs the arguments into a message, which is known as marshalling, and sends it to the server.

Logical Clocks

A logical clock assigns a number to each event so that the order of events can be determined without a shared physical clock. Lamport's logical clock increments its counter before each event and attaches the counter to every message. Vector clocks extend this idea so that concurrent events can be detected.

The examination for this course will be held in the last week of November in the main seminar hall.

Exercises

1. Write a program to implement the Bully election algorithm.
2. Calculate the speedup obtained when eight processors are used instead of one.
3. Explain the difference between synchronous and asynchronous message passing.
4. What is marshalling in a remote procedure call?

References: Tanenbaum, A. S. and van Steen, M. Distributed Systems: Principles and Paradigms.`;
const messy = noteFrom("n1", "Distributed Systems - Unit 1", MESSY);
const NOT_SUBJECT = /institute|department|prepared by|kulkarni|semester|laptop|attendance|examination|seminar hall|bully|speedup|tanenbaum|write a program|calculate/i;

console.log("\n=== Rules: what is never subject matter ===");
for (const line of [
  "Prepared by Prof. A. B. Kulkarni for Semester VII students of the 2026-27 batch.",
  "Pune Institute of Technology is affiliated to the University of Pune and was founded long ago.",
  "Write a program to implement the Bully election algorithm.",
  "Calculate the speedup obtained when eight processors are used instead of one.",
  "What is marshalling in a remote procedure call?",
  "Assignment 3 on logical clocks carries 10 marks and is due on Friday next week.",
  "Contact the course coordinator at coordinator@example.edu for any further details about it.",
]) check(`rejected: ${line.slice(0, 48)}...`, !isQuestionWorthy(line));
check("accepted: a statement of fact", isQuestionWorthy("A logical clock assigns a number to each event so that their order can be determined."));
check("accepted: 'When ...' opening a statement", isQuestionWorthy("When a collision occurs, both stations stop sending and wait for a random time."));
check("a list entry may end without a full stop", isQuestionWorthy("Shared lock: the transaction can read the item but cannot write it", { listEntry: true }));
check("...but a short heading-like line may not", !isQuestionWorthy("Types of message passing", { listEntry: true }));

console.log("\n=== Structure: sentences come from paragraphs and list entries ===");
const cands = candidateSentences(messy).map((s) => s.text);
check("headings are not sentences", !cands.some((s) => /^(Message Passing|Logical Clocks|Characteristics)$/.test(s)));
check("the cover block is gone", !cands.some((s) => /Institute|Department|Prepared by/.test(s)));
check("the exercises are gone", !cands.some((s) => /Bully|speedup|marshalling in a remote/.test(s)));
check("list entries are kept, with the term they open with",
  candidateSentences(messy).find((s) => s.text.startsWith("Fault tolerance:"))?.lead === "Fault tolerance");
check("each sentence knows its section", candidateSentences(messy).find((s) => s.text.startsWith('Synchronous message'))?.section === "Message Passing");
check("what may be quoted includes the display text", quotableText(noteFrom("t", "T", "Uses **Ethernet** frames to carry data.")).includes("Uses Ethernet frames"));

console.log("\n=== Key terms are whole terms ===");
check("a run ends at a verb or function word", contentRuns("The lock manager decides whether a request can be granted.").map((r) => r.map((w) => w.lower).join(" ")).join("|") === "lock manager|request|granted",
  contentRuns("The lock manager decides whether a request can be granted.").map((r) => r.map((w) => w.lower).join(" ")).join("|"));
check("singular and plural are one term", termKey("Block Ciphers") === "block cipher" && termKey("vector clocks") === termKey("vector clock"));
check("the pattern finds either form, as whole words", termPattern("vector clock", "i").test("Vector clocks extend this.") && !termPattern("clock", "i").test("the clockwork"));
const ruleStudy = await studyFor(messy, { corpus: [messy], embedder: null });
const keys = ruleStudy.terms.map((t) => t.key);
check("multi-word terms are found", ["distributed system", "message passing", "logical clock"].every((k) => keys.includes(k)), keys.join(", "));
check("'distributed computing' is one term (it is a heading)", keys.includes("distributed computing"));
check("'computing' alone is not a term: it only appears inside the longer one", !keys.includes("computing"));
check("a phrase spelled out before its acronym is a term", ruleStudy.terms.find((t) => t.abbr === "RPC")?.term === "Remote Procedure Call", JSON.stringify(ruleStudy.terms.find((t) => t.abbr)));
check("terms opening a list entry are marked", ruleStudy.terms.find((t) => t.key === "fault tolerance")?.marks.includes("lead"));
check("a sentence-initial capital is not kept", ruleStudy.terms.find((t) => t.key === "distributed computing")?.term === "distributed computing");
check("nothing administrative becomes a term", !ruleStudy.terms.some((t) => NOT_SUBJECT.test(t.term)), keys.join(", "));
check("off-topic sentences are dropped even without the model", !ruleStudy.sentences.some((s) => /laptops|examination/.test(s.text)));
const nested = extractTerms({ title: "T", rawText: "" }, [
  { text: "Cloud computing rents servers on demand." },
  { text: "With cloud computing, the provider owns the hardware." },
  { text: "The provider bills by the hour." },
]);
check("a word counted only inside a longer term is dropped", nested.some((t) => t.key === "cloud computing") && !nested.some((t) => t.key === "computing"), nested.map((t) => t.key).join(", "));

// ---------------------------------------------------------------------------
// The model path, with a stand-in: each text becomes a normalised bag of its
// content words, so texts sharing words are close. Crude, but it behaves like
// the real model where it matters here - subject sentences share vocabulary
// with the topic and administrative ones do not.
// ---------------------------------------------------------------------------
const DIM = 256;
const hash = (w) => [...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % DIM;
const STOP = new Set("the a an of to in on for and or is are was by that its with as be this it at from into when so can".split(" "));
const fake = async (texts) =>
  texts.map((t) => {
    const v = new Array(DIM).fill(0);
    for (const w of String(t).toLowerCase().match(/[a-z]{3,}/g) || []) if (!STOP.has(w)) v[hash(w.replace(/s$/, ""))] += 1;
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  });

console.log("\n=== The embedding model is optional ===");
const saved = process.env.SEMANTIC_MODEL;
process.env.SEMANTIC_MODEL = "off";
check("SEMANTIC_MODEL=off: no embedder, and it says why", (await getEmbedder()) === null && semanticStatus().state === "off");
if (saved === undefined) delete process.env.SEMANTIC_MODEL;
else process.env.SEMANTIC_MODEL = saved;

setEmbedderForTests(fake);
clearStudyCache();
const embedder = await getEmbedder();
check("an embedder, once ready, is returned at once", embedder !== null && semanticStatus().active === true);
const [a, b, c] = await embedder.embed(["message passing between processes", "processes pass messages", "attendance sheet in the seminar hall"]);
check("vectors are normalised and comparable", Math.abs(cosine(a, a) - 1) < 1e-6 && cosine(a, b) > cosine(a, c));
check("a centroid is itself a unit vector", Math.abs(Math.hypot(...centroid([a, b])) - 1) < 1e-6);

console.log("\n=== Meaning: relevance and ranking with the model ===");
const withAdmin = [...candidateSentences(messy)];
const kept = await keepRelevant(messy, withAdmin, embedder);
check("administrative sentences are dropped by meaning", !kept.some((s) => /laptops|examination/.test(s.text)), `${withAdmin.length} -> ${kept.length}`);
check("subject sentences survive", kept.some((s) => /In message passing, processes/.test(s.text)) && kept.length >= Math.ceil(withAdmin.length / 2), `${kept.length} of ${withAdmin.length}`);
check("every kept sentence has a relevance score", kept.every((s) => typeof s.relevance === "number"));
const loose = Array.from({ length: 6 }, (_, i) => ({ text: `Unrelated statement number ${i} about ${["tea", "rain", "chess", "wool", "sand", "maps"][i]} and nothing else.`, kind: "para" }));
check("a loose-knit note is never emptied", (await keepRelevant({ title: "Misc", rawText: "" }, loose, embedder)).length >= 3);
const semStudy = await studyFor(messy, { corpus: [messy], embedder });
check("terms carry a meaning score and stay whole", semStudy.semantic && semStudy.terms.every((t) => typeof t.semantic === "number") && semStudy.terms.some((t) => t.key === "message passing"));

// ---------------------------------------------------------------------------
// End to end: a whole test from the messy note
// ---------------------------------------------------------------------------
const dbms = [
  noteFrom("d1", "Lock-Based Protocols", `A **lock** is a mechanism to control concurrent access to a data item. A transaction must hold a lock on an item before it can read or write that item.

Lock modes:
- **Shared lock** (S): the transaction can read the item but cannot write it.
- **Exclusive lock** (X): the transaction can both read and write the item.

The **two-phase locking** protocol ensures conflict serializable schedules. In the growing phase a transaction may obtain locks but may not release any. Strict two-phase locking holds all exclusive locks until the transaction commits.`),
  noteFrom("d2", "Deadlock Handling", `A system is in a **deadlock** state if every transaction in a set is waiting for another transaction in the set. A deadlock can be prevented in advance or detected and broken after it occurs.

Prevention schemes:
- Wait-die: an older transaction waits for a younger one, and a younger one is rolled back.
- Wound-wait: an older transaction wounds a younger one and forces it to roll back.

The system maintains a wait-for graph and searches the wait-for graph for a cycle. When a cycle is found, a victim transaction is rolled back to break the deadlock.`),
];

for (const mode of ["rules", "embeddings"]) {
  console.log(`\n=== A whole test, ranked by ${mode} ===`);
  setEmbedderForTests(mode === "embeddings" ? fake : null);
  if (mode === "rules") process.env.SEMANTIC_MODEL = "off";
  else if (saved === undefined) delete process.env.SEMANTIC_MODEL;
  else process.env.SEMANTIC_MODEL = saved;
  clearStudyCache();
  delete process.env.GROQ_API_KEY;

  const r = await generateQuestions([messy], { mcqCount: 8, theoryCount: 6, marksPerQuestion: 2 });
  const mcq = r.accepted.filter((q) => q.type === "mcq");
  const theory = r.accepted.filter((q) => q.type === "theory");
  check("reports how it ranked", r.rankedBy === mode, r.rankedBy);
  check("questions were produced and none failed the grounding gate", mcq.length >= 6 && theory.length >= 4 && gateFailures(r) === 0, `${mcq.length} mcq, ${theory.length} theory, ${gateFailures(r)} failed the gate`);

  const offTopic = r.accepted.filter((q) => NOT_SUBJECT.test(`${q.prompt} ${q.answerKey} ${(q.options || []).join(" ")}`));
  check("nothing is asked about the college, admin lines or exercises", offTopic.length === 0, offTopic[0]?.prompt);
  check("every excerpt is the note's own words", r.accepted.every((q) => quotableText(messy).replace(/\s+/g, " ").includes(q.supportingExcerpt.replace(/\s+/g, " "))));

  const halfTerm = mcq.filter((q) => /distributed _____|_____ passing|message _____[^,]|logical _____|_____ clock|fault _____|_____ tolerance|resource _____|_____ sharing/i.test(q.prompt));
  check("no blank hides half a term", halfTerm.length === 0, halfTerm[0]?.prompt);
  check("at least one answer is a multi-word term", mcq.some((q) => q.answerKey.trim().split(/\s+/).length >= 2), mcq.map((q) => q.answerKey).join(" | "));
  check("the answer never still shows in its own question", mcq.every((q) => !termPattern(q.answerKey, "i").test(q.prompt)), mcq.find((q) => termPattern(q.answerKey, "i").test(q.prompt))?.prompt);
  check("four distinct options, one of them the answer", mcq.every((q) => q.options.length === 4 && new Set(q.options.map((o) => o.toLowerCase())).size === 4 && q.options.includes(q.answerKey)));
  check("no placeholder options", mcq.every((q) => !q.options.some((o) => /related term \d/.test(o))), mcq.flatMap((q) => q.options).find((o) => /related term/.test(o)));
  check("no option appears in its own sentence", mcq.every((q) => q.options.every((o) => o === q.answerKey || !termPattern(o, "i").test(q.supportingExcerpt))));
  check("the same term is not the answer twice", new Set(mcq.map((q) => termKey(q.answerKey))).size === mcq.length, mcq.map((q) => q.answerKey).join(" | "));

  check("theory questions open with an examiner's command word", theory.every((q) => /^(Define|Explain|List|Differentiate|State|Describe)\b/.test(q.prompt)), theory.map((q) => q.prompt).join(" | "));
  check("...and never say 'your notes'", theory.every((q) => !/your notes|the notes|in your own words/i.test(q.prompt)));
  check("each says how much to write", theory.every((q) => typeof q.guidance === "string" && q.guidance.length > 5), theory.map((q) => q.guidance).join(" | "));
  check("each has a model answer and key points to grade against", theory.every((q) => q.answerKey?.length > 20 && q.keyPoints?.length >= 1));
  check("a 'Define' answer is a sentence that says what the term is",
    theory.filter((q) => q.prompt.startsWith('Define')).every((q) => /\b(is|are)\s+(an?|the)\b|:\s/.test(q.answerKey)), theory.find((q) => q.prompt.startsWith('Define'))?.answerKey);
  check("the list under 'Characteristics' becomes a list question", theory.some((q) => /^List and briefly explain the characteristics of Distributed Systems\.$/.test(q.prompt)), theory.map((q) => q.prompt).join(" | "));
  check("MCQ guidance stays empty; marks are carried", mcq.every((q) => q.guidance === null && q.marks === 2));

  const two = await generateQuestions(dbms, { mcqCount: 6, theoryCount: 8, marksPerQuestion: 5 });
  const prompts = two.accepted.map((q) => q.prompt);
  check("two terms of the same kind give a 'Differentiate' question",
    prompts.some((p) => /^Differentiate between .(shared|exclusive) lock. and .(shared|exclusive) lock.\.$/.test(p)), prompts.filter((p) => !p.startsWith('Fill')).join(" | "));
  check("bold terms from the notes are asked about", two.accepted.some((q) => /two-phase locking|deadlock/i.test(q.answerKey + q.prompt)));
  check("questions name the topic they came from", two.accepted.every((q) => ["Lock-Based Protocols", "Deadlock Handling"].includes(q.topic)));
}

console.log("\n=== A note with almost nothing in it still works ===");
setEmbedderForTests(null);
process.env.SEMANTIC_MODEL = "off";
clearStudyCache();
const tiny = noteFrom("t1", "Osmosis", "Osmosis is the movement of water across a membrane. Water moves toward the region of higher solute concentration.");
const small = await generateQuestions([tiny], { mcqCount: 2, theoryCount: 1, marksPerQuestion: 1 });
check("no crash, and whatever is produced is grounded", gateFailures(small) === 0 && small.accepted.every((q) => tiny.rawText.includes(q.supportingExcerpt)), `${small.accepted.length} accepted`);
const empty = await generateQuestions([noteFrom("e1", "Cover", "Pune Institute of Computer Technology\n\nDepartment of Computer Engineering")], { mcqCount: 2, theoryCount: 2, marksPerQuestion: 1 });
check("a note that is only a cover page produces no questions", empty.accepted.length === 0, empty.accepted[0]?.prompt);

// ---------------------------------------------------------------------------
// The real model, when it is installed (skipped otherwise - e.g. in CI)
// ---------------------------------------------------------------------------
console.log("\n=== The real model (only if installed) ===");
if (saved === undefined) delete process.env.SEMANTIC_MODEL;
else process.env.SEMANTIC_MODEL = saved;
clearStudyCache();
const real = saved && /^(off|false|0|no)$/i.test(saved) ? null : await getEmbedder({ waitMs: 30_000 });
if (!real) {
  console.log(`  SKIP  real-model checks  -> ${semanticStatus().reason}`);
} else {
  const [topic, on, off] = await real.embed([
    "Distributed systems: message passing and logical clocks",
    "In message passing, processes communicate by sending and receiving messages.",
    "Students should bring their own laptops to every laboratory session.",
  ]);
  check(`${real.model}: a subject sentence is far closer to the topic than an admin line`, cosine(topic, on) > cosine(topic, off) + 0.2, `${cosine(topic, on).toFixed(2)} vs ${cosine(topic, off).toFixed(2)}`);
  const r = await generateQuestions([messy], { mcqCount: 6, theoryCount: 4, marksPerQuestion: 2 });
  check("a test built with it stays on the subject", r.rankedBy === "embeddings" && r.accepted.length >= 8 && !r.accepted.some((q) => NOT_SUBJECT.test(q.prompt + q.answerKey)));
}

console.log(failures ? `\n${failures} FAILING CHECK(S)` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
