# How well the mastery model predicts real students' answers

The mastery model (Bayesian Knowledge Tracing, `server/src/services/masteryEngine.js`)
keeps a chance that a student knows each topic and updates it after every
answer. Its settings were never fitted to data (`docs/HANDOVER.md`). This
measurement tests it on the public ASSISTments 2009-10 data: before each answer,
what chance of a right answer does the model give, and how does that compare
with what the student actually did?

`BKT_DEFAULTS` is untouched. Checking this measurement found one bug in the app,
which is now fixed, and the scores below are from the fixed code: see
[The bug this found](#the-bug-this-found).

## The result in short

- **With the app's default settings the model has real predictive value, but
  only moderate.** Its AUC is 0.681. That beats a coin toss (0.5), and it beats
  knowing only how hard each skill is (0.629).
- **Its probabilities are no better than simple averages.** Its RMSE (0.463) is
  no better than the per-skill average's (0.462), and its accuracy (0.660) is
  about the same as always saying "right" (0.658).
- **Settings fitted per skill are clearly better on all three scores**: AUC
  0.725, RMSE 0.438, accuracy 0.713. The team has not acted on this: see
  [The decision left open](#the-decision-left-open).
- **Mastery could stick at 100% for good, and that is now fixed.** The fix raised
  the default AUC from 0.674 to 0.681 on the same students.
- **These are US school maths students, not ours.** Read [the limits](#limits)
  before quoting any of these numbers.

## What the scores mean

**AUC** answers one question. Take one answer that was right and one that was
wrong, at random. How often did the model give the right one the higher chance?

| AUC | Meaning |
| --- | --- |
| 0.5 | No better than tossing a coin |
| 0.681 | The right answer got the higher chance about 68 times in 100 |
| 1.0 | The right answer always got the higher chance |

AUC only looks at the order of the predictions. A model can put answers in a
good order while its chances are all too high or too low, which is why the other
two scores are here as well.

**RMSE** is how far the predicted chance typically is from what happened, where
a right answer counts as 1 and a wrong one as 0. Lower is better. Even a good
model stays well above 0, because an answer is only ever 0 or 1.

**Accuracy** is how often the model's call was correct, calling a chance of 0.5
or more "right". In this data 65.8% of answers are right, so always saying
"right" already scores 0.658. Only a score above that shows the model adds anything.

**95% intervals** are in square brackets. They show how far a score moves if a
different sample of students had been used (see [Method](#method)).

## Results

259,399 answers from 4,163 students on 145 skills. Each predictor was tested
only on students it had not been trained on, and all four were tested on the
same folds.

| Predictor | What it does | AUC [95%] | RMSE [95%] | Accuracy [95%] |
| --- | --- | --- | --- | --- |
| Overall average | Gives every answer the same chance, the training students' average | 0.495 [0.484, 0.506] | 0.474 [0.471, 0.477] | 0.658 [0.649, 0.667] |
| Per-skill average | Gives every answer on a skill that skill's training average, ignoring the student's history | 0.629 [0.624, 0.633] | 0.462 [0.459, 0.465] | 0.672 [0.665, 0.679] |
| Mastery model, app's default settings | Follows the student's answers, with `BKT_DEFAULTS` | 0.681 [0.675, 0.688] | 0.463 [0.461, 0.465] | 0.660 [0.657, 0.664] |
| Mastery model, settings fitted per skill | The same model, with settings fitted on the training students | 0.725 [0.720, 0.730] | 0.438 [0.435, 0.440] | 0.713 [0.708, 0.718] |

The overall average is one number per fold, so inside a fold its AUC is exactly
0.5. Read its AUC as 0.5: the 0.495 only comes from pooling five folds whose
averages differ very slightly.

The differences, over the same resamples. An interval that does not cross zero
means a real difference, for these students.

| Compared | AUC [95%] | RMSE [95%] (lower is better) | Accuracy [95%] |
| --- | --- | --- | --- |
| Fitted minus default | +0.043 [+0.040, +0.046] | −0.025 [−0.027, −0.024] | +0.053 [+0.049, +0.057] |
| Default minus per-skill average | +0.053 [+0.045, +0.061] | +0.001 [−0.001, +0.004] | −0.012 [−0.019, −0.004] |
| Fitted minus per-skill average | +0.096 [+0.090, +0.102] | −0.024 [−0.026, −0.022] | +0.041 [+0.036, +0.046] |
| Default minus overall average | +0.187 [+0.174, +0.199]\* | −0.011 [−0.014, −0.009] | +0.002 [−0.006, +0.012] |

\* This one moves with the split (+0.203 on seed 2), because of the pooling
effect above. Read it as "well above chance".

AUC on each test fold:

| Fold | Students | Answers | Overall average | Per-skill average | Default | Fitted |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 833 | 48,851 | 0.500 | 0.636 | 0.686 | 0.732 |
| 2 | 833 | 49,790 | 0.500 | 0.620 | 0.675 | 0.718 |
| 3 | 833 | 55,251 | 0.500 | 0.632 | 0.681 | 0.724 |
| 4 | 832 | 54,486 | 0.500 | 0.628 | 0.681 | 0.723 |
| 5 | 832 | 51,021 | 0.500 | 0.630 | 0.683 | 0.726 |

## The bug this found

The first version of this report missed this. A separate check that did not round
gave slightly different scores, and the difference turned out to be a real bug.

**The bug.** `updateMastery` rounds mastery to four decimal places. A value near
the top rounded up to exactly 1, and at exactly 1 the update has no way down, so a
wrong answer changed nothing. With the default settings it took 8 right MCQs in a
row on a topic, or 5 full-mark theory answers, and the topic then stayed at 100%
for good.

| Mastery before the wrong answers | Five wrong answers in a row give |
| --- | --- |
| Exactly 1 (before the fix) | 1, 1, 1, 1, 1 |
| 0.9999 (now) | 0.9994, 0.9962, 0.9764, 0.8696, 0.5501 |

**In this data.** Before the fix, 25,551 answers (9.9%) came after mastery had
stuck. The model gave those a 90% chance of being right, and 76.8% were. Now,
20,189 answers (7.8%) are given at the cap and 83.8% of them are right, so the
model is still somewhat too sure at the top.

**In the app.** Going by the code, a stuck topic stayed on the hard tier, was never
flagged as shaky for revision and got less weight when questions were picked. How
many students on the live site this reached has not been checked.

**The fix.** Mastery now stops at 0.9999, the largest value four decimal places can
hold below 1 (`MASTERY_CAP` in `masteryEngine.js`). The cap also applies to the
value coming in, so a topic already stored at 1 moves again when next answered.
Stored values are not rewritten, and 0.9999 still shows as 100% on the page.

**Before and after, on the same students (seed 1).**

| Predictor | AUC [95%] | RMSE [95%] (lower is better) | Accuracy [95%] |
| --- | --- | --- | --- |
| Default settings, before the fix | 0.674 [0.667, 0.680] | 0.465 [0.463, 0.467] | 0.659 [0.656, 0.663] |
| Default settings, after the fix | 0.681 [0.675, 0.688] | 0.463 [0.461, 0.465] | 0.660 [0.657, 0.664] |
| **After minus before, same resamples** | **+0.0076 [+0.0057, +0.0098]** | **−0.0015 [−0.0021, −0.0011]** | **+0.0008 [+0.0004, +0.0014]** |
| Fitted settings, before the fix | 0.724 [0.719, 0.729] | 0.438 [0.436, 0.441] | 0.713 [0.708, 0.718] |
| Fitted settings, after the fix | 0.725 [0.720, 0.730] | 0.438 [0.435, 0.440] | 0.713 [0.708, 0.718] |

- **The gain is real but small overall.** The separate intervals overlap, but the
  paired row compares the same students both ways, and its intervals do not cross
  zero. Most answers never come near the top, so the fix matters most for the
  students who reach it.
- **The gap between fitted and default settings shrank**, from +0.050 to +0.043
  AUC, so part of the earlier gap was this bug. Fitted settings are still clearly
  better.

The "before" rows are from commit `46ba876` and the "after" rows from `839ddc8`. The
paired row comes from a one-off script with the same 1,000 resamples method, written
for this comparison and not part of `eval:mastery`, because the old update is no
longer in the app.

## Fitted settings beside the defaults

Fitted on all students, for this table only (the scores above come from fits
that never saw the students being tested). It covers the 121 skills with at
least 100 answers; the other 24 are left out of the table but not out of the
scores.

| Setting | What it is | App default | Fitted, median skill | Middle half of skills | Skills at the edge of the grid |
| --- | --- | --- | --- | --- | --- |
| prior | Chance the skill is known before any answer | 0.25 | 0.70 | 0.55 to 0.85 | 21 of 121 |
| transit | Chance of learning it at each answer | 0.15 | 0.15 | 0.05 to 0.25 | 26 of 121 |
| slip | Chance of a wrong answer when the skill is known | 0.10 | 0.20 | 0.10 to 0.30 | 20 of 121 |
| guess | Chance of a right answer when it is not known | 0.25 (`guessMcq`) | 0.15 | 0.10 to 0.35 | 48 of 121 |

The biggest gap is the prior. With the default settings the model gives every
student's first answer on a skill a 41.25% chance of being right, and in this
data 60.3% of first answers are right.

## The decision left open

Fitted settings are clearly better than the defaults here, on all three scores,
and that holds on a second split. `BKT_DEFAULTS` has not been changed: that
decision is the team's. Three things bear on it:

1. **These per-skill settings cannot be copied into the app.** They belong to
   ASSISTments' fixed list of maths skills, and our topics come from each
   student's own notes. A median skill here also has 906 answers, which a single
   topic in our app is unlikely to reach.
2. **The app uses one set of settings, and one fitted set was not measured.**
   The fitted result above shows what per-skill settings can do. It does not show
   what one new set of defaults would do.
3. **The numbers describe these students.** A prior of 0.70 fits US pupils
   practising what they have already been taught. Our students may start
   elsewhere. `docs/HANDOVER.md` already plans to fit the settings once enough
   of our own answers are logged, and that would answer this directly.

## Limits

**About what was tested**

- **These are US school maths students, not our students.** The data is from
  2009-10 and covers maths only. A score here is evidence about the model, not
  about how it does on our students or our subjects.
- **Right and wrong answers only.** The team's partial-credit extension in
  `updateMastery` is not tested, because every answer here scores 0 or 1. So the
  model's handling of marked theory answers has no evidence behind it from this
  measurement.
- **One guess rate throughout.** `BKT_DEFAULTS.guessMcq` (0.25) is used for every
  answer. In this data only 8.0% of answers are single-choice (`choose_1`), and
  most (84.1%) are typed algebra. The app's other guess rates (one over the
  number of options, and `guessTheory`) are not tested.
- **It measures prediction, not teaching.** It does not test whether steering
  students by mastery (starting difficulty, which topic comes next) helps them
  learn, or whether mastery should carry across tests taken days apart.

**About this data**

- **Practice stops early.** The data page says a student must get three questions
  right in a row to finish an assignment, so students leave once they succeed.
  The data has few answers from students who already know a skill well, and a
  typical student-skill sequence is short (median 4 answers, middle half 1 to 7).
  Our app has no such rule.
- **"Wrong" also means "asked for help".** `correct` is 0 for a wrong first
  attempt and also for asking for a hint first. Our app has no such hints.
- **Joined skills count as skills of their own.** A question tagged with two
  skills appears as `a_b`, which is 44 of the 145 skills and 17.3% of the answers.
  Practice on `a_b` does not carry over to `a` or `b`.

**About the numbers**

- **The intervals cover one thing only**: which students happened to be sampled.
  They do not cover any limit above, and the settings are not re-fitted in each
  resample, so the fitted model's intervals may be a little too narrow.
- **Do not read much into one skill's fitted settings.** Different combinations
  can fit the same answers about equally well, and the grid has limits: 48 of 121
  skills have a guess rate at the edge of the grid (0.05 or 0.45).
- **Published AUC figures are context only, because their preprocessing differs.**
  The [seewoo5/KT](https://github.com/seewoo5/KT) README gives, for ASSISTments
  2009 (read 2026-11-01): DKT 0.818, DKVMN 0.796, NPA 0.818, SAKT 0.808. Those are
  deep-learning models, not this model. Its README does not say how it filters
  rows, how it treats multi-skill questions, or whether its split is by student,
  and it uses a different test share (30%). So these figures cannot show which
  approach is better on this data or by how much.

## Method

**Data.** `skill_builder_data_corrected_collapsed.csv`, the corrected ASSISTments
2009-10 skill-builder file, with one row per student-problem.

| Step | Rows |
| --- | --- |
| In the file | 346,860 |
| Removed: not a main problem (`original` is not 1) | 71,402 |
| Removed: no skill (`skill_id` is NA) | 16,059 |
| Removed: unreadable answer, student or order | 0 |
| **Answers used** | **259,399** |

The skill is `skill_id`, because 7,994 of the answers used have a `skill_id` but
no `skill_name`. Answers are taken in `order_id` order, which the data's
documentation describes as chronological.

**Split.** Students were shuffled with a fixed seed and dealt into 5 folds. A
student's answers are all in one fold, so no student is in both training and
testing. Each fold is tested once, using what was learned from the other four,
and every score above pools all five.

**The prediction.** For each student and skill, in order, before each answer:
P(correct) = mastery x (1 - slip) + (1 - mastery) x guess. Mastery then updates
with `updateMastery`, imported from the app and not rewritten.

**Default settings.** `BKT_DEFAULTS`, with `guessMcq` as the guess rate, as noted
in the limits. They are not trained at all.

**Fitted settings.** For each skill, 13,851 combinations of settings were tried,
and the one that makes the training students' answers most likely was kept. The
grid is prior 0.05 to 0.95 in steps of 0.05; transit 0.01, 0.05, 0.1, 0.15, 0.2,
0.25, 0.3, 0.4, 0.5; slip and guess 0.05 to 0.45 in steps of 0.05. It includes
the defaults. Slip and guess stop below 0.5, so knowing a skill always makes a
right answer more likely.

**Skills with no training answers.** One test answer was on such a skill. It uses
the overall average in place of the per-skill average, and the default settings
in place of fitted ones.

**Intervals.** 1,000 resamples of the 4,163 students, drawn with repeats. A student
drawn twice counts with all their answers twice. Each interval runs from the 2.5th
to the 97.5th percentile. The differences compare two predictors in the same
resample.

## Running it again

Run in `server/`:

```bash
npm run eval:mastery
```

| | |
| --- | --- |
| Commit | `839ddc8` (this version of the report was added in the next commit) |
| Seed | 1 (the default; `--seed` changes it) |
| Folds, resamples | 5, 1,000 |
| Dataset | `skill_builder_data_corrected_collapsed.csv`, 64,412,812 bytes |
| Dataset SHA-256 | `162ef8d2d28bcbfea6591a282994062bd8d5eaa00636544292a0d268dca6e5da` |
| Takes | About 6 minutes on a laptop |

It reads the file from `server/evaluation-output/datasets/assistments/`, or from
`--data <file>`. It writes `results.md`, `results.json` and `fitted_settings.csv`
to a new folder in `server/evaluation-output/` (git-ignored), or to `--out <dir>`.
They hold scores and settings only, with no rows of the file and no student ids.
The run behind this report passed `--data` and `--out` only because it ran from a
git worktree; nothing else differs from the command above.

Checks on these numbers:

- **Repeatable:** before the fix, a second run with seed 1 gave exactly the same
  results. After the fix, each seed was run once.
- **A second split agrees:** seed 2 gives AUC 0.628 per-skill, 0.681 default and
  0.724 fitted, and fitted minus default is +0.043 [+0.040, +0.046].
- **Worked out a second way:** a separate script in Python, with its own file
  reading, update and AUC, gave the same default-settings scores to 6 decimal
  places. It copies the app's rounding and cap, so it cannot catch an error in
  those: the first such check agreed while the bug was there. It checks the default
  row only.
- **A rough check of the fitted row:** separate code with its own folds, 135 settings
  instead of 13,851 and no rounding gave AUC 0.719. That is close to 0.725 with far
  fewer settings tried, so it shows no sign of test students leaking into training.
  These check scripts are not in this repository.
- **Tested on made-up data:** `server/test/masteryEvaluation.test.mjs` is part of
  `npm test`. It checks the code by hand-worked values and on simulated students,
  and uses none of the real file.

## The data and its terms

The file is not in this repository and must never be: not committed, and no rows
copied into docs or tests. Each person downloads their own copy from the
[data page](https://sites.google.com/site/assistmentsdata/home/2009-2010-assistment-data/skill-builder-data-2009-2010),
where it is linked as the corrected version. The
[terms of use](https://sites.google.com/site/assistmentsdata/termsofuseforusingdata)
were agreed to on 2026-11-01, before the download. In short:

- Do not try to work out who any student is. If something could identify a
  student, delete it, tell Neil Heffernan at WPI (nth@wpi.edu) and help make the
  data anonymous.
- Do not give the data to anyone else, and use it only for this purpose.
- Acknowledge ASSISTments in any publication.
- Papers must make their data and algorithms public. The code behind this
  measurement is in this public repository.

The terms page does not clearly say whether it covers already-released files like
this one, so we follow it anyway.

**If this goes into a publication,** the data page asks for its exact URL, for
this citation, and for a link to the paper to be sent to Dr Heffernan:

> Feng, M., Heffernan, N.T., & Koedinger, K.R. (2009). Addressing the assessment
> challenge in an Intelligent Tutoring System that tutors as it assesses. *User
> Modeling and User-Adapted Interaction*, 19, 243-266.

**Acknowledgement:** this measurement uses data from the ASSISTments TestBed,
<https://sites.google.com/site/assistmentsdata/home/2009-2010-assistment-data/skill-builder-data-2009-2010>.
