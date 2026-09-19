// Unit tests for the Bayesian Knowledge Tracing update. These check the
// properties that actually matter for adaptive testing - that evidence moves
// mastery the right way, that a guessable question moves it less, and that
// the partial-credit extension collapses to textbook BKT at the endpoints -
// rather than pinning exact numbers that would break on any reparameterisation.
import {
  BKT_DEFAULTS, updateMastery, guessRateFor, applyAttemptToMastery,
  difficultyForMastery, startingDifficulty, topicWeight,
} from "../src/services/masteryEngine.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!cond) failures++;
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

console.log("\n=== BKT update direction ===");
const start = BKT_DEFAULTS.prior;
const afterRight = updateMastery(start, 1, BKT_DEFAULTS.guessMcq);
const afterWrong = updateMastery(start, 0, BKT_DEFAULTS.guessMcq);
check("a correct answer raises mastery", afterRight > start, `${start} -> ${afterRight}`);
check("a wrong answer lowers it below the correct case", afterWrong < afterRight, `wrong ${afterWrong} < right ${afterRight}`);
check("mastery stays within [0,1]", afterRight <= 1 && afterWrong >= 0, `${afterWrong} .. ${afterRight}`);

console.log("\n=== Guessability weakens the evidence ===");
const easyGuess = updateMastery(start, 1, 0.5);   // 2 options
const hardGuess = updateMastery(start, 1, 0.05);  // essentially unguessable
check("a correct answer counts for more when guessing is unlikely", hardGuess > easyGuess,
  `guess .05 -> ${hardGuess}  vs  guess .5 -> ${easyGuess}`);
check("theory guess rate is below MCQ", BKT_DEFAULTS.guessTheory < BKT_DEFAULTS.guessMcq);
check("guessRateFor reads a 4-option MCQ as 0.25", near(guessRateFor({ type: "mcq", options: [1, 2, 3, 4] }), 0.25));
check("guessRateFor reads a 2-option MCQ as 0.5", near(guessRateFor({ type: "mcq", options: [1, 2] }), 0.5));
check("guessRateFor uses the theory rate for theory", near(guessRateFor({ type: "theory" }), BKT_DEFAULTS.guessTheory));

console.log("\n=== Partial credit collapses to textbook BKT at the endpoints ===");
const half = updateMastery(start, 0.5, BKT_DEFAULTS.guessTheory);
const full = updateMastery(start, 1, BKT_DEFAULTS.guessTheory);
const none = updateMastery(start, 0, BKT_DEFAULTS.guessTheory);
check("half credit lands between the two endpoints", half > none && half < full, `${none} < ${half} < ${full}`);
check("score 1 equals the fully-correct posterior", near(full, updateMastery(start, 1.0, BKT_DEFAULTS.guessTheory)));

console.log("\n=== Repeated evidence accumulates ===");
let p = start;
for (let i = 0; i < 6; i++) p = updateMastery(p, 1, BKT_DEFAULTS.guessMcq);
check("six correct answers push mastery high", p > 0.9, `${p}`);
let q = 0.9;
for (let i = 0; i < 6; i++) q = updateMastery(q, 0, BKT_DEFAULTS.guessMcq);
check("six wrong answers pull a confident topic down", q < 0.5, `${q}`);

console.log("\n=== Difficulty tiers ===");
check("weak mastery opens on easy", difficultyForMastery(0.2) === "easy");
check("mid mastery opens on medium", difficultyForMastery(0.55) === "medium");
check("strong mastery opens on hard", difficultyForMastery(0.9) === "hard");
check("no history falls back to medium", difficultyForMastery(undefined) === "medium");
check("a fresh student (prior only) opens on medium — unchanged from before mastery existed",
  startingDifficulty(["t1", "t2"], new Map()) === "medium");
check("a struggling student opens on easy",
  startingDifficulty(["t1"], new Map([["t1", { pKnown: 0.15, observations: 8 }]])) === "easy");
check("too little evidence stays on medium even when mastery looks weak",
  startingDifficulty(["t1"], new Map([["t1", { pKnown: 0.05, observations: 2 }]])) === "medium");
check("a strong student opens on hard",
  startingDifficulty(["t1"], new Map([["t1", { pKnown: 0.95, observations: 8 }]])) === "hard");
check("a demonstrated track record outweighs one untested topic in the pool",
  startingDifficulty(["t1", "t2", "t3"], new Map([
    ["t1", { pKnown: 0.93, observations: 3 }],
    ["t2", { pKnown: 0.93, observations: 3 }],
  ])) === "hard", "two proven topics + one never seen should still open hard");
check("but many untested topics do pull back toward the middle",
  startingDifficulty(["t1", "t2", "t3", "t4", "t5", "t6"], new Map([
    ["t1", { pKnown: 0.93, observations: 3 }],
  ])) === "medium");

console.log("\n=== Topic weighting ===");
const mm = new Map([
  ["weak", { pKnown: 0.1, observations: 10 }],
  ["strong", { pKnown: 0.95, observations: 10 }],
]);
check("a weak topic outweighs a strong one", topicWeight("weak", mm) > topicWeight("strong", mm),
  `weak ${topicWeight("weak", mm)} vs strong ${topicWeight("strong", mm)}`);
check("an unseen topic outweighs a well-known one", topicWeight("unseen", mm) > topicWeight("strong", mm),
  `unseen ${topicWeight("unseen", mm)}`);
check("every weight is strictly positive so no topic starves", topicWeight("strong", mm) > 0);

console.log("\n=== Folding a whole attempt ===");
const questionsById = new Map([
  ["q1", { _id: "q1", type: "mcq", topicId: "n1", topic: "Atoms", options: [1, 2, 3, 4] }],
  ["q2", { _id: "q2", type: "mcq", topicId: "n1", topic: "Atoms", options: [1, 2, 3, 4] }],
  ["q3", { _id: "q3", type: "theory", topicId: "n2", topic: "Bonds" }],
]);
const responses = [
  { questionId: "q1", score: 0, answeredAt: "2026-09-19T10:00:00Z" },
  { questionId: "q2", score: 0, answeredAt: "2026-09-19T10:01:00Z" },
  { questionId: "q3", score: 1, answeredAt: "2026-09-19T10:02:00Z" },
];
const folded = applyAttemptToMastery({ responses, questionsById, existing: new Map() });
const atoms = folded.get("n1");
const bonds = folded.get("n2");
check("both topics are tracked", folded.size === 2, `got ${folded.size}`);
check("two wrong answers lower the Atoms topic", atoms.after < atoms.before, `${atoms.before} -> ${atoms.after}`);
check("a correct theory answer raises the Bonds topic", bonds.after > bonds.before, `${bonds.before} -> ${bonds.after}`);
check("observation counts are recorded", atoms.observations === 2 && bonds.observations === 1);
check("display labels are carried", atoms.topicLabel === "Atoms" && bonds.topicLabel === "Bonds");

console.log("\n=== Prior history carries into the next attempt ===");
const existing = new Map([["n1", { pKnown: 0.8, observations: 5 }]]);
const second = applyAttemptToMastery({ responses, questionsById, existing });
check("the second attempt starts from stored mastery, not the prior",
  second.get("n1").before === 0.8, `before = ${second.get("n1").before}`);
check("observations accumulate across attempts",
  second.get("n1").observations === 7, `observations = ${second.get("n1").observations}`);

console.log(`\n${failures === 0 ? "All checks passed." : failures + " FAILING CHECK(S)"}`);
process.exit(failures === 0 ? 0 : 1);
