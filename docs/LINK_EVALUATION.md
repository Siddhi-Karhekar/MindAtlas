# Evaluating the knowledge graph's links

How to check whether the graph links the right notes, and how to choose the
linking thresholds from evidence: real notes, every pair of topics scored the
way the graph scores it, people judging a sample of pairs without seeing the
scores.

Nothing here costs money or needs an account. The code is
`server/evaluation/links.mjs` and `server/evaluation/lib/links.js`; its checks
are `server/test/linkEvaluation.test.mjs`.

The first run (14 Oct 2026) is under "Results" below: it lowered the
same-subject threshold from 0.12 to 0.11 and kept the cross-subject rule.
The same ratings were then scored again to try TextRank keywords, which were
not kept: "Keywords and TextRank", below. A second run, sampled and rated on
sentence-embedding similarity, made cross-subject links by meaning:
"Sentence embeddings", below. Both runs' ratings were then read as labels for
the graph's clusters, which moved from connected components to Louvain
community detection: "Clusters", below. Links students remove as wrong can
refit the rule from a backup, checked on the same ratings: "Students'
corrections", below.

## What is measured

The linking rule (`server/src/services/graphEngine.js`, `decideLink`) has
these numbers:

| Constant | Now | What it does |
| --- | --- | --- |
| `SIMILARITY_THRESHOLD` | 0.11 | Two topics in the same subject are linked at this similarity or above. |
| `CROSS_SUBJECT_THRESHOLD` | 0.25 | Topics in different subjects need this similarity... |
| `CROSS_SUBJECT_MIN_SHARED` | 2 | ...and this many shared top words: each topic's 12 highest TF-IDF terms (`linkTerms`). |
| `CROSS_SUBJECT_MEANING_THRESHOLD` | 0.68 | When both topics have a sentence embedding, topics in different subjects need this embedding similarity instead... |
| `CROSS_SUBJECT_MEANING_MIN_SHARED` | 1 | ...and this many shared top words. |

They were set on a handful of hand-written notes. The evaluation measures, for
every setting of them in a grid, how many of the links it makes are right
(**precision**) and how many of the right links it makes (**recall**), with
**F1** combining the two, separately for same-subject and cross-subject links.

Same-subject decisions depend only on the same-subject threshold, and
cross-subject ones only on the other two numbers, so the two are searched
separately: 0.05-0.30 for the same-subject threshold, 0.15-0.40 by 1-3
shared keywords for the cross-subject rule, in steps of 0.01.

## The procedure

Commands are run in `server/`.

### 1. Collect the notes

One folder, with one subfolder per subject holding that subject's files (PDF,
Word, PowerPoint, text or photos, as students upload them). A file directly in
the folder counts as a subject of its own.

```
eval-notes/
  biology/      cell_structure.pdf, osmosis.docx, ...
  chemistry/    ...
  networks/     ...
```

- Real notes people are happy to share, with anything personal removed. Never
  students' notes from the live database.
- At least 3-4 subjects with about 10-20 topics each (several files, or long
  files that split into subtopics). Fewer topics give too few pairs near the
  thresholds.
- Include subjects that share a word with different meanings ("cell" in
  biology, chemistry and networks; "nucleus"; "kernel"; "tree"), and at least
  one real overlap between subjects (diffusion in biology and in chemistry).
  The cross-subject rule exists for exactly these.
- `sample-notes/networks_unit2.md` and the files in `server/evaluation/samples/`
  may be added. Use one format of `networks_unit2`, not all four.

### 2. Generate

```
npm run eval:links -- generate D:\eval-notes --out D:\links-run1 --seed 1
```

It makes every file into topics exactly as an upload would, works out every
topic's keywords against the rest of its subject as `npm run relink` does (so
they do not depend on the order files were added), scores every pair of topics
with the current rule, and picks the pairs to rate (below). Options:
`--per-bin 10`, `--cross-cap 150`, `--zero-shared 20`, `--seed`.

`--similarity embedding` measures sentence-embedding similarity instead of
TF-IDF: the cosine of two topics' MiniLM vectors, each the normalised mean of
its sentences' vectors (`server/src/services/noteEmbedding.js`). It needs the
model (`npm run semantic:install`). Pairs are binned and sampled by that
similarity, on its own scale (same subject 0.30-0.75 in bins, cross subject
0.40-0.70, with pairs sharing no word binned as finely, since meaning can link
them). Scoring searches thresholds on it (0.30-0.80 same subject, 0.40-0.80
cross subject with 0-3 shared words) and still compares them with today's
rule on TF-IDF similarity, which `key.csv` keeps for every pair
(`tfidf_similarity`). The run remembers its similarity in `manifest.json`, so
`score` takes no option.

It writes:

- `for-raters/` - everything the raters get, and nothing else:
  - `rating_sheet.csv` - the pairs: each topic's subject, title and the
    opening of its text, then `related` and `comment` to fill in. Shuffled,
    with the order inside each pair random too, and no scores, keywords or
    decisions.
  - `practice_sheet.csv` - 10 other pairs, for the practice round.
  - `topics.md` - the full text of every topic, by T number.
  - `HOW_TO_RATE.txt` - the instructions.
- `key.csv` - each rated pair's similarity, shared keywords, current decision
  and stratum. **Raters must not see it.**
- `pairs.csv` - every pair, for the record (and a chart of the similarity
  distribution).
- `manifest.json` - the seed, the commit, the rule, the subjects and how many
  pairs each stratum has.

The same command with the same seed gives the same sheet.

### 3. Rate

Give each rater the `for-raters` folder.

- **At least two raters**, ideally three (so a pair is rarely a tie), who know
  the subjects. Say in the report if any of them built the graph.
- First, all raters do `practice_sheet.csv` together and talk through every
  disagreement. It is not counted.
- Then each rates `rating_sheet.csv` alone and saves it as
  `ratings_<name>.csv` (CSV, not .xlsx), which goes back into the output
  folder.

The question for each pair is whether the two topics **should be linked**: a
student revising one would be helped by being pointed to the other, because
they are about the same concept, one builds on the other, or they explain one
idea from different sides. Answers are `yes`, `no` or `unsure`.

- The same word with a different meaning is "no" ("cell" in biology and in an
  electrochemical cell).
- Being in the same subject is not enough on its own.
- Topics in different subjects can be "yes".

Raters see subject names, because "cell" cannot be judged without knowing the
subject; it does mean they can tell which pairs cross subjects.

### 4. Score

```
npm run eval:links -- score D:\links-run1
```

It reads every `ratings_*.csv` and writes `results.md` (the tables for the PR
or a report), `results.json` and `grid.csv` (every setting with intervals).
Options: `--flat 0.02`, `--min-linked 10`, `--min-precision 0.5`, `--reps 1000`.

After a change to what the linking rule looks at (the words it compares, the
vector), score the same ratings again instead of rating new pairs. The labels
are about the notes, so they still apply:

```
npm run eval:links -- score D:\links-run1 --recompute D:\eval-notes
```

It reads the notes the run was generated from again, with the current code,
finds every rated pair again by its topics' refs (`<subject>/<file>#<n>`),
and scores the ratings on the features worked out now. The pairs keep their
strata, so the sampling weights are the run's. It writes into
`links-run1/recomputed/` (or `--out`), leaving the run's own results alone:
`results.md`, `results.json` and `grid.csv` as above, `comparison.md`
(before against after on the same ratings: precision, recall and F1 with the
paired change in F1, how many cross-subject pairs share words, links made,
and the rated pairs decided differently) and `key.recomputed.csv`. A pair
whose topic is gone is listed and left out; if similarities have moved, it
says so, because the notes are then not the ones that were rated.

### 5. Change the constants (if the results say so)

Change the three constants in `graphEngine.js` to the recommended ones, with a
comment giving the evidence (how many pairs were rated, precision and recall
before and after), and update `server/test/graphEngine.test.mjs`. Show the
effect with `npm run relink -- --all` (a dry run) on a local database holding
the same notes, before and after the change. After the change is deployed,
Member 4 relinks the live site (`DEPLOY.md`, "Relinking the graph").

## Which pairs are rated

Most pairs of topics have nothing to do with each other and score near zero:
in the sample notes, 152 of 221 same-subject pairs score below 0.05 and only 6
fall between 0.10 and 0.125. A random sample would be almost all easy "no"s.
So pairs are drawn from **strata**:

| Stratum | How many are rated |
| --- | --- |
| Same subject, similarity in bins of 0.025 from 0.05 to 0.30 | up to `--per-bin` (10) from each bin |
| Same subject, below 0.05 | 15 (half as many again: most pairs, and most of the related pairs recall could miss, are here) |
| Same subject, 0.30 and above | up to 10 |
| Different subjects sharing a keyword | **all of them**; past `--cross-cap` (150) they are sampled evenly across bins of shared keywords (1, 2, 3+) and similarity |
| Different subjects sharing no keyword | `--zero-shared` (20), half below 0.05 and half above |

The last group can never be linked whatever the thresholds are. It is rated to
see whether the shared-keyword requirement itself misses real links, for
example two notes that say "cell" and "cells", which are different words to
the linking rule.

Expect about 150-250 pairs to rate; at 20-30 seconds a pair, 1-1.5 hours per
rater.

## How the setting is chosen

**One label per pair.** The majority of the raters' yes/no answers; `unsure`
is no vote. A tie counts as not related (as in `docs/EVALUATION.md`), which
leans the choice towards precision. A pair everyone was unsure about is left
out and counted in the report.

**Weights.** Because near-threshold pairs are rated more densely than the
rest, each rated pair is weighted by the number of pairs it stands for: its
stratum's size over the stratum's labelled pairs. The estimates are therefore
for all pairs, not for the sample. Unweighted, recall would come out too high,
because the related pairs that score low sit in the big low-similarity
strata where few pairs are rated.

**Intervals.** Precision and recall have 95% Wilson intervals on the effective
number of pairs (Kish: the number of equally weighted pairs that would carry
as much information). F1 is not a proportion, so its interval comes from 1000
resamples drawn within each stratum.

**The choice**, for same-subject and cross-subject links separately:

1. Settings that link fewer than 10 rated pairs are not considered: their
   precision would rest on too few pairs.
2. Take the best F1. A setting counts as equally good unless its F1 is
   clearly below the best one's: across the same 1000 resamples, its F1 minus
   the best's stays under -0.02 at the 97.5th percentile. The comparison is
   paired, because every setting is scored on the same pairs.
3. If the current setting is among them, keep it: the difference is smaller
   than a sample this size can show.
4. Otherwise choose, among them, the one with the highest precision, because
   a wrong link costs a student more than a missing one, especially across
   subjects. Ties go to the higher F1, then the stricter setting. Only a
   setting with precision of at least 50% can be chosen, so the links a
   change adds are right more often than wrong; if none qualifies, keep the
   current setting.

Steps 2 and 4 were tightened after the first run, before any constant was
changed. As first written, "equally good" meant within a fixed 0.02 of the
best F1, and there was no precision floor. That version recommended 0.07 for
same-subject links, a peak resting on two rated pairs that each stood for
about 40 others, and loosening the cross-subject rule to 0.15 with one
shared keyword, where only 31% of links were right. Both results are kept in
the run's output.

`results.md` also lists the rated pairs the recommendation would decide
differently, so the change can be checked pair by pair.

## How much it can show

With about 10 rated pairs per 0.025 bin, the evaluation can tell whether 0.12
is clearly too low or too high, not where the best threshold is to the
second decimal place. A precision of 80% from 30 linked pairs has an interval
of roughly 63-91%. Read neighbouring thresholds together, not one row on its
own.

## Results (14 Oct 2026)

**Notes.** 117 topics in 5 subjects, 6,786 pairs: the team's own DEDV notes
(data engineering, warehousing and pre-processing; 2 PDFs, 32 topics) and
Machine Learning notes (5 PDFs, 54 topics), plus the sample notes
(Networks, DBMS, Distributed Systems; 31 topics). A sixth subject's two PDFs were one-page
scans with no text layer, which the app cannot read either.

**Rater.** One: Claude (Anthropic's AI model), working only from the rater
folder and writing its answers before key.csv was opened. 293 pairs, 291
labelled (2 unsure). No second rater, so no agreement figure: the labels are
one rater's judgement. Its rule for "related": the same concept, an overview
and one of its techniques, a revision sheet and a topic it summarises, two
methods for the same task, or the same idea in two subjects; "no" for a
shared word with another meaning ("class", "support", "network", "layers",
"variance").

| Links | Setting | Precision | Recall | F1 | Links made |
| --- | --- | --- | --- | --- | --- |
| Same subject | 0.12 (before) | 62% [49-74%] | 34% [16-59%] | 0.44 [0.32-0.61] | 237 |
| Same subject | **0.11** (now) | 65% [51-76%] | 46% [24-69%] | 0.54 [0.40-0.71] | 278 |
| Cross subject | 0.25 + 2 shared (kept) | 33% [6-79%] | 5% [0-47%] | 0.09 | 3 |

- **Same subject.** 0.09, 0.10 and 0.11 all beat 0.12 in the paired
  resamples (0.11: +0.10 F1, 95% interval +0.02 to +0.17); none is more
  precise than 0.11, so 0.11 was chosen.
- **Cross subject.** Every looser setting that linked 10 or more rated pairs
  was right only 30-40% of the time, so the rule was kept. The fix there
  looked like better keywords (TextRank, stemming), not a lower bar; they
  were tried next, and did not help ("Keywords and TextRank").
- **Relink, dry run** on a local database of the same notes, uploaded
  through the API: before the change 237 same-subject, 3 cross-subject and 56
  rejected links after relinking; after it 278, 3 and 72 (as saved at upload:
  265, 2 and 76).

## Keywords and TextRank (14 Oct 2026)

TextRank keywords were Member 2's next step, expected to improve both the
keyword map and the cross-subject rule, which counts shared words. They were
built, measured on the same notes and ratings, and not kept.

**What was tried.** TextRank (Mihalcea & Tarau, 2004): a note's words (after
stopwords) are nodes, joined when they stand next to each other in a
sentence (window 2), and weighted PageRank (damping 0.85) ranks them; the
score was multiplied by the word's IDF within its subject, a word's singular
and plural were one keyword, and numbers were never keywords. Window 2 was
chosen before the ratings were looked at, on the keyword measures below;
windows 3 and 4 were scored as a check. The attempt is commit `208d805` on
`graph/textrank-keywords`: `score --recompute` there reproduces the linking
numbers below.

**The keywords themselves.** 117 topics, each against the rest of its
subject (as after a relink). Two measures that do not use the ratings, and
neither is the truth: how many keywords are words of the note's key terms
(`keyTerms.js`: headings, bold type, repeated phrases - what the note view
shows), and how many are weak words (function words, common verb forms,
numbers and generic words, by `keyTerms.js`'s own lists, which also flag some
real terms such as "table").

| Keywords | Words of the note's key terms | Weak words | Plural duplicates | Numbers |
| --- | --- | --- | --- | --- |
| TF-IDF, top 12 (before) | 36.5% | 17.8% | 50 | 8 |
| **TF-IDF, singular and plural as one, no numbers (now)** | 34.3% | 17.7% | 0 | 0 |
| TextRank x IDF, window 2 | 29.1% | 15.0% | 0 | 0 |
| TextRank x IDF, window 3 | 29.4% | 16.2% | 0 | 0 |
| TextRank x IDF, window 4 | 30.3% | 17.1% | 0 | 0 |
| TextRank alone, window 2 | 32.7% | 21.1% | 0 | 0 |

The first column counts "cell" and "cells" twice; counting distinct words,
a topic's keywords hold 4.03 of its key-term words before, 4.12 now and 3.49
with TextRank. TextRank weighted by IDF favours what is distinctive to a note
within its subject: Data Cleaning lost "missing", "values" and "binning" for
"measured", "unimportant", "malfunction" and "thus". Nor did it drop "holds"
and "enters" from the five-sentence Cell structure note in the tests: there
every word but "cell" appears once, the graph is a few short chains, and
"holds" went from 10th to 2nd.

**Linking: the same ratings scored again** (`score --recompute`). All 293
rated pairs were found again, at the same similarity (largest difference
2e-16), so same-subject results could not change and did not. Cross-subject,
with today's rule (0.25 and two shared words):

| Words two topics share | Links made | Rated pairs linked | Precision | Recall | F1 | Related rated pairs sharing 1+ / 2+ | All cross-subject pairs sharing 2+ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Top 12 TF-IDF terms (before, and now)** | 3 | 3 (1 related) | 33% | 5% | 0.09 | 12 / 5 | 37 |
| TextRank x IDF, window 2 | 1 | 1 (0 related) | 0% | 0% | 0.00 | 6 / 1 | 13 |
| TextRank x IDF, window 3 | 2 | 2 (1 related) | 50% | 5% | 0.10 | 6 / 2 | 14 |
| TextRank x IDF, window 4 | 1 | 1 (1 related) | 100% | 5% | 0.10 | 7 / 1 | 13 |
| The new keywords, singular and plural matched | 3 | 3 (1 related) | 33% | 5% | 0.09 | 12 / 5 | 55 |

- The F1 differences rest on one pair: DEDV's and ML's data pre-processing
  topics (similarity 0.33, related), which shared "data", "missing" and
  "real-world". At window 2 they share only "data" and lose their link; at 3
  and 4 they keep two words. Window 2's change in F1 is -0.09 (paired 95%
  interval -0.19 to -0.05), but one pair cannot carry a conclusion either way.
- What holds at every window: related pairs keep fewer words in common. Of
  the 12 related cross-subject pairs, 5 share two or more TF-IDF terms and
  only 1-2 shared two TextRank keywords. TextRank demotes exactly what two
  subjects genuinely share ("data", "missing", "outliers"). And the wrong
  matches it was meant to remove ("class" in IPv4 address classes and in
  class-imbalanced data) are a question of meaning that no ranking of single
  words settles; sentence embeddings (item 5) are the next thing to try.
- Linking on the new keywords decided every rated pair as before but one
  (rejected became no edge; not related), while 18 more cross-subject pairs
  shared two words, few of them rated.

**What was kept.**

- **Keywords**: TF-IDF as before, with a word's singular and plural as one
  keyword (weighted by both forms together, shown in the form the note uses
  most) and no numbers (`tfidf.js`). On 93 of the 117 topics the 12 change,
  by 1.5 words on average: the slot a plural or a number took goes to the
  next word.
- **Links**: they still compare each topic's 12 highest TF-IDF terms, read
  from its vector (`graphEngine.js`, `linkTerms`) - exactly the words they
  compared before. With nothing gained, the linking rule was not changed.
- **Thresholds**: scored again with the final code, unchanged; the choice
  rule keeps 0.11 and 0.25 with two shared words.
- **Relink, dry run** on a local database of the same notes, uploaded
  through `main`'s API: with `main`'s code and with this change alike, 278
  same-subject, 3 cross-subject and 72 rejected links after relinking (317,
  2 and 97 as saved at upload). Keywords change on 119 of the 127 notes,
  against 58 with `main`'s code, whose relink recomputes keywords against the
  whole subject.

## Sentence embeddings (14 Oct 2026)

Member 2's next-phase item 5: link topics by what they are about, with the
optional MiniLM model (`server/src/services/embeddings.js`). A topic's vector
is the normalised mean of its sentences' vectors
(`server/src/services/noteEmbedding.js`), so a long topic is never cut off at
the model's 256-word-piece limit.

**On run 1's ratings** (sampled by TF-IDF similarity), embeddings ranked
related same-subject pairs better (AUC 0.91 against 0.81), but the choice rule
kept today's rule for both groups. Across subjects, embedding similarity of
0.65-0.68 with a shared word found 6-7 of the 12 related pairs at 42-48%
precision - just under the 50% floor - and was found on the same pairs.

**Run 2** settled it on new pairs: 153 pairs sampled by embedding similarity
(`generate --similarity embedding`, seed 2), rated blind by a fresh Claude
agent given only the rater folder (29 yes, 122 no, 2 unsure). The hypotheses
and the decision rule were written into the run's `PLAN.md` before rating,
with checksums of the sheet and key; the code that generated it is commit
`9ef90a1`. Decision rule: link a group by meaning only if the unchanged choice
rule recommends an embedding setting for it.

| Links | Setting | Rated pairs linked | Precision | Recall | F1 |
| --- | --- | --- | --- | --- | --- |
| Same subject | today (TF-IDF 0.11) | 18 | 32% [13-61%] | 27% [9-59%] | 0.30 [0.18-0.47] |
| Cross subject | today (TF-IDF 0.25 + 2 shared) | 2 | 100% [34-100%] | 8% [1-48%] | 0.15 [0.06-0.36] |
| Cross subject | **embedding 0.68 + 1 shared (chosen)** | 10 | 58% [29-82%] | 29% [8-67%] | 0.39 [0.20-0.71] |
| Cross subject | embedding 0.65 + 1 shared (named in the plan) | 15 | 50% [27-73%] | 38% [12-74%] | 0.44 [0.24-0.72] |

- **Same subject: kept on TF-IDF.** The best embedding threshold scored F1
  0.47 against 0.30, but not clearly better across resamples.
- **Cross subject: linked by meaning** at embedding similarity 0.68 with at
  least one shared top TF-IDF word. The gain over today held across resamples
  (+0.02 to +0.50). On run 1's ratings the same setting is right 48% of the
  time (recall 33%, F1 0.39 against 0.09), so expect about half of these links
  to be right. The right ones are mostly data pre-processing and outliers in
  DEDV and ML; Decision trees <-> Data reduction is a typical wrong one.
- **Vectors must not depend on their batch.** Batched, the 8-bit model gives
  a sentence a slightly different vector depending on the other sentences in
  its batch (alone and in a batch of four: cosine 0.995), so a topic's vector
  depended on what had been embedded before it, and a relink of the same notes
  made 12 cross-subject links where the evaluation made 13. Sentences are now
  embedded one at a time (`embed(texts, { alone: true })`): the same topics in
  either order give identical vectors, and the whole set takes 2.5 s. Both
  runs were scored again on these vectors (`score --recompute`): similarities
  moved by at most 0.016, no rated pair is decided differently at the chosen
  setting, and the choice rule keeps it.
- **Relink, dry run** on a local database of the same notes uploaded through
  `main`'s API, with the model: 278 same-subject links as before, 13
  cross-subject (3 on `main`), 65 rejected (72); 117 embeddings made.

**In the app.** Each topic's embedding is stored in its own collection
(`note_embeddings`, `server/src/models/NoteEmbedding.js`) with the model's
name and a fingerprint of the text, made when a note is saved if the model is
ready, and by `npm run relink` for the rest. A pair is linked by meaning only
when both topics have a vector from the same model; otherwise the TF-IDF rule
applies, as before. Same-subject links never change. Without the model (a
default install, CI, the live site today) nothing changes at all - except that
stored vectors are used wherever they exist, so a relink run where the model is
installed gives existing notes their links by meaning.

## Clusters (14 Oct 2026)

Member 2's next-phase item 6: should the graph's clusters
(`server/src/services/graphEngine.js`, `clusterNotes`) come from Louvain
community detection instead of connected components? Connected components put
a whole subject in one cluster as soon as one chain of links runs through it:
on these notes, all 32 DEDV topics and 51 of ML's 54.

No new ratings were needed. A rated same-subject pair is read as "should these
two topics share a cluster?", and a clustering is scored like a linking rule:
a pair counts as linked when its two topics are in one cluster. The weights,
intervals and paired resamples are the link evaluation's.

```
npm run eval:links -- clusters D:\links-run1 D:\links-run2 --notes D:\eval-notes
```

It clusters the notes, with today's same-subject links, by connected
components and by Louvain at resolutions 0.25-3 (`--resolutions`), scores
each on the first run's rated same-subject pairs, chooses, and checks the
choice on the second run. It writes into `<run>/clusters/` (or `--out`):
`results.md`, `results.json`, `grid.csv` and `clusters.csv` (every topic's
cluster under every setting). It also describes each subject under each
setting: cluster sizes, modularity, how much one removed link moves, how much
reversing the notes' order moves, agreement with the documents' own sections,
and the time per call.

**The choice**, written down before the first run (`PLAN.md` beside the
results, with checksums of the ratings):

1. Settings that put fewer than 10 rated pairs together are not considered.
2. "As good as the best" is the paired test above (F1 minus the best F1 at
   least -0.02 at the 97.5th percentile).
3. If connected components are as good as the best, keep them.
4. Otherwise resolution 1 (the standard definition of modularity) if it is
   as good as the best; if not, the closest resolution to 1 that is. The
   resolution is preferred, not tuned, because each run's labels are one AI
   rater's and two subjects hold most of them (DEDV and ML: 111 of run 1's
   123 rated same-subject pairs).
5. On the second run, the choice must not be clearly worse than connected
   components, by the same test.

There is no 50% precision floor here: cluster precision counts every pair in
a cluster, linked or not, so connected components score about the share of
pairs that are related (20%), and a floor could block a clear improvement for
an arbitrary reason.

**Result: Louvain at resolution 1.**

| Clustering | Rated pairs together | Precision | Recall | F1 |
| --- | --- | --- | --- | --- |
| Connected components (before) | 117 | 20% [10-36%] | 81% [56-94%] | 0.32 [0.22-0.42] |
| Louvain 0.75 | 78 | 33% [15-58%] | 53% [30-75%] | 0.41 [0.27-0.59] |
| **Louvain 1 (now)** | 67 | 73% [52-87%] | 43% [22-67%] | 0.55 [0.36-0.75] |
| Louvain 1.5 | 61 | 78% [55-91%] | 39% [19-63%] | 0.52 [0.34-0.71] |

- **Run 1** (123 rated same-subject pairs): resolution 1 against connected
  components, F1 +0.23 [+0.03 to +0.44]. Every resolution from 0.75 to 3 was
  as good as the best.
- **Run 2** (63 pairs, another rater; the check): 0.64 against 0.36, +0.28
  [+0.04 to +0.52]. Passes.
- **Read the precision with care.** At resolution 1 against 0.75, most of the
  difference in weighted precision on run 1 comes from four pairs below
  similarity 0.05, each standing for about 81 pairs and all rated not
  related, that 0.75 puts together and 1 does not. Unweighted, the share of
  rated pairs put together that are related rises smoothly with the
  resolution: 61% for connected components, 74% at 0.75, 81% at 1, 84% at
  1.5. That Louvain does better holds; how much better at exactly 1 partly
  rests on those four pairs.
- **The clusters.** DEDV: 4 (10, 9, 7 and 6 topics: data pre-processing,
  warehouse modelling and OLAP, the introductory topics, types of data). ML: 8, the largest 11 topics, one topic alone.
  Networks: 5, with 4 topics alone. They agree with the documents' own units
  much more than before (adjusted Rand index, ML 0.50 against -0.01; Networks
  0.56 against 0.38).
- **One removed link** moves, on average, 2% of a subject's topic pairs
  between together and apart (at worst 14% in DEDV, 8% in ML). But the three
  coloured clusters change after about 30% of single removals, against 2-6%
  before, so a Remove can move a colour. On the graph page, removing one link
  in DEDV moved just that topic out of its cluster.
- **Order.** Louvain visits notes oldest first, so the same notes always give
  the same clusters. Reversing that order moves 0% of DEDV's pairs and 6% of
  ML's.
- **Time**: 1.6 ms per graph request on ML (54 topics, 168 links), against
  7.8 ms before; Louvain itself takes 0.15 ms, and labelling one 51-topic
  cluster was the slow part.

**Limits.** The labels were given for links ("should these two be linked?"),
not clusters, and a student may draw a topic area wider or narrower than a
link. Each run has one AI rater, and two subjects carry most of the pairs.

## Students' corrections (20 Oct 2026)

Member 2's next-phase item 6, second half: feeding the links students remove
as wrong (`POST /api/graph/edges/:id/correct`) back into the linking rule.

```
npm run eval:corrections -- [backup folder] --run D:\links-run1 --run D:\links-run2
```

It reads a backup `npm run db:backup` wrote (only `graph_edges.json` and
`subjects.json`, never `notes.json`), prints numbers only and writes nothing.
For each threshold of the rule - same-subject links, cross-subject links by
meaning, cross-subject links by TF-IDF:

1. **Enough corrections?** At least 50 removed links from at least 5
   students, about 10 for each thing the regression weighs. Each student's
   removals count for at most 10 together, so one student who removes a lot
   cannot move the rule for everyone. Otherwise the threshold is kept and
   nothing is fitted.
2. **The refit.** A weighted logistic regression of "removed" on a link's
   similarity and shared words (with a light ridge penalty, so a perfect
   split by similarity still gives an answer). The threshold it suggests is
   the lowest similarity, in steps of 0.01, from which links are kept more
   often than removed, for the median number of shared words. Only ever
   stricter: students can remove a wrong link but cannot add one the graph
   missed, so corrections cannot show that the rule is too strict.
3. **The ratings check it.** A stricter threshold is suggested only if, on
   the rated pairs of a run on the same similarity (`--run`: run 1 for
   TF-IDF, run 2 for links by meaning), it links at least 10 rated pairs,
   its F1 is not clearly below the best setting's (the paired test above)
   and its precision is at least 50%. The corrections may move a threshold
   only within what the ratings consider as good as the best; the ratings
   never train the refit.

Its verdict is a suggestion: a threshold goes into `graphEngine.js` by hand,
in a PR with the output, then a relink.

**Result: no corrections yet.** On the live site's backup of 15 Oct, 3
students had 180 links, all within a subject, and none was marked as removed:
"not enough to refit (0 of 50 removals, 0 of 5 students) - keep 0.11". None
removed does not mean the links are right; with 3 students, nobody may have
looked. As a check of the safeguard: on made-up removals that put the
same-subject threshold at 0.14, run 1's ratings refuse it (F1 0.40 against
0.68 for the best setting).

**Limits.** Restoring a link erases its removal, so restores are not
counted; a removed link keeps the features of its last relink, not of the
moment it was removed; and links a student never looked at count as kept.

## What to report

- The notes: subjects, files, topics, formats and where they came from.
- The raters: how many, who they are relative to the project, and the
  agreement table. If kappa is low, say so: the labels are then partly taste.
- The recommendation table with intervals, and the rated pairs it changes.
- The command, the seed and the commit (all in `manifest.json`).

## Limits to state

- **The labels judge pairs of topics, not the graph a student sees.** A link
  can be "right" and still clutter a busy graph.
- **The keywords are the relink's.** Notes saved before the last relink on
  the live site may have different keywords, so their links can differ until
  Member 4 relinks.
- **Cross-subject links by meaning rest on two runs of one AI rater each,**
  with about 10 linked pairs per run behind each precision. Half right is the
  honest expectation; a person rating the cross-subject pairs of run 2 would
  show how far that holds. To do that without disturbing the run: copy its
  folder, keep in the copy's `for-raters/rating_sheet.csv` only the 30
  cross-subject pairs that share a word, highest embedding similarity first
  (where the 0.68 threshold decides), have the person rate them, put their
  `ratings_<name>.csv` in the copy and run `score` on it. Its agreement table
  is the answer; its other numbers mix two raters' labels and change nothing.
- **Shared words depend on what the rule compares.** Links compare each
  topic's top TF-IDF terms (`linkTerms`), not its stored keywords, so how
  keywords are ranked does not move a link; a change to the vector or to
  `linkTerms` does. The labels stay valid, because they are about the notes:
  score the same ratings again with `score --recompute` and re-check the
  cross-subject rule after any such change.
- **The sample notes were used while developing the rule.** Do not report
  numbers from them alone.
- **The first run had one rater, an AI.** It judged consistently and without
  seeing scores, but a person may draw "related" differently, especially
  for revision sheets and for two methods of the same task. A second rater
  (even on a 30-pair subset) would show how far that matters.

## Files

```
server/src/services/noteEmbedding.js   a topic's vector; attaching stored ones for linking
server/src/models/NoteEmbedding.js     the stored vectors
server/evaluation/
  links.mjs          generate, score and clusters
  corrections.mjs    refit the rule from students' corrections in a backup
  lib/links.js       topics, pairs, strata, labels, weighted metrics, the choice
  lib/clusters.js    clusters: rated pairs as labels, the choice, sizes, stability
  lib/corrections.js reading a backup, the gate, the regression, the check
  lib/ingest.js      files -> notes, the way the app builds them
  lib/stats.js       Wilson intervals, kappa, CSV
server/test/linkEvaluation.test.mjs
server/test/corrections.test.mjs
server/scripts/correction-counts.mjs   counts of students' corrections in a backup
```

The output folder holds your notes' text and the raters' names: do not commit
it. `evaluation-output/` (the default) is git-ignored.
