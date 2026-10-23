// Key-term evaluation: how well the platform finds the key terms of a note,
// against terms marked by hand (evaluation/keyterms/labels.json).
//
//   npm run eval:keyterms                         this checkout only
//   npm run eval:keyterms -- --before ../old/server --out report.md
//
// Each labelled document is turned into notes the way an upload is (split at
// its headings), then three outputs are scored for every note:
//   question terms  the terms test generation works from (studyFor, top 16)
//   shown terms     the terms the reading pane highlights (keyTermsFor, top 10)
//   keywords        the single-word TF-IDF keywords stored at upload (top 12)
// Precision: the share of what the system gave that is a marked term.
// Recall: the share of the marked terms the system found.
// Strict: the same words (ignoring case, plurals, hyphens, possessives).
// Lenient: one also counts when one term is the other with words added
// ("deadlock" for "deadlock detection").
//
// Conditions for this checkout: the rules as before (part-of-speech tagger
// off), with the tagger, and with the tagger and the subject's syllabus. The
// AI-suggested terms need a live Groq key and are not scored here.
//
// Each condition runs in its own process (settings are read when modules
// load). Runs on the rules alone: no AI key, no embedding model.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ownServer = path.resolve(here, "..");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

// ---- matching -----------------------------------------------------------
const singular = (w) => (w.length <= 3 || /(ss|us|is)$/.test(w) ? w : w.endsWith("ies") ? `${w.slice(0, -3)}y` : /(sh|ch|x|z)es$/.test(w) ? w.slice(0, -2) : w.endsWith("s") ? w.slice(0, -1) : w);
export const norm = (t) =>
  String(t)
    .toLowerCase()
    .replace(/[’']s\b/g, "")
    .replace(/[-–/]/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(singular)
    .join(" ");
const within = (a, b) => ` ${b} `.includes(` ${a} `);
const matches = (a, b, lenient) => a === b || (lenient && (within(a, b) || within(b, a)));

function score(predicted, gold, lenient) {
  const p = [...new Set(predicted.map(norm))].filter(Boolean);
  const g = [...new Set(gold.map(norm))];
  const tp = p.filter((x) => g.some((y) => matches(x, y, lenient))).length;
  const found = g.filter((y) => p.some((x) => matches(x, y, lenient))).length;
  return { predicted: p.length, gold: g.length, correct: tp, found, misses: g.filter((y) => !p.some((x) => matches(x, y, lenient))), extra: p.filter((x) => !g.some((y) => matches(x, y, lenient))) };
}

// ---- one condition, in this process ------------------------------------
async function runCondition(serverDir, condition) {
  const load = (rel) => import(pathToFileURL(path.join(serverDir, "src", rel)).href);
  const { blocksFromPlainText, segmentDocument, normalizeContent } = await load("services/documentStructure.js");
  const { studyFor, keyTermsFor } = await load("services/keyTerms.js");
  const { computeTfidf } = await load("services/tfidf.js");
  const labels = JSON.parse(fs.readFileSync(path.join(ownServer, "evaluation/keyterms/labels.json"), "utf8"));
  const out = [];
  let id = 0;
  for (const doc of labels.documents) {
    const text = fs.readFileSync(path.join(ownServer, doc.file), "utf8");
    const blocks = blocksFromPlainText(text);
    const seg = segmentDocument(blocks);
    const title = path.basename(doc.file).replace(/\.[a-z]+$/, "");
    const syllabus = condition === "syllabus" ? doc.syllabus : undefined;
    const leaves =
      seg.sections.length >= 2
        ? seg.sections.map((s) => ({ _id: `n${++id}`, title: s.title, rawText: s.text, content: s.content, path: s.path || [], parentNoteId: "p", syllabus }))
        : [{ _id: `n${++id}`, title, rawText: text, content: normalizeContent(blocks, { title }), path: [], syllabus }];
    const question = [];
    const shown = [];
    const keywords = [];
    for (const n of leaves) {
      const study = await studyFor(n, { corpus: leaves, embedder: null });
      question.push(...study.terms.map((t) => t.term));
      shown.push(...keyTermsFor(n, leaves));
      keywords.push(...computeTfidf(n.rawText, leaves.filter((x) => x !== n).map((x) => x.rawText)).keywords);
    }
    out.push({ file: doc.file, subject: doc.subject, notes: leaves.length, outputs: { question, shown, keywords } });
  }
  return out;
}

if (opt("--run")) {
  const res = await runCondition(path.resolve(opt("--run")), opt("--cond") || "rules");
  process.stdout.write(JSON.stringify(res));
  process.exit(0);
}

// ---- all conditions, each in a child process ---------------------------
function child(serverDir, condition, env) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--run", serverDir, "--cond", condition], {
    env: { ...process.env, GROQ_API_KEY: "", SEMANTIC_MODEL: "off", KEYTERMS_AI: "off", ...env },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`condition ${condition} failed:\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

const labels = JSON.parse(fs.readFileSync(path.join(ownServer, "evaluation/keyterms/labels.json"), "utf8"));
const goldOf = new Map(labels.documents.map((d) => [d.file, d.gold]));
const conditions = [];
if (opt("--before")) conditions.push({ name: "Before (--before checkout)", res: child(path.resolve(opt("--before")), "rules", {}) });
conditions.push({ name: "Rules, tagger off", res: child(ownServer, "rules", { KEYTERMS_POS: "off" }) });
conditions.push({ name: "Rules + tagger", res: child(ownServer, "rules", {}) });
conditions.push({ name: "Rules + tagger + syllabus", res: child(ownServer, "syllabus", {}) });

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "-");
const f1 = (p, r) => (p + r ? (2 * p * r) / (p + r) : 0);
const lines = [`# Key-term evaluation`, ``, `${labels.documents.length} documents, ${labels.documents.reduce((n, d) => n + d.gold.length, 0)} marked terms (labels: ${labels.about.split(":")[0]}). Run ${new Date().toISOString().slice(0, 10)}.`, ``];
const summary = {};
for (const output of ["question", "shown", "keywords"]) {
  lines.push(`## ${{ question: "Question terms (test generation, top 16 per note)", shown: "Shown terms (reading pane, top 10 per note)", keywords: "Keywords (TF-IDF, top 12 per note)" }[output]}`, ``);
  lines.push(`| Condition | Precision (strict) | Recall (strict) | F1 (strict) | Precision (lenient) | Recall (lenient) |`, `| --- | --- | --- | --- | --- | --- |`);
  for (const c of conditions) {
    const tot = { s: { predicted: 0, correct: 0, gold: 0, found: 0 }, l: { predicted: 0, correct: 0, gold: 0, found: 0 } };
    for (const d of c.res) {
      for (const [k, lenient] of [["s", false], ["l", true]]) {
        const r = score(d.outputs[output], goldOf.get(d.file), lenient);
        for (const f of ["predicted", "correct", "gold", "found"]) tot[k][f] += r[f];
      }
    }
    const P = tot.s.correct / (tot.s.predicted || 1);
    const R = tot.s.found / (tot.s.gold || 1);
    summary[`${c.name}|${output}`] = { P, R, F1: f1(P, R), predicted: tot.s.predicted };
    lines.push(`| ${c.name} | ${pct(tot.s.correct, tot.s.predicted)} (${tot.s.correct}/${tot.s.predicted}) | ${pct(tot.s.found, tot.s.gold)} | ${f1(P, R).toFixed(2)} | ${pct(tot.l.correct, tot.l.predicted)} | ${pct(tot.l.found, tot.l.gold)} |`);
  }
  lines.push(``);
}
// per document, for the question terms: the first and last condition
lines.push(`## Per document (question terms, strict)`, ``, `| Document | ${conditions.map((c) => c.name).join(" | ")} |`, `| --- | ${conditions.map(() => "---").join(" | ")} |`);
for (const d of labels.documents) {
  const cells = conditions.map((c) => {
    const r = score(c.res.find((x) => x.file === d.file).outputs.question, d.gold, false);
    return `P ${pct(r.correct, r.predicted)} R ${pct(r.found, r.gold)}`;
  });
  lines.push(`| ${d.subject} | ${cells.join(" | ")} |`);
}
lines.push(``, `## What changed, per document (question terms, strict)`, ``);
const first = conditions[0];
const last = conditions[conditions.length - 2]; // rules + tagger
for (const d of labels.documents) {
  const a = score(first.res.find((x) => x.file === d.file).outputs.question, d.gold, false);
  const b = score(last.res.find((x) => x.file === d.file).outputs.question, d.gold, false);
  const gained = a.misses.filter((m) => !b.misses.includes(m));
  const lost = b.misses.filter((m) => !a.misses.includes(m));
  const dropped = a.extra.filter((x) => !b.extra.includes(x));
  const added = b.extra.filter((x) => !a.extra.includes(x));
  lines.push(`- **${d.subject}**: found ${gained.length ? gained.join(", ") : "nothing new"}; lost ${lost.length ? lost.join(", ") : "nothing"}; unmarked terms dropped ${dropped.length ? dropped.slice(0, 12).join(", ") : "none"}; unmarked terms added ${added.length ? added.slice(0, 12).join(", ") : "none"}.`);
}
lines.push(``, `"Unmarked" terms are not necessarily wrong: a rater may have left out a fair term. Precision here is a lower bound.`);
const report = lines.join("\n");
if (opt("--out")) fs.writeFileSync(opt("--out"), report);
console.log(report);
if (opt("--json")) fs.writeFileSync(opt("--json"), JSON.stringify(summary, null, 2));
