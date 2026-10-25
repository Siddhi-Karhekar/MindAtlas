// The whole pipeline - file -> notes -> concept records -> tests - measured on
// one evaluation set, old generator against new, rules only (no AI).
//
//   git worktree add ../mindatlas-before <old commit>
//   npm run eval:pipeline -- --before ../mindatlas-before
//   (without --before: the new side only)
//
// The set (see evaluation/pipeline/README.md): the networks unit in four
// formats (Markdown, PDF, Word, PowerPoint: clean digital notes, lists,
// tables), the subject fixtures (formulas, code, an algorithm, a comparison
// table), the samples (definitions, classifications), a misread OCR page and
// a page of sentences missing their context, and a "legacy" note saved before
// formatted content existed.
//
// NOTE METRICS (new side; the old side has no structured representation)
//   provenance     share of record passages found verbatim in the note
//   formulas       share of the notes' formula sentences that a record holds
//   MCQ material   share of MCQ-worthy sentences that belong to an MCQ-eligible
//                  concept (what is worth an MCQ, the plan can reach)
//   structure      process / comparison / list / formula records found
//   OCR flagged    misread files whose reading confidence is below 0.5
//   cross-format   Jaccard of concept ids between the Markdown and the other
//                  formats of the same unit (how stable the records are)
//   complete       share of records with every required field
// TEST METRICS (both sides, same files, 10 MCQ + 4 theory asked)
//   accepted       accepted / drafted (drafted = accepted + discarded)
//   flagged        accepted questions the NEW gate would reject (an automatic
//                  measure; no human rating)
//   2+ answers     of those, for a second defensible option
//   from bad text  questions from the misread / context-less files
//   top concepts   share of the 10 most important eligible concepts that the
//                  test's questions cover (questions mapped to records by
//                  their passage)
//   max topic      largest share of one note in a multi-note file's test
//   repeated way   in 3 consecutive tests, share of questions in tests 2-3 that
//                  ask a concept already asked the same way (cloze, define ...)
//   ms             build time
// What still needs people: correctness of keys, ambiguity as students meet
// it, distractor plausibility, reviewer acceptance (docs/EVALUATION.md).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.SEMANTIC_MODEL = process.env.SEMANTIC_MODEL || "off";
delete process.env.GROQ_API_KEY;

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, "..");
const argv = process.argv.slice(2);
const at = argv.indexOf("--before");
const beforeRoot = at >= 0 ? path.resolve(argv[at + 1]) : null;

const { notesFromFile } = await import("./lib/ingest.js");
const now = await import("../src/services/testEngine.js");
const { evaluateQuestion } = await import("../src/services/questionEvaluator.js");
const { studyFor, clearStudyCache } = await import("../src/services/keyTerms.js");
const { quotableText } = await import("../src/services/studyText.js");
const { recordForExcerpt } = await import("../src/services/conceptRecords.js");
const { mcqWorthy } = await import("../src/services/worthiness.js");
const { conceptOf } = await import("../src/services/questionQuality.js");
const old = beforeRoot ? await import(pathToFileURL(path.join(beforeRoot, "server", "src", "services", "testEngine.js")).href) : null;

const SET = [
  ["../sample-notes/networks_unit2.md", "clean, lists, tables"],
  ["../sample-notes/networks_unit2.pdf", "same unit as PDF"],
  ["../sample-notes/networks_unit2.docx", "same unit as Word"],
  ["../sample-notes/networks_unit2.pptx", "same unit as PowerPoint"],
  ["test/fixtures/subjects/ee_circuits.md", "formulas"],
  ["test/fixtures/subjects/maths_differentiation.md", "LaTeX, derivation"],
  ["test/fixtures/subjects/programming_recursion.md", "code"],
  ["test/fixtures/subjects/spos_linker_loader.txt", "algorithm, comparison table"],
  ["evaluation/samples/dbms_unit4.md", "definitions, classifications"],
  ["evaluation/samples/distributed_systems_unit1.txt", "admin lines, exercises"],
  ["test/fixtures/ics_unit3.md", "definitions, comparisons"],
  ["evaluation/pipeline/ocr_noisy_paging.txt", "misread OCR"],
  ["evaluation/pipeline/missing_context.txt", "missing context"],
].map(([f, what]) => [path.join(server, f), what]);

const pct = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : "-");
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

async function recordsFor(notes) {
  clearStudyCache();
  const studies = new Map();
  for (const n of notes) studies.set(n, await studyFor(n, { corpus: notes }));
  const q = now.qualityContext(notes, studies);
  const built = new Map(notes.map((n) => [n, now.conceptsOfNote(n, studies.get(n), studies.relations)]));
  return { studies, built, ...q };
}

function noteMetrics(notes, { studies, built }) {
  const records = [...built.values()].flatMap((b) => b.records);
  const quoted = notes.map((n) => norm(quotableText(n))).join("\n");
  const passages = records.flatMap((r) => r.source.passages);
  const formulaSentences = notes.flatMap((n) => (studies.get(n)?.sentences || []).filter((s) => s.suit?.kind === "formula").map((s) => s.text));
  const formulaHeld = formulaSentences.filter((t) => records.some((r) => r.source.passages.includes(t)));
  const worthy = notes.flatMap((n) => (studies.get(n)?.sentences || []).filter(mcqWorthy).map((s) => s.text));
  const reached = worthy.filter((t) => records.some((r) => r.suitability.mcq && r.statements.some((x) => x.text === t && x.mcq)));
  const complete = records.filter((r) => r.id && r.key && r.title && r.kind && r.type && r.suitability?.label && typeof r.importance?.score === "number" && r.difficulty?.level && Array.isArray(r.prerequisites) && r.relations && typeof r.confidence === "number" && r.source?.passages?.length);
  return {
    records: records.length,
    excluded: [...built.values()].reduce((t, b) => t + b.excluded.length, 0),
    labels: Object.fromEntries(["both", "mcq", "theory", "context-dependent"].map((l) => [l, records.filter((r) => r.suitability.label === l).length])),
    provenance: passages.length ? passages.filter((p) => quoted.includes(norm(p))).length / passages.length : NaN,
    formulas: formulaSentences.length ? formulaHeld.length / formulaSentences.length : NaN,
    mcqMaterial: worthy.length ? reached.length / worthy.length : NaN,
    structure: ["process", "comparison", "list", "formula"].map((k) => records.filter((r) => r.kind === k).length).join("/"),
    confidence: Math.min(...[...built.values()].map((b) => b.extraction.confidence)),
    complete: records.length ? complete.length / records.length : NaN,
    ids: new Set(records.filter((r) => r.kind === "term").map((r) => r.id)),
  };
}

async function testMetrics(engine, notes, ctx) {
  const t0 = Date.now();
  const tests = [];
  const history = { avoid: [], conceptHistory: new Map(), recentConcepts: new Set(), approachHistory: new Map() };
  for (let k = 0; k < 3; k++) {
    clearStudyCache();
    const out = await engine.generateQuestions(notes, { mcqCount: 10, theoryCount: 4, marksPerQuestion: 1, mcqTarget: 6, theoryTarget: 3, ...history });
    tests.push(out);
    for (const q of out.accepted) {
      history.avoid.push(q.prompt);
      const c = conceptOf(q, q.type);
      const h = history.conceptHistory.get(c) || { count: 0, last: -1 };
      h.count++;
      h.last = k;
      history.conceptHistory.set(c, h);
      if (!history.approachHistory.has(c)) history.approachHistory.set(c, new Set());
      history.approachHistory.get(c).add(q.approach || q.form || (q.type === "theory" ? "theory" : "mcq"));
    }
    history.recentConcepts = new Set(tests.slice(-2).flatMap((t) => t.accepted.map((q) => conceptOf(q, q.type))));
  }
  const ms = Date.now() - t0;
  const first = tests[0];
  const records = [...ctx.built.values()].flatMap((b) => b.records);
  // the NEW gate on whatever was accepted
  const verdicts = first.accepted.map((q) => {
    const g = now.gateDraft({ ...q, correctAnswer: q.answerKey, modelAnswer: q.type === "theory" ? q.answerKey : undefined }, { type: q.type, notes, contextText: ctx.contextText, sourceIndex: ctx.sourceIndex, generatedBy: q.generatedBy });
    if (g.discarded) return { reject: true, codes: g.discarded.discardReason.split(",") };
    const ev = evaluateQuestion({ ...g.candidate, generatedBy: q.generatedBy }, ctx.evalCtx, { type: q.type });
    return { reject: ev.decision === "reject", codes: ev.problems.filter((p) => p.severity === "hard").map((p) => p.code) };
  });
  const top = records.filter((r) => r.suitability.mcq || r.suitability.theory).sort((a, b) => b.importance.score - a.importance.score).slice(0, 10);
  const covered = new Set(first.accepted.map((q) => recordForExcerpt(records, q.supportingExcerpt)?.id).filter(Boolean));
  const byNote = new Map();
  for (const q of first.accepted) byNote.set(String(q.topicId), (byNote.get(String(q.topicId)) || 0) + 1);
  const way = (q) => `${conceptOf(q, q.type)}|${q.approach || q.form || q.type}`;
  const later = tests.slice(1).flatMap((t, i) => t.accepted.map((q) => ({ q, before: new Set(tests.slice(0, i + 1).flatMap((x) => x.accepted.map(way))) })));
  return {
    accepted: first.accepted.length,
    acceptance: first.accepted.length / Math.max(1, first.accepted.length + first.discarded.length),
    flagged: verdicts.filter((v) => v.reject).length,
    multiple: verdicts.filter((v) => v.codes.some((c) => /another-option-also-correct|option-overlaps-answer|equivalent-options/.test(c))).length,
    topConcepts: top.length ? top.filter((r) => covered.has(r.id)).length / top.length : NaN,
    maxTopic: notes.length > 1 && first.accepted.length ? Math.max(...byNote.values()) / first.accepted.length : NaN,
    repeatedWay: later.length ? later.filter((x) => x.before.has(way(x.q))).length / later.length : NaN,
    ms,
  };
}

const rows = [];
let mdIds = null;
for (const [file, what] of SET) {
  const doc = await notesFromFile(file);
  const ctx = await recordsFor(doc.notes);
  const nm = noteMetrics(doc.notes, ctx);
  if (file.endsWith("networks_unit2.md")) mdIds = nm.ids;
  const jaccard = mdIds && /networks_unit2\.(pdf|docx|pptx)$/.test(file) ? [...nm.ids].filter((x) => mdIds.has(x)).length / new Set([...nm.ids, ...mdIds]).size : NaN;
  const after = await testMetrics(now, doc.notes, ctx);
  const before = old ? await testMetrics(old, doc.notes, await recordsFor(doc.notes)) : null;
  rows.push({ file: path.basename(file), what, nm, jaccard, after, before });
}
// a note saved before formatted content existed: rawText and keywords only
{
  const doc = await notesFromFile(SET[0][0]);
  const legacy = doc.notes.slice(0, 6).map(({ content: _c, ...n }) => n);
  const ctx = await recordsFor(legacy);
  const nm = noteMetrics(legacy, ctx);
  const after = await testMetrics(now, legacy, ctx);
  const before = old ? await testMetrics(old, legacy, await recordsFor(legacy)) : null;
  rows.push({ file: "networks (legacy, no content)", what: "legacy note", nm, jaccard: NaN, after, before });
}

const out = [];
out.push("## Note metrics (new: concept records)", "", "| File | Kind | Records (excl.) | both/mcq/theory/ctx | Provenance | Formulas held | MCQ material reached | proc/comp/list/formula | Read confidence | Complete | Same ids as .md |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of rows) {
  const l = r.nm.labels;
  out.push(`| ${r.file} | ${r.what} | ${r.nm.records} (${r.nm.excluded}) | ${l.both}/${l.mcq}/${l.theory}/${l["context-dependent"]} | ${pct(r.nm.provenance)} | ${pct(r.nm.formulas)} | ${pct(r.nm.mcqMaterial)} | ${r.nm.structure} | ${r.nm.confidence} | ${pct(r.nm.complete)} | ${pct(r.jaccard)} |`);
}
out.push("", "## Test metrics, old vs new (rules only)", "", "| File | Side | Accepted | Acceptance | Flagged by new gate | 2+ answers | Top-10 concepts covered | Max topic share | Repeated same way (tests 2-3) | ms |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
const sides = beforeRoot ? ["before", "after"] : ["after"];
for (const r of rows) {
  for (const side of sides) {
    const m = r[side];
    out.push(`| ${r.file} | ${side} | ${m.accepted} | ${pct(m.acceptance)} | ${m.flagged} | ${m.multiple} | ${pct(m.topConcepts)} | ${pct(m.maxTopic)} | ${pct(m.repeatedWay)} | ${m.ms} |`);
  }
}
out.push("", "| Side | Accepted | Flagged by new gate | 2+ answers | From misread / context-less files | Top-10 concepts covered (mean) | Repeated same way (mean) | Total ms |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const side of sides) {
  const ms = rows.map((r) => r[side]);
  const bad = rows.filter((r) => /misread|missing context/.test(r.what)).reduce((t, r) => t + r[side].accepted, 0);
  out.push(`| ${side} | ${ms.reduce((t, m) => t + m.accepted, 0)} | ${ms.reduce((t, m) => t + m.flagged, 0)} | ${ms.reduce((t, m) => t + m.multiple, 0)} | ${bad} | ${pct(mean(ms.map((m) => m.topConcepts).filter(Number.isFinite)))} | ${pct(mean(ms.map((m) => m.repeatedWay).filter(Number.isFinite)))} | ${ms.reduce((t, m) => t + m.ms, 0)} |`);
}
const text = out.join("\n");
console.log(text);
const outIdx = argv.indexOf("--out");
if (outIdx >= 0) fs.writeFileSync(argv[outIdx + 1], text);
process.exit(0);
