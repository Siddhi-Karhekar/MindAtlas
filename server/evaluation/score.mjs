// Turns the raters' filled-in sheets into results.
//
//   npm run eval:score -- <output folder> [ratings files...] [--baseline tfidf]
//
// The folder is the one eval:generate wrote. Each rater saves their copy of
// rating_sheet.csv in it as ratings_<name>.csv; every such file is read unless
// files are named on the command line. It writes, into the same folder:
//
//   results.md    the tables for a report: scores per strategy, each strategy
//                 against the baseline, how far the raters agree, and the
//                 lowest-rated questions
//   results.json  the same numbers, for plotting
//
// How the numbers are made (docs/EVALUATION.md explains why):
//   - the unit is the question, not the rating. Each question gets one value
//     per criterion: for yes/no criteria the majority of its raters (a tie
//     counts as "no"), for 1-5 criteria the mean of its raters;
//   - yes/no criteria are reported as a share with a 95% Wilson interval,
//     1-5 criteria as mean and standard deviation over questions;
//   - a strategy is compared with the baseline by Fisher's exact test (yes/no)
//     or the Mann-Whitney U test with Cliff's delta (1-5), and the p-values
//     are Holm-corrected for the number of comparisons made;
//   - agreement is Cohen's kappa (yes/no) or quadratic-weighted kappa (1-5)
//     for every pair of raters, over the questions both rated.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cohenKappa, fisherExact, holm, mannWhitney, mean, parseCsv, rate, round, sd, weightedKappa, wilson } from "./lib/stats.js";

export const BINARY = ["relevant", "correct", "whole_term"];
export const SCALE = ["clear", "distractors", "usable"];
const BLANK_ONLY = new Set(["whole_term", "distractors"]); // asked of fill-in-the-blank questions only
const CRITERIA = ["relevant", "correct", "clear", "whole_term", "distractors", "usable"];
const LABELS = {
  relevant: "Relevant to the subject",
  correct: "Answer is correct",
  clear: "Clear (1-5)",
  whole_term: "Blank hides a whole term",
  distractors: "Wrong options are plausible (1-5)",
  usable: "Usable in a real test (1-5)",
};

const YES = /^(1|y|yes|true|t)$/i;
const NO = /^(0|n|no|false|f)$/i;

/** One cell -> a number, null if empty, or undefined if it is not a valid answer. */
export function readCell(criterion, raw) {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  if (BINARY.includes(criterion)) return YES.test(v) ? 1 : NO.test(v) ? 0 : undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : undefined;
}

const RATINGS_FILE = /^ratings[_-].+\.csv$/i; // ratings_<name>.csv; never rating_sheet.csv, the empty original
const raterName = (file) => path.basename(file).replace(/\.csv$/i, "").replace(/^ratings[_-]/i, "") || path.basename(file);

function parseArgs(argv) {
  const opts = { dir: null, ratings: [], baseline: "tfidf" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--baseline") opts.baseline = argv[++i];
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else if (!opts.dir) opts.dir = a;
    else opts.ratings.push(a);
  }
  return opts;
}

/**
 * Score the ratings. Exported so the tests can call it directly.
 * Returns the results object that is also written to results.json.
 */
export function runScoring(options) {
  const opts = { ratings: [], baseline: "tfidf", quiet: false, write: true, ...options };
  const dir = opts.dir;
  if (!dir || !fs.existsSync(path.join(dir, "key.csv"))) throw new Error(`no key.csv in ${dir || "(no folder given)"} - pass the folder eval:generate wrote`);

  // qid -> { type, strategies:Set, document, question }
  const questions = new Map();
  for (const row of parseCsv(fs.readFileSync(path.join(dir, "key.csv"), "utf8"))) {
    if (!questions.has(row.qid)) questions.set(row.qid, { qid: row.qid, type: row.type, document: row.document, strategies: new Set(), question: "", marked: "" });
    questions.get(row.qid).strategies.add(row.strategy);
  }
  const sheetPath = path.join(dir, "rating_sheet.csv");
  if (fs.existsSync(sheetPath)) {
    for (const row of parseCsv(fs.readFileSync(sheetPath, "utf8"))) {
      const q = questions.get(row.qid);
      if (q) Object.assign(q, { question: row.question, marked: row.marked_answer });
    }
  }

  const files = opts.ratings.length
    ? opts.ratings
    : fs.readdirSync(dir).filter((f) => RATINGS_FILE.test(f)).sort().map((f) => path.join(dir, f));
  if (!files.length) throw new Error(`no ratings found - each rater saves their filled-in copy of rating_sheet.csv in ${dir} as ratings_<name>.csv`);

  // ---- read every rater's sheet
  const problems = [];
  const raters = [];
  const ratings = new Map(); // qid -> criterion -> Map(rater -> value)
  const comments = new Map(); // qid -> [ "rater: comment" ]
  for (const file of files) {
    let rater = raterName(file);
    while (raters.includes(rater)) rater += "'";
    raters.push(rater);
    const seen = new Set();
    for (const row of parseCsv(fs.readFileSync(file, "utf8"))) {
      const q = questions.get(row.qid);
      if (!q) {
        problems.push(`${rater}: ${row.qid || "(a row with no qid)"} is not a question of this run - ignored`);
        continue;
      }
      if (seen.has(row.qid)) {
        problems.push(`${rater}: ${row.qid} appears twice - the later row is ignored`);
        continue;
      }
      seen.add(row.qid);
      for (const c of CRITERIA) {
        const value = readCell(c, row[c]);
        if (value === null) continue;
        if (value === undefined) {
          problems.push(`${rater}: ${row.qid} ${c} = "${row[c]}" is not ${BINARY.includes(c) ? "yes/no (1/0)" : "a whole number from 1 to 5"} - ignored`);
          continue;
        }
        if (BLANK_ONLY.has(c) && q.type !== "mcq") continue; // not asked of theory questions
        if (!ratings.has(row.qid)) ratings.set(row.qid, {});
        ((ratings.get(row.qid)[c] ||= new Map())).set(rater, value);
      }
      if (row.comment) (comments.get(row.qid) || comments.set(row.qid, []).get(row.qid)).push(`${rater}: ${row.comment}`);
    }
  }

  // ---- one value per question and criterion
  const valueOf = (qid, c) => {
    const given = ratings.get(qid)?.[c];
    if (!given?.size) return null;
    const values = [...given.values()];
    if (BINARY.includes(c)) return values.filter((v) => v === 1).length * 2 > values.length ? 1 : 0;
    return mean(values);
  };
  const strategies = [...new Set([...questions.values()].flatMap((q) => [...q.strategies]))];
  const valuesFor = (strategy, c, type = null) =>
    [...questions.values()]
      .filter((q) => q.strategies.has(strategy) && (!type || q.type === type))
      .map((q) => valueOf(q.qid, c))
      .filter((v) => v !== null);

  const summarise = (values, c) => {
    if (!values.length) return { n: 0 };
    if (BINARY.includes(c)) {
      const hits = values.filter((v) => v === 1).length;
      return { n: values.length, yes: hits, share: rate(hits, values.length), ci95: wilson(hits, values.length) };
    }
    const high = values.filter((v) => v >= 4).length;
    return { n: values.length, mean: round(mean(values), 2), sd: round(sd(values), 2), share_4_or_more: rate(high, values.length), ci95_4_or_more: wilson(high, values.length) };
  };

  const perStrategy = {};
  for (const s of strategies) {
    perStrategy[s] = {
      questions: [...questions.values()].filter((q) => q.strategies.has(s)).length,
      rated: [...questions.values()].filter((q) => q.strategies.has(s) && ratings.has(q.qid)).length,
      criteria: Object.fromEntries(CRITERIA.map((c) => [c, summarise(valuesFor(s, c), c)])),
      usable_by_type: { fill_in_the_blank: summarise(valuesFor(s, "usable", "mcq"), "usable"), theory: summarise(valuesFor(s, "usable", "theory"), "usable") },
    };
  }

  // ---- each strategy against the baseline
  const baseline = strategies.includes(opts.baseline) ? opts.baseline : null;
  const comparisons = [];
  if (baseline) {
    for (const s of strategies.filter((x) => x !== baseline)) {
      for (const c of CRITERIA) {
        const a = valuesFor(s, c);
        const b = valuesFor(baseline, c);
        if (!a.length || !b.length) continue;
        if (BINARY.includes(c)) {
          const ha = a.filter((v) => v === 1).length;
          const hb = b.filter((v) => v === 1).length;
          comparisons.push({ strategy: s, baseline, criterion: c, test: "Fisher exact", value: rate(ha, a.length), baseline_value: rate(hb, b.length), difference: round(ha / a.length - hb / b.length), p: fisherExact(ha, a.length, hb, b.length) });
        } else {
          const mw = mannWhitney(a, b);
          comparisons.push({ strategy: s, baseline, criterion: c, test: "Mann-Whitney U", value: round(mean(a), 2), baseline_value: round(mean(b), 2), difference: round(mean(a) - mean(b), 2), cliffs_delta: mw.delta, p: mw.p });
        }
      }
    }
    holm(comparisons.map((c) => c.p)).forEach((p, i) => (comparisons[i].p_holm = p));
  }

  // ---- how far the raters agree
  const agreement = [];
  for (let i = 0; i < raters.length; i++) {
    for (let j = i + 1; j < raters.length; j++) {
      for (const c of CRITERIA) {
        const a = [];
        const b = [];
        for (const [, byCriterion] of ratings) {
          const given = byCriterion[c];
          if (given?.has(raters[i]) && given.has(raters[j])) {
            a.push(given.get(raters[i]));
            b.push(given.get(raters[j]));
          }
        }
        if (!a.length) continue;
        agreement.push({
          raters: [raters[i], raters[j]],
          criterion: c,
          n: a.length,
          same: rate(a.filter((v, k) => v === b[k]).length, a.length),
          kappa: BINARY.includes(c) ? cohenKappa(a, b) : weightedKappa(a, b),
          kind: BINARY.includes(c) ? "Cohen's kappa" : "quadratic-weighted kappa",
        });
      }
    }
  }

  // ---- the questions to look at first when improving the generator
  const lowest = [...questions.values()]
    .map((q) => ({ qid: q.qid, strategies: [...q.strategies], type: q.type, usable: valueOf(q.qid, "usable"), relevant: valueOf(q.qid, "relevant"), correct: valueOf(q.qid, "correct"), question: q.question, answer: q.marked, comments: comments.get(q.qid) || [] }))
    .filter((q) => q.usable !== null)
    .sort((a, b) => a.usable - b.usable || a.qid.localeCompare(b.qid))
    .slice(0, 10)
    .map((q) => ({ ...q, usable: round(q.usable, 2) }));

  const results = {
    scoredAt: new Date().toISOString(),
    raters,
    questions: questions.size,
    questions_rated: [...questions.keys()].filter((id) => ratings.has(id)).length,
    baseline,
    strategies: perStrategy,
    comparisons,
    agreement,
    lowest_rated: lowest,
    problems,
  };
  if (opts.write) {
    fs.writeFileSync(path.join(dir, "results.json"), JSON.stringify(results, null, 2));
    fs.writeFileSync(path.join(dir, "results.md"), resultsMarkdown(results));
  }
  if (!opts.quiet) console.log(resultsMarkdown(results));
  return results;
}

const pct = (x) => (x === null || x === undefined ? "-" : `${Math.round(x * 100)}%`);
const ci = (r) => (r ? `${pct(r[0])}-${pct(r[1])}` : "-");
const fmtP = (p) => (p === null || p === undefined ? "-" : p < 0.001 ? "<0.001" : p.toFixed(3));
const signed = (x, asPct) => (x === null || x === undefined ? "-" : `${x > 0 ? "+" : ""}${asPct ? `${Math.round(x * 100)} pts` : x}`);

/** The results as tables that can go straight into a report. */
export function resultsMarkdown(r) {
  const names = Object.keys(r.strategies);
  const lines = [
    "# Question quality: human ratings",
    "",
    `${r.questions_rated} of ${r.questions} questions rated by ${r.raters.length} rater${r.raters.length === 1 ? "" : "s"} (${r.raters.join(", ")}).`,
    "",
    "## Scores per strategy",
    "",
    "One value per question: the majority of its raters for yes/no criteria (a tie counts as no), their mean for 1-5 criteria. Brackets are 95% Wilson intervals; n is the number of rated questions.",
    "",
    `| Criterion | ${names.join(" | ")} |`,
    `| --- | ${names.map(() => "---").join(" | ")} |`,
  ];
  const cellFor = (s, c) => {
    if (!s?.n) return "-";
    return BINARY.includes(c) ? `${pct(s.share)} [${ci(s.ci95)}], n=${s.n}` : `${s.mean} (sd ${s.sd ?? "-"}), n=${s.n}`;
  };
  for (const c of CRITERIA) lines.push(`| ${LABELS[c]} | ${names.map((n) => cellFor(r.strategies[n].criteria[c], c)).join(" | ")} |`);
  const four = (s) => (s?.n ? `${pct(s.share_4_or_more)} [${ci(s.ci95_4_or_more)}]` : "-");
  lines.push(`| Usable rated 4 or more | ${names.map((n) => four(r.strategies[n].criteria.usable)).join(" | ")} |`);
  lines.push(`| Usable, fill in the blank | ${names.map((n) => cellFor(r.strategies[n].usable_by_type.fill_in_the_blank, "usable")).join(" | ")} |`);
  lines.push(`| Usable, theory | ${names.map((n) => cellFor(r.strategies[n].usable_by_type.theory, "usable")).join(" | ")} |`);

  if (r.comparisons.length) {
    lines.push("", `## Against the baseline (${r.baseline})`, "", `${r.comparisons.length} comparisons; use the Holm-corrected p, which allows for that number. Cliff's delta is the effect size for 1-5 criteria (about 0.33 medium, 0.47 large).`, "", "| Strategy | Criterion | Strategy | Baseline | Difference | Effect size | p | p (Holm) |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const c of r.comparisons) {
      const binary = BINARY.includes(c.criterion);
      lines.push(`| ${c.strategy} | ${LABELS[c.criterion]} | ${binary ? pct(c.value) : c.value} | ${binary ? pct(c.baseline_value) : c.baseline_value} | ${signed(c.difference, binary)} | ${binary ? "-" : c.cliffs_delta} | ${fmtP(c.p)} | ${fmtP(c.p_holm)} |`);
    }
  }

  lines.push("", "## Agreement between raters", "");
  if (!r.agreement.length) lines.push("Only one rater, so agreement cannot be measured. A second rater is needed before these scores can be reported: without one there is no evidence that the ratings are more than one person's taste.");
  else {
    lines.push("Kappa is agreement beyond chance (1 = perfect, 0 = chance): 0.41-0.60 is usually called moderate, 0.61-0.80 substantial. When nearly every answer is the same (for example almost all \"yes\"), kappa is low or missing even though the raters agree; read it together with the share of identical answers.", "", "| Raters | Criterion | Questions | Identical answers | Kappa |", "| --- | --- | --- | --- | --- |");
    for (const a of r.agreement) lines.push(`| ${a.raters.join(" / ")} | ${LABELS[a.criterion]} | ${a.n} | ${pct(a.same)} | ${a.kappa === null ? "-" : a.kappa.toFixed(2)} |`);
  }

  if (r.lowest_rated.length) {
    lines.push("", "## Lowest-rated questions", "", "Where to look first when improving the generator.", "");
    for (const q of r.lowest_rated) {
      lines.push(`- **${q.qid}** (${q.strategies.join(", ")}; ${q.type === "mcq" ? "fill in the blank" : "theory"}; usable ${q.usable}${q.relevant === 0 ? "; not relevant" : ""}${q.correct === 0 ? "; answer wrong" : ""}) ${q.question}${q.answer ? ` - answer: ${q.answer}` : ""}${q.comments.length ? ` - ${q.comments.join("; ")}` : ""}`);
    }
  }
  if (r.problems.length) lines.push("", "## Cells that were ignored", "", ...r.problems.map((p) => `- ${p}`));
  lines.push("");
  return lines.join("\n");
}

// Windows paths differ only by case ("d:\\" and "D:\\" are the same folder)
const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

// run directly: `node evaluation/score.mjs ...`
if (process.argv[1] && samePath(fileURLToPath(import.meta.url), path.resolve(process.argv[1]))) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (!opts.dir) {
      console.log("Usage: npm run eval:score -- <output folder> [ratings files...] [--baseline tfidf]");
      process.exit(1);
    }
    runScoring(opts);
    console.log(`Written to ${path.join(opts.dir, "results.md")} and results.json`);
  } catch (err) {
    console.error(`eval:score failed: ${err.message}`);
    process.exit(1);
  }
}
