// Old generator against new, on the same notes, with the rules only (no AI).
//
//   git worktree add ../mindatlas-before <old commit>
//   npm run eval:compare -- --before ../mindatlas-before [files...]
//
// (--before is the root of a checkout of the old code, with its server
// dependencies installed or linked.) With no files, the bundled fixtures and
// samples are used. For each side it reports, per file and in total:
//
//   MCQs          accepted MCQs (the pool a test draws on)
//   forms         how they are asked: cloze (fill in the blank), identify,
//                 describe, acronym, numerical
//   copied        how much of a stem is the source sentence's own words
//                 (share of the stem's content words found in the excerpt)
//   flagged       share of the accepted MCQs the NEW gate (gateDraft +
//                 questionEvaluator) would reject, and the commonest reasons -
//                 an automatic measure, not a human rating
//   distractors   the evaluator's distractor score, mean
//   duplicates    pairs of accepted MCQs in one build that ask the same thing
//   ms            build time
//
// The AI path is not compared here: it needs a GROQ_API_KEY and costs quota.
// Run the same notes through the app with the key set, and compare the
// [quality] and [testgen] log lines, or rate the questions
// (docs/EVALUATION.md).
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.SEMANTIC_MODEL = process.env.SEMANTIC_MODEL || "off";
delete process.env.GROQ_API_KEY;

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.join(here, "..");
const argv = process.argv.slice(2);
const at = argv.indexOf("--before");
if (at < 0) {
  console.error("usage: npm run eval:compare -- --before <root of the old checkout> [files...]");
  process.exit(2);
}
const beforeRoot = path.resolve(argv[at + 1]);
const files = argv.filter((_, i) => i !== at && i !== at + 1);
const defaults = [
  "../sample-notes/networks_unit2.md",
  "test/fixtures/subjects/ee_circuits.md",
  "test/fixtures/subjects/maths_differentiation.md",
  "test/fixtures/subjects/programming_recursion.md",
  "test/fixtures/subjects/spos_linker_loader.txt",
  "test/fixtures/ics_unit3.md",
  "evaluation/samples/dbms_unit4.md",
  "evaluation/samples/distributed_systems_unit1.txt",
].map((f) => path.join(serverRoot, f));

const { notesFromFile } = await import("./lib/ingest.js");
const now = await import("../src/services/testEngine.js");
const { evaluateQuestion } = await import("../src/services/questionEvaluator.js");
const { studyFor, clearStudyCache } = await import("../src/services/keyTerms.js");
const { stem, tokenize } = await import("../src/services/tfidf.js");
const old = await import(pathToFileURL(path.join(beforeRoot, "server", "src", "services", "testEngine.js")).href);
const oldTerms = await import(pathToFileURL(path.join(beforeRoot, "server", "src", "services", "keyTerms.js")).href);

const stems = (s) => new Set(tokenize(String(s || "")).map(stem));
function copied(q) {
  const a = stems(String(q.prompt).replace(/^fill in the blank:\s*/i, ""));
  const b = stems(q.supportingExcerpt);
  if (!a.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / a.size;
}
const formOf = (q) => q.form || (/^fill in the blank/i.test(q.prompt) ? "cloze" : /stand for/i.test(q.prompt) ? "acronym" : /^which of the following/i.test(q.prompt) ? "identify" : "other");

async function judge(notes, mcqs) {
  clearStudyCache();
  const studies = new Map();
  for (const n of notes) studies.set(n, await studyFor(n, { corpus: notes }));
  const { evalCtx, sourceIndex, contextText } = now.qualityContext(notes, studies);
  return mcqs.map((q) => {
    const gate = now.gateDraft({ ...q, correctAnswer: q.answerKey }, { type: "mcq", notes, contextText, sourceIndex, generatedBy: q.generatedBy });
    if (gate.discarded) return { reject: true, reasons: gate.discarded.discardReason.split(","), distractors: null };
    const ev = evaluateQuestion({ ...gate.candidate, generatedBy: q.generatedBy }, evalCtx, { type: "mcq" });
    return { reject: ev.decision === "reject", reasons: ev.problems.filter((p) => p.severity === "hard").map((p) => p.code), distractors: ev.criteria.distractors };
  });
}

async function side(engine, terms, file) {
  const doc = await notesFromFile(file);
  terms.clearStudyCache?.();
  const t0 = Date.now();
  const r = await engine.generateQuestions(doc.notes, { mcqCount: 10, theoryCount: 4, marksPerQuestion: 1 });
  const ms = Date.now() - t0;
  const mcqs = r.accepted.filter((q) => q.type === "mcq");
  const verdicts = await judge(doc.notes, mcqs);
  let dups = 0;
  for (let i = 0; i < mcqs.length; i++) for (let j = i + 1; j < mcqs.length; j++) if (now.sameQuestion(mcqs[i].prompt, mcqs[j].prompt)) dups++;
  return { mcqs, verdicts, ms, dups };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (x) => `${Math.round(x * 100)}%`;
const totals = { before: [], after: [] };
const lines = ["| File | Side | MCQs | Forms | Copied | Flagged by new gate | Distractors | Duplicates | ms |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
for (const f of files.length ? files : defaults) {
  for (const [name, engine, terms] of [["before", old, oldTerms], ["after", now, { clearStudyCache }]]) {
    const s = await side(engine, terms, f);
    totals[name].push(s);
    const forms = {};
    for (const q of s.mcqs) forms[formOf(q)] = (forms[formOf(q)] || 0) + 1;
    const flagged = s.verdicts.filter((v) => v.reject).length;
    lines.push(`| ${path.basename(f)} | ${name} | ${s.mcqs.length} | ${Object.entries(forms).map(([k, v]) => `${k} ${v}`).join(", ")} | ${pct(mean(s.mcqs.map(copied)))} | ${flagged}/${s.mcqs.length} | ${mean(s.verdicts.filter((v) => v.distractors !== null).map((v) => v.distractors)).toFixed(2)} | ${s.dups} | ${s.ms} |`);
  }
}
lines.push("", "| Side | MCQs | Cloze share | Copied | Flagged by new gate | Distractors | Duplicates | Total ms |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const name of ["before", "after"]) {
  const all = totals[name];
  const mcqs = all.flatMap((s) => s.mcqs);
  const verdicts = all.flatMap((s) => s.verdicts);
  const reasons = {};
  for (const v of verdicts.filter((x) => x.reject)) for (const r of v.reasons) reasons[r] = (reasons[r] || 0) + 1;
  const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${v}`).join("; ");
  lines.push(`| ${name} | ${mcqs.length} | ${pct(mcqs.filter((q) => formOf(q) === "cloze").length / Math.max(1, mcqs.length))} | ${pct(mean(mcqs.map(copied)))} | ${verdicts.filter((v) => v.reject).length}/${mcqs.length}${top ? ` (${top})` : ""} | ${mean(verdicts.filter((v) => v.distractors !== null).map((v) => v.distractors)).toFixed(2)} | ${all.reduce((t, s) => t + s.dups, 0)} | ${all.reduce((t, s) => t + s.ms, 0)} |`);
}
console.log(lines.join("\n"));
process.exit(0);
