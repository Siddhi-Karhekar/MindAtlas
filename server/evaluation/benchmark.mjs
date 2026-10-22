// How well the quality gate tells good MCQs from bad ones, on a labelled set.
//
//   npm run eval:benchmark                      the bundled set (benchmark/)
//   npm run eval:benchmark -- --set <file.json> another labelled set
//   npm run eval:benchmark -- --json <out.json> also write the results
//
// For every labelled question it runs
//   OLD  the gates as they were before the quality evaluation layer:
//        grounding, questionQuality.validateQuestion and MCQ suitability
//        (testEngine.gateDraft, with no numerical exemption), and
//   NEW  the same gates, then questionEvaluator.evaluateQuestion
// and reports, for each: bad questions caught (recall), good questions
// wrongly rejected (false rejection rate), and what was caught per defect.
// It then sweeps the soft-score threshold (QUALITY_MIN_SCORE) to show how
// the trade-off moves - the way to calibrate it once people have rated a
// set of real questions (docs/QUESTION_QUALITY.md, "Calibrating").
//
// The bundled labels are provisional (see the set's "about"): a number from
// this script is a regression check, not a measurement of quality, until
// people have labelled the questions.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.SEMANTIC_MODEL = process.env.SEMANTIC_MODEL || "off";
delete process.env.GROQ_API_KEY;

const here = path.dirname(fileURLToPath(import.meta.url));
const { notesFromFile } = await import("./lib/ingest.js");
const { studyFor, clearStudyCache } = await import("../src/services/keyTerms.js");
const { gateDraft, qualityContext } = await import("../src/services/testEngine.js");
const { evaluateQuestion } = await import("../src/services/questionEvaluator.js");

function parseArgs(argv) {
  const o = { set: path.join(here, "benchmark", "mcq_benchmark.json"), json: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--set") o.set = argv[++i];
    else if (argv[i] === "--json") o.json = argv[++i];
  }
  return o;
}

/** Judge every item of a labelled set, old and new. Exported for the tests. */
export async function runBenchmark(setPath) {
  const set = JSON.parse(fs.readFileSync(setPath, "utf8"));
  const doc = await notesFromFile(path.join(path.dirname(setPath), set.notes));
  clearStudyCache();
  const studies = new Map();
  for (const n of doc.notes) studies.set(n, await studyFor(n, { corpus: doc.notes }));
  const { evalCtx, sourceIndex, contextText } = qualityContext(doc.notes, studies);
  const rows = [];
  for (const it of set.items) {
    const draft = { ...it, correctAnswer: it.answerKey };
    const env = { type: "mcq", notes: doc.notes, contextText, sourceIndex, generatedBy: it.generatedBy || "llm" };
    // OLD: the gates without what this change added (no computed answers)
    const { computation: _c, ...plain } = draft;
    const old = gateDraft(plain, env);
    const gate = gateDraft(draft, env);
    let decision;
    let reasons;
    let score = null;
    let ev = null;
    if (gate.discarded) {
      decision = "reject";
      reasons = gate.discarded.discardReason.split(",");
    } else {
      ev = evaluateQuestion({ ...gate.candidate, generatedBy: it.generatedBy || "llm" }, evalCtx, { type: "mcq" });
      decision = ev.decision;
      score = ev.score;
      reasons = ev.problems.filter((p) => p.severity === "hard").map((p) => p.code);
    }
    rows.push({
      id: it.id,
      label: it.label,
      defect: it.defect || null,
      old: old.discarded ? "reject" : "accept",
      oldReasons: old.discarded ? old.discarded.discardReason.split(",") : [],
      new: decision === "reject" ? "reject" : "accept",
      newReasons: reasons,
      score,
      hardFail: Boolean(gate.discarded) || Boolean(ev?.problems.some((p) => p.severity === "hard" && p.code !== "quality:low-score")),
    });
  }
  return { set, rows, summary: summarise(rows) };
}

function rates(rows, key) {
  const bad = rows.filter((r) => r.label === "bad");
  const good = rows.filter((r) => r.label === "good");
  const caught = bad.filter((r) => r[key] === "reject").length;
  const wrong = good.filter((r) => r[key] === "reject").length;
  return { badCaught: caught, bad: bad.length, recall: bad.length ? caught / bad.length : 0, goodRejected: wrong, good: good.length, falseRejection: good.length ? wrong / good.length : 0 };
}

function summarise(rows) {
  const byDefect = {};
  for (const r of rows.filter((x) => x.label === "bad")) {
    const d = (byDefect[r.defect] ||= { n: 0, old: 0, new: 0 });
    d.n++;
    if (r.old === "reject") d.old++;
    if (r.new === "reject") d.new++;
  }
  // the soft threshold: questions with no hard failure, decided by score alone
  const sweep = [];
  for (let t = 0.4; t <= 0.851; t += 0.05) {
    const decide = (r) => (r.hardFail || (r.score !== null && r.score < t) ? "reject" : "accept");
    const x = rates(rows.map((r) => ({ ...r, swept: decide(r) })), "swept");
    sweep.push({ threshold: Number(t.toFixed(2)), ...x });
  }
  return { old: rates(rows, "old"), new: rates(rows, "new"), byDefect, sweep };
}

const pct = (x) => `${Math.round(x * 100)}%`;
export function report({ rows, summary }) {
  const lines = [];
  lines.push("| Gate | Bad questions caught | Good questions wrongly rejected |", "| --- | --- | --- |");
  for (const k of ["old", "new"]) {
    const s = summary[k];
    lines.push(`| ${k.toUpperCase()} | ${s.badCaught}/${s.bad} (${pct(s.recall)}) | ${s.goodRejected}/${s.good} (${pct(s.falseRejection)}) |`);
  }
  lines.push("", "| Defect | Items | Caught by OLD | Caught by NEW |", "| --- | --- | --- | --- |");
  for (const [d, x] of Object.entries(summary.byDefect)) lines.push(`| ${d} | ${x.n} | ${x.old} | ${x.new} |`);
  lines.push("", "| QUALITY_MIN_SCORE | Bad caught | Good rejected |", "| --- | --- | --- |");
  for (const s of summary.sweep) lines.push(`| ${s.threshold} | ${pct(s.recall)} | ${pct(s.falseRejection)} |`);
  lines.push("", "| Item | Label | OLD | NEW | Score | NEW reasons |", "| --- | --- | --- | --- | --- | --- |");
  for (const r of rows) lines.push(`| ${r.id} | ${r.label}${r.defect ? ` (${r.defect})` : ""} | ${r.old} | ${r.new} | ${r.score ?? "-"} | ${r.newReasons.join(", ") || "-"} |`);
  return lines.join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const opts = parseArgs(process.argv.slice(2));
  const out = await runBenchmark(opts.set);
  console.log(report(out));
  if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(out, null, 2));
  process.exit(0);
}
