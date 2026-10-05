# Evaluating question quality

How to measure whether Mind Atlas writes good questions, in a way that can be
reported: the same notes, several ways of generating questions, people rating
the results without knowing which way wrote which.

Nothing here costs money or needs an account. The code is in
`server/evaluation/`; its checks are `server/test/evaluation.test.mjs`.

**There are no results yet.** This document and the code are the method. The
numbers come from running it on real notes with real raters (steps 1-5).

## What is compared

Each strategy is asked for the same number of questions from the same notes.

| Strategy | What it is | Needs |
| --- | --- | --- |
| `tfidf` | The generator the project had before (commit `d202772`, kept unchanged in `evaluation/baseline/`): single TF-IDF keywords, one word blanked, one theory template. | nothing |
| `terms` | The current generator with rules only: study sentences and whole key terms. This is what runs on the live site today. | nothing |
| `embeddings` | The current generator with the MiniLM model ranking relevance, terms and wrong options. | `npm run semantic:install` |
| `llm` | The current generator with an LLM drafting the questions. | `--llm` and a `GROQ_API_KEY` |

A strategy whose requirement is missing is skipped, and the run says so.

## Two kinds of evidence

**Human ratings** are the main result. Raters score every question on six
criteria (the rubric below).

**Automatic measures** are computed from the questions themselves, written to
`metrics.md`. They are cheap and repeatable, and each says something narrow:

| Measure | What it tells you | Its limit |
| --- | --- | --- |
| Questions produced / requested | Whether a strategy can fill a test from the notes | A strict strategy produces fewer; that is not worse by itself |
| Blanks hiding only part of a term | The "_____ computing" fault | Uses the app's own key-term finder as the reference, so it favours `terms` and `embeddings`. The raters' `whole_term` column is the independent measure |
| Answer still readable in its question, repeated answers, placeholder options | Plain defects | None found does not mean the question is good |
| Option length gap | Whether the right answer stands out by length | Says nothing about plausibility |
| Command words, "your notes", stated length | Whether theory questions read like a question paper | Form only |
| Questions built from off-topic text; relevance gate precision and recall | Whether college names, notices and exercises are kept out | Needs hand labels (step 2); only counted for labelled files |

## The procedure

Commands are run in `server/`, one line at a time.

### 1. Collect the notes

Put real notes in one folder, for example `D:\eval-notes`: PDF, Word,
PowerPoint, text or photos, as students would upload them.

- Use notes the generator has **not** been developed on. The files in
  `server/evaluation/samples/` were, so they are for trying the tool only.
- Aim for at least 10 documents from at least 3 subjects, with different
  authors and formats. Results from one subject or one person's notes say
  little about other notes.
- Only use notes you are allowed to use, and remove anything personal.

### 2. Label the off-topic lines (optional, recommended for 3-5 files)

For a file `unit1.pdf`, create `unit1.pdf.offtopic.txt` beside it and list the
lines that are not subject matter - the college name, "prepared by", notices,
exercises, references - one per line. A distinctive part of the line is
enough; if the line has initials or abbreviations ("Prof. A. B. Rao"), write
it out in full. `evaluation/samples/distributed_systems_unit1.txt.offtopic.txt`
is an example.

Do the labelling **before** looking at any generated question, and have it
done by someone who has not seen the generator's output for that file.

### 3. Generate

```
npm run eval:generate -- D:\eval-notes --out D:\eval-run1 --seed 1
```

Options: `--mcq 6 --theory 4` (questions per file and strategy), `--seed`,
`--labels <folder>`, `--no-embeddings`, `--llm`.

It writes into the output folder:

- `rating_sheet.csv` - the questions from all strategies, shuffled, with no
  sign of which strategy wrote which. Identical questions from two strategies
  appear once.
- `key.csv` - which strategy wrote each question. **Raters must not see it.**
- `metrics.md`, `metrics.json` - the automatic measures.
- `questions.json` - everything generated, for the record.

The same command with the same seed gives the same sheet (except `llm`, whose
output varies from call to call).

### 4. Rate

Each rater gets a copy of `rating_sheet.csv` and this rubric, fills in the
last seven columns in Excel or Google Sheets, and saves it as
`ratings_<name>.csv` (CSV, not .xlsx) in the output folder.

- **At least two raters**, working alone. With one rater there is no evidence
  that the scores are more than one person's taste.
- Raters should know the subject. Ideally they are not the people who built
  the generator; if they are, say so in the report.
- Rate a question as a student would meet it in a test. The `source_sentence`
  column is there to check the answer against the notes.

| Column | Answer | Question to ask yourself |
| --- | --- | --- |
| `relevant` | yes / no | Is this about the subject? "No" for a question about the college, the course arrangements, or one built from an exercise. |
| `correct` | yes / no | Is the marked answer (or the model answer) right, going by the source sentence and the subject? |
| `clear` | 1-5 | Can it be understood and answered without seeing the notes? 1 = cannot tell what is asked; 3 = understandable but awkward or ambiguous; 5 = reads like a question from a paper. |
| `whole_term` | yes / no | Fill in the blank only. Does the blank hide a complete term? "No" if part of the term is still showing ("_____ computing"). Leave empty for theory. |
| `distractors` | 1-5 | Fill in the blank only. Are the wrong options plausible but clearly wrong? 1 = the answer is obvious without knowing the subject, or another option is also right; 3 = one or two weak options; 5 = all three need the knowledge to rule out. |
| `usable` | 1-5 | Would you put it in a real test? 1 = no; 2 = needs rewriting; 3 = needs an edit; 4 = needs a small touch; 5 = as it is. |
| `comment` | text | Optional: what is wrong. |

yes/no may be typed as `yes`/`no`, `y`/`n` or `1`/`0`. An empty cell means
"not rated". Before the real run, have the raters do 10 questions together and
talk through any disagreement, then rate the rest alone; do not include those
10 in the results.

### 5. Score

```
npm run eval:score -- D:\eval-run1
```

It reads every `ratings_*.csv` in the folder and writes `results.md` and
`results.json`:

- **Scores per strategy.** One value per question and criterion: for yes/no
  criteria the majority of its raters (a tie counts as "no"), for 1-5
  criteria their mean. Yes/no criteria are shares with a 95% Wilson interval;
  1-5 criteria are mean and standard deviation, plus the share of questions
  scoring 4 or more.
- **Each strategy against the baseline** (`--baseline`, default `tfidf`).
  Fisher's exact test for yes/no criteria; the Mann-Whitney U test with
  Cliff's delta as effect size for 1-5 criteria. The p-values are
  Holm-corrected for the number of comparisons made; report the corrected
  ones.
- **Agreement between raters**, for every pair: Cohen's kappa for yes/no
  criteria, quadratic-weighted kappa for 1-5 criteria, and the share of
  identical answers.
- **The lowest-rated questions**, with the raters' comments - where to look
  first when improving the generator.
- **Cells that were ignored** (a typo such as "good" in a 1-5 column).

## How many questions

The interval around a share narrows slowly. For a criterion that 80% of
questions meet:

| Rated questions per strategy | 95% interval |
| --- | --- |
| 30 | 63% - 91% |
| 50 | 67% - 89% |
| 100 | 71% - 87% |
| 200 | 74% - 85% |

About 100 questions per strategy is a reasonable target: 10 documents at the
default 10 questions each. With three strategies that is up to 300 rows to
rate, fewer after identical questions are merged.

## What to report

- The notes: how many documents, subjects, formats, and where they came from.
- The raters: how many, who they are relative to the project, and the
  agreement table. If kappa is low on a criterion, say so and treat that
  criterion's scores with caution.
- The scores table, with intervals, and the comparison table with corrected
  p-values and effect sizes.
- The automatic measures, with their limits from the table above.
- The command, the seed, the commit the code was at, and (for `llm`) the model
  name and date.

## Limits to state

- **The baseline is this project's earlier generator**, not a published
  system. The result supports "better than what we had", not "better than
  other tools". Comparing with an external generator would need its output on
  the same notes, rated in the same sheet.
- **Ratings measure the questions, not learning.** Whether students learn
  more from better questions is a different study.
- **The groups overlap slightly.** A question two strategies both wrote is
  rated once and counted for both, so the tests' assumption of independent
  groups is not fully met. `key.csv` shows how many such questions there are.
- **Several raters' scores are combined per question** before testing, which
  hides how much raters differ; the agreement table is where that shows.
- **The off-topic labels are substring matches** on the lines someone chose to
  label. A missed label makes a strategy look better than it is.
- **The sample notes were used during development.** Do not report numbers
  from them.
- **Rule-based paths were written for English engineering notes.** Other
  languages and subjects are untested.

## Files

```
server/evaluation/
  generate.mjs        step 3
  score.mjs           step 5
  baseline/           the earlier generator, frozen
  lib/ingest.js       files -> notes, the way the app builds them
  lib/metrics.js      the automatic measures
  lib/stats.js        intervals, kappa, tests, CSV
  samples/            two small sets of notes for trying the tool
```

`evaluation-output/` and any folder you pass to `--out` inside the repository
should not be committed: they hold your notes' text and the raters' names.
`evaluation-output/` is git-ignored.
