// Checks for the Groq path measurement (evaluation/groqPath.mjs,
// evaluation/lib/groqPath.js, docs/measurements/groq-path.md). Its numbers go in
// front of faculty, so an error here would misreport the app. Covered: the small
// readers against values worked out by hand, the recorder, and whole runs through
// the real generateQuestions against a stand-in for Groq: a clean reply, a refusal,
// a time-out, a missing model, bad JSON and more, each of which must be counted as
// the right outcome. It needs no key, no network and no git history: the stand-in is
// a local server on a port the system picks. Every word here is made up.
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  byKind, conditionSummary, describeRequest, durationMs, funnelOf, inFlightMs, isDailyStop, limitsSeen, median, outcomeOf, readingOf, readLogLines, readRefusal, recordingFetch, replayReplies, resultsMarkdown, scoreRun, spacedWaitMs,
} from "../evaluation/lib/groqPath.js";
import { oldParser, runGroqPath } from "../evaluation/groqPath.mjs";
import { parseJsonLoose } from "../src/services/llm.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!cond) failures++;
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mindatlas-groq-"));

console.log("\n=== Reading headers and refusals ===");
check("durations in Groq's forms", durationMs("1m26.4s") === 86_400 && durationMs("7.66s") === 7660 && durationMs("120ms") === 120 && durationMs("1h2m3s") === 3_723_000);
check("a duration it cannot read is null, not 0", durationMs("soon") === null && durationMs("") === null && durationMs(null) === null);

const tpm = readRefusal("Rate limit reached for model `m` in organization `org_secret` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 7000, Requested 3000. Please try again in 15s. Need more tokens?");
check("a minute refusal: the limit and its numbers", tpm.limit_name === "TPM" && tpm.limit === 8000 && tpm.used === 7000 && tpm.requested === 3000 && tpm.try_again_ms === 15_000, JSON.stringify(tpm));
const tpd = readRefusal("... on tokens per day (TPD): Limit 200000, Used 199000, Requested 9000. Please try again in 1h2m3.5s.");
check("a daily refusal: the limit and its wait", tpd.limit_name === "TPD" && tpd.try_again_ms === 3_723_500, JSON.stringify(tpd));
const big = readRefusal("Request too large for model `m` on tokens per minute (TPM): Limit 8000, Requested 9000, please reduce your message size");
check("a request too large on its own has no 'used'", big.limit_name === "TPM" && big.used === null && big.limit === 8000, JSON.stringify(big));
check("the organisation in a refusal is not carried over", !JSON.stringify(tpm).includes("org_secret"));
check("no message means no limit named", readRefusal(undefined).limit_name === null);

check("outcomes by status", outcomeOf(200) === "ok" && outcomeOf(404) === "not-found" && outcomeOf(401) === "auth" && outcomeOf(503) === "server-error" && outcomeOf(400) === "bad-status");
check("a 429 says which limit it was", outcomeOf(429, tpm) === "refused-minute" && outcomeOf(429, tpd) === "refused-day" && outcomeOf(429, { limit_name: null }) === "refused-unknown");
check("a 413 on the minute limit is a refusal too", outcomeOf(413, big) === "refused-minute" && outcomeOf(413, { limit_name: null }) === "too-large");

const asked = describeRequest(JSON.stringify({ model: "m", messages: [{ role: "system", content: "You are setting multiple-choice questions SECRETNOTES" }, { role: "user", content: "SECRETNOTES" }] }));
check("a request is told apart by its prompt's opening", asked.kind === "mcq" && asked.model === "m", JSON.stringify(asked));
check("what is kept of a request holds none of its text", !JSON.stringify(asked).includes("SECRETNOTES"));
check("the other two kinds, and anything else", describeRequest(JSON.stringify({ messages: [{ role: "system", content: "You are setting the theory (short-answer)" }] })).kind === "theory" && describeRequest(JSON.stringify({ messages: [{ role: "system", content: "You are an independent examiner" }] })).kind === "verify" && describeRequest("not json").kind === "other");

check("median of an odd and an even list", median([3, 1, 2]) === 2 && median([4, 1, 2, 3]) === 2.5 && median([]) === null);
check("time in the air: overlaps count once, gaps not at all", inFlightMs([{ started_at_ms: 0, ms: 10 }, { started_at_ms: 5, ms: 10 }, { started_at_ms: 30, ms: 5 }]) === 20);
check("spaced wait: at least the gap", spacedWaitMs([], 65) === 65_000);
check("spaced wait: longer if the provider says so", spacedWaitMs([{ limits: { reset_tokens: "1m30s" } }], 65) === 91_000 && spacedWaitMs([{ refusal: { try_again_ms: 100_000 } }], 65) === 101_000);
check("spaced wait: never without end", spacedWaitMs([{ refusal: { try_again_ms: 9_000_000 } }], 65) === 180_000);
check("the daily stop: a daily refusal or a refused key, not a minute refusal", isDailyStop({ outcome: "refused-day" }) && isDailyStop({ outcome: "auth" }) && !isDailyStop({ outcome: "refused-minute" }));

console.log("\n=== The app's log lines ===");
const logged = readLogLines([
  "[testgen] mcq: status=mixed provider=Groq llm=ok byLlm=3 byRules=6 llmDrafts=12 llmRejected=7 llmMs=4100 totalMs=9000",
  "[testgen] theory: status=rule-based-fallback provider=Groq llm=failed fallbackReason=rate-limited byLlm=0 byRules=6 llmDrafts=0 llmRejected=0 llmMs=6200 totalMs=9002",
  "[quality] mcq: accepted=8 revised=2 rejected=4 verify=checked verified=14 reasons=verify:key-mismatch:2 mcq:weak-distractor:2",
  "[quality] theory: accepted=6 revised=0 rejected=0 verify=not-run verified=0",
  "[llm] request failed: 429 rate-limited rate_limit_exceeded",
  "[llm] request errored: timed out",
  "[concepts] mcq: considered=5",
]);
check("[testgen] fields", logged.testgen.mcq.byLlm === 3 && logged.testgen.mcq.llmMs === 4100 && logged.testgen.theory.fallbackReason === "rate-limited" && logged.testgen.theory.totalMs === 9002, JSON.stringify(logged.testgen));
check("[quality] fields, and a reason holding a colon", logged.quality.mcq.verified === 14 && logged.quality.mcq.reasons["verify:key-mismatch"] === 2 && logged.quality.mcq.reasons["mcq:weak-distractor"] === 2, JSON.stringify(logged.quality.mcq));
check("[quality] with no reasons", logged.quality.theory.verify === "not-run" && Object.keys(logged.quality.theory.reasons).length === 0);
check("failed requests are counted from their lines", logged.llm_failures === 2);

console.log("\n=== What became of each draft ===");
const funnel = funnelOf({
  accepted: [{ type: "mcq", generatedBy: "llm", quality: { decision: "accept" } }, { type: "mcq", generatedBy: "llm", quality: { decision: "revise" } }, { type: "theory", generatedBy: "rule-based-fallback", quality: { decision: "accept" } }],
  discarded: [
    { type: "mcq", generatedBy: "llm", discardReason: "not-grounded,mcq:short" },
    { type: "mcq", generatedBy: "llm", quality: { decision: "reject" }, discardReason: "verify:key-mismatch" },
    { type: "mcq", generatedBy: "llm", quality: { decision: "accept" }, discardReason: "duplicate-concept" },
    { type: "mcq", generatedBy: "rule-based-fallback", discardReason: "suitability:formula" },
  ],
});
const f = funnel.mcq.llm;
check("the AI's MCQs by hand: gate 1, evaluator 1, repeat 1, chosen 2 (1 revised)", f.stopped_by_gate === 1 && f.rejected_by_evaluator === 1 && f.duplicates === 1 && f.chosen === 2 && f.chosen_revised === 1, JSON.stringify(f));
check("every reason in a discard counts", f.reasons["not-grounded"] === 1 && f.reasons["mcq:short"] === 1);
check("the rules' drafts are counted apart", funnel.mcq.rules.stopped_by_gate === 1 && funnel.theory.rules.chosen === 1);

console.log("\n=== A reply through the parser ===");
const REPLY = '[{"a":1}]';
check("plain JSON", readingOf(REPLY).reads === "array" && readingOf(REPLY).items === 1);
check("a fenced reply", readingOf("```json\n[{\"a\":1},{\"b\":2}]\n```").items === 2);
check("cut-off JSON cannot be read", readingOf('[{"a":1},{"b"').reads === "unreadable");
check("an object where a list is needed is not an array", readingOf('{"a":1}').reads === "other-json");

const replay = replayReplies(
  [
    { build: "b", seq: 1, kind: "mcq", content: REPLY },
    { build: "b", seq: 2, kind: "mcq", content: String.raw`[{"a":"50\% of it"}]` },
    { build: "b", seq: 3, kind: "theory", content: "not json", finish_reason: "length" },
    { build: "b", seq: 4, kind: "theory", content: "<think>x</think>[1]" },
  ],
  (text) => (text.includes("\\%") ? null : parseJsonLoose(text))
);
check("replay: read by both, lost only by the old one, lost by both", replay.replies === 4 && replay.read_by_both === 2 && replay.lost_only_by_old === 1 && replay.lost_by_both === 1 && replay.lost_only_by_current === 0, JSON.stringify(replay));
check("replay: which backslash the lost one held", replay.escapes_in_old_lost["\\%"] === 1);
check("replay: a reply needing no repair is counted", replay.plain_json === 1);

let realOld = null;
try {
  realOld = await oldParser();
} catch {
  console.log("  (no git history here: the real old parser is skipped)");
}
if (realOld) {
  const before = replayReplies([{ build: "b", seq: 1, kind: "mcq", content: String.raw`[{"a":"50\% of it"}]` }, { build: "b", seq: 2, kind: "mcq", content: String.raw`[{"a":"\frac{1}{2}"}]` }], realOld);
  check("the real old parser loses \\% and keeps \\frac; the current one keeps both", before.lost_only_by_old === 1 && before.read_by_both === 1 && before.same_result === 1, JSON.stringify(before));
}

console.log("\n=== A stand-in for Groq ===");
const NOTES = `# Made-Up Systems Notes

## Loaders

A loader is a system program that places the executable program into main memory and prepares it for execution. The loader also resolves the starting address of the program before control passes to it.

## Linkers

A linker is a system program that combines separately compiled object modules into one executable program. The linker resolves references between the modules so that each call reaches the right address.

## Assemblers

An assembler is a system program that translates assembly language into machine code. The assembler keeps a symbol table so that each label stands for one address.

## Compilers

A compiler is a system program that translates source code in a high level language into object code. The compiler checks the syntax of the program and reports errors before any code is produced.

## Interpreters

An interpreter is a system program that executes source code line by line without producing object code. The interpreter stops at the first error it meets, so the program may run partly.
`;
const docFile = path.join(tmp, "made_up_systems.md");
fs.writeFileSync(docFile, NOTES);

const MCQ_DRAFTS = [
  { topic: "Loaders", concept: "loader", prompt: "Which of the following places the executable program into main memory and prepares it for execution?", options: ["loader", "linker", "assembler", "compiler"], correctAnswer: "loader", supportingExcerpt: "A loader is a system program that places the executable program into main memory and prepares it for execution.", difficulty: "easy" },
  { topic: "Linkers", concept: "linker", prompt: "Which of the following combines separately compiled object modules into one executable program?", options: ["linker", "loader", "assembler", "compiler"], correctAnswer: "linker", supportingExcerpt: "A linker is a system program that combines separately compiled object modules into one executable program.", difficulty: "medium" },
  // not in the notes: the gate must stop this one
  { topic: "Loaders", concept: "made up", prompt: "Which of the following was invented by nobody at all in these notes?", options: ["alpha unit", "beta unit", "gamma unit", "delta unit"], correctAnswer: "alpha unit", supportingExcerpt: "This sentence appears nowhere in the source material given here.", difficulty: "hard" },
];
const THEORY_DRAFTS = [
  { topic: "Assemblers", concept: "assembler", prompt: "Explain how an assembler uses a symbol table.", guidance: "Answer in two or three sentences.", modelAnswer: "An assembler translates assembly language into machine code and keeps a symbol table so that each label stands for one address.", keyPoints: ["translates assembly language", "symbol table", "label stands for one address"], supportingExcerpt: "The assembler keeps a symbol table so that each label stands for one address.", difficulty: "medium" },
];

const TPM_MESSAGE = "Rate limit reached for model `m` in organization `org_secret123` on tokens per minute (TPM): Limit 8000, Used 7500, Requested 3000. Please try again in 15s.";
const TPD_MESSAGE = "Rate limit reached for model `m` in organization `org_secret123` on tokens per day (TPD): Limit 200000, Used 199000, Requested 3000. Please try again in 2h.";
const HEADERS = { "x-ratelimit-limit-requests": "1000", "x-ratelimit-remaining-requests": "999", "x-ratelimit-reset-requests": "1m26.4s", "x-ratelimit-limit-tokens": "8000", "x-ratelimit-remaining-tokens": "5000", "x-ratelimit-reset-tokens": "22.5s" };
const usage = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, completion_tokens_details: { reasoning_tokens: 200 } };

let mode = "clean";
const seenBodies = [];
const seenAuth = [];
const standIn = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seenBodies.push(body);
    seenAuth.push(req.headers.authorization);
    const theory = /You are setting the theory/.test(body);
    const verify = /You are an independent examiner/.test(body);
    const send = (status, payload, extra = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...HEADERS, ...extra });
      res.end(JSON.stringify(payload));
    };
    const reply = (content, more = {}) => send(200, { choices: [{ message: { content, ...more }, finish_reason: "stop" }], usage });
    if (mode === "timeout") return; // never answers
    if (mode === "stall-body") {
      res.writeHead(200, { "Content-Type": "application/json", ...HEADERS });
      res.write('{"choices":[');
      return; // the headers came, the rest never does
    }
    if (mode === "404") return send(404, { error: { message: "The model `m` does not exist. SECRETECHO", type: "invalid_request_error", code: "model_not_found" } });
    if (mode === "401") return send(401, { error: { message: "Invalid API Key", type: "invalid_request_error", code: "invalid_api_key" } });
    if (mode === "429") return send(429, { error: { message: TPM_MESSAGE, type: "tokens", code: "rate_limit_exceeded" } }, { "retry-after": "1" });
    if (mode === "429-day") return send(429, { error: { message: TPD_MESSAGE, type: "tokens", code: "rate_limit_exceeded" } }, { "retry-after": "7200" });
    if (mode === "bad-json") return reply('[{"prompt": "Which of the following ...", "options": ["a", "b"');
    if (mode === "empty-reasoning") return reply("", { reasoning: "thinking about it at length" });
    if (mode === "second-too-busy" && theory) return send(429, { error: { message: TPM_MESSAGE, type: "tokens", code: "rate_limit_exceeded" } }, { "retry-after": "1" });
    if (mode === "verify-refused" && verify) return send(429, { error: { message: TPM_MESSAGE, type: "tokens", code: "rate_limit_exceeded" } }, { "retry-after": "1" });
    if (verify) {
      const items = JSON.parse(JSON.parse(body).messages.at(-1).content.replace(/^<items>\n/, "").replace(/\n<\/items>$/, ""));
      // agrees with the first two, which are the AI's; says the third is ambiguous
      return reply(JSON.stringify(items.map((it, i) => ({ id: it.id, answer: Object.entries(it.options).find(([, o]) => /^(loader|linker)$/.test(o))?.[0] || "A", defensible: [Object.entries(it.options).find(([, o]) => /^(loader|linker)$/.test(o))?.[0] || "A"], ambiguous: i === 2, format: "mcq", implausible: [] }))));
    }
    const drafts = theory ? THEORY_DRAFTS : MCQ_DRAFTS;
    if (mode === "think") return reply(`<think>the notes have [several] parts to consider</think>\n${JSON.stringify(drafts)}`);
    return reply(JSON.stringify(drafts), { reasoning: "a short thought" });
  });
});
await new Promise((r) => standIn.listen(0, "127.0.0.1", r));
const port = standIn.address().port;

process.env.GROQ_API_KEY = "SECRETKEY-not-a-real-one";
process.env.LLM_API_URL = `http://127.0.0.1:${port}/v1/chat/completions`;
process.env.LLM_TIMEOUT_MS = "1000";
process.env.LLM_MODEL = "stand-in-model";
process.env.SEMANTIC_MODEL = "kept-as-it-was";
const fetchBefore = globalThis.fetch;

// The old parser comes from git, and CI's checkout has no history. These runs use a
// stand-in, and the real one is checked above whenever the history is there.
const OLD_PARSER_STAND_IN = async () => (text) => (text.includes("\\%") ? null : parseJsonLoose(text));
const QUIET_RUN = { notes: [docFile], mcq: 4, theory: 2, gap: 0, quiet: true, parser: OLD_PARSER_STAND_IN };
let runCount = 0;
async function run(caseMode, more = {}) {
  mode = caseMode;
  const out = path.join(tmp, `run-${++runCount}-${caseMode}`);
  const results = await runGroqPath({ ...QUIET_RUN, out, pacing: "spaced", rules: false, ...more });
  const read = (f) => (fs.existsSync(path.join(out, f)) ? fs.readFileSync(path.join(out, f), "utf8") : "");
  const rows = (f) => read(f).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const builds = rows("builds.jsonl").slice(1);
  return { out, results, requests: rows("requests.jsonl"), builds, replies: rows("replies.jsonl"), log: read("app.log"), read };
}
const statusOf = (b) => `${b.generation.mcq.status}/${b.generation.theory.status}`;

console.log("\n=== Sanity case: a clean reply ===");
const clean = await run("clean");
const cb = clean.builds[0];
check("three requests: MCQ, theory, blind check", clean.requests.length === 3 && ["mcq", "theory", "verify"].every((k) => clean.requests.some((r) => r.kind === k)), clean.requests.map((r) => r.kind).join(","));
check("every request counted as ok, status 200", clean.requests.every((r) => r.status === 200 && r.outcome === "ok"));
check("tokens as the provider gave them", clean.requests[0].tokens.prompt === 1000 && clean.requests[0].tokens.completion === 500 && clean.requests[0].tokens.reasoning === 200);
check("a reasoning field is noticed, and the reply still reaches the parser", clean.requests.find((r) => r.kind === "mcq").reasoning_chars > 0 && clean.requests.find((r) => r.kind === "mcq").reads === "array");
check("the rate-limit headers are read", clean.requests[0].limits.limit_tokens === "8000" && clean.requests[0].limits.reset_requests === "1m26.4s");
check("the build says the AI answered", cb.generation.mcq.llmOutcome === "ok" && cb.generation.mcq.llmDrafts === 3 && cb.generation.theory.llmDrafts === 1, JSON.stringify(cb.generation.mcq));
check("the blind check ran", cb.log.quality.mcq.verify === "checked" && cb.log.quality.mcq.verified > 0, JSON.stringify(cb.log.quality.mcq));
check("totalMs comes from the log, and is close to the time measured here", cb.total_ms !== null && Math.abs(cb.total_ms - cb.wall_ms) < 500, `${cb.total_ms} / ${cb.wall_ms}`);
const cf = cb.funnel.mcq.llm;
check("the AI's drafts all add up: gate + evaluator + repeats + chosen <= drafts", cf.stopped_by_gate + cf.rejected_by_evaluator + cf.duplicates + cf.chosen <= 3 && cf.stopped_by_gate >= 1, JSON.stringify(cf));
check("the draft not in the notes was stopped by the gate, as not-grounded", cf.reasons["not-grounded"] === 1, JSON.stringify(cf.reasons));
check("an AI question reached the test", cb.by_llm >= 1, String(cb.by_llm));
check("the log line and the returned numbers agree on who wrote what", cb.log.testgen.mcq.byLlm === cb.generation.mcq.byLlm && cb.log.testgen.mcq.byRules === cb.generation.mcq.byRules);

console.log("\n=== Nothing secret is saved ===");
const everything = ["builds.jsonl", "requests.jsonl", "app.log", "results.md", "results.json"].map((f) => clean.read(f)).join("\n");
check("the stand-in really was sent the key and the notes", seenAuth.at(-1) === "Bearer SECRETKEY-not-a-real-one" && seenBodies.some((b) => b.includes("loader")));
check("the key is in no saved file", !(everything + clean.read("replies.jsonl")).includes("SECRETKEY"));
check("the notes' text is in no file but the replies", !everything.includes("places the executable program") && !everything.includes("A loader is"));
check("the replies are saved, for the parser replay", clean.replies.length === 3 && clean.replies.some((r) => r.content.includes("loader")));
check("no request body field was recorded", clean.requests.every((r) => !("body" in r) && !("headers" in r) && !("messages" in r)));

console.log("\n=== Sanity case: a 429 on the minute limit ===");
const refused = await run("429");
const rb = refused.builds[0];
check("each of MCQ and theory is tried twice, as the app does", refused.requests.length === 4 && refused.requests.every((r) => r.kind !== "verify"), refused.requests.map((r) => r.kind).join(","));
check("every request counted as a minute refusal, naming TPM", refused.requests.every((r) => r.status === 429 && r.outcome === "refused-minute" && r.refusal.limit_name === "TPM"));
check("retry-after is read", refused.requests[0].retry_after === "1");
check("the build falls back to the rules, because rate-limited", rb.generation.mcq.status === "rule-based-fallback" && rb.generation.mcq.fallbackReason === "rate-limited" && rb.generation.theory.fallbackReason === "rate-limited", statusOf(rb));
check("the blind check is not asked when the AI answered nothing", rb.log.quality.mcq?.verify === "not-run" || !rb.log.quality.mcq, JSON.stringify(rb.log.quality.mcq));
check("the app logged 4 failed requests, matching the 4 recorded", rb.log.llm_failures === 4, String(rb.log.llm_failures));
check("it still made a test, from the rules", rb.produced > 0 && rb.by_llm === 0, String(rb.produced));
check("the organisation's name is not saved", !(refused.read("requests.jsonl") + refused.read("results.json")).includes("org_secret123"));
check("the run is not stopped: a minute limit is not a daily one", refused.results.stopped === null);

console.log("\n=== Sanity case: a time-out ===");
const timedOut = await run("timeout");
const tb = timedOut.builds[0];
check("each tried twice, each counted as a time-out with no status", timedOut.requests.length === 4 && timedOut.requests.every((r) => r.outcome === "timeout" && r.status === null), timedOut.requests.map((r) => r.outcome).join(","));
check("each ran for about the time limit", timedOut.requests.every((r) => r.ms >= 950 && r.ms < 2000), timedOut.requests.map((r) => r.ms).join(","));
check("the build falls back to the rules, because timeout", tb.generation.mcq.fallbackReason === "timeout" && tb.generation.theory.fallbackReason === "timeout" && tb.by_llm === 0, statusOf(tb));
check("llmMs counts both tries and the wait between", tb.generation.mcq.llmMs >= 2400 && tb.generation.mcq.llmMs < 3500, String(tb.generation.mcq.llmMs));

console.log("\n=== Sanity case: the headers come but the body never does ===");
const stalled = await run("stall-body");
check("counted as a time-out in the body", stalled.requests.length >= 2 && stalled.requests.every((r) => r.outcome === "timeout-in-body"), stalled.requests.map((r) => r.outcome).join(","));
check("the build still falls back to the rules", stalled.builds[0].by_llm === 0 && stalled.builds[0].produced > 0, `the app calls it ${stalled.builds[0].generation.mcq.fallbackReason}`);

console.log("\n=== Sanity case: a 404, the retired model ===");
const missing = await run("404");
const mb = missing.builds[0];
check("not retried, and counted as not found with its code", missing.requests.length === 2 && missing.requests.every((r) => r.status === 404 && r.outcome === "not-found" && r.error_code === "model_not_found"), missing.requests.map((r) => r.outcome).join(","));
check("the build falls back to the rules, as a bad request", mb.generation.mcq.fallbackReason === "bad-request" && mb.generation.theory.fallbackReason === "bad-request", statusOf(mb));
check("no tokens are counted", missing.results.conditions.spaced.tokens_total === 0);
check("what an error echoes is not saved", !missing.read("requests.jsonl").includes("SECRETECHO"));

console.log("\n=== Sanity case: a reply with bad JSON ===");
const broken = await run("bad-json");
const bb = broken.builds[0];
check("the requests themselves succeeded", broken.requests.length === 2 && broken.requests.every((r) => r.status === 200 && r.outcome === "ok"), broken.requests.map((r) => `${r.outcome}/${r.reads}`).join(","));
check("but the replies are counted as not read", broken.requests.every((r) => r.reads === "unreadable") && broken.results.conditions.spaced.replies.not_read === 2);
check("the build falls back to the rules, as an invalid response", bb.generation.mcq.fallbackReason === "invalid-response" && bb.generation.theory.fallbackReason === "invalid-response", statusOf(bb));
check("the replay counts them as lost by both parsers", broken.results.replay.lost_by_both === 2 && broken.results.replay.lost_only_by_old === 0, JSON.stringify(broken.results.replay).slice(0, 120));

console.log("\n=== An answer only in the reasoning field, and <think> tags in the reply ===");
const noContent = await run("empty-reasoning");
check("no text in message.content is counted as empty, though there is reasoning", noContent.requests.every((r) => r.outcome === "empty" && r.reasoning_chars > 0) && noContent.builds[0].generation.mcq.fallbackReason === "empty-response", noContent.requests.map((r) => r.outcome).join(","));
const thinking = await run("think");
check("reasoning inside the reply is noticed", thinking.requests.filter((r) => r.kind !== "verify").every((r) => r.think_tags_in_content));

console.log("\n=== Sanity case: a daily limit stops the run ===");
const secondDoc = path.join(tmp, "made_up_again.md");
fs.writeFileSync(secondDoc, NOTES.replace("Made-Up Systems", "More Made-Up Systems"));
const daily = await run("429-day", { notes: [docFile, secondDoc] });
check("counted as a daily refusal", daily.requests.every((r) => r.outcome === "refused-day"), daily.requests.map((r) => r.outcome).join(","));
check("the run stops after that build and says why", daily.builds.length === 1 && /daily limit.*TPD/.test(String(daily.results.stopped)), String(daily.results.stopped));
check("the app still has only its own one retry each: no more calls", daily.requests.length === 4, String(daily.requests.length));

console.log("\n=== Sanity case: a refused key stops the run ===");
const badKey = await run("401", { notes: [docFile, secondDoc] });
check("counted as auth, not retried, and the run stops", badKey.requests.length === 2 && badKey.requests.every((r) => r.outcome === "auth") && badKey.builds.length === 1 && /refused the key/.test(String(badKey.results.stopped)), String(badKey.results.stopped));

console.log("\n=== Sanity case: one kind refused while the other answers ===");
const partly = await run("second-too-busy");
const pb = partly.builds[0];
check("the MCQs are the AI's, the theory falls back: refused on the limit", pb.generation.mcq.llmOutcome === "ok" && pb.generation.theory.fallbackReason === "rate-limited", statusOf(pb));
check("the blind check still runs, because the AI answered once", pb.log.quality.mcq.verify === "checked");
check("requests by kind add up: 1 MCQ, 2 theory, 1 check", partly.requests.filter((r) => r.kind === "mcq").length === 1 && partly.requests.filter((r) => r.kind === "theory").length === 2 && partly.requests.filter((r) => r.kind === "verify").length === 1);
const noCheck = await run("verify-refused");
check("a refused blind check is reported, and the questions stand", /failed:rate-limited/.test(noCheck.builds[0].log.quality.mcq.verify) && noCheck.builds[0].by_llm >= 1, noCheck.builds[0].log.quality.mcq.verify);

console.log("\n=== A checkout with no git history ===");
const noHistory = await run("clean", {
  parser: async () => {
    throw new Error("no such commit");
  },
});
check("the run still finishes, and says the replay did not run", noHistory.builds.length === 1 && /could not be read from git/.test(noHistory.results.replay.reason) && resultsMarkdown(noHistory.results).includes("Not run: the old parser"), String(noHistory.results.replay?.reason));

console.log("\n=== Rules only against the AI, on the same notes ===");
const both = await run("clean", { rules: true, pacing: "both" });
check("three builds of the document: rules, spaced, back to back", both.builds.length === 3 && both.builds.map((b) => (b.mode === "rules" ? "rules" : b.pacing)).join(",") === "rules,spaced,back-to-back", both.builds.map((b) => b.key).join(" "));
const rulesBuild = both.builds[0];
check("the rules build sent no request", both.requests.every((r) => r.build !== rulesBuild.key) && rulesBuild.by_llm === 0 && rulesBuild.generation.mcq.fallbackReason === "not-configured", String(rulesBuild.generation.mcq.fallbackReason));
check("the key is back after the rules build", both.builds[1].by_llm >= 1 && process.env.GROQ_API_KEY === "SECRETKEY-not-a-real-one");
check("the tables have all three conditions", Object.keys(both.results.conditions).join(",") === "rules,spaced,back-to-back");
check("the rules condition counts no tokens and no requests", both.results.conditions.rules.requests_total === 0 && both.results.conditions.rules.tokens_total === 0);
const md = resultsMarkdown(both.results);
check("the markdown holds the table and no question text", md.includes("## AI against rules only") && md.includes("| Rules only | AI, spaced | AI, back to back |") && !md.includes("executable program"));
const again = await runGroqPath({ ...QUIET_RUN, out: both.out, rules: true, pacing: "both" });
check("a run picked up again adds nothing that is already there", again.per_build.length === 3 && fs.readFileSync(path.join(both.out, "requests.jsonl"), "utf8").trim().split("\n").length === both.requests.length);
const twoRequests = both.requests.length;
let refusedResume = false;
try {
  await runGroqPath({ ...QUIET_RUN, out: both.out, rules: true, seed: 2 });
} catch (err) {
  refusedResume = /use a new --out/.test(err.message);
}
check("a different seed will not be mixed into a saved run", refusedResume && twoRequests === both.requests.length);

console.log("\n=== Waiting between builds ===");
const waits = [];
const paced = await run("clean", { notes: [docFile, secondDoc], gap: 65, wait: async (ms) => waits.push(ms) });
check("spaced: a wait before every build", paced.builds.length === 2 && waits.length === 2 && waits[1] > 60_000 && waits[1] <= 65_000, waits.join(","));
waits.length = 0;
await run("clean", { notes: [docFile, secondDoc], gap: 65, pacing: "back-to-back", wait: async (ms) => waits.push(ms) });
check("back to back: a wait only before the first", waits.length === 1, waits.join(","));

console.log("\n=== Tables from made-up rows ===");
const rows = [
  { key: "a", mode: "ai", pacing: "spaced", doc: "a", asked: { mcq: 9, theory: 6 }, produced: 10, by_llm: 10, by_rules: 0, wall_ms: 5000, total_ms: 4000, generation: { mcq: { status: "llm", llmAttempted: true, llmDrafts: 12, llmMs: 3000, fallbackReason: null }, theory: { status: "llm", llmAttempted: true, llmDrafts: 8, llmMs: 2000, fallbackReason: null } }, log: { quality: { mcq: { verify: "checked", verified: 9, accepted: 5, revised: 1, rejected: 2 }, theory: { accepted: 4, revised: 0, rejected: 0 } } }, funnel: { mcq: { llm: { stopped_by_gate: 3, rejected_by_evaluator: 2, duplicates: 1, chosen: 5, chosen_revised: 1, reasons: { "verify:key-mismatch": 2, "not-grounded": 3 } }, rules: { stopped_by_gate: 0, rejected_by_evaluator: 0, duplicates: 0, chosen: 0, chosen_revised: 0, reasons: {} } }, theory: { llm: { stopped_by_gate: 0, rejected_by_evaluator: 0, duplicates: 0, chosen: 5, chosen_revised: 0, reasons: {} }, rules: { stopped_by_gate: 0, rejected_by_evaluator: 0, duplicates: 0, chosen: 0, chosen_revised: 0, reasons: {} } } } },
  { key: "b", mode: "ai", pacing: "spaced", doc: "b", asked: { mcq: 9, theory: 6 }, produced: 12, by_llm: 0, by_rules: 12, wall_ms: 7000, total_ms: 6000, generation: { mcq: { status: "rule-based-fallback", llmAttempted: true, llmDrafts: 0, llmMs: 6000, fallbackReason: "rate-limited" }, theory: { status: "rule-based-fallback", llmAttempted: true, llmDrafts: 0, llmMs: 5000, fallbackReason: "rate-limited" } }, log: { quality: { mcq: { verify: "not-run", verified: 0, accepted: 6, revised: 0, rejected: 1 }, theory: { accepted: 6, revised: 0, rejected: 0 } } }, funnel: { mcq: { llm: { stopped_by_gate: 0, rejected_by_evaluator: 0, duplicates: 0, chosen: 0, chosen_revised: 0, reasons: {} }, rules: { stopped_by_gate: 0, rejected_by_evaluator: 1, duplicates: 0, chosen: 6, chosen_revised: 0, reasons: { "mcq:x": 1 } } }, theory: { llm: { stopped_by_gate: 0, rejected_by_evaluator: 0, duplicates: 0, chosen: 0, chosen_revised: 0, reasons: {} }, rules: { stopped_by_gate: 0, rejected_by_evaluator: 0, duplicates: 0, chosen: 6, chosen_revised: 0, reasons: {} } } } },
];
const reqs = [
  { build: "a", kind: "mcq", model: "m", status: 200, outcome: "ok", reads: "array", ms: 3000, started_at_ms: 0, tokens: { prompt: 1000, completion: 900, total: 1900, reasoning: 100 }, finish_reason: "stop", limits: { limit_requests: "1000", remaining_requests: "999", reset_requests: "1m26.4s", limit_tokens: "8000", remaining_tokens: "6100" } },
  { build: "a", kind: "theory", model: "m", status: 200, outcome: "ok", reads: "array", ms: 2000, started_at_ms: 0, tokens: { prompt: 1100, completion: 800, total: 1900, reasoning: 50 }, finish_reason: "stop", limits: { limit_requests: "1000", remaining_requests: "998", reset_requests: "2m52.8s", limit_tokens: "8000", remaining_tokens: "4200" } },
  { build: "b", kind: "mcq", model: "m", status: 429, outcome: "refused-minute", ms: 100, started_at_ms: 0, retry_after: "20", refusal: { limit_name: "TPM", limit: 8000, used: 7000, requested: 3000, try_again_ms: 20_000 }, limits: {} },
];
const table = conditionSummary(rows, reqs);
check("median of 4 s and 6 s is 5 s; the slowest is 6 s", table.total_ms.median === 5000 && table.total_ms.slowest === 6000);
check("tokens per build: 3,800 and 0", table.tokens_total === 3800 && table.tokens_per_build.total.median === 1900);
check("requests and refusals", table.requests_total === 3 && table.refused_total === 1);
check("the MCQ pass rate by hand: 12 drafts, 3 stopped, 2 rejected, so 7 passed", table.types.mcq.ai_drafts === 12 && table.types.mcq.ai_passed_filter === 7 && Math.abs(table.types.mcq.ai_pass_share - 7 / 12) < 1e-9, JSON.stringify(table.types.mcq.ai_pass_share));
check("passed but not needed by hand: 12 - 3 - 2 - 1 - 5 = 1", table.types.mcq.ai_passed_but_not_needed === 1);
check("one build all AI, one all rules", table.written.all_ai === 1 && table.written.all_rules === 1);
check("fallback reasons counted", table.types.mcq.fallback_reasons[0].reason === "rate-limited" && table.types.mcq.fallback_reasons[0].n === 1);
check("the blind check: ran once, found 2 key mismatches in the AI's", table.verify.builds_checked === 1 && table.verify.questions_checked === 9 && table.verify.found.ai[0].reason === "verify:key-mismatch" && table.verify.found.ai[0].n === 2);
const kinds = byKind([
  { kind: "theory", status: 200, outcome: "empty", finish_reason: "length", ms: 10, tokens: { prompt: 100, completion: 50, total: 150, reasoning: 49 } },
  { kind: "theory", status: 429, outcome: "refused-minute", ms: 1 },
]);
check("an empty reply's tokens still count in the table by kind", kinds.theory.prompt_tokens.median === 100 && kinds.theory.completion_tokens.median === 50 && kinds.theory.finish_reasons.length === 1 && kinds.theory.requests === 2, JSON.stringify(kinds.theory));
const limits = limitsSeen(reqs).m;
check("the request window from headers: 86.4 s for 1 of 1,000 is 24 hours", Math.abs(limits.request_window_hours - 24) < 0.01, String(limits.request_window_hours));
check("the refusal's numbers are collected", limits.refusals.TPM.count === 1 && limits.refusals.TPM.largest_requested === 3000 && limits.retry_after_seconds.longest === 20);
check("a whole table can be drawn from it", resultsMarkdown({ commit: "x", seed: 1, model: "m", mcq: 9, theory: 6, gap_seconds: 65, ...scoreRun(rows, reqs) }).includes("| Builds | 2 |"));

// ---- fetch stays as it was, and nothing else is recorded
console.log("\n=== The recorder leaves the rest alone ===");
const added = [];
const passthrough = recordingFetch(async () => new Response("ok"), { isLlm: (u) => u.includes("/chat/"), add: (r) => added.push(r) });
const other = await passthrough("http://example.test/model.bin");
check("a request that is not the AI's passes straight through, unrecorded", (await other.text()) === "ok" && added.length === 0);
const asIs = await passthrough("http://example.test/chat/x", { body: "{}" });
const text = await asIs.text();
await passthrough.settle();
check("the app gets the response whole, though a copy was read", text === "ok" && added.length === 1);
check("fetch is restored after a run", globalThis.fetch === fetchBefore);
check("the meaning model's setting is restored after a run", process.env.SEMANTIC_MODEL === "kept-as-it-was", String(process.env.SEMANTIC_MODEL));

standIn.closeAllConnections();
await new Promise((r) => standIn.close(r));
fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures ? `\n${failures} FAILED` : "\nAll Groq path measurement checks passed.");
process.exit(failures ? 1 : 0);
