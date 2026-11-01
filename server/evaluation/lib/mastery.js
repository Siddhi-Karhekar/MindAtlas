// The working parts of the mastery measurement (evaluation/mastery.mjs,
// docs/measurements/mastery.md): real answers -> each student's answers on each
// skill in order, students split into folds, the four ways of predicting an
// answer, and their scores. Pure, so test/masteryEvaluation.test.mjs can check
// every step. The mastery model itself is the app's: updateMastery and
// BKT_DEFAULTS are imported from services/masteryEngine.js, never copied here.

import { BKT_DEFAULTS, updateMastery } from "../../src/services/masteryEngine.js";
import { shuffled } from "./stats.js";

// The app's default settings as one set. The app picks the guess rate by
// question type; this data has no such match, so the multiple-choice default
// stands for all of it.
export const DEFAULT_SETTINGS = {
  prior: BKT_DEFAULTS.prior,
  transit: BKT_DEFAULTS.transit,
  slip: BKT_DEFAULTS.slip,
  guess: BKT_DEFAULTS.guessMcq,
};

const steps = (from, to, by) => {
  const out = [];
  for (let x = from; x <= to + 1e-9; x += by) out.push(Number(x.toFixed(2)));
  return out;
};

// The settings tried when fitting a skill, every combination of these. The
// app's defaults are all on it, so on the training answers a fit can never do
// worse than the defaults. Slip and guess stop below 0.5, so knowing a skill
// always makes a right answer more likely than not knowing it.
export const FIT_GRID = {
  prior: steps(0.05, 0.95, 0.05),
  transit: [0.01, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5],
  slip: steps(0.05, 0.45, 0.05),
  guess: steps(0.05, 0.45, 0.05),
};

// ---------------------------------------------------------------------------
// Rows -> answers
// ---------------------------------------------------------------------------

const MISSING = new Set(["", "NA", "NULL", "null"]);
const COLUMNS = ["order_id", "user_id", "original", "correct", "skill_id", "skill_name", "answer_type"];

/**
 * The answers the measurement uses, from the file's rows: main problems only
 * (`original` 1, not the scaffolding steps), with a skill. `skill_id` is the
 * skill, because `skill_name` is sometimes blank where it is not and is not
 * joined the way it is: a question with several skills has them as "a_b", which
 * counts as one skill of its own. Returns { answers, counts }; `counts` says how
 * many rows each filter removed, in the order they ran, and describes what is
 * left.
 */
export function readAnswers(rows) {
  if (rows.length) {
    const absent = COLUMNS.filter((c) => !(c in rows[0]));
    if (absent.length) throw new Error(`the file has no column ${absent.join(", ")}`);
  }
  const counts = { rows: rows.length, not_original: 0, no_skill: 0, unreadable: 0, kept: 0, without_skill_name: 0, joined_skills: 0, answer_types: {} };
  const answers = [];
  for (const r of rows) {
    if (Number(r.original) !== 1) counts.not_original += 1;
    else if (MISSING.has(r.skill_id)) counts.no_skill += 1;
    else if ((r.correct !== "0" && r.correct !== "1") || MISSING.has(r.user_id) || MISSING.has(r.order_id) || !Number.isFinite(Number(r.order_id))) counts.unreadable += 1;
    else {
      answers.push({ student: r.user_id, skill: r.skill_id, skillName: MISSING.has(r.skill_name) ? "" : r.skill_name, order: Number(r.order_id), correct: Number(r.correct) });
      counts.kept += 1;
      if (MISSING.has(r.skill_name)) counts.without_skill_name += 1;
      if (r.skill_id.includes("_")) counts.joined_skills += 1;
      counts.answer_types[r.answer_type] = (counts.answer_types[r.answer_type] || 0) + 1;
    }
  }
  return { answers, counts };
}

/** Each student's answers on each skill, in `order_id` order: [{ student, skill, correct: [0|1, ...] }]. */
export function sequencesOf(answers) {
  const byKey = new Map();
  for (const a of answers) {
    const key = `${a.student}\n${a.skill}`;
    if (!byKey.has(key)) byKey.set(key, { student: a.student, skill: a.skill, list: [] });
    byKey.get(key).list.push(a);
  }
  return [...byKey.values()].map(({ student, skill, list }) => ({
    student,
    skill,
    correct: list.sort((x, y) => x.order - y.order).map((a) => a.correct),
  }));
}

/**
 * Every student into one of `folds` folds of even size: Map student -> fold.
 * The order the students arrive in makes no difference, only `random` does.
 */
export function assignFolds(students, folds, random) {
  const ids = [...new Set(students)].sort();
  return new Map(shuffled(ids, random).map((id, i) => [id, i % folds]));
}

// ---------------------------------------------------------------------------
// The mastery model
// ---------------------------------------------------------------------------

/** The chance of a right answer, from the chance the student knows the skill. */
export const pCorrect = (mastery, { slip, guess }) => mastery * (1 - slip) + (1 - mastery) * guess;

/**
 * One student's answers on one skill: the chance of each answer being right,
 * worked out before that answer is used to update mastery.
 */
export function predictSequence(correct, settings) {
  let mastery = settings.prior;
  return correct.map((y) => {
    const p = pCorrect(mastery, settings);
    mastery = updateMastery(mastery, y, settings.guess, settings);
    return p;
  });
}

/**
 * One skill's answers as a tree of answer histories: every student who began
 * right, right, wrong shares that path, so a history is worked out once
 * however many students had it (about a third as many as there are answers).
 * Node 0 is no answers yet. A node's counts say how the answers given straight
 * after that history went, per fold. Parents always come before their children.
 */
export function historyTree(sequences, foldOf, folds) {
  const parent = [-1];
  const answer = [0];
  const right = [new Array(folds).fill(0)];
  const wrong = [new Array(folds).fill(0)];
  const childOf = new Map();
  const answersInFold = new Array(folds).fill(0);
  for (const { student, correct } of sequences) {
    const fold = foldOf.get(student);
    let node = 0;
    for (const y of correct) {
      (y ? right : wrong)[node][fold] += 1;
      answersInFold[fold] += 1;
      const key = node * 2 + y;
      if (!childOf.has(key)) {
        childOf.set(key, parent.length);
        parent.push(node);
        answer.push(y);
        right.push(new Array(folds).fill(0));
        wrong.push(new Array(folds).fill(0));
      }
      node = childOf.get(key);
    }
  }
  return { size: parent.length, folds, parent, answer, right, wrong, answersInFold, mastery: new Float64Array(parent.length) };
}

/** How likely a tree's answers are under `settings`, as a log-likelihood per fold, into `out`. */
export function logLikelihoods(tree, settings, out) {
  const { size, folds, parent, answer, right, wrong, mastery } = tree;
  out.fill(0);
  for (let i = 0; i < size; i++) {
    mastery[i] = i === 0 ? settings.prior : updateMastery(mastery[parent[i]], answer[i], settings.guess, settings);
    const p = pCorrect(mastery[i], settings);
    const logRight = Math.log(p);
    const logWrong = Math.log(1 - p);
    for (let f = 0; f < folds; f++) out[f] += right[i][f] * logRight + wrong[i][f] * logWrong;
  }
  return out;
}

/**
 * Fit one skill: try every combination on the grid and keep the one that makes
 * the answers most likely. A fold's fit leaves that fold's students out. Each
 * combination is run once over everyone, and a fold's training total is the
 * whole total minus that fold. Returns { byFold, all }: the settings for each
 * test fold (null when the skill has no training answers for it) and the fit
 * on all students, which is only ever reported, never scored.
 */
export function fitSkill(sequences, foldOf, folds, grid = FIT_GRID) {
  const tree = historyTree(sequences, foldOf, folds);
  const ll = new Float64Array(folds);
  const bestByFold = new Array(folds).fill(-Infinity);
  const byFold = new Array(folds).fill(null);
  let bestAll = -Infinity;
  let all = null;
  for (const prior of grid.prior) {
    for (const transit of grid.transit) {
      for (const slip of grid.slip) {
        for (const guess of grid.guess) {
          const settings = { prior, transit, slip, guess };
          logLikelihoods(tree, settings, ll);
          let total = 0;
          for (let f = 0; f < folds; f++) total += ll[f];
          if (total > bestAll) {
            bestAll = total;
            all = settings;
          }
          for (let f = 0; f < folds; f++) {
            const training = total - ll[f];
            if (training > bestByFold[f]) {
              bestByFold[f] = training;
              byFold[f] = settings;
            }
          }
        }
      }
    }
  }
  const answers = tree.answersInFold.reduce((a, b) => a + b, 0);
  return { byFold: byFold.map((s, f) => (answers - tree.answersInFold[f] > 0 ? s : null)), all, answers };
}

// ---------------------------------------------------------------------------
// The four predictors, on the same test folds
// ---------------------------------------------------------------------------

export const MODELS = ["overall", "per_skill", "default", "fitted"];

/**
 * Every answer predicted by all four, each only from students outside the
 * answer's fold. `fits` is Map skill -> fitSkill's result. A skill with no
 * training answers for a fold falls back: the per-skill average to the overall
 * average, the fitted model to the app's defaults (`unseen` counts these).
 * Returns the answers as parallel arrays, so one student's rows can be
 * reweighted at once: { y, student, fold, students, preds: { model: p[] },
 * unseen, firstAnswers }.
 */
export function predictAll(sequences, foldOf, folds, fits) {
  const size = sequences.reduce((s, q) => s + q.correct.length, 0);
  const totals = { right: new Array(folds).fill(0), all: new Array(folds).fill(0) };
  const bySkill = new Map();
  for (const { student, skill, correct } of sequences) {
    const f = foldOf.get(student);
    if (!bySkill.has(skill)) bySkill.set(skill, { right: new Array(folds).fill(0), all: new Array(folds).fill(0) });
    const row = bySkill.get(skill);
    for (const y of correct) {
      totals.right[f] += y;
      totals.all[f] += 1;
      row.right[f] += y;
      row.all[f] += 1;
    }
  }
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  const training = (counts, f) => ({ right: sum(counts.right) - counts.right[f], all: sum(counts.all) - counts.all[f] });

  const studentIndex = new Map([...new Set(sequences.map((q) => q.student))].sort().map((id, i) => [id, i]));
  const y = new Uint8Array(size);
  const student = new Int32Array(size);
  const fold = new Uint8Array(size);
  const preds = Object.fromEntries(MODELS.map((m) => [m, new Float64Array(size)]));
  const firstAnswers = { right: 0, all: 0 };
  let unseen = 0;
  let at = 0;
  for (const q of sequences) {
    const f = foldOf.get(q.student);
    const everyone = training(totals, f);
    if (!everyone.all) throw new Error("a fold holds every student - nothing to train on");
    const overall = everyone.right / everyone.all;
    const skill = training(bySkill.get(q.skill), f);
    const skillAverage = skill.all ? skill.right / skill.all : overall;
    const fitted = fits.get(q.skill)?.byFold[f] ?? DEFAULT_SETTINGS;
    if (!skill.all) unseen += q.correct.length;
    const byDefault = predictSequence(q.correct, DEFAULT_SETTINGS);
    const byFit = predictSequence(q.correct, fitted);
    firstAnswers.right += q.correct[0];
    firstAnswers.all += 1;
    for (let i = 0; i < q.correct.length; i++, at++) {
      y[at] = q.correct[i];
      student[at] = studentIndex.get(q.student);
      fold[at] = f;
      preds.overall[at] = overall;
      preds.per_skill[at] = skillAverage;
      preds.default[at] = byDefault[i];
      preds.fitted[at] = byFit[i];
    }
  }
  return { y, student, fold, students: studentIndex.size, preds, unseen, firstAnswers };
}

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

/** The answers' indices, lowest prediction first. Works out once what every resample walks. */
export function orderBy(p) {
  return Int32Array.from(p.keys()).sort((a, b) => p[a] - p[b]);
}

/**
 * AUC, RMSE and accuracy, each row counted `weights[student[row]]` times. AUC
 * counts every right-wrong pair of answers: 1 when the right one was predicted
 * higher, a half when level. Accuracy calls a prediction of 0.5 or above "right".
 * Null scores when the rows weighted in leave nothing to compare.
 */
export function scoreWeighted({ y, p, order, student, weights }) {
  let rights = 0;
  let wrongs = 0;
  let pairs = 0;
  let squared = 0;
  let hits = 0;
  let predicted = 0;
  for (let k = 0; k < order.length; ) {
    const level = p[order[k]];
    let right = 0;
    let wrong = 0;
    for (; k < order.length && p[order[k]] === level; k++) {
      const row = order[k];
      const w = weights[student[row]];
      if (y[row]) right += w;
      else wrong += w;
      squared += w * (level - y[row]) * (level - y[row]);
      if ((level >= 0.5) === (y[row] === 1)) hits += w;
    }
    pairs += right * (wrongs + wrong / 2);
    predicted += level * (right + wrong);
    rights += right;
    wrongs += wrong;
  }
  const total = rights + wrongs;
  if (!total) return { auc: null, rmse: null, accuracy: null, predicted: null };
  return {
    auc: rights && wrongs ? pairs / (rights * wrongs) : null,
    rmse: Math.sqrt(squared / total),
    accuracy: hits / total,
    predicted: predicted / total,
  };
}

/**
 * The scores in `reps` resamples of the students: each resample draws as many
 * students as there are, with repeats, and a student drawn twice counts with
 * all their answers twice. Returns { model: [scores per resample] }.
 */
export function bootstrapScores({ y, student, students, preds }, orders, random, reps = 1000) {
  const draws = Object.fromEntries(Object.keys(preds).map((m) => [m, []]));
  const weights = new Float64Array(students);
  for (let rep = 0; rep < reps; rep++) {
    weights.fill(0);
    for (let s = 0; s < students; s++) weights[Math.floor(random() * students)] += 1;
    for (const m of Object.keys(preds)) draws[m].push(scoreWeighted({ y, p: preds[m], order: orders[m], student, weights }));
  }
  return draws;
}

/** The 95% percentile interval of a list of numbers, ignoring nulls. */
export function interval(values) {
  const sorted = values.filter((v) => v !== null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return [at(0.025), at(0.975)];
}

/** Middle of a list, and its quartiles: [q1, median, q3]. */
export function quartiles(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => {
    const pos = q * (sorted.length - 1);
    const low = Math.floor(pos);
    const high = Math.ceil(pos);
    return sorted[low] + (sorted[high] - sorted[low]) * (pos - low);
  };
  return [at(0.25), at(0.5), at(0.75)];
}
