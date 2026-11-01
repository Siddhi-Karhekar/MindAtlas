# Whether the AI path works, how fast it is, and how often its questions pass the filter

When a student builds a test, the app can ask an AI on Groq to write the questions. A build sends
up to 3 requests: one for MCQs, one for theory questions, and one blind check of the MCQs. Every
question then goes through the app's filter. If the AI fails, the app's own rules write the
questions instead. This measurement runs the app's real `generateQuestions`
(`server/src/services/testEngine.js`) on our own notes, records every request to Groq, and compares
the result with the rules alone.

**No app code was changed.** Checking this measurement found several problems in the AI path.
None is fixed: see [The problems this found](#the-problems-this-found).

## The result in short

- **The AI path does not work today.** In 20 real builds with the AI switched on, across the
  retired default model and all 3 replacements, **the AI wrote 0 of 300 questions**. The rules wrote
  them all, so students still got a full test.
- **Three separate things stop it, and setting `LLM_MODEL` fixes only the first.**
  1. **The default model is retired.** `llama-3.3-70b-versatile` returns 404, so every request fails.
  2. **Replies are cut off.** All 13 replies that were answered stopped at a fixed length. 8 were
     empty because the model spent the whole allowance on reasoning, and 5 were broken JSON.
  3. **The minute limit refuses the rest.** 8,000 tokens a minute is about one real request, and a
     build sends more than one. 44 of the 57 requests were refused.
- **There is no filter pass rate for the app as it is.** The AI produced 0 drafts, so there was
  nothing to filter, and the blind check ran on 0 builds.
- **With the AI on, a build takes longer and gains nothing.** The median build takes 5.9 s against
  0.4 s for the rules, for rule-written questions either way. About 5 s of that is a wait before a
  retry, and all 19 retries were refused again.
- **Spacing builds out does not help.** With at least 65 s between builds, 7 of 21 requests were
  answered. Back to back, 1 of 24 was. The AI wrote 0 questions either way.
- **No model wins on merit.** The plan written beforehand picks `openai/gpt-oss-20b`, but only
  because its replies are cut off sooner, which makes it cheaper and faster.
- **The JSON bug fixed in `d72ac82` would have lost 0 of the 10 saved replies.** Only 3 of them were
  whole, and those were already valid JSON, so this says little.
- **One-off trials show the path can work, with a code change that was not made.** Asking for less
  reasoning got 11 of 12 questions written by the AI on the page's default test. The blind check
  was still refused. See [One-off trials](#one-off-trials-not-the-app).

Read [the limits](#limits) before quoting any of these numbers.

## What the scores mean

| Word | Meaning |
| --- | --- |
| Build | One test being made from one document. Here, a pool of 9 MCQs and 6 theory questions, which is what the app asks for on a test of 6 MCQs and 4 theory questions |
| Token | The unit Groq counts in, roughly three quarters of an English word |
| Total time (`totalMs`) | How long `generateQuestions` took, from the app's `[testgen]` log line |
| AI time (`llmMs`) | How long the AI took to write one question type, including any wait and retry. The two types run at the same time, so they overlap. It leaves out the blind check |
| Time with a request in the air | Time with at least one request open to Groq, counted once when requests overlap. It leaves out waits between tries |
| Fall back | The AI gave nothing usable for a question type, so the rules wrote it. `fallbackReason` says why |
| Reasoning | Some models think before answering. Those tokens count towards the reply's length even though the app never reads them |
| The filter | Two steps every draft goes through: the **gate** (does it quote the notes, about 40 format rules) and the **evaluator** (ambiguity, correctness, quality score). The evaluator can accept, revise or reject |
| Blind AI check | The AI answers each MCQ without being told the answer key. A disagreement rejects the question. It runs only if the AI answered earlier in that build |
| Spaced | At least 65 s between builds, so the build before cannot use up this build's minute limit |
| Back to back | No wait between builds, like busy students |

Median means half the builds were faster. With 7 builds per row, these are rough.

## Results

### Which model works

**The default model.** One real build on `2_ML.pdf` with `LLM_MODEL` unset, which is what the live
site does if the setting is not there. Both requests failed in about 0.3 s, and the rules wrote all
15 questions:

```text
[llm] request failed: 404 bad-request model_not_found
[llm] request failed: 404 bad-request model_not_found
[testgen] mcq: status=rule-based-fallback provider=Groq llm=failed fallbackReason=bad-request byLlm=0 byRules=9 ...
[testgen] theory: status=rule-based-fallback provider=Groq llm=failed fallbackReason=bad-request byLlm=0 byRules=6 ...
```

Groq's [deprecations page](https://console.groq.com/docs/deprecations) (read 2026-11-01) gives this
model's shutdown as 16 August 2026. `render.yaml` sets no `LLM_MODEL`.

**The replacements.** These are the 3 ordinary text models this key lists, tried on the same 3
documents (`4_ML.pdf`, `2_ML.pdf`, `2_DEDV.pdf`), one spaced build each.

| Model | Builds | Requests | Whole replies | Cut off | Empty | Refused | AI questions | Reply stopped at | Tokens per build, median | Total time, median |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `openai/gpt-oss-120b` | 3 | 6 | 0 | 2 | 1 | 3 (too big, 413) | 0 of 45 | 3,072 tokens | 10,463 | 7.4 s |
| `openai/gpt-oss-20b` | 3 | 9 | 0 | 1 | 2 | 6 (minute limit, 429) | 0 of 45 | 2,048 tokens | 8,486 | 5.9 s |
| `qwen/qwen3.8-27b` | 2 of 3 | 6 | 0 | 2 | 0 | 4 (daily limit, 429) | 0 of 30 | 2,048 tokens | 7,733 | 6.0 s |

**The choice: `openai/gpt-oss-20b`, a weak win.** The plan was written down before the comparison.
Its first three rules (readable replies, AI questions, blind check) all tie at zero. Its fourth,
fewer tokens per build, picks `openai/gpt-oss-20b` over `openai/gpt-oss-120b`, and its fifth, speed,
agrees. But those savings exist only because Groq cuts this model's replies off sooner. The plan
assumed the models would work, and none does.

`qwen/qwen3.8-27b` could not finish: its daily limit ran out with one document left, and it is the
same limit that answer photos use. Its low token count comes from its theory requests being refused.

### AI against rules only

All 7 documents, `openai/gpt-oss-20b`. The AI wrote nothing in either AI column.

| Measure | Rules only | AI, spaced | AI, back to back |
| --- | --- | --- | --- |
| Builds | 7 | 7 | 7 |
| Total time, median | 0.4 s | 5.9 s | 5.6 s |
| Total time, slowest | 0.5 s | 6.0 s | 5.8 s |
| AI time for MCQs, median / slowest | - | 5.3 s / 5.3 s | 5.2 s / 5.3 s |
| AI time for theory, median / slowest | - | 3.2 s / 5.3 s | 5.2 s / 5.3 s |
| Time with a request in the air, median / slowest | 0 | 3.2 s / 3.4 s | 0.3 s / 3.0 s |
| Requests per build, median / most | 0 | 3 / 3 | 4 / 4 |
| Requests answered | - | 7 of 21 | 1 of 24 |
| Requests refused | - | 14 of 21 | 23 of 24 |
| Tokens per build, median / most | 0 | 7,536 / 9,439 | 0 / 6,545 |
| Tokens, all builds | 0 | 51,398 | 6,545 |
| Questions produced / asked | 105 / 105 | 105 / 105 | 105 / 105 |
| Written by the AI / by the rules | 0 / 105 | 0 / 105 | 0 / 105 |
| AI drafts | 0 | 0 | 0 |
| Builds all by the AI / some / all by the rules | 0 / 0 / 7 | 0 / 0 / 7 | 0 / 0 / 7 |
| Blind AI check ran | 0 of 7 | 0 of 7 | 0 of 7 |

- **Why 5.9 s against 0.4 s.** When Groq refuses a request, the app waits up to 5 s and tries once
  more. Time the app spends waiting is why total time is so much longer than time in the air. The
  whole of a back-to-back build is nearly this wait.
- **The 20-second time-out was never reached.** The slowest request on any model took 7.1 s, because
  replies stop early at their fixed length. How long a whole reply would take is not measured here,
  apart from the [one-off trials](#one-off-trials-not-the-app), whose slowest took 7.6 s.

### Why each build fell back

Each build has 2 question types, so 14 for each pacing. Every one fell back.

| `fallbackReason` | What really happened | MCQ, spaced | Theory, spaced | MCQ, back to back | Theory, back to back |
| --- | --- | --- | --- | --- | --- |
| `rate-limited` | 429: refused for the minute limit, twice | 5 | 2 | 6 | 4 |
| `empty-response` | The whole reply went on reasoning | 2 | 4 | 1 | 0 |
| `invalid-response` | The reply was cut off, so its JSON is broken | 0 | 1 | 0 | 0 |
| `bad-request` | 413: this one request is over the minute limit by itself | 0 | 0 | 0 | 3 |

### The filter

**How often the AI's questions pass: not measurable on the app as it is, because there were 0 AI
drafts.** The only drafts seen came from the [one-off trials](#one-off-trials-not-the-app).

The rule-written questions did go through the filter. These counts cover all the rules' drafts,
including the ones a test did not need.

| | Rules only | AI, spaced | AI, back to back |
| --- | --- | --- | --- |
| MCQs stopped at the gate | 5 | 4 | 4 |
| MCQs through the gate, accepted / revised / rejected | 90 / 0 / 3 | 91 / 0 / 3 | 91 / 0 / 3 |
| Theory stopped at the gate | 0 | 0 | 0 |
| Theory through the gate, accepted / revised / rejected | 42 / 0 / 0 | 42 / 0 / 0 | 42 / 0 / 0 |
| Chosen for the test, MCQ / theory | 63 / 42 | 63 / 42 | 63 / 42 |

The commonest reason a rule-written MCQ was dropped is `ambiguity:vague-qualifier`, with 2. These
each happened once: `blank:negative-statement`, `blank:part-of-term`, `mcq:equivalent-options`,
`mcq:negative-not-verifiable` and `mcq:overlapping-options`. Rules only also had
`blank:meaningless` once.

The difference between 90 and 91 is real and explained: see problem 7 below.

### The blind AI check

**It never ran.** The app asks for it only when the AI answered earlier in that build (`llmAnswered`
in `testEngine.js`), and the AI never gave a usable answer. So it found nothing, and it cost nothing.
In the one-off trials it was asked 6 times and refused 6 times by the minute limit.

### The two pacings

This shows what the plan's minute limit is causing.

- **Back to back, the limit refuses nearly everything:** 23 of 24 requests. Each build uses up the
  minute's allowance for the next.
- **Spaced, a build still competes with itself.** The MCQ and theory requests go out together. In
  every one of the 7 spaced builds, one was answered and the other refused twice.
- **So the limit is not the only cause.** The 7 spaced requests that were answered still gave
  nothing usable: 6 empty and 1 cut off. Removing the limit alone would not bring the AI back.

### The limits this key has

| Limit | Value | How we know |
| --- | --- | --- |
| Tokens per minute | 8,000 | Response headers and every refusal |
| Requests per day | 1,000 | Headers. **The window is a day, not a minute.** The counter says 1m26.4s to win back 1 request of 1,000, which works out at 24.0 hours, and [Groq's page](https://console.groq.com/docs/rate-limits) says the same |
| Tokens per day | 200,000 | Only from `qwen/qwen3.8-27b`'s refusals. The headers do not show it, and the page lists the same figure for the other two models. Their own daily limits were not reached |
| Reply length, when the app sends no limit | 3,072 on `openai/gpt-oss-120b`, 2,048 on the other two | 15 replies stopped at exactly these lengths. Groq's pages do not mention these numbers |

- **The daily limit refills bit by bit. It does not reset at midnight.** Groq's stated wait matched
  a steady refill of 200,000 tokens per 24 hours (about 8,300 an hour) on all 4 daily refusals, to
  the second. It stayed at the limit across midnight India time.
- **At the median build's cost, 200,000 tokens is about 27 builds.** After that, about one more an
  hour. Marking, feedback and key terms use the same model, and so would draw on the same limit.
- **A request's size is judged with an allowance for its reply.** On 15 of the 18 refusals where the
  prompt's size is known, Groq's "requested" figure is exactly the prompt plus the whole reply
  length, and on the other 3 it is under 500 above the prompt. So the same request can be answered
  once and refused another time: `2_ML.pdf`'s theory request was answered when spaced and refused
  with a 413 back to back. Groq does not document how it picks this allowance.

### Does a reasoning model's reply reach the parser?

**Yes, when the reply is whole. Mostly it is not.**

- **Where the reasoning goes.** Both `openai/gpt-oss` models put it in a separate `message.reasoning`
  field, and `message.content` holds the answer, so the app reads only the answer, as intended.
  None of the replies had `<think>` tags in the answer, including `qwen/qwen3.8-27b`'s, which
  reported no reasoning tokens.
- **What goes wrong.** Reasoning counts towards the fixed reply length. On `openai/gpt-oss-20b`, 7 of
  8 replies spent 2,046 of their 2,048 tokens on it, leaving nothing to read. That shows up as
  `empty-response`.
- **`parseJsonLoose` copes with what it can.** All 3 whole replies, from the trials, read correctly.
  All 7 cut-off replies were lost, because the list never closes, even though they held up to 7
  questions' worth of complete fields.

### Replies lost to bad JSON

All 10 saved replies were run through the parser as it was before `d72ac82` and as it is now.
Empty replies have no text to read, so they are not among them.

| | Replies |
| --- | --- |
| Read by both, with the same result | 3 |
| Lost only by the old parser (the bug) | **0** |
| Lost only by the current parser | 0 |
| Lost by both, all cut off by the reply length | 7 |

The 3 whole replies were valid JSON as sent, with their backslashes correctly escaped. So nothing
here shows how often the bug would matter: it would take many more whole replies to know.

### One-off trials (not the app)

**These are not the app's results and should not be quoted as its pass rate.** They were run to find
out what would work before asking whether to change anything. All are on `openai/gpt-oss-120b`,
with `LLM_CONTEXT_CHARS=6000`. Reasoning effort and the reply limit were added to each request by a
one-off script from outside the app.

| Trial | Test | Builds | What was added | AI questions | Replies | Blind check |
| --- | --- | --- | --- | --- | --- | --- |
| A | Page's default: 4 MCQs (pool of 6) | 2 | Nothing: settings only | 0 of 12 | Both cut off | Not asked |
| B | The same | 2 | `reasoning_effort: low` | **11 of 12** | Both whole | Refused, 4 of 4 tries |
| C | 6 MCQs and 4 theory (pool of 9 and 6) | 1 | The same, and `max_completion_tokens: 4500` | **7 of 15**, MCQs only | MCQs whole, theory refused | Refused, 2 of 2 tries |

- **In trials B and C, 18 of the AI's 28 draft MCQs passed the filter (64%), with no blind check.**
  4 were stopped at the gate and 6 rejected by the evaluator. The commonest reasons were `not-grounded`
  (3), `ambiguity:vague-qualifier` (2) and `context:unnamed-actor` (2). That is 3 builds from 2
  documents, so it is only a first sign. With the check running, fewer would pass.
- **The reply length is only a default.** In trial C a reply reached 3,299 tokens, past the 3,072 seen
  when no limit was sent.
- **The minute limit stays.** Even here the AI wrote one question type at most, and the blind check
  was always refused. Builds took 11.8 s (median of B) and 13.6 s (C).

### The question run for the later chats

`evaluation/generate.mjs` on the same 7 documents, with `openai/gpt-oss-20b`. Saved in
`server/evaluation-output/questions-run1/`, which is git-ignored.

| Document | `tfidf` | `terms` | `llm` |
| --- | --- | --- | --- |
| `1_DEDV.pdf` | 13 | 15 | 15 |
| `2_DEDV.pdf` | 13 | 15 | 15 |
| `1_ML.pdf` | 15 | 15 | 15 |
| `2_ML.pdf` | 15 | 15 | 15 |
| `4_ML.pdf` | 15 | 15 | 15 |
| `5_ML.pdf` | 15 | 15 | 15 |
| `ML_3.pdf` | 14 | 15 | 15 |
| **Total** (MCQ + theory) | **100** (60 + 40) | **105** (63 + 42) | **105** (63 + 42) |

- **The AI wrote 0 of these 310 questions.** All 14 of the `llm` strategy's question types fell back
  to the rules, so that label does not mean AI-written here. This run cannot compare the AI with the
  rules. It can only compare the old generator with the current rules.
- **`rating_sheet.csv` has 210 rows,** because identical questions are merged.
- **Raters get `rating_sheet.csv` only.** `key.csv` and `questions.json` say which method wrote what.

## The problems this found

None is fixed. On 2026-11-02 the team decided not to add settings for reasoning and reply length,
and to measure the app as it is.

1. **The default model is retired** (`DEFAULT_MODEL` in `server/src/services/llm.js`). Every text
   request returns 404. By the code, marking, feedback and key terms use the same setting, so they
   should fall back too, but they were not run here.
2. **The app sets no reply length and no reasoning effort** (`callLLMDetailed` sends only the model,
   temperature and messages). All 13 replies stopped at the provider's default length. In trial C, a
   reply of 12 MCQs took 3,299 tokens even with almost no reasoning.
3. **One cut-off reply loses every question in it** (`parseJsonLoose`). Replies held up to 7 questions'
   worth of complete fields, and all of it was thrown away.
4. **A build is larger than the minute limit** on this plan. The MCQ and theory requests go out
   together (`Promise.all` in `generateQuestions`), and each is thousands of tokens.
5. **The retry rarely helps against the minute limit** (`sendWithRetry`). The app waits at most 5 s.
   On the minute limit Groq asked for a median of 22.5 s, and told 30 of 34 refused requests to wait
   more than 5 s. All 19 retries in the comparison and the measurement were refused, and each costs
   the build about 5 s. In the question run, one retry was answered, with an empty reply.
6. **A request too big for the limit is reported as `bad-request`,** the same words as a wrong model
   name. A person reading the logs sees `413 bad-request rate_limit_exceeded`, and the `413` is the
   only way to tell them apart.
7. **When the AI fails, which rule writer runs first is a race.** The comment in `generateQuestions`
   says theory goes first, so its answers claim their sentences. If the MCQ request fails first, the
   MCQ writer goes first. With a stand-in AI, theory failing first matched rules only on all 15
   questions, while MCQ failing first changed 2 of 15 on each of 3 documents. This is the cause of
   the 90 and 91 in the table above: `5_ML.pdf` is the one document where this changed the count.
8. **A time-out while a reply's body is arriving is called `empty-response` and is not retried**
   (`res.json().catch` in `once`). This was seen only with a stand-in, never on Groq.
9. **`--no-embeddings` in `evaluation/generate.mjs` does not turn the meaning model off for the `llm`
   strategy,** if it is installed. This is the evaluation tool, not the app. The question run
   set `SEMANTIC_MODEL=off` so that it matches this measurement and the live site.

## The decisions left open

1. **Whether to change the app so the AI can work.** Two small settings would get part of the way, as
   the [trials](#one-off-trials-not-the-app) show. The minute limit would remain.
2. **Whether to set `LLM_MODEL` on the live site.** It stops the 404. For question writing it adds
   about 5 s and about 7,500 tokens to each build, and gains no AI questions. It may bring back
   marking and feedback, which is not measured yet, so the marking measurement should say first.
3. **Whether to change `DEFAULT_MODEL`.** It has not been changed. `server/.env.example`,
   `docs/HANDOVER.md` and `DEPLOY.md` still describe the old model or say nothing of this.

## Limits

**About what was tested**

- **Speed depends on Groq's load and this laptop on that day.** It was one night, an Apple M2 laptop
  with 8 GB of memory, 7 builds per row, each run once. The live server may be much slower.
- **These are this key's limits, and the live site's key may differ.** A different key or plan could
  have different limits, reply lengths or models. What the live site does has not been seen.
- **Passing the filter does not mean a question is good.** The filter catches known faults. Whether
  a question is good is for people to rate, which is a later measure.
- **The notes are 7 documents from 2 subjects, while `docs/EVALUATION.md` asks for at least 10 from
  3.** DBMS, Networks and DistributedSystems were left out because the generator was developed on
  them, and CCNLP's PDFs are scans with no text layer.
- **These notes are the team's own.** Our students' notes could be shorter or longer, and the size of
  the notes decides how large each request is.
- **Only one size of test was measured:** a pool of 9 MCQs and 6 theory questions. The page's default
  is 4 MCQs, tried only in the one-off trials, where it was still cut off. Smaller tests were not
  tried and might get through.
- **Only question writing was measured.** Marking, feedback, key terms and answer photos use Groq too.
- **Each document was a first test on those notes,** alone, with no earlier questions to avoid. A
  student's later tests send more text. Tests from several documents were not tried.
- **It calls `generateQuestions` directly,** without the server, the database or other students. Real
  students using the site at the same moment would share the same limits.

**About the numbers**

- **Each model got only 2 or 3 builds in the comparison,** and each build once. Which request gets
  refused varies from one run to the next.
- **`qwen/qwen3.8-27b` had one document fewer,** and its daily limit was nearly used when it was tried.
  It was at 193,838 of 200,000, most likely from the OCR measurement earlier that day, though that was
  not checked.
- **The AI's replies are not repeatable.** The seed fixes the app's own random choices only. The app
  sends Groq no seed.

## Method

**The path measured.** Each PDF becomes notes through `evaluation/lib/ingest.js`, as an upload does.
Those notes go to the real `generateQuestions`, imported and not rewritten, asking for 9 MCQs and 6
theory questions, which the AI is asked for as 12 and 8. The meaning model is off, as `render.yaml`
has it on the live site. Each build starts from the same seeded random numbers and an empty study
cache, and builds run one at a time.

**The notes.** The DEDV and ML PDFs in `server/evaluation-output/links-notes/` (git-ignored). Each
document is treated as its own subject.

| Document | Bytes | Topics | Characters | SHA-256 |
| --- | --- | --- | --- | --- |
| `1_DEDV.pdf` | 408,245 | 12 | 18,611 | `f4f9a1db2df094122c61be5def2db3bb086ea39233ed25edae6a0aa75b9eaa00` |
| `2_DEDV.pdf` | 335,434 | 20 | 22,266 | `14ffc0a794b3782a931a45ba85ece2c543fc26526f3abea2df5c0a4191ab232c` |
| `1_ML.pdf` | 219,246 | 16 | 17,419 | `fa0861623a4885c2d8534819831ed4e63daf7f299d23f19cdd244f242033c91c` |
| `2_ML.pdf` | 370,418 | 13 | 28,546 | `9075a41fe65acd13169933dfa900dd25e6471a6091ce0eca91c9e9ebb8d65c2d` |
| `4_ML.pdf` | 292,142 | 6 | 14,901 | `599c747d9e1a4e2d637f329d7909c2ae16e574e7235654dcfdaf691a91800f93` |
| `5_ML.pdf` | 279,999 | 6 | 16,230 | `afcaa4ce4c8c15770bfbc3e4712515ee0edec7aee64e6144207a19d30a0b9327` |
| `ML_3.pdf` | 341,109 | 13 | 20,107 | `37dd9d2ef446fb16b19733461625f1432b71e41704d069ad9577a24a4c670282` |

**Rules only** removes the key, so the app makes no request. **Spaced** waits at least 65 s, or longer
if Groq's headers say so. **Back to back** waits only before its first build. Each stops at once if
Groq says a daily limit is used up or refuses the key.

**The recording.** Inside the evaluation only, `globalThis.fetch` is wrapped. For each request to Groq
it keeps the kind of request, model, size, status, times, tokens, `retry-after`, rate-limit headers and
the numbers in any refusal. It reads the opening words of the prompt to tell the three kinds apart
and keeps only the kind. It never keeps the key or the request body. The app gets the response
untouched. The app's own log lines are kept too, and they hold counts and kinds only.

**Counting the AI's drafts.** `llmDrafts` gives the number. `generateQuestions` returns the questions
it chose and most it dropped, and those show which step stopped each one. A draft that passed but
was not needed is in neither list, so it is worked out by subtraction.

**The old parser.** `parseJsonLoose` as it was before `d72ac82` is read from git, and every saved reply
goes through it and the current one. A reply counts as read when it gives a list.

**The choice of model.** `server/evaluation-output/groq-run1/PLAN.md` was written before the comparison,
and the outcome was added to it afterwards. It left out `allam-2-7b` (its context of 4,096 tokens is too
small) and the safety and speech models this key also lists. `qwen/qwen3.6-27b`, one of Groq's suggested
replacements, is not listed for this key, and the deprecations page says it has been retired as well.

## Running it again

Run in `server/`, with `GROQ_API_KEY` in `server/.env`:

```bash
LLM_MODEL=openai/gpt-oss-20b npm run eval:groq
```

| | |
| --- | --- |
| Commit | `72173dd` for every run. `46d81d9` then fixed one table in `results.md` (see the checks below). This report was added in the next commit |
| Seed | 1 (the default; `--seed` changes it) |
| Model | `openai/gpt-oss-20b` on Groq |
| Date | The night of 2026-11-01 to 2026-11-02, India time: everything between 18:09 and 18:44 UTC on 2026-11-01 |
| Pool | 9 MCQs and 6 theory questions (the defaults; `--mcq` and `--theory` change them) |
| Gap | 65 seconds (the default; `--gap` changes it) |
| Settings left at their defaults | `LLM_CONTEXT_CHARS` 24,000, `LLM_TIMEOUT_MS` 20,000, `LLM_VERIFY` on |
| Takes | About 10 minutes, and about 58,000 tokens |

It writes `results.md`, `results.json`, `builds.jsonl`, `requests.jsonl`, `app.log` and `replies.jsonl` to a
new folder in `server/evaluation-output/` (git-ignored), or to `--out <dir>`. `replies.jsonl` holds the AI's raw
replies, which quote the notes, so it must stay git-ignored and never be shared. A stopped run is picked up
again from these files, but only on the same commit. The replay through the old parser reads it from git, so in a
shallow clone it says it did not run, and everything else still works.

The run behind this report passed `--out` only, and it picked up the 3 spaced builds of the comparison on the
same commit, so they were not run twice. The comparison added `--only 4_ML.pdf,2_ML.pdf,2_DEDV.pdf --no-rules
--pacing spaced` with `LLM_MODEL` set for each model. The default-model build was the same with `--only 2_ML.pdf
--gap 0` and no `LLM_MODEL`.

The question run, in `server/`, on the same commit:

```bash
SEMANTIC_MODEL=off LLM_MODEL=openai/gpt-oss-20b node evaluation/generate.mjs evaluation-output/links-notes/DEDV evaluation-output/links-notes/ML --llm --no-embeddings --mcq 9 --theory 6 --seed 1 --out evaluation-output/questions-run1
```

Its log is `generate.log` in the same folder.

Checks on these numbers:

- **Worked out a second way:** a separate Python script shares no code with the tool. It reads the saved
  `[testgen]`, `[quality]` and `[llm]` log lines, the fetch records and the raw replies. It works out from how each
  request ended what the app's fallback reason should be, counts the drafts with its own JSON repair, and
  recomputes the medians, sums and counts in `results.json`. All of it agreed on all 7 folders: 787 comparisons on
  the main run, and the app's `llmMs` was within 2 ms of the fetch records. It also found no key, organisation
  name or reply text in the files that can be shared. This script is not in this repository. It cannot check what
  Groq says, only what is done with it.
- **Sanity cases with a stand-in AI:** `server/test/groqPathEvaluation.test.mjs` is part of `npm test` and needs no key
  and no network. Through the real `generateQuestions` it checks a clean reply, a 429, a time-out, a 404 and a reply
  with bad JSON, each counted as the right outcome, as well as an empty reply, a stalled reply, a daily limit, a
  refused key and one request refused while the other is answered.
- **The disagreements, and their causes:**
  - **90 against 91 accepted MCQs.** The rules should give the same questions in every column. They differ on
    `5_ML.pdf` alone, and the cause is problem 7, which was confirmed with a stand-in.
  - **A larger request answered while a smaller one was refused.** The cause is the reply allowance described in
    [the limits this key has](#the-limits-this-key-has). Why Groq picks one allowance or another is not known.
- **One bug in the tool, found on reading its output:** its table by kind of request left out the tokens of empty
  replies. Commit `46d81d9` fixed it. Re-scoring the saved records changed only that table, so no run was repeated,
  and this report takes nothing from that table's old numbers.

Calls to Groq: 72 requests in the tool's runs, of which 2 on the retired model, 6 on `openai/gpt-oss-120b`, 45 on
`openai/gpt-oss-20b`, 6 on `qwen/qwen3.8-27b` and 13 in the trials. The question run made 25 more, 23 of them refused.
Tokens recorded: about 55,700 on `openai/gpt-oss-120b`, 57,900 on `openai/gpt-oss-20b` and 15,500 on
`qwen/qwen3.8-27b`. The question run did not record its tokens. Parts of the 7 documents were sent to Groq, and
nothing from the live database was.
