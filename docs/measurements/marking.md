# How closely MindAtlas's theory marking follows human markers

This measurement runs the app's real marker, `gradeTheoryResponse`
(`server/src/services/gradingEngine.js`), on the Mohler dataset: 2,273 computer science answers to
79 questions, each marked by two people (Mohler et al., 2011).[^dataset] It tests two markers:

- **The keyword marker,** which looks for each key point's words in the answer. Students get this
  when the AI fails.
- **The AI marker,** `openai/gpt-oss-20b` on Groq, tried on a random 200 answers.

No app code was changed.

## The result in short

- **People do not fully agree with each other, and that is the yardstick.** Grader 1 against grader 2:
  Pearson 0.60, average gap 0.75 marks out of 5.
- **The AI puts answers in about the same order as people do, but its marks are much too low.** Against
  one grader its Pearson is 0.53 and 0.63, where the two graders score 0.59 on the same answers. But its
  gap is 1.47 and 1.83 marks, about twice the graders' 0.80. It averages 2.52 out of 5 where people
  average 4.10.
- **The keyword marker is further away on both.** Against one grader its Pearson is 0.35 and 0.38, and
  its gap is 2.46 and 2.79 marks. It gives 0 to 48% of all answers, and averages 1.64 out of 5.
- **The AI is clearly closer to people than the keyword marker.** On the same 200 answers, against
  `score_avg`, its Pearson is 0.19 higher [0.13, 0.27] and its gap 0.63 marks smaller [0.42, 0.85].
- **Giving every answer 5 would have a smaller gap (0.82) than either marker,** although it could not
  tell a good answer from a bad one. About half the answers have full marks, so this says as much about
  the data as about the markers.
- **An AI wrote the key points, and both markers depend on them.** Better ones might close some of the
  gap. This data cannot separate strict key points, a strict marker and generous people. Read
  [the limits](#limits) before quoting these numbers.

## What the scores mean

| Word | Meaning |
| --- | --- |
| Pearson | Whether two markers rank answers in the same order, from −1 (opposite) through 0 (unrelated) to +1 (the same). It ignores whether one marker is simply lower than the other |
| Average gap | The average distance between two marks, in marks out of 5. Lower is closer |
| `score_avg` | The dataset's average of the two people's marks. It is easier to match than one person, because averaging smooths out each person's quirks. So compare a marker against **one grader** when setting it beside the graders' own 0.60 |
| 95% interval | In square brackets. How far a Pearson could move with a different set of questions, from resampling the questions 1,000 times |
| Too harsh / too generous | The marker is more than 1 mark below / above the other mark |
| Key-point cap | An app rule: an AI mark may be at most half of full marks above the share of key points whose words appear in the answer |
| No-shared-words check | An app rule: if the AI gives marks but the answer shares no word with the model answer or key points, the AI's mark is thrown away and the keyword mark is used |

**Pearson and the gap answer different questions.** A marker can rank answers well and still give marks
that are too low. That is what the AI does here.

## Results

### How close each marker is

| Marker | Answers | Against `score_avg`: Pearson, gap | Against grader 1: Pearson, gap | Against grader 2: Pearson, gap |
| --- | --- | --- | --- | --- |
| Keyword | 2,273 | 0.40 [0.33, 0.47], 2.61 | 0.38 [0.32, 0.45], 2.79 | 0.35 [0.27, 0.42], 2.46 |
| Keyword | the 200 | 0.45 [0.33, 0.55], 2.29 | 0.43 [0.32, 0.52], 2.45 | 0.39 [0.25, 0.50], 2.15 |
| **AI** | the 200 | **0.64 [0.54, 0.73], 1.66** | **0.53 [0.44, 0.62], 1.83** | **0.63 [0.51, 0.72], 1.47** |
| Always 5 | 2,273 | no Pearson, 0.82 | no Pearson, 0.59 | no Pearson, 1.08 |
| Always 5 | the 200 | no Pearson, 0.91 | no Pearson, 0.71 | no Pearson, 1.17 |
| Always the average mark | 2,273 | no Pearson, 0.89 | no Pearson, 0.75 | no Pearson, 1.24 |
| Always the average mark | the 200 | no Pearson, 0.94 | no Pearson, 0.83 | no Pearson, 1.32 |

**The yardstick, grader 1 against grader 2:**

| Answers | Pearson | Gap |
| --- | --- | --- |
| 2,273 | 0.60 [0.54, 0.65] | 0.75 |
| the 200 | 0.59 [0.47, 0.70] | 0.80 |

A marker that gives the same mark every time has no Pearson, because its marks do not vary. "Always the
average mark" uses the average of whichever marks it is compared with.

**Compare markers on the same row of answers.** The 200 happen to suit the keyword marker a little: it
averages 1.90 on them and 1.64 on all answers, just above the 1.41 to 1.89 that random sets of 200 give.
This is the luck of the draw, so the 200-answer keyword row is the fair one to set beside the AI.

### How often each marker is off by more than 1 mark

| Marker | Answers | Against `score_avg`: harsh / generous | Against grader 1: harsh / generous | Against grader 2: harsh / generous |
| --- | --- | --- | --- | --- |
| Keyword | 2,273 | 77.6% / 0.7% | 80.6% / 0.4% | 69.8% / 3.1% |
| Keyword | the 200 | 74.0% / 1.5% | 78.0% / 1.0% | 64.5% / 3.5% |
| **AI** | the 200 | **56.5% / 0.5%** | **58.0% / 1.0%** | **46.5% / 2.0%** |
| Always 5 | 2,273 | 0% / 27.9% | 0% / 18.8% | 0% / 29.9% |

The two graders are more than 1 mark apart on 20.6% of all answers and 24.0% of the 200. Grader 1 is the
higher one on most of those (17.0% and 19.0%).

**Both markers miss in one direction: too low.** The AI gave 0 to 60 of the 200 answers, and people
averaged 4 or more on 16 of those. It gave full marks to 60, where people's average was full marks on 92,
and the two agree on 51.

### What the app's checks did to the AI's marks

All 200 got an answer from the AI: **0 had a `fallbackReason`,** so none was left out. No answer was
flagged as talking to the marker, here or in the full 2,273.

| What happened | Answers | Effect |
| --- | --- | --- |
| The AI's mark stood | 171 | |
| **Limited by the key-point cap** | **22** | The AI had given full marks to all 22. They became 2.5 or 4.17 |
| No-shared-words check | 7 | The AI had given half marks or more, and it became 0. People averaged 3 or more on all 7. These show `gradedBy: keyword-overlap` with no `fallbackReason` |

The AI alone, from its own replies, would score Pearson 0.66 and gap 1.41 against `score_avg`, where the
final marks score 0.64 and 1.66. Of the 29 marks these checks lowered, 26 moved further from people and 3
moved closer. **This shows only what the checks cost.** They exist to stop students talking the AI into a
mark, and nobody here was trying to. They work as designed, so this is not a bug report. It does mean that
a correct answer in other words can lose marks, as the code's comments say it can.

## What this means for setting `LLM_MODEL` on the live site

[The Groq report](groq-path.md) left this open until marking was measured. **The decision is the team's, and
nothing was changed.**

**What marking would gain.** Today, if `LLM_MODEL` is not set, students get the keyword marker. One request
through the real marker with the setting unset confirmed this: 404 `model_not_found`, then key-point marking
with `fallbackReason=bad-request`. Setting it would, on this data, change:

| On the same 200 answers | Keyword (today, if not set) | AI |
| --- | --- | --- |
| Pearson against `score_avg` | 0.45 | 0.64 |
| Average gap | 2.29 marks | 1.66 marks |
| Too harsh by more than 1 mark | 74.0% | 56.5% |
| Answers given 0 | 39.5% | 30.0% |

And unlike question writing, marking really does work on this model: 200 of 200 replies were whole and
readable, with none empty or cut off, because each reply is short.

**What it would cost.**

- **About 777 tokens per answer** (median 728, largest 1,711): 452 for the request and 324 for the reply, of
  which 284 are reasoning. The median reply took 0.9 s and the slowest 2.8 s.
- **On this key, that is at most about 257 answers a day** (200,000 tokens) and about 10 a minute (8,000 tokens),
  if nothing else uses the key. A test with 4 theory questions is about 3,100 tokens.
- **Question writing would draw on the same limit and gain nothing.** The Groq report found a build costs about
  7,500 tokens with 0 AI questions, which is about 10 marked answers per build. Feedback and key terms use the
  same limit, and their cost is not measured.
- **Students on one day could be marked differently.** Once the limit is reached, marking falls back to keywords,
  which average 1.90 where the AI averages 2.52 on the same answers. Students are told when this happens.

**What it would not fix.** The AI's marks would still be much lower than these people's marks, so setting it
makes marks closer, not close.

## Compared with the original paper

A rough comparison only, since those systems learned from marked answers and the answers and measures differ:
Mohler et al.'s Table 7 gives a best Pearson of 0.518 and a lowest RMSE (a gap that punishes big misses more) of
0.978 against the graders' average, with the two people at 0.586 and 0.659, where we get Pearson 0.64 and RMSE 2.21
for the AI on 200 answers, and 0.40 and 3.07 for the keyword marker.

## Limits

**About what was tested**

- **This is one set of data structures answers from one US university.** They are not our students or our subjects.
  The paper says 31 students were enrolled, and the median answer is 16 words.
- **An AI wrote the key points, so the app's own generated ones may be better or worse.** They came from the question
  and model answer alone, and from the same kind of AI that helped build the app and wrote this report. Many model
  answers here are one line, and the app's rules ask for 2 to 4 key points anyway. The app writes them from a
  student's notes.
- **Marks in other languages, answer photos and re-marking are not tested.** The data is all English, typed, and
  marked once.
- **What the live site does today is not confirmed.** Its key and settings were not seen. The keyword row is what it
  gives if `LLM_MODEL` is not set.
- **Only one answer was sent at a time.** The app marks up to 4 answers at once for one test, and students share the
  limits, so how real use meets the minute limit is not measured.

**About the numbers**

- **The AI marker's score is from 200 answers on one day and one model.** The app sends Groq no seed, so a repeat
  would give somewhat different marks.
- **About half the answers have full marks (49.3%), so a generous marker looks good.** That is why always giving 5
  has such a small gap. People here may simply be kinder than a strict exam marker would be, so "closer to these people"
  is not the same as "more correct".
- **The intervals cover only which questions happened to be included.** They do not cover any limit above.
- **`score_avg` is not quite the average of the two graders.** On 214 rows, all in E11 and E12, it differs from the
  mean of the rescaled marks by up to 0.5 (87 rows by 0.125, 99 by 0.25, 19 by 0.375, 9 by 0.5). The cause is not known.
  It is used as given. Using the mean instead moves the Pearson by at most 0.011 and the gap by at most 0.033.

## Method

**The data.** The `cleaned` open-ended split, with graders' marks halved on E11 and E12 to put them out of 5. This
matches the figures given in advance: Pearson 0.597, gap 0.748, and 49.3% full marks.

**Taking out the dataset's markup.** Every row has `<STOP>` between sentences, and 217 answers have tokeniser marks such
as `-LRB-` for a bracket. Nobody wrote those, and `stop` would count as a word in every answer, so they were replaced
with what they stand for before marking. It made no difference to the keyword marks: 0 of 2,273 changed when run both
ways. It was not tried on the AI.

**81 pairs, not 80.** There are 79 distinct question texts and 81 distinct question and model answer pairs, because 2
questions were asked twice with different model answers. 80 is the count of distinct model answers, since 2 questions
share one, and the paper also says 80 questions. Key points were written for all 81: 195 in all.

**Key points.** Claude Opus 5.5 wrote them from a file of questions and model answers only, following the wording of the
app's prompt (`server/src/services/testEngine.js`). They were saved and their SHA-256 recorded before any student answer
or mark was looked at, and they were not changed afterwards.

**Marking.** The one-off Node scripts import the real `gradeTheoryResponse`. The keyword run had no key set and its
`fetch` was blocked, so it could make no request. For the AI, all ids were sorted, shuffled with seed 1 and the first 200
taken, then sent one every 7 seconds. Each result was saved as it came.

**Comparing.** A one-off Python script. Intervals resample the distinct question texts: 79 for the full set, and 78 for
the 200.

## Running it again

The one-off scripts stay in the git-ignored working folder, `server/evaluation-output/marking-run1/`, and are not part of
this repository, nor are the key points or marks. They run from that folder in the order they are numbered. The two marking
steps are:

```bash
env -u GROQ_API_KEY -u LLM_MODEL node 4_keyword.mjs
```

```bash
LLM_MODEL=openai/gpt-oss-20b node --env-file=../../.env 5_ai.mjs
```

| | |
| --- | --- |
| Commit | `065a87e` (this report was added in the next commit) |
| Seed | 1, for the shuffle and for the intervals |
| Model | `openai/gpt-oss-20b` on Groq, prompt `grade-v4` |
| Date | 2026-11-02, 04:11 to 04:35 UTC |
| Takes | About 25 minutes, and about 155,000 tokens |
| Versions | Node 25.8.1, Python 3.9.6, numpy 2.0.2, pandas 2.3.2, pyarrow 21.0.0 |
| `cleaned-oe-00001.parquet` | SHA-256 `f2aff37d7a3c6e6a7267afe0ab29ca4ebfbf90285b8eea77b08da9e1217376b0` |
| `rubrics.json` | SHA-256 `619dd25bb9a188d6e53c0d42ee62a91412bc7513c5955a2986d6f8ffd2939dd5` |
| `keyword_marks.jsonl` | SHA-256 `f1d96cf4653e4ab636bfeb473e510f7409f9b2f5ea47ac0908a4815532bafdd8` |
| `ai_marks.jsonl` | SHA-256 `8a72627b48c63d9a8a16171aa83ae722b0aabf191afa404de4a2d63db0187f0e` |

Checks on these numbers:

- **The counts are right.** All 81 pairs have 2 to 4 key points, the keyword run has 2,273 rows, and the AI run has 200, in
  the shuffled order, with no id twice.
- **Worked out a second way.** A separate script reads the parquet again and works out every Pearson and gap in the first
  results table with its own plain formula, without numpy or pandas. All match to 3 decimal places, apart from one rounding
  tie, always the average against grader 1 on the 200: 0.8285 exactly, printed as 0.828 and 0.829. The table's 0.83 is
  the same either way.
- **The numbers that looked wrong were checked.** After the key points were saved, the biggest misses on the first answers
  were read to rule out a fault in the scripts. The AI's own replies gave those low marks. Nothing was changed as a
  result.
- **The limit count is exact.** The note's "is limited" wording and the app's exact cap sentence both count 22, and a check
  of each AI reply against its final mark finds the same 29 lowered marks.
- **No app bug was found.**

Calls to Groq: 200 requests on `openai/gpt-oss-20b`, all answered with no refusals, using 155,325 tokens. At this pace the
minute allowance never fell below 6,184 of 8,000. There was also 1 request on the retired default model, using a made-up
answer. The 200 rows' questions, model answers, key points and student answers were sent to Groq. Nothing from the live
database was.

## The data and its terms

**Credit.** The data is the Mohler ASAG dataset (`cleaned` subset), under CC BY 4.0 according to its page. No dataset row
or key point is copied here. The paper was read on 2026-11-02.

> Mohler, M., Bunescu, R., & Mihalcea, R. (2011). Learning to Grade Short Answer Questions using Semantic Similarity Measures
> and Dependency Graph Alignments. In *Proceedings of the 49th Annual Meeting of the Association for Computational Linguistics:
> Human Language Technologies*, pages 752-762. Association for Computational Linguistics. https://aclanthology.org/P11-1076

[^dataset]: The dataset's page: https://huggingface.co/datasets/nkazi/MohlerASAG
