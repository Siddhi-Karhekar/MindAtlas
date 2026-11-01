// The mastery measurement: how well does the mastery model (Bayesian Knowledge
// Tracing, services/masteryEngine.js) predict real students' answers?
// docs/measurements/mastery.md has the method, the limits and the results.
//
//   npm run eval:mastery -- [--data <file>] [--out <dir>] [--seed <n>] [--folds <n>] [--reps <n>]
//
// Reads the public ASSISTments 2009-10 skill-builder file (--data, default
// evaluation-output/datasets/assistments/skill_builder_data_corrected_collapsed.csv,
// which is git-ignored and must stay that way: its terms do not allow passing
// it on), splits the students into folds (--folds, default 5) with a fixed seed
// (--seed, default 1), and compares on the same test folds the overall average,
// the per-skill average, the app's default settings and settings fitted per
// skill on the training folds. --reps is the number of resamples of students
// behind the 95% intervals (default 1000).
//
// Writes into --out (default evaluation-output/mastery-<timestamp>): results.md,
// results.json and fitted_settings.csv. They hold scores and settings only, no
// rows of the file and no student ids. App behaviour does not change.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assignFolds, bootstrapScores, DEFAULT_SETTINGS, FIT_GRID, fitSkill, interval, MODELS, orderBy, predictAll, quartiles, readAnswers,
  scoreWeighted, sequencesOf,
} from "./lib/mastery.js";
import { parseCsv, seededRandom, toCsv } from "./lib/stats.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = "skill_builder_data_corrected_collapsed.csv";
const DATA_PAGE = "https://sites.google.com/site/assistmentsdata/home/2009-2010-assistment-data/skill-builder-data-2009-2010";
const SCORES = ["auc", "rmse", "accuracy"];
const SETTINGS = ["prior", "transit", "slip", "guess"];
const LABELS = {
  overall: "Overall average",
  per_skill: "Per-skill average",
  default: "Mastery model, app's default settings",
  fitted: "Mastery model, settings fitted per skill",
};
// The pairs a reader wants told apart. The first of each is the one in question.
const COMPARED = [["fitted", "default"], ["default", "per_skill"], ["fitted", "per_skill"], ["default", "overall"]];
// A skill below this many answers says little about its settings, so it stays
// out of the summary of fitted settings (not out of the scores).
const SUMMARY_MIN_ANSWERS = 100;
const SETTINGS_COLUMNS = ["skill_id", "skill_name", "answers", "students", ...SETTINGS];

function parseArgs(argv) {
  const opts = {};
  const numbers = { "--seed": "seed", "--folds": "folds", "--reps": "reps" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--data") opts.data = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (numbers[a]) {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 0) throw new Error(`${a} needs a whole number`);
      opts[numbers[a]] = v;
    } else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

function gitCommit() {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: HERE, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const changed = execFileSync("git", ["status", "--porcelain"], { cwd: HERE, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return { commit, uncommitted_changes: changed !== "" };
  } catch {
    return { commit: null, uncommitted_changes: null };
  }
}

const withCi = (score, draws) => ({ value: score, ci: interval(draws) });

/** A's score minus B's, with the interval over the same resamples (paired). */
function differences(a, b, points, draws) {
  return Object.fromEntries(SCORES.map((s) => {
    if (points[a][s] === null || points[b][s] === null) return [s, null];
    return [s, withCi(points[a][s] - points[b][s], draws[a].map((d, i) => (d[s] === null || draws[b][i][s] === null ? null : d[s] - draws[b][i][s])))];
  }));
}

/** How the fitted settings sit against the defaults, across the skills with enough answers. */
function settingsSummary(perSkill, grid) {
  const enough = perSkill.filter((s) => s.answers >= SUMMARY_MIN_ANSWERS);
  return {
    min_answers: SUMMARY_MIN_ANSWERS,
    skills: enough.length,
    skills_left_out: perSkill.length - enough.length,
    by_setting: Object.fromEntries(SETTINGS.map((name) => {
      const [low, high] = [grid[name][0], grid[name][grid[name].length - 1]];
      return [name, {
        default: DEFAULT_SETTINGS[name],
        quartiles: quartiles(enough.map((s) => s[name])),
        at_edge_of_grid: enough.filter((s) => s[name] === low || s[name] === high).length,
      }];
    })),
  };
}

/**
 * Run the measurement. Exported so the tests can call it without a child
 * process, on a made-up file. Returns the results object that results.json holds.
 */
export function runMasteryEvaluation(options = {}) {
  const opts = { seed: 1, folds: 5, reps: 1000, grid: FIT_GRID, write: true, quiet: false, ...options };
  const log = (...a) => !opts.quiet && console.log(...a);
  if (opts.folds < 2) throw new Error("--folds needs at least 2");
  const dataPath = opts.data ?? path.join("evaluation-output", "datasets", "assistments", FILE);
  if (!fs.existsSync(dataPath)) {
    throw new Error(`${dataPath} not found. It is the corrected, collapsed ASSISTments 2009-10 skill-builder file, from ${DATA_PAGE} - read docs/measurements/mastery.md and the data's terms of use before downloading it`);
  }
  const started = Date.now();
  const bytes = fs.readFileSync(dataPath);
  const { answers, counts } = readAnswers(parseCsv(bytes.toString("utf8")));
  const sequences = sequencesOf(answers);
  if (!sequences.length) throw new Error(`no usable answers in ${dataPath}`);

  const skills = new Map();
  for (const a of answers) {
    if (!skills.has(a.skill)) skills.set(a.skill, { name: "", students: new Set() });
    const row = skills.get(a.skill);
    row.name ||= a.skillName;
    row.students.add(a.student);
  }

  const random = seededRandom(opts.seed);
  const studentIds = sequences.map((q) => q.student);
  const foldOf = assignFolds(studentIds, opts.folds, random);

  log(`${counts.kept} answers from ${foldOf.size} students on ${skills.size} skills. Fitting each skill on ${Object.values(opts.grid).reduce((n, g) => n * g.length, 1)} combinations of settings ...`);
  const bySkill = new Map();
  for (const q of sequences) {
    if (!bySkill.has(q.skill)) bySkill.set(q.skill, []);
    bySkill.get(q.skill).push(q);
  }
  const fits = new Map();
  for (const [skill, list] of bySkill) fits.set(skill, fitSkill(list, foldOf, opts.folds, opts.grid));

  log("Predicting and scoring ...");
  const predicted = predictAll(sequences, foldOf, opts.folds, fits);
  const { y, student, fold, students, preds } = predicted;
  const orders = Object.fromEntries(MODELS.map((m) => [m, orderBy(preds[m])]));
  const everyone = new Float64Array(students).fill(1);
  const points = Object.fromEntries(MODELS.map((m) => [m, scoreWeighted({ y, p: preds[m], order: orders[m], student, weights: everyone })]));
  const draws = bootstrapScores(predicted, orders, random, opts.reps);

  const studentFold = new Uint8Array(students);
  for (let i = 0; i < y.length; i++) studentFold[student[i]] = fold[i];
  const perFold = Array.from({ length: opts.folds }, (_, f) => {
    const weights = Float64Array.from(studentFold, (x) => (x === f ? 1 : 0));
    return {
      fold: f + 1,
      students: weights.reduce((a, b) => a + b, 0),
      answers: fold.reduce((n, x) => n + (x === f ? 1 : 0), 0),
      auc: Object.fromEntries(MODELS.map((m) => [m, scoreWeighted({ y, p: preds[m], order: orders[m], student, weights }).auc])),
    };
  });

  const perSkill = [...fits].map(([skill, fit]) => ({
    skill_id: skill, skill_name: skills.get(skill).name, answers: fit.answers, students: skills.get(skill).students.size, ...fit.all,
  })).sort((a, b) => b.answers - a.answers);
  const right = y.reduce((a, b) => a + b, 0);

  const results = {
    created: new Date().toISOString(),
    ...gitCommit(),
    seed: opts.seed,
    folds: opts.folds,
    reps: opts.reps,
    seconds: Math.round((Date.now() - started) / 1000),
    dataset: { file: path.basename(dataPath), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), page: DATA_PAGE },
    counts: {
      ...counts,
      students: foldOf.size,
      skills: skills.size,
      joined_skill_labels: [...skills.keys()].filter((s) => s.includes("_")).length,
      sequences: sequences.length,
      right_rate: right / y.length,
      first_answer_right_rate: predicted.firstAnswers.right / predicted.firstAnswers.all,
      unseen_skill_answers: predicted.unseen,
    },
    default_settings: DEFAULT_SETTINGS,
    fit_grid: opts.grid,
    models: Object.fromEntries(MODELS.map((m) => [m, {
      label: LABELS[m],
      mean_prediction: points[m].predicted,
      ...Object.fromEntries(SCORES.map((s) => [s, points[m][s] === null ? null : withCi(points[m][s], draws[m].map((d) => d[s]))])),
    }])),
    differences: COMPARED.map(([a, b]) => ({ a, b, ...differences(a, b, points, draws) })),
    per_fold: perFold,
    fitted_settings: settingsSummary(perSkill, opts.grid),
  };

  if (opts.write) {
    const outDir = opts.out || path.join("evaluation-output", `mastery-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
    fs.writeFileSync(path.join(outDir, "results.md"), resultsMarkdown(results));
    fs.writeFileSync(path.join(outDir, "fitted_settings.csv"), toCsv(perSkill, SETTINGS_COLUMNS));
    results.outDir = outDir;
  }
  log(resultsMarkdown(results));
  return results;
}

const f3 = (x) => (x === null || x === undefined ? "-" : x.toFixed(3));
const f2 = (x) => (x === null || x === undefined ? "-" : x.toFixed(2));
const count = (x) => x.toLocaleString("en-US");
const scoreCell = (s) => (s ? `${f3(s.value)} [${f3(s.ci?.[0])}, ${f3(s.ci?.[1])}]` : "-");
const signed = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(3)}`;
const diffCell = (d) => (d ? `${signed(d.value)} [${d.ci ? `${signed(d.ci[0])}, ${signed(d.ci[1])}` : "-"}]` : "-");

/** The results as tables for the report. */
export function resultsMarkdown(r) {
  const c = r.counts;
  const lines = [
    "# Mastery measurement",
    "",
    `Commit ${r.commit || "unknown"}${r.uncommitted_changes ? " (with uncommitted changes)" : ""}, seed ${r.seed}, ${r.folds} folds, ${r.reps} resamples of students, ${r.dataset.file} (sha256 ${r.dataset.sha256}).`,
    "",
    "## Data",
    "",
    "| Step | Rows |",
    "| --- | --- |",
    `| In the file | ${count(c.rows)} |`,
    `| Removed: not a main problem (\`original\` is not 1) | ${count(c.not_original)} |`,
    `| Removed: no skill | ${count(c.no_skill)} |`,
    `| Removed: unreadable answer, student or order | ${count(c.unreadable)} |`,
    `| **Answers used** | **${count(c.kept)}** |`,
    "",
    `${count(c.students)} students, ${count(c.skills)} skills (${count(c.joined_skill_labels)} of them joined labels such as "a_b", holding ${count(c.joined_skills)} answers), ${count(c.sequences)} student-skill sequences. ` +
      `${(c.right_rate * 100).toFixed(1)}% of the answers are right, and ${(c.first_answer_right_rate * 100).toFixed(1)}% of each student's first answers on a skill. ` +
      `Answer types: ${Object.entries(c.answer_types).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t || "blank"} ${count(n)}`).join(", ")}.`,
    "",
    "## Scores on the test folds",
    "",
    "| Predictor | AUC [95%] | RMSE [95%] | Accuracy [95%] | Mean prediction |",
    "| --- | --- | --- | --- | --- |",
    ...MODELS.map((m) => {
      const x = r.models[m];
      return `| ${x.label} | ${scoreCell(x.auc)} | ${scoreCell(x.rmse)} | ${scoreCell(x.accuracy)} | ${f3(x.mean_prediction)} |`;
    }),
    "",
    `${count(c.unseen_skill_answers)} test answers are on a skill with no training answers in their fold: the per-skill average uses the overall average for them, the fitted model the default settings.`,
    "",
    "## Differences, over the same resamples",
    "",
    "| Compared | AUC [95%] | RMSE [95%] (lower is better) | Accuracy [95%] |",
    "| --- | --- | --- | --- |",
    ...r.differences.map((d) => `| ${r.models[d.a].label} minus ${r.models[d.b].label} | ${diffCell(d.auc)} | ${diffCell(d.rmse)} | ${diffCell(d.accuracy)} |`),
    "",
    "## AUC per test fold",
    "",
    `| Fold | Students | Answers | ${MODELS.map((m) => r.models[m].label).join(" | ")} |`,
    `| --- | --- | --- | ${MODELS.map(() => "---").join(" | ")} |`,
    ...r.per_fold.map((f) => `| ${f.fold} | ${count(f.students)} | ${count(f.answers)} | ${MODELS.map((m) => f3(f.auc[m])).join(" | ")} |`),
    "",
    "## Fitted settings beside the defaults",
    "",
    `Fitted on all students, for this table only, across the ${r.fitted_settings.skills} skills with at least ${r.fitted_settings.min_answers} answers (${r.fitted_settings.skills_left_out} left out). fitted_settings.csv has every skill.`,
    "",
    "| Setting | App default | Fitted, median skill | Middle half of skills | Skills at the edge of the grid |",
    "| --- | --- | --- | --- | --- |",
    ...SETTINGS.map((name) => {
      const s = r.fitted_settings.by_setting[name];
      return `| ${name} | ${f2(s.default)} | ${f2(s.quartiles?.[1])} | ${f2(s.quartiles?.[0])} to ${f2(s.quartiles?.[2])} | ${s.at_edge_of_grid} |`;
    }),
    "",
  ];
  return lines.join("\n");
}

const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

// run directly: `node evaluation/mastery.mjs ...`
if (process.argv[1] && samePath(fileURLToPath(import.meta.url), path.resolve(process.argv[1]))) {
  try {
    const results = runMasteryEvaluation(parseArgs(process.argv.slice(2)));
    console.log(`Written to ${path.join(results.outDir, "results.md")}, results.json and fitted_settings.csv`);
    process.exit(0);
  } catch (err) {
    console.error(`eval:mastery failed: ${err.message}`);
    process.exit(1);
  }
}
