// Checks for the question-quality evaluation (server/evaluation/,
// docs/EVALUATION.md). An evaluation that is itself wrong is worse than none,
// so this covers the arithmetic (against values worked out independently with
// scipy), the automatic measures, a whole generate -> rate -> score run on the
// sample notes, and that the evaluation builds the same notes the app does.
//
// The last part starts the real server (in-memory database, no API keys) on a
// spare port, like noteContent.test.mjs.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cohenKappa, fisherExact, holm, mannWhitney, parseCsv, seededRandom, toCsv, weightedKappa, wilson } from "../evaluation/lib/stats.js";
import { collectFiles, notesFromFile, readOffTopicLabels } from "../evaluation/lib/ingest.js";
import { automaticMetrics, gateMetrics, isOffTopic, isPartialTerm } from "../evaluation/lib/metrics.js";
import { RATING_COLUMNS, runGeneration } from "../evaluation/generate.mjs";
import { readCell, runScoring } from "../evaluation/score.mjs";
import { isQuestionWorthy } from "../src/services/studyText.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!cond) failures++;
};
const SAMPLES = fileURLToPath(new URL("../evaluation/samples", import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mindatlas-eval-"));

console.log("\n=== Statistics (reference values from scipy) ===");
check("Wilson interval for 8 of 10", JSON.stringify(wilson(8, 10)) === "[0.49,0.943]", JSON.stringify(wilson(8, 10)));
check("Wilson interval stays inside 0..1", wilson(10, 10)[1] === 1 && wilson(0, 10)[0] === 0);
// Cohen (1960)-style table: 20 yes/yes, 5 yes/no, 10 no/yes, 15 no/no -> 0.4
const ka = [...Array(20).fill(1), ...Array(5).fill(1), ...Array(10).fill(0), ...Array(15).fill(0)];
const kb = [...Array(20).fill(1), ...Array(5).fill(0), ...Array(10).fill(1), ...Array(15).fill(0)];
check("Cohen's kappa on the textbook table is 0.4", cohenKappa(ka, kb) === 0.4, String(cohenKappa(ka, kb)));
check("kappa is undefined when both raters say one thing throughout", cohenKappa([1, 1, 1], [1, 1, 1]) === null);
const wa = [1, 2, 3, 4, 5, 3, 2, 4, 5, 1];
const wb = [1, 2, 3, 4, 4, 3, 3, 5, 5, 2];
check("quadratic-weighted kappa", weightedKappa(wa, wb) === 0.889, String(weightedKappa(wa, wb)));
check("  ...is 1 for identical ratings and counts near misses as near", weightedKappa(wa, wa) === 1 && weightedKappa(wa, wb) > cohenKappa(wa, wb));
const mw = mannWhitney([1, 2, 2, 3, 3, 3, 4, 5, 5, 2], [3, 4, 4, 5, 5, 5, 4, 3, 5, 5, 4]);
check("Mann-Whitney U with ties: U=24, p=0.0263", mw.u === 24 && mw.p === 0.0263, JSON.stringify(mw));
check("  ...Cliff's delta is negative when the first group scores lower", mw.delta === -0.564, String(mw.delta));
check("  ...identical groups give p=1, delta 0", mannWhitney([3, 3, 3], [3, 3]).p === 1 && mannWhitney([3, 3, 3], [3, 3]).delta === 0);
check("Fisher's exact test: 8/10 against 1/6 is 0.035", fisherExact(8, 10, 1, 6) === 0.035, String(fisherExact(8, 10, 1, 6)));
check("  ...3/4 against 1/4 is 0.4857", fisherExact(3, 4, 1, 4) === 0.4857, String(fisherExact(3, 4, 1, 4)));
check("  ...no difference gives 1", fisherExact(5, 5, 5, 5) === 1 && fisherExact(0, 7, 0, 9) === 1);
check("Holm correction keeps order and skips missing values", JSON.stringify(holm([0.01, 0.04, 0.03, null, 0.005])) === "[0.03,0.06,0.06,null,0.02]", JSON.stringify(holm([0.01, 0.04, 0.03, null, 0.005])));
check("the same seed gives the same numbers", seededRandom(5)() === seededRandom(5)() && seededRandom(5)() !== seededRandom(6)());

console.log("\n=== CSV ===");
const rows = [{ a: 'He said "no", twice', b: "line one\nline two" }, { a: "plain", b: "" }, { a: "ünïcode › ok", b: "5" }];
const back = parseCsv(toCsv(rows, ["a", "b"]));
check("commas, quotes and line breaks survive a round trip", JSON.stringify(back) === JSON.stringify(rows), JSON.stringify(back));
check("a file saved by Excel (BOM, CRLF, trailing blank row) reads the same", parseCsv('﻿qid,usable\r\nQ001,4\r\n,\r\n').length === 1);

console.log("\n=== Reading a rater's answers ===");
check("yes/no in any usual spelling", readCell("relevant", "Yes") === 1 && readCell("relevant", "n") === 0 && readCell("correct", "1") === 1 && readCell("whole_term", "FALSE") === 0);
check("1-5 only, whole numbers", readCell("usable", "4") === 4 && readCell("usable", "6") === undefined && readCell("usable", "3.5") === undefined && readCell("clear", "good") === undefined);
check("an empty cell is 'not rated', not zero", readCell("usable", " ") === null && readCell("relevant", "") === null);

console.log("\n=== Which files are notes ===");
const files = collectFiles([SAMPLES]).map((f) => path.basename(f));
check("the sample notes are found", files.join(",") === "dbms_unit4.md,distributed_systems_unit1.txt", files.join(","));
check("label files and READMEs are never read as notes", !files.some((f) => /offtopic|readme/i.test(f)));
const messy = path.join(SAMPLES, "distributed_systems_unit1.txt");
const labels = readOffTopicLabels(messy);
check("labels are read from beside the file, comments skipped", labels.length === 10 && !labels.some((l) => l.startsWith("#")), String(labels.length));
check("a file with no labels has none", readOffTopicLabels(path.join(SAMPLES, "dbms_unit4.md")).length === 0);

console.log("\n=== Off-topic labels ===");
check("a sentence containing a label is off topic", isOffTopic("Students should bring their own laptops to every laboratory session.", labels));
check("a piece of a labelled line is off topic too", isOffTopic("Kulkarni for Semester VII students of the 2026-27 batch.", labels));
check("a subject sentence is not", !isOffTopic("A distributed system is a collection of independent computers.", labels));
check("one word is not enough to match a label", !isOffTopic("Distributed", labels));
const gm = gateMetrics(["off one", "off two", "subject a", "subject b", "subject c"], new Set(["off two", "subject a", "subject b"]), ["off one", "off two"]);
check("gate counts: 1 of 2 off-topic dropped, 1 subject sentence lost", gm.counts.off_topic_dropped === 1 && gm.counts.subject_dropped === 1 && gm.precision === 0.5 && gm.recall === 0.5 && gm.subject_kept === 0.667, JSON.stringify(gm));

console.log("\n=== Automatic measures ===");
const reference = [{ term: "distributed computing", key: "distributed computing", words: 2 }];
const cloze = (answer, sentence, extra = {}) => ({
  status: "accepted", type: "mcq", topicId: "n1", file: "a.txt", answerKey: answer, supportingExcerpt: sentence,
  prompt: `Fill in the blank: "${sentence.replace(answer, "_____")}"`, options: [answer, "x", "y", "z"], ...extra,
});
const half = cloze("computing", "Distributed computing divides a large problem into smaller tasks.");
const whole = cloze("Distributed computing", "Distributed computing divides a large problem into smaller tasks.");
check("blanking 'computing' out of 'distributed computing' is a partial term", isPartialTerm(half, reference));
check("blanking the whole term is not", !isPartialTerm(whole, reference));
const theory = { status: "accepted", type: "theory", topicId: "n1", file: "a.txt", prompt: "Define deadlock.", guidance: "2-3 sentences", answerKey: "A deadlock is a cycle of waiting.", supportingExcerpt: "A deadlock is a cycle of waiting." };
const offTopicQ = cloze("November", "The examination for this course will be held in November.", { file: "b.txt" });
const am = automaticMetrics([half, whole, theory, offTopicQ, { ...whole, status: "discarded" }], {
  requested: 6, termsByNote: new Map([["n1", reference]]), labelsByFile: new Map([["b.txt", ["The examination for this course"]], ["a.txt", []]]),
});
check("produced, discarded and yield", am.produced === 4 && am.discarded === 1 && am.yield === 0.667, JSON.stringify([am.produced, am.discarded, am.yield]));
check("partial-term and multi-word rates", am.mcq.partial_term_rate === 0.333 && am.mcq.multi_word_answer_rate === 0.333, JSON.stringify(am.mcq));
check("theory: command word and stated length", am.theory.command_words.Define === 1 && am.theory.states_expected_length_rate === 1);
check("off-topic is judged only inside labelled documents", am.off_topic.questions_in_labelled_documents === 1 && am.off_topic.questions_from_off_topic_text === 1, JSON.stringify(am.off_topic));
check("with no labels at all, off-topic is not reported", automaticMetrics([half], { requested: 1 }).off_topic === undefined);

console.log("\n=== Course notices are not subject matter ===");
check("an exam notice is dropped", !isQuestionWorthy("The examination for this course will be held in the last week of November in the main seminar hall."));
check("a notice to students is dropped", !isQuestionWorthy("Students should bring their own laptops to every laboratory session and sign the sheet."));
check("a sentence about elections being held is kept", isQuestionWorthy("An election is held whenever a process notices that the coordinator has stopped responding."));
check("'in the course of' is ordinary prose", isQuestionWorthy("In the course of a transaction the database may pass through inconsistent intermediate states."));

console.log("\n=== A whole run on the sample notes (rules only, no model) ===");
const outA = path.join(tmp, "a");
const run = await runGeneration({ inputs: [SAMPLES], out: outA, seed: 3, embeddings: false, quiet: true });
check("both built-in strategies ran", run.strategies.join(",") === "tfidf,terms", run.strategies.join(","));
for (const f of ["rating_sheet.csv", "key.csv", "metrics.json", "metrics.md", "questions.json"]) check(`writes ${f}`, fs.existsSync(path.join(outA, f)));
const sheetText = fs.readFileSync(path.join(outA, "rating_sheet.csv"), "utf8");
const sheet = parseCsv(sheetText);
const key = parseCsv(fs.readFileSync(path.join(outA, "key.csv"), "utf8"));
check("the sheet does not say which strategy wrote a question", !/tfidf|terms|embeddings|strategy/i.test(sheetText.split("\r\n")[0]) && !Object.keys(sheet[0]).includes("strategy"));
check("  ...and has the empty rating columns", RATING_COLUMNS.every((c) => c in sheet[0] && sheet.every((r) => r[c] === "")));
check("every question is in the key, and only those", new Set(key.map((k) => k.qid)).size === sheet.length && key.every((k) => sheet.some((r) => r.qid === k.qid)));
check("fill-in-the-blank rows show a blank, four options and the marked answer", sheet.filter((r) => r.type === "fill in the blank").every((r) => r.question.includes("_____") && r.option_d && r.marked_answer));
check("theory rows carry the model answer", sheet.filter((r) => r.type === "theory").every((r) => r.model_answer && !r.marked_answer));
const m = run.metrics.strategies;
check("the current generator never blanks part of a term", m.terms.mcq.partial_term_rate === 0, String(m.terms.mcq.partial_term_rate));
check("  ...asks no 'your notes' theory questions; the baseline always does", m.terms.theory.mentions_the_notes_rate === 0 && m.tfidf.theory.mentions_the_notes_rate === 1);
check("  ...and builds nothing from the labelled off-topic lines", m.terms.off_topic?.questions_from_off_topic_text === 0, JSON.stringify(m.terms.off_topic));
const gate = Object.fromEntries(Object.entries(run.metrics.relevance_gate).map(([k, v]) => [k, v[0]]));
check("the relevance gate is scored against the labels", gate.terms.off_topic === 10 && gate.terms.recall > gate.tfidf.recall, JSON.stringify([gate.tfidf.recall, gate.terms.recall]));
const outB = path.join(tmp, "b");
await runGeneration({ inputs: [SAMPLES], out: outB, seed: 3, embeddings: false, quiet: true });
check("the same seed writes the same sheet", fs.readFileSync(path.join(outB, "rating_sheet.csv"), "utf8") === sheetText);
const outC = path.join(tmp, "c");
await runGeneration({ inputs: [SAMPLES], out: outC, seed: 4, embeddings: false, quiet: true });
check("a different seed shuffles it differently", fs.readFileSync(path.join(outC, "rating_sheet.csv"), "utf8") !== sheetText);
check("the run puts back Math.random and the environment", Math.random !== undefined && Math.random.name === "random" && process.env.SEMANTIC_MODEL !== "off");

console.log("\n=== Scoring two raters ===");
// Ratings made up for the test: questions from the current generator score
// higher, with noise, so there is a difference to find. Not a result.
const strategiesOf = new Map();
for (const k of key) (strategiesOf.get(k.qid) || strategiesOf.set(k.qid, []).get(k.qid)).push(k.strategy);
const columns = Object.keys(sheet[0]);
const fakeRatings = (seed, shift) => {
  const random = seededRandom(seed);
  return sheet.map((row) => {
    const current = strategiesOf.get(row.qid).includes("terms");
    const score = () => Math.max(1, Math.min(5, Math.round((current ? 4.2 : 2.4) + shift + (random() - 0.5) * 2)));
    const blank = row.type === "fill in the blank";
    return { ...row, relevant: random() < (current ? 0.97 : 0.7) ? "yes" : "no", correct: "1", clear: score(), whole_term: blank ? (current ? "y" : random() < 0.5 ? "y" : "n") : "", distractors: blank ? score() : "", usable: score(), comment: "" };
  });
};
const first = fakeRatings(21, 0);
const second = fakeRatings(22, -0.2);
second[0].usable = "good"; // not a number
second[1].clear = ""; // left empty
second.push({ ...second[2], qid: "Q999" }); // not a question of this run
const theoryRow = second.find((r) => r.type === "theory");
theoryRow.whole_term = "y"; // answered where it does not apply
fs.writeFileSync(path.join(outA, "ratings_asha.csv"), toCsv(first, columns));
fs.writeFileSync(path.join(outA, "ratings_rohan.csv"), toCsv(second, columns));
const scored = runScoring({ dir: outA, quiet: true });
check("both raters are found; the empty sheet is not a rater", scored.raters.join(",") === "asha,rohan", scored.raters.join(","));
check("writes results.md and results.json", fs.existsSync(path.join(outA, "results.md")) && fs.existsSync(path.join(outA, "results.json")));
check("every question is scored", scored.questions === sheet.length && scored.questions_rated === sheet.length);
const t = scored.strategies.terms.criteria;
const b = scored.strategies.tfidf.criteria;
check("each strategy is scored on its own questions", t.usable.n === key.filter((k) => k.strategy === "terms").length && b.usable.n === key.filter((k) => k.strategy === "tfidf").length - 0, JSON.stringify([t.usable.n, b.usable.n]));
check("the planted difference is found", t.usable.mean > b.usable.mean + 1 && t.clear.mean > b.clear.mean, JSON.stringify([t.usable.mean, b.usable.mean]));
check("yes/no scores come with an interval inside 0..1", t.relevant.ci95[0] >= 0 && t.relevant.ci95[1] <= 1 && t.relevant.ci95[0] <= t.relevant.share && t.relevant.share <= t.relevant.ci95[1]);
check("blank-only criteria count fill-in-the-blank questions only", t.whole_term.n === key.filter((k) => k.strategy === "terms" && k.type === "mcq").length, String(t.whole_term.n));
const usable = scored.comparisons.find((c) => c.strategy === "terms" && c.criterion === "usable");
check("compared with the baseline by the right test", usable?.test === "Mann-Whitney U" && usable.p < 0.001 && usable.cliffs_delta > 0.5 && scored.comparisons.find((c) => c.criterion === "relevant").test === "Fisher exact", JSON.stringify(usable));
check("corrected p-values are never smaller than raw ones", scored.comparisons.every((c) => c.p_holm >= c.p));
const agree = scored.agreement.find((a) => a.criterion === "usable");
check("agreement is reported per criterion, over questions both rated", agree?.n === sheet.length - 1 && agree.kappa !== null && agree.kind === "quadratic-weighted kappa", JSON.stringify(agree));
check("bad cells are listed and left out, not guessed", scored.problems.length === 2 && /Q\d+ usable = "good"/.test(scored.problems.join("|")) && /Q999/.test(scored.problems.join("|")), scored.problems.join(" | "));
check("the lowest-rated questions are listed for follow-up", scored.lowest_rated.length === 10 && scored.lowest_rated[0].usable <= scored.lowest_rated[9].usable);
const single = runScoring({ dir: outA, ratings: [path.join(outA, "ratings_asha.csv")], quiet: true, write: false });
check("one rater: scores but no agreement, and the report says why", single.raters.length === 1 && single.agreement.length === 0);
let refused = "";
try {
  runScoring({ dir: outB, quiet: true });
} catch (err) {
  refused = err.message;
}
check("no ratings is an error that says what to do", /ratings_<name>\.csv/.test(refused), refused);

// ---------------------------------------------------------------------------
// The evaluation must run on the notes the app would build
// ---------------------------------------------------------------------------
const PORT = 4595;
const API = `http://localhost:${PORT}/api`;
const server = spawn(process.execPath, ["src/index.js"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, PORT: String(PORT), MONGODB_URI: "", DB_FILE: "memory", GROQ_API_KEY: "", SEMANTIC_MODEL: "off", NODE_ENV: "development" },
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
  const post = async (route, body, token) => {
    const res = await fetch(API + route, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return res.json();
  };
  const { token } = await post("/auth/register", { email: `eval${Date.now()}@example.com`, password: "river-Kettle-42x" });

  console.log("\n=== The evaluation reads files the way the app does ===");
  const shape = (n) => JSON.stringify({ title: n.title, rawText: n.rawText, path: n.path || [], content: n.content, keywords: (n.keywords || []).map((k) => k.term ?? k) });
  for (const name of ["dbms_unit4.md", "distributed_systems_unit1.txt"]) {
    // its own subject, as in the evaluation: keywords are judged within the document
    const { subject } = await post("/subjects", { name: `Eval ${name}` }, token);
    const form = new FormData();
    form.append("file", new Blob([fs.readFileSync(path.join(SAMPLES, name))]), name);
    const res = await fetch(`${API}/subjects/${subject._id}/notes`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
    const uploaded = await res.json();
    const fromApp = uploaded.children?.length ? uploaded.children : [uploaded.note];
    const fromEval = (await notesFromFile(path.join(SAMPLES, name))).notes;
    check(`${name}: same number of topic notes`, res.status === 201 && fromApp.length === fromEval.length, `${fromApp.length} vs ${fromEval.length}`);
    const differing = fromEval.findIndex((n, i) => shape(n) !== shape(fromApp[i] || {}));
    check(`${name}: same titles, text, outline, content and keywords`, differing === -1, differing === -1 ? "" : `first difference in note ${differing + 1} ("${fromEval[differing].title}")`);
  }
} catch (err) {
  console.log(`  FAIL  ${err.message}`);
  failures++;
} finally {
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILING CHECK(S)` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
