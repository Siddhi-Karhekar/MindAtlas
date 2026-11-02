# How good MindAtlas's generated questions are, rated by AI

This measurement rates 210 questions the app's generators wrote from our notes. The rater is an
AI, Claude Opus 5.5, and its judgement was first checked against scores people gave on a public
set of questions.

**It compares the old generator with the current rules. It says nothing about AI-written
questions, because none were rated.** The AI was asked to write the questions in the `llm` part of
this run, but it wrote 0 of them and the rules wrote them all
([the Groq report](groq-path.md) explains why).

No app code was changed.

## The result in short

- **Rated by AI. On a public human-scored set, this rater agreed with people by a Spearman of 0.76
  on whether the answer fits the question, but only 0.18 and 0.21 on clarity and answerability.**
  On those two, a rater who always answers "3" came as close to people or closer. So trust the
  "answer is correct" scores most, and the "clear" scores little.
- **The current rules beat the old generator on most things.** Usable in a real test: 2.77 against
  2.31 out of 5. Blanks hiding a whole term: 96% against 63%. Wrong options that are plausible:
  2.43 against 1.65.
- **The current rules are worse on one thing: correct answers.** 86% against 97%. Almost all of the
  wrong ones are theory questions (14 of 42), where a question pattern does not fit the sentence
  it was built from.
- **Neither is good enough to use without checking.** An average of 2.77 sits between "needs
  rewriting" and "needs an edit". Only 33% of the current rules' questions scored 4 or more.
- **This is one AI's opinion.** `docs/EVALUATION.md` asks for at least two raters, and the scoring
  tool itself warns that a second rater is needed. Read [the limits](#limits) before quoting these
  numbers.

## What the scores mean

Each question was rated on the rubric in `docs/EVALUATION.md`:

| Score | Question it answers | Scale |
| --- | --- | --- |
| Relevant | Is it about the subject? | yes / no |
| Correct | Is the marked or model answer right? | yes / no |
| Clear | Can it be understood and answered without the notes? | 1 (cannot tell what is asked) to 5 (reads like an exam paper) |
| Whole term | Does the blank hide a complete term? Blanks only | yes / no |
| Wrong options | Are the wrong options plausible but clearly wrong? Blanks only | 1 (obvious, or another option is also right) to 5 (all need real knowledge) |
| Usable | Would you put it in a real test? | 1 (no), 2 (needs rewriting), 3 (needs an edit), 4 (a small touch), 5 (as it is) |

**95% intervals** are in square brackets. They show how far a score could move if a different
sample of questions had been drawn.

**Holm-corrected p-value.** The p-value is the chance of a gap this big if the two methods were
really equal. Twelve comparisons were made, and the more you make, the more likely one looks real
by luck. Holm's correction allows for that. Below 0.05 is the usual line for "a real difference".

**Spearman** shows whether two raters put questions in the same order, from −1 (opposite) through
0 (unrelated) to +1 (the same). **The gap** is the average distance between this rater's score and
the people's score, in points on their 1-to-3 scale.

## Results

### Old generator against current rules

The old generator is `tfidf` in the tool's tables and the current rules are `terms`. The sheet did
not show which method wrote which question.

| Score | Current rules (105 questions) | Old generator (100 questions) | Difference | p, Holm-corrected |
| --- | --- | --- | --- | --- |
| Relevant | 100% [97%, 100%] | 100% [96%, 100%] | 0 points | 1.000 |
| Correct | 86% [78%, 91%] | 97% [92%, 99%] | **−11 points, old is better** | 0.038 |
| Clear | 3.41 [3.15, 3.66] | 3.10 [2.86, 3.34] | +0.31 [−0.05, +0.65] | 0.337 |
| Whole term (56 and 60 blanks) | 96% [88%, 99%] | 63% [51%, 74%] | **+33 points** | <0.001 |
| Wrong options (56 and 60 blanks) | 2.43 [2.16, 2.70] | 1.65 [1.50, 1.82] | **+0.78** [+0.46, +1.08] | <0.001 |
| Usable | 2.77 [2.55, 2.98] | 2.31 [2.13, 2.48] | **+0.46** [+0.18, +0.74] | 0.021 |
| Usable scored 4 or more | 33% [25%, 43%] | 10% [6%, 17%] | +23 points | not tested |

- **The `llm` column repeats the rules.** 100 of its 105 questions are the same as in `terms`, and
  its scores are nearly the same (correct 86%, usable 2.71), so it is not shown as a third method.
- **Relevant does not separate them.** Every question was about the subject.
- **Clear is not a real difference.** Its interval crosses zero, and it is also where this rater
  agreed with people least.
- **Usable by type.** Theory: 2.36 for the rules, 1.60 for the old generator. Blanks and multiple
  choice together: 3.05 and 2.78. The rules were ahead in all 7 documents.
- **Where the wrong answers are.** The rules got 14 of 42 theory questions and 1 of 63 others
  wrong. The old generator got 3 of 40 and 0 of 60. Its theory questions have the source sentence
  itself as the answer, which can rarely be wrong even when the question is poor. So its 97% says
  less than it seems to.

### Agreement with people

150 rows of QGEval, one from each of 150 reading passages. Each human score is the mean of 3
people on a 1-to-3 scale. This rater gave whole numbers from 1 to 3 before seeing any human score.

| Score | Spearman [95%] | Gap, this rater | Gap, always answering 3 | Rows people scored 3 |
| --- | --- | --- | --- | --- |
| Clarity | 0.18 [−0.02, 0.38] | 0.24 | **0.12** | 120 of 150 |
| Answerability | 0.21 [0.00, 0.41] | 0.23 | 0.21 | 111 of 150 |
| Answer consistency | **0.76** [0.67, 0.83] | **0.21** | 0.46 | 88 of 150 |

`relevance` is left out, because people gave a 3 on 147 of the 150 rows.

- **Answer consistency is the one solid check.** This rater beats always answering 3 by a wide
  margin. It marked 34 rows down, and people gave none of those full marks. It also missed some:
  on 16 rows it gave 3 where people gave under 2.5.
- **Clarity and answerability are weak.** Both intervals reach zero, and always answering 3 does as
  well or better. On clarity this rater was too strict: it marked down 21 rows that all 3 people
  gave full marks, for grammar or long wording. On answerability it was too generous, giving 3 on 18 rows
  where people gave under 2.5.
- **Most of the scores on our questions have no check at all.** Answer consistency is close to our
  `correct`, and clarity is close to our `clear`. Nothing in QGEval checks `usable`, `whole_term` or
  the wrong options, and `usable` is the score the headline rests on.

### The commonest faults

These are counted from this rater's own comments on questions that scored 2 or lower on usable.
They were grouped after rating, and one question can count twice, so the counts are approximate.

**Current rules, 44 of 105 questions:**

- **About 21: no clear subject.** A section heading is used as if it were the topic, or the question
  never says what it is about, so it cannot be answered without the notes.
- **About 7: weak options.** The answer is obvious, or another option is also right.
- **About 6: the model answer does not answer the question.** Asking for the difference between two
  things that a sentence merely lists together is the usual case.
- **5: a plain sentence treated as a formula.** A sentence with an equals sign in it gets a question
  asking the student to explain the formula's terms. All 5 scored 1 on usable and were marked wrong.

**Old generator, 59 of 100 questions:**

- **About 34: a common word treated as a concept.** All 40 of its theory questions use one pattern,
  which asks what the notes say about a single word, and many of those words mean little alone.
- **About 11: several blanks, or a blank hiding a filler word.**
- **About 10: options obvious.** Many options come from unrelated parts of the notes.

## Limits

- **It is AI-rated, not rated by people, so faculty may still ask for people.**
- **There is one rater, while `docs/EVALUATION.md` asks for at least two.** Agreement between raters
  could not be measured, so nothing shows these scores are more than one rater's taste. The rubric's
  practice round of 10 questions was also not possible.
- **The rater is the same kind of AI that helped build the app, and it also wrote this report.** That
  is a conflict of interest, and the check against people only partly offsets it.
- **QGEval's questions come from reading passages, not engineering notes, so the agreement only
  partly carries over.** An AI that judges general-knowledge questions may judge engineering ones
  better or worse.
- **No AI-written questions were rated.** Nothing here says how good the AI's questions would be.
- **The notes are 7 documents from 2 subjects, while `docs/EVALUATION.md` asks for at least 10 from
  3.** They are the team's own notes, and 5 of the 7 are one subject.
- **Hiding the method was only partly effective.** The sheet did not name the method, but each
  generator has its own question patterns, and the rater had been told what was being compared.
- **The intervals cover one thing only**: which questions happened to be sampled. They do not cover
  any limit above. Questions from one document are not fully independent either.
- **The old generator is this project's own earlier version.** The result supports "better than what
  we had", not "better than other tools".
- **Ratings measure the questions, not learning.**

## Method

**Rating.** Claude Opus 5.5 (`claude-opus-5-5`) read and judged every row itself. No script or other
AI gave a rating. The QGEval ratings were saved first, then the 210 ratings, each before seeing the
human scores, `key.csv` or the metrics. No rating was changed afterwards, and the files' SHA-256
values below were recorded before scoring and checked again after it.

**The QGEval sample.** Seed 1: 150 of the 200 passages, and one of each passage's 15 rows. The rater
saw only the passage, answer and question. The Spearman intervals come from 10,000 resamples of the
rows, drawn with repeats. A one-off script gave the intervals on the 1-to-5 means and their
differences the same way. The tool gave every other number in the comparison table.

**Our questions.** The run is the one in [the Groq report](groq-path.md): 7 documents, 9 blanks and 6
theory questions per document and method, seed 1, 310 questions and 210 rows after merging identical
ones. The old generator and the rules share no questions.

## Running it again

In `server/`, with the ratings file in the questions folder:

```bash
node evaluation/score.mjs evaluation-output/questions-run1
```

This repeats the scoring only. A new rating session could give different ratings.

| | |
| --- | --- |
| Commit | `7396466` for the scoring (this report was added in the next commit). The questions came from `72173dd` |
| Seed | 1, for both the question run and the QGEval sample |
| Rater | Claude Opus 5.5, `claude-opus-5-5` |
| Date | 2026-11-02 |
| `ratings_claude.csv` | SHA-256 `46c37162c5e050c907b43212af6df0329fe0dabb676d2c344435a79f59c92092` |
| `qgeval_ratings_claude.csv` | SHA-256 `cc03208e85e8e6dc6b4b7dce265b2569833f011118de9a952d222f07bb52c867` |
| QGEval `scores.xlsx` | SHA-256 `4efd3634e0c6099e45dc0134e6820ff32a888e4d6edcc838dedbb6a6f83a104a` |

The one-off scripts stay in the git-ignored working folder, `server/evaluation-output/quality-run1/`,
and are not part of this repository. The ratings and the tool's `results.md` and `results.json` are
in the git-ignored `server/evaluation-output/questions-run1/`. `results.md` is titled "human ratings"
because that is the tool's fixed title. These ratings are the AI's, and that file also quotes the
notes, so it must not be shared.

Checks on these numbers:

- **Everything was rated.** All 210 and all 150 rows have ratings, and the tool reports no ignored
  cells.
- **Worked out a second way.** A separate script took the mean usable and the share relevant for each
  method straight from `ratings_claude.csv` and `key.csv`. They match the tool: 2.77, 2.71 and 2.31,
  and 100% for all three.
- **The rater's scores were not corrected after the comparison.** The weak agreement above is
  reported as it came out.

## The data and its terms

**Credit.** The check uses QGEval, by Weiping Fu, Bifan Wei, Jianxiang Hu, Zhongmin Cai and Jun Liu,
from its [official repository](https://github.com/WeipingFu/QGEval). The citation was checked against
the [ACL Anthology page](https://aclanthology.org/2024.emnlp-main.658/) on 2026-11-02. The repository
states no licence, so its files stay out of this repository, and no row of it is copied here.

> Fu, W., Wei, B., Hu, J., Cai, Z., & Liu, J. (2024). QGEval: Benchmarking Multi-dimensional Evaluation
> for Question Generation. In *Proceedings of the 2024 Conference on Empirical Methods in Natural
> Language Processing*, pages 11783-11803. Association for Computational Linguistics.
> https://doi.org/10.18653/v1/2024.emnlp-main.658
