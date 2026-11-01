// Checks for the mastery measurement (evaluation/mastery.mjs,
// evaluation/lib/mastery.js, docs/measurements/mastery.md). Its numbers go in
// front of faculty, so an error here would misreport the model. Covered: which
// rows are kept, answers in order, a split that keeps each student in one fold,
// the prediction against values worked out by hand, AUC / RMSE / accuracy,
// resampling by student rather than by row, fitting, predictors that only ever
// learn from other students, and a whole run on a file. Every answer here is
// made up: rows of the real file must never be copied into a test.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BKT_DEFAULTS, updateMastery } from "../src/services/masteryEngine.js";
import {
  assignFolds, bootstrapScores, DEFAULT_SETTINGS, FIT_GRID, fitSkill, historyTree, interval, logLikelihoods, orderBy, pCorrect,
  predictAll, predictSequence, quartiles, readAnswers, scoreWeighted, sequencesOf,
} from "../evaluation/lib/mastery.js";
import { resultsMarkdown, runMasteryEvaluation } from "../evaluation/mastery.mjs";
import { seededRandom, toCsv } from "../evaluation/lib/stats.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!cond) failures++;
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mindatlas-mastery-"));

const row = (user, skill, order, correct, extra = {}) => ({
  order_id: String(order), user_id: user, original: "1", correct: String(correct), skill_id: skill,
  skill_name: `Made-up skill ${skill}`, answer_type: "algebra", ...extra,
});
const SMALL_GRID = { prior: [0.25, 0.5, 0.75], transit: [0.05, 0.15, 0.3], slip: [0.05, 0.1, 0.2], guess: [0.1, 0.25, 0.4] };
const seq = (student, skill, correct) => ({ student, skill, correct });

// Made-up students learning one skill exactly as the model says they do.
function simulate({ prefix, skill, students, answers, settings, random, firstOrder = 1 }) {
  const rows = [];
  let order = firstOrder;
  for (let s = 0; s < students; s++) {
    let known = random() < settings.prior;
    for (let a = 0; a < answers; a++) {
      const right = known ? random() >= settings.slip : random() < settings.guess;
      rows.push(row(`${prefix}${s}`, skill, order++, right ? 1 : 0));
      if (!known && random() < settings.transit) known = true;
    }
  }
  return rows;
}

console.log("\n=== Which rows are kept ===");
const { answers: kept, counts } = readAnswers([
  row("a", "1", 1, 1),
  row("a", "1", 2, 0, { original: "0" }),
  row("a", "NA", 3, 1),
  row("b", "", 4, 0),
  row("b", "NA", 5, 0, { original: "0" }),
  row("b", "1_2", 6, 0, { answer_type: "choose_1" }),
  row("b", "2", 7, 1, { skill_name: "" }),
  row("c", "1", 8, 0.5),
  row("", "1", 9, 1),
  row("c", "1", "", 1),
]);
check("a scaffolding step is removed", counts.not_original === 2, `${counts.not_original}`);
check("a row with no skill is removed, blank or NA", counts.no_skill === 2, `${counts.no_skill}`);
check("each row is counted under the first filter that removes it", counts.rows === counts.not_original + counts.no_skill + counts.unreadable + counts.kept);
check("a row with no readable answer, student or order is removed", counts.unreadable === 3, `${counts.unreadable}`);
check("the rest are kept", counts.kept === 3 && kept.length === 3, `${counts.kept}`);
check("joined skills are kept as one skill, and counted", counts.joined_skills === 1 && kept.some((a) => a.skill === "1_2"));
check("a skill_id with no skill_name is kept, and counted", counts.without_skill_name === 1);
check("answer types of the kept rows are tallied", counts.answer_types.algebra === 2 && counts.answer_types.choose_1 === 1);
let wrongFile = "";
try {
  readAnswers([{ order_id: "1", user_id: "a" }]);
} catch (err) {
  wrongFile = err.message;
}
check("a file without the expected columns is refused", /no column/.test(wrongFile), wrongFile);

console.log("\n=== Answers in order, per student and skill ===");
const sequences = sequencesOf(readAnswers([
  row("a", "1", 10, 0),
  row("a", "2", 5, 1),
  row("b", "1", 7, 1),
  row("a", "1", 9, 1),
  row("a", "1", 100, 1),
]).answers);
const aOne = sequences.find((q) => q.student === "a" && q.skill === "1");
check("sorted by order_id as a number, not as text", aOne.correct.join("") === "101", aOne.correct.join(""));
check("one sequence per student and skill", sequences.length === 3, `${sequences.length}`);
check("another student's and another skill's answers stay out", sequences.find((q) => q.student === "b").correct.length === 1);

console.log("\n=== Folds ===");
const ids = Array.from({ length: 103 }, (_, i) => `s${i}`);
const folds = assignFolds(ids, 5, seededRandom(7));
const sizes = [0, 1, 2, 3, 4].map((f) => [...folds.values()].filter((x) => x === f).length);
check("every student is in one fold", folds.size === 103 && ids.every((s) => folds.has(s)));
check("folds differ by at most one student", Math.max(...sizes) - Math.min(...sizes) <= 1, sizes.join(","));
const sameFolds = (a, b) => [...a].every(([k, v]) => b.get(k) === v);
check("a fixed seed gives the same split", sameFolds(folds, assignFolds(ids, 5, seededRandom(7))));
check("the order students arrive in makes no difference", sameFolds(folds, assignFolds([...ids].reverse(), 5, seededRandom(7))));
check("repeats of a student make no difference", sameFolds(folds, assignFolds([...ids, ...ids], 5, seededRandom(7))));
check("another seed gives another split", !sameFolds(folds, assignFolds(ids, 5, seededRandom(8))));

console.log("\n=== The prediction, by hand ===");
check("the default guess is the app's multiple-choice rate", DEFAULT_SETTINGS.guess === BKT_DEFAULTS.guessMcq);
check("the other defaults are the app's", DEFAULT_SETTINGS.prior === BKT_DEFAULTS.prior && DEFAULT_SETTINGS.transit === BKT_DEFAULTS.transit && DEFAULT_SETTINGS.slip === BKT_DEFAULTS.slip);
check("P(correct) = mastery x (1 - slip) + (1 - mastery) x guess", near(pCorrect(0.25, DEFAULT_SETTINGS), 0.25 * 0.9 + 0.75 * 0.25));
const [first, afterRight] = predictSequence([1, 1], DEFAULT_SETTINGS);
// mastery after a right answer: 0.225 / 0.4125 = 0.54545, then 0.54545 + 0.45455 x 0.15 = 0.6136
check("the first prediction uses the prior: 0.4125", near(first, 0.4125), `${first}`);
check("after a right answer: mastery 0.6136, prediction 0.64884", near(afterRight, 0.6136 * 0.9 + 0.3864 * 0.25), `${afterRight}`);
// mastery after a wrong answer: 0.025 / 0.5875 = 0.04255, then 0.04255 + 0.95745 x 0.15 = 0.1862
const afterWrong = predictSequence([0, 1], DEFAULT_SETTINGS)[1];
check("after a wrong answer: mastery 0.1862, prediction 0.37103", near(afterWrong, 0.1862 * 0.9 + 0.8138 * 0.25), `${afterWrong}`);
const walked = [];
let m = DEFAULT_SETTINGS.prior;
for (const y of [1, 0, 0, 1, 1, 1]) {
  walked.push(pCorrect(m, DEFAULT_SETTINGS));
  m = updateMastery(m, y, BKT_DEFAULTS.guessMcq, BKT_DEFAULTS);
}
check("a longer sequence follows the app's own update", predictSequence([1, 0, 0, 1, 1, 1], DEFAULT_SETTINGS).every((p, i) => near(p, walked[i])));
check("each prediction is made before its own answer is used", near(predictSequence([0], DEFAULT_SETTINGS)[0], predictSequence([1], DEFAULT_SETTINGS)[0]));

console.log("\n=== AUC, RMSE, accuracy, by hand ===");
const score = (y, p, student = y.map(() => 0), weights = [1]) => scoreWeighted({
  y: Uint8Array.from(y), p: Float64Array.from(p), order: orderBy(Float64Array.from(p)), student: Int32Array.from(student), weights: Float64Array.from(weights),
});
check("3 of 4 right-wrong pairs ordered correctly: AUC 0.75", near(score([0, 0, 1, 1], [0.1, 0.4, 0.35, 0.8]).auc, 0.75));
check("always higher for the right answer: AUC 1", score([0, 1], [0.2, 0.3]).auc === 1);
check("always lower for the right answer: AUC 0", score([0, 1], [0.9, 0.3]).auc === 0);
check("the same prediction throughout: AUC 0.5", score([0, 0, 1, 1, 1], [0.6, 0.6, 0.6, 0.6, 0.6]).auc === 0.5);
check("a level pair counts a half", near(score([0, 1, 1], [0.5, 0.5, 0.9]).auc, 0.75));
check("nothing to compare with one kind of answer: no AUC", score([1, 1], [0.2, 0.3]).auc === null);
check("RMSE: both 0.5 away", near(score([1, 0], [0.5, 0.5]).rmse, 0.5));
check("RMSE: 0.1 and 0.3 away", near(score([1, 0], [0.9, 0.3]).rmse, Math.sqrt((0.01 + 0.09) / 2)));
check("accuracy: half called correctly", near(score([1, 0, 1, 0], [0.9, 0.1, 0.2, 0.8]).accuracy, 0.5));
check("accuracy: 0.5 is called right", score([1], [0.5]).accuracy === 1 && score([0], [0.5]).accuracy === 0);
const doubled = score([1, 0, 1, 0], [0.9, 0.1, 0.2, 0.8], [0, 0, 1, 1], [2, 1]);
const written = score([1, 0, 1, 0, 1, 0], [0.9, 0.1, 0.9, 0.1, 0.2, 0.8]);
check("a student counted twice is the same as their rows written twice", near(doubled.auc, written.auc) && near(doubled.rmse, written.rmse) && near(doubled.accuracy, written.accuracy));
check("a student counted zero times is left out", near(score([1, 0, 1, 0], [0.9, 0.1, 0.2, 0.8], [0, 0, 1, 1], [1, 0]).auc, 1));
check("nothing weighted in: no scores", score([1, 0], [0.9, 0.1], [0, 0], [0]).rmse === null);

console.log("\n=== Resampling students, not rows ===");
// One student predicted perfectly, one backwards. Resampling students can only
// give AUC 1 (the first twice), 0 (the second twice) or 0.75 (one of each);
// resampling rows would give others.
const two = {
  y: Uint8Array.from([1, 0, 1, 0]), student: Int32Array.from([0, 0, 1, 1]), students: 2,
  preds: { only: Float64Array.from([0.9, 0.1, 0.2, 0.8]) },
};
const twoDraws = bootstrapScores(two, { only: orderBy(two.preds.only) }, seededRandom(1), 200).only.map((d) => d.auc);
check("a student's answers stay together", twoDraws.every((a) => a === 0 || a === 1 || near(a, 0.75)), [...new Set(twoDraws)].join(", "));
check("all three outcomes occur", twoDraws.includes(0) && twoDraws.includes(1) && twoDraws.some((a) => near(a, 0.75)));
const again = bootstrapScores(two, { only: orderBy(two.preds.only) }, seededRandom(1), 200).only.map((d) => d.auc);
check("a fixed seed gives the same resamples", again.every((a, i) => a === twoDraws[i]));
const hundred = Array.from({ length: 1000 }, (_, i) => i + 1);
check("the 95% interval is the 2.5th to 97.5th percentile", interval(hundred).join() === "26,976", interval(hundred).join());
check("nulls are ignored in an interval", interval([null, 1, null]).join() === "1,1");
check("an interval of nothing is null", interval([null]) === null);
check("quartiles of 1..5", quartiles([5, 1, 3, 2, 4]).join() === "2,3,4");

console.log("\n=== Fitting one skill ===");
const onGrid = (name, value) => FIT_GRID[name].some((x) => near(x, value));
check("the app's defaults are on the grid", ["prior", "transit", "slip", "guess"].every((n) => onGrid(n, DEFAULT_SETTINGS[n])));
check("knowing a skill always makes a right answer more likely", Math.max(...FIT_GRID.slip) + Math.max(...FIT_GRID.guess) < 1);
check("grid values are clean", FIT_GRID.prior.includes(0.15) && FIT_GRID.prior.length === 19 && FIT_GRID.slip.length === 9 && FIT_GRID.guess.length === 9);

const random = seededRandom(11);
const TRUE = { prior: 0.5, transit: 0.3, slip: 0.05, guess: 0.4 };
const simulated = sequencesOf(readAnswers(simulate({ prefix: "sim", skill: "9", students: 500, answers: 8, settings: TRUE, random })).answers);
const simFolds = assignFolds(simulated.map((q) => q.student), 5, random);
const tree = historyTree(simulated, simFolds, 5);
const logLik = (list, settings) => list.reduce((sum, q) => sum + predictSequence(q.correct, settings).reduce((s, p, i) => s + Math.log(q.correct[i] ? p : 1 - p), 0), 0);
const treeLogLik = logLikelihoods(tree, TRUE, new Float64Array(5));
const inFold = (f) => simulated.filter((q) => simFolds.get(q.student) === f);
check("the tree gives each fold the same likelihood as going through its students one by one", [0, 1, 2, 3, 4].every((f) => near(treeLogLik[f], logLik(inFold(f), TRUE), 1e-6)));
check("identical histories are worked out once", tree.size < simulated.length * 8, `${tree.size} nodes for ${simulated.length * 8} answers`);
const shared = historyTree([seq("x", "1", [1, 0]), seq("y", "1", [1, 0]), seq("z", "1", [1, 1])], new Map([["x", 0], ["y", 0], ["z", 1]]), 2);
check("three students who begin alike share the first steps", shared.size === 4, `${shared.size} nodes`);
check("a node counts the answers after it, per fold", shared.right[0].join() === "2,1" && shared.wrong[1].join() === "2,0" && shared.right[1].join() === "0,1");

const fit = fitSkill(simulated, simFolds, 5, SMALL_GRID);
check("the settings the answers were made from are found again", JSON.stringify(fit.all) === JSON.stringify(TRUE), JSON.stringify(fit.all));
check("a fit explains its answers at least as well as the defaults", logLik(simulated, fit.all) >= logLik(simulated, DEFAULT_SETTINGS));
for (const f of [0, 3]) {
  const training = simulated.filter((q) => simFolds.get(q.student) !== f);
  const alone = fitSkill(training, new Map(training.map((q) => [q.student, 0])), 2, SMALL_GRID).all;
  check(`fold ${f}'s fit is what fitting only the other students gives`, near(logLik(training, fit.byFold[f]), logLik(training, alone), 1e-6), JSON.stringify(fit.byFold[f]));
}
// Two groups who behave differently, one per fold: each fold's fit has to come
// from the other group alone, and fitting both together gives something else.
const LOW = { prior: 0.25, transit: 0.05, slip: 0.2, guess: 0.1 };
const groups = sequencesOf(readAnswers([
  ...simulate({ prefix: "low", skill: "9", students: 400, answers: 8, settings: LOW, random }),
  ...simulate({ prefix: "high", skill: "9", students: 400, answers: 8, settings: TRUE, random }),
]).answers);
const groupFolds = new Map(groups.map((q) => [q.student, q.student.startsWith("low") ? 0 : 1]));
const groupFit = fitSkill(groups, groupFolds, 2, SMALL_GRID);
check("testing the low group, the fit has seen only the high group", JSON.stringify(groupFit.byFold[0]) === JSON.stringify(TRUE), JSON.stringify(groupFit.byFold[0]));
check("testing the high group, the fit has seen only the low group", JSON.stringify(groupFit.byFold[1]) === JSON.stringify(LOW), JSON.stringify(groupFit.byFold[1]));
check("a fit on everyone is neither", ![LOW, TRUE].some((s) => JSON.stringify(s) === JSON.stringify(groupFit.all)), JSON.stringify(groupFit.all));
const onlyOneFold = fitSkill([seq("x", "1", [1, 0, 1])], new Map([["x", 2]]), 3, SMALL_GRID);
check("no fit for the fold holding a skill's only students", onlyOneFold.byFold[2] === null);
check("a fit for the folds that can train on them", onlyOneFold.byFold[0] !== null && onlyOneFold.byFold[1] !== null);

console.log("\n=== Predictors learn only from other students ===");
// x and y are in fold 0, z in fold 1. Skill 1 has answers in both folds, skill
// 2 only in fold 0.
const predictFolds = new Map([["x", 0], ["y", 0], ["z", 1]]);
const predictSeqs = [seq("x", "1", [1, 1]), seq("y", "1", [1, 1]), seq("z", "1", [0, 0, 0, 1]), seq("x", "2", [1, 0])];
const predictFits = new Map([
  ["1", { byFold: [{ prior: 0.75, transit: 0.05, slip: 0.2, guess: 0.1 }, { prior: 0.5, transit: 0.3, slip: 0.05, guess: 0.4 }] }],
  ["2", { byFold: [null, { prior: 0.5, transit: 0.3, slip: 0.05, guess: 0.4 }] }],
]);
const predicted = predictAll(predictSeqs, predictFolds, 2, predictFits);
const rowsFor = (student, skill) => {
  const at = predictSeqs.findIndex((q) => q.student === student && q.skill === skill);
  const from = predictSeqs.slice(0, at).reduce((s, q) => s + q.correct.length, 0);
  return Array.from({ length: predictSeqs[at].correct.length }, (_, i) => from + i);
};
const [xRows, zRows, x2Rows] = [rowsFor("x", "1"), rowsFor("z", "1"), rowsFor("x", "2")];
check("x's per-skill average comes from z alone: 1 of 4", xRows.every((i) => near(predicted.preds.per_skill[i], 0.25)));
check("z's per-skill average comes from x and y alone: 4 of 4", zRows.every((i) => predicted.preds.per_skill[i] === 1));
check("x's overall average comes from z alone: 1 of 4", xRows.every((i) => near(predicted.preds.overall[i], 0.25)));
check("z's overall average comes from fold 0: 5 of 6", zRows.every((i) => near(predicted.preds.overall[i], 5 / 6)));
const predictedAs = (settings, list) => predictSequence(list, settings);
check("x's fitted prediction uses the settings trained without x", xRows.every((i, k) => near(predicted.preds.fitted[i], predictedAs(predictFits.get("1").byFold[0], [1, 1])[k])));
check("the default prediction is the same whatever the fold", xRows.every((i, k) => near(predicted.preds.default[i], predictedAs(DEFAULT_SETTINGS, [1, 1])[k])));
check("a skill with no training answers: the per-skill average falls back to overall", x2Rows.every((i) => near(predicted.preds.per_skill[i], 0.25)));
check("a skill with no training answers: the fitted model falls back to the defaults", x2Rows.every((i, k) => near(predicted.preds.fitted[i], predictedAs(DEFAULT_SETTINGS, [1, 0])[k])));
check("such answers are counted", predicted.unseen === 2, `${predicted.unseen}`);
check("first answers are counted once per sequence", predicted.firstAnswers.all === 4 && predicted.firstAnswers.right === 3);
const changed = predictAll([seq("x", "1", [0, 0]), ...predictSeqs.slice(1)], predictFolds, 2, predictFits);
check("changing x's own answers leaves x's averages alone", xRows.every((i) => changed.preds.per_skill[i] === predicted.preds.per_skill[i] && changed.preds.overall[i] === predicted.preds.overall[i]));
check("...and moves z's", zRows.every((i) => changed.preds.per_skill[i] < predicted.preds.per_skill[i]));

console.log("\n=== A whole run on a made-up file ===");
const runRandom = seededRandom(23);
const makeFile = () => {
  // made-up skills: "1" follows the settings below, far from the defaults, and
  // is harder than "2". A scaffolding step, a row with no skill and a comma in
  // a quoted field go through as the real file's would.
  const rows = [
    ...simulate({ prefix: "stu-a", skill: "1", students: 120, answers: 6, settings: { prior: 0.75, transit: 0.05, slip: 0.2, guess: 0.1 }, random: runRandom, firstOrder: 1 }),
    ...simulate({ prefix: "stu-b", skill: "2", students: 120, answers: 6, settings: { prior: 0.5, transit: 0.3, slip: 0.05, guess: 0.4 }, random: runRandom, firstOrder: 5000 }),
    row("stu-a0", "1", 9000, 0, { original: "0" }),
    row("stu-a0", "NA", 9001, 0),
    row("stu-b0", "1_2", 9002, 1, { answer_text: "says, with a comma" }),
    row("lonely", "7", 9003, 1),
  ];
  const columns = [...Object.keys(row("", "", 0, 0)), "answer_text"];
  const file = path.join(tmp, "made_up.csv");
  fs.writeFileSync(file, toCsv(rows, columns));
  return file;
};
const file = makeFile();
const out = path.join(tmp, "run");
const run = (extra) => runMasteryEvaluation({ data: file, grid: SMALL_GRID, reps: 50, quiet: true, write: false, ...extra });
const results = run({ write: true, out });
const c = results.counts;
const expectedAnswers = 120 * 6 * 2 + 2;
check("the filters are reported", c.rows === expectedAnswers + 2 && c.not_original === 1 && c.no_skill === 1 && c.kept === expectedAnswers, JSON.stringify({ rows: c.rows, kept: c.kept }));
check("students and skills are counted", c.students === 241 && c.skills === 4, `${c.students}, ${c.skills}`);
check("sequence lengths and answers per skill are summarised", c.sequence_length_quartiles[1] === 6 && c.answers_per_skill_quartiles[1] === 360.5, `${c.sequence_length_quartiles[1]}, ${c.answers_per_skill_quartiles[1]}`);
check("every student is tested exactly once", results.per_fold.reduce((s, f) => s + f.students, 0) === c.students);
check("every answer is tested exactly once", results.per_fold.reduce((s, f) => s + f.answers, 0) === c.kept);
check("a single test fold's overall average gives AUC 0.5", results.per_fold.every((f) => near(f.auc.overall, 0.5)));
const models = Object.keys(results.models);
check("the four predictors are compared", models.join() === "overall,per_skill,default,fitted", models.join());
check("each score has an interval around it", models.every((k) => ["auc", "rmse", "accuracy"].every((s) => {
  const { value, ci } = results.models[k][s];
  return ci[0] <= ci[1] && ci[0] - 0.02 <= value && value <= ci[1] + 0.02;
})));
check("on students it was not trained on, a fit beats defaults that are wrong for them", results.models.fitted.auc.value > results.models.default.auc.value && results.models.fitted.rmse.value < results.models.default.rmse.value,
  `AUC ${results.models.fitted.auc.value.toFixed(3)} vs ${results.models.default.auc.value.toFixed(3)}`);
check("the differences are between the same resamples", results.differences.every((d) => near(d.auc.value, results.models[d.a].auc.value - results.models[d.b].auc.value)));
check("the fitted settings sit beside the defaults", results.fitted_settings.by_setting.guess.default === 0.25 && results.fitted_settings.by_setting.guess.quartiles.length === 3);
check("skills with too few answers stay out of that summary", results.fitted_settings.skills === 2 && results.fitted_settings.skills_left_out === 2);
check("the run records the dataset, the seed and the commit", /^[0-9a-f]{64}$/.test(results.dataset.sha256) && results.seed === 1 && "commit" in results && results.dataset.file === "made_up.csv");

const writtenFiles = ["results.json", "results.md", "fitted_settings.csv"].map((name) => fs.readFileSync(path.join(out, name), "utf8"));
check("results.json, results.md and fitted_settings.csv are written", writtenFiles.every((text) => text.length > 0));
check("no student id reaches any of them", writtenFiles.every((text) => !/stu-[ab]\d|lonely/.test(text)));
check("no answer's text reaches any of them", writtenFiles.every((text) => !text.includes("with a comma")));
check("fitted_settings.csv has a row per skill", writtenFiles[2].trim().split(/\r?\n/).length === 5);
const markdown = resultsMarkdown(results);
check("the report tells the four predictors apart", ["Overall average", "Per-skill average", "app's default settings", "fitted per skill"].every((s) => markdown.includes(s)));

const strip = ({ created: _created, seconds: _seconds, ...rest }) => JSON.stringify(rest);
check("the same seed gives exactly the same results", strip(run()) === strip({ ...results, outDir: undefined }));
const otherSeed = run({ seed: 2 });
check("another seed splits the students differently", otherSeed.per_fold.map((f) => f.answers).join() !== results.per_fold.map((f) => f.answers).join() || otherSeed.models.fitted.auc.value !== results.models.fitted.auc.value);

let missing = "";
try {
  runMasteryEvaluation({ data: path.join(tmp, "not_there.csv"), quiet: true });
} catch (err) {
  missing = err.message;
}
check("a missing file is explained, and points at the terms", /not found/.test(missing) && /terms of use/.test(missing), missing);
fs.writeFileSync(path.join(tmp, "empty.csv"), toCsv([row("a", "NA", 1, 1)], Object.keys(row("", "", 0, 0))));
let empty = "";
try {
  run({ data: path.join(tmp, "empty.csv") });
} catch (err) {
  empty = err.message;
}
check("a file with no usable answers is refused", /no usable answers/.test(empty), empty);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
