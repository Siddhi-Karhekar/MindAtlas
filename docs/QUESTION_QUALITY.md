# Question quality: what deserves to be asked, how, and whether it is fair

How MindAtlas decides **what** to ask, **in which form**, and **whether a question is good enough** to reach a student. This applies to both writers: Groq (Llama 3.3 70B) and the built-in rule-based writer. Written 22 October 2026 for branch `quiz/question-quality` (on top of `fix/classifier-and-reports`).

The aim is not more questions. It is **fewer, better questions**: an important concept, clear wording, exactly one answer you can defend, and three wrong options a student could really believe. When the notes cannot support a good question, the test gets shorter and the student is told (as before). It is not padded.

---

## 1. Walkthrough: from upload to question

| Step | What happens | File · function |
| --- | --- | --- |
| Upload, text, structure | File type checked; text read with its headings, lists and tables; long files split into subtopics | `routes/notes.js`, `documentText.js`, `documentStructure.segmentDocument` |
| Study sentences | Only paragraph and list sentences; page furniture, admin lines, exercises and fragments dropped | `studyText.candidateSentences`, `isQuestionWorthy` |
| Key terms | Whole phrases ("data link layer"), ranked by TF-IDF distinctiveness and author marking | `keyTerms.extractTerms`, `studyFor` |
| MiniLM (optional) | **Only** embeddings: is a sentence on topic, ranking terms (KeyBERT), choosing distractors close in meaning, catching paraphrased repeats (cosine ≥ 0.92). It never writes questions and cannot check facts. **Not installed on Render** (512 MB plan), so production runs without it. | `embeddings.js`, `studyText.keepRelevant` |
| MCQ or theory | Each sentence is given a kind (definition, fact, formula, code, step, …) | `suitability.classifyText` |
| **New: question-worthiness** | Each study sentence gets a 0–1 score; MCQs only come from sentences scoring at least 0.5 | `worthiness.js` |
| **New: concept relations** | Siblings, categories and parent families, read from the notes' own wording | `conceptRelations.js` |
| Who writes | Groq is tried first when `GROQ_API_KEY` is set; on any failure the rules take over. Rule drafts always queue behind the AI's to fill gaps | `testEngine.generateBatch` |
| Groq prompts | MCQ prompt (`mcq-v6`) and theory prompt (`theory-v5`); JSON parsed loosely, LaTeX escapes repaired | `testEngine.generateMcqWithLLM`, `llm.parseJsonLoose` |
| Rule-based writer | MCQ forms: identify, **describe (new)**, acronym, **numerical (new)**, cloze; theory forms: define, explain, compare, steps, formula, list … | `testEngine.generateMcqFallback`, `generateTheoryFallback` |
| Gates (unchanged, now one function) | Grounding (verbatim excerpt), `validateQuestion` (~40 rules), reported questions, MCQ suitability | **`testEngine.gateDraft`** |
| **New: AI check** | One extra Groq call per build. It answers every MCQ without seeing the key | `testEngine.verifyWithLLM` |
| **New: evaluator** | Hard ambiguity and correctness rules, plus a soft score; decides accept, revise or reject | `questionEvaluator.evaluateQuestion` |
| No repeats, difficulty, storage | Duplicates by wording, meaning (with MiniLM) and concept; adaptive pool; stored with `generatedBy` and now `quality` | `pickFresh`, `routes/tests.js` |

## 2. Why questions were poor (root causes, with evidence)

All examples below were accepted by the old pipeline on the repo's own fixtures (rules only, which is what runs whenever Groq is rate-limited).

1. **Frequency treated as importance.** A single word counted as a "strong term" just because it appeared three or more times (`isStrongTerm`: `standalone >= 3`). That produced blanks like `"Kirchhoff's voltage law states that the _____ of voltages…"` → **sum**, `"In a star topology every _____ connects to a central hub"` → **device**, and `"…when some of its _____ fail"` → **nodes**. 13 of the 47 old MCQs were of this kind.
2. **Distractors did not have to be the same kind of thing as the answer.** Options were picked by shape and length. Nothing related them to the answer, so you got `older transaction / stable storage / ACID property / exclusive lock` and `ARQ / CIDR / LAN / SYN`, where the answer is the only one of its kind.
3. **No check that a wrong option was also right.** The only test was an exact match of a wrong option inside the blank. The checker never asked whether the notes call one option a kind of another (**SHA-2** offered beside **SHA-512**), or say the same thing of another concept (TCP / SCTP). It also accepted an abbreviation beside what it stands for (LAN / local area network).
4. **Missing context passed if it was not at the very start.** "It…" or "This…" was caught only as the opening word, so `"A decrypts the session key…"` (who is A?), "the figure above" and abbreviations the notes never use all got through.
5. **No vague-qualifier rule.** "best", "most important" and "hardest" passed whenever the stem was otherwise well formed.
6. **One template did most of the work.** 77% of rule-based MCQs were fill-in-the-blank, copied word for word (96% of the stem's words came from the source sentence).
7. **The AI was trusted on ambiguity.** The prompt told Groq to write one defensible answer, and nothing independent checked it. The only checks were the rules.
8. **Formulas were thrown away for MCQs.** That was correct for blanking. But formula interpretation and numerical reasoning, which are good MCQ material, were never asked.
9. **Classification without confidence.** A regex priority chain had a "fact" fallback for anything unmatched, and there was no way to say "unsure, do not build an MCQ on this".

## 3. Architecture after this change

```
note ─► study sentences ─► classifyText ──────────────► kind + confidence + reason
             │                 (low confidence → theory only)
             ├─► worthiness score (centrality, relevance, substance,
             │                     completeness, assessability) ── < 0.5: no MCQ
             └─► concept relations (siblings, categories, families)
                               │
        ┌──────────────────────┴───────────────────────┐
   Groq (mcq-v6)                                   rule-based writer
   gets worthy MCQ lines tagged                    describe · identify · acronym
   ⟦definition, importance high⟧; must give        numerical (computed) · cloze;
   objective, level, explanation, reasons         distractors ranked by kinship;
   for each wrong option                           no hypernym options; ≤2 per option set
        └──────────────────────┬───────────────────────┘
                               ▼
              gateDraft  (same for both writers)
              grounding · validateQuestion · reported · suitability
              (a numerical question passes suitability only if its answer recomputes)
                               ▼
              verifyWithLLM  (one Groq call, when the AI answered in this build)
              answers each MCQ blind; lists defensible / implausible options
                               ▼
              evaluateQuestion  (same for both writers)
              HARD: vague qualifier, missing material, unnamed actor, undefined
                    abbreviation, unsupported name, two questions, equivalent
                    options, option overlaps answer, another option also true,
                    options do not fit stem, trivial one-word answer, computed
                    key wrong, checker disagrees / 2 defensible / ambiguous /
                    better as theory / 2 implausible options
              SOFT: importance, suitability, clarity, correctness, distractors,
                    uniqueness, cognitive level, difficulty fit, novelty,
                    originality → score; < 0.55 reject; distractors < 0.45 reject
                               ▼
              accept / revise (safe rewording) / reject (stored as discarded)
                               ▼
              pickFresh (no repeats) ─► test pool, stored with quality record
```

## 4. What changed, file by file

| File | Change |
| --- | --- |
| `services/suitability.js` | `classifyText` now returns a `confidence` (0–1), a `reason` and a `role` (definition / cause-effect / fact). Below `MCQ_MIN_CONFIDENCE` (0.45) a sentence is theory only. Hedged, example-led, number-heavy and open-ended sentences lose confidence. The kinds and their order are unchanged. |
| `services/worthiness.js` (new) | The question-worthiness score and `WORTH_MIN` (0.5, `QUALITY_WORTH_MIN`). `mcqWorthy` is used by both writers. |
| `services/conceptRelations.js` (new) | Reads siblings (list entries, enumerations), categories ("X is a mechanism…") and families ("W such as / includes X") from the notes. Provides `kinship` and `isHypernymPair`. |
| `services/numerical.js` (new) | A small safe parser for `V = I × R`, `1/R = 1/R1 + 1/R2` and similar. Inputs are chosen deterministically, the answer is computed, and distractors come from typical slips (× for ÷, a term left out, the reciprocal forgotten). `recompute` re-checks the answer. Nothing is evaluated as code, and uploaded code is never run. |
| `services/questionEvaluator.js` (new) | The unified evaluation layer (§3). It returns `{ decision, score, criteria, problems, cognitiveLevel, sourceKind, classification }`. |
| `services/testEngine.js` | `gateDraft` and `qualityContext` are now shared, exported functions. New forms `describeDraft` and `numericalDrafts`. `answerWorthy` stops frequency-only one-word answers. `termDistractors` ranks by kinship, skips hypernyms and needs at least one same-kind option when the notes name one. At most two questions per identical option set. Adds `verifyWithLLM` and `optionSimilarity` (MiniLM, when present). MCQ prompt `mcq-v6` with tagged lines, a worked transformation example, the clarity rules, distractors as a separate task with a reason for each, and extra output fields (`learningObjective`, `cognitiveLevel`, `explanation`, `distractorReasons`). |
| `services/questionQuality.js` | Direct-answer check: "512 bits" now matches "512-bit". Numerical questions skip the passage check, because the evaluator recomputes them. |
| `services/llm.js` | `mcq-v5` → `mcq-v6`; new `verify-v1`. |
| `routes/attempts.js`, `routes/tests.js` | The new fields (`quality`, `verification`, `computation`, `explanation`, `distractorReasons`, `classification`) are stripped while a test is taken, just as the answer key is. |
| `test/questionEvaluator.test.mjs` (new) | 62 checks: classification, worthiness, numerical, every evaluator rule, the benchmark, the rule writer under the gate, and the AI check against a stand-in Groq. |
| `test/contentSuitability.test.mjs`, `test/questionQuality.test.mjs` | Numerical MCQs are now allowed from formulas and checked by recomputation. The expected MCQ count from one short note went from ≥5 to ≥4, because trivial answers and a third copy of the same option set are now left out. |
| `evaluation/benchmark.mjs`, `evaluation/benchmark/` (new) | A labelled MCQ set with notes; old gate vs new, per defect, and a threshold sweep. `npm run eval:benchmark` |
| `evaluation/compare.mjs` (new) | Old generator vs new on the same notes. `npm run eval:compare -- --before <old checkout>` |

**Unchanged:** API contracts, the database schema (new fields are extra keys on question documents), the client, the theory prompt, marking, mastery and the Groq-then-rules switch. Every existing test still passes (25 files, about 1,560 checks).

**Stored with every question (accepted or discarded):** `quality` `{ decision, score, criteria, problems[{code, severity, detail}], version: "eval-v1" }`, `sourceKind`, `classification`, `cognitiveLevel`. Where present, also `verification` (the AI check, with `promptVersion`/`model`), `computation`, `learningObjective` and `explanation`. Log lines are counts only: `[quality] mcq: accepted=… revised=… rejected=… verify=… verified=… reasons=…`. Provider failures (`[testgen] … fallbackReason=`) and quality failures (`[quality] … reasons=`) are kept separate.

## 5. Before and after (rules only, the fallback path)

| Before (accepted) | After |
| --- | --- |
| `"Kirchhoff's voltage law states that the _____ of voltages around any closed loop is zero."` sum / resistance / resistor / current | Rejected: `importance:trivial-answer`. The notes give a numerical question instead: *"For resistors in series the total resistance is given by $R = R1 + R2 + R3$. What is $R$ when $R1 = 12$, $R2 = 5$ and $R3 = 3$?"* 20 / 14 / 51 / 17 (a minus sign, × for +, a term left out) |
| `"In a star topology every _____ connects to a central hub or switch."` device / failure / backbone / mesh | Rejected (`importance:trivial-answer`). "Device" is just a word the notes repeat. |
| `"A decrypts the session key with its private key, and both users then discard the _____ …"` | Rejected: `context:unnamed-actor`. "A" is never introduced. |
| `"_____: after a transaction completes, its changes persist…"`, then the same blank for atomicity, isolation and consistency, each offering the other three | *"Which statement describes “durability”?"* The four options are the four ACID descriptions: confusing two properties is the misconception this tests. The family's sentences are then used up, so the same options are not offered four times. |
| `"Fault tolerance: … when some of its _____ fail."` nodes / users / computers / actions | `"_____: the distributed system continues to operate correctly when some of its nodes fail."` fault tolerance / resource sharing / scalability / concurrency. These are siblings from the same list. |
| `"SHA-256 produces a 256-bit digest and _____ produces a 512-bit digest."` with SHA-2 offered | When the notes say "the SHA-2 family includes SHA-512": rejected (`mcq:option-overlaps-answer`). When they do not, the rules cannot know, and only the AI check can catch it (§8). |

On the AI path the prompt now asks for transformed, application-style stems (the deadlock scenario from the brief is in the prompt as the worked example). Every AI question then faces the same gate as the rules' questions, plus the blind AI check.

## 6. Evaluation report

### 6.1 Labelled benchmark (`npm run eval:benchmark`)

The set has 35 MCQs on `evaluation/benchmark/notes.md`: 14 good and 21 bad across eight defect types.

| Gate | Bad questions caught | Good questions wrongly rejected |
| --- | --- | --- |
| OLD (grounding + validateQuestion + suitability) | 9/21 (43%) | 2/14 (14%) |
| NEW (+ evaluator, rules only, no AI check) | 20/21 (95%) | 0/14 (0%) |

| Defect | Items | OLD | NEW |
| --- | --- | --- | --- |
| ambiguous | 3 | 1 | 3 |
| missing-context | 3 | 1 | 3 |
| unsupported | 2 | 0 | 2 |
| multiple-correct | 6 | 2 | 6 |
| weak-distractors | 1 | 0 | 0 |
| wrong-key | 2 | 2 | 2 |
| format | 3 | 2 | 3 |
| trivial | 1 | 1 | 1 |

The two good questions the old gate rejected were both numerical; they were thrown away only for coming from a formula. The one bad question the new gate misses has absurd options ("banana", "42", "blue"). Without the embedding model or the AI check, rules cannot tell "banana" from a real neighbouring concept that the notes do not mention.

**Read these numbers with care.** The labels are provisional and were written by an AI session (see the set's `about` field). The set was also written while the rules were being built, so it shows the rules do what they were designed to do. It is a regression check, not independent evidence of quality. Treat it as a measurement only after two people have re-labelled it (§7).

### 6.2 Old generator against new, same notes (`npm run eval:compare`)

Rules only, on the 8 fixture and sample files, 10 MCQs requested per file:

| | MCQs | Fill-in-the-blank share | Stem copied from source | Would fail the new gate | Distractor score | Duplicates | Build time (all 8) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Before | 47 | 77% | 96% | 15/47 (13 trivial answers, 1 unnamed actor, 1 weak options) | 0.81 | 0 | 1.2 s |
| After | 48 | 60% | 90% | 0/48 | 0.83 | 0 | 0.9 s |

The after side passes the new gate by construction, because it is built under that gate. The useful comparisons are therefore the first and second columns and how the old output fares under the stricter gate. The rule writer still copies most of its wording (90%). Controlled rewording without a language model is limited to the describe, identify and numerical forms, and real paraphrase is the AI path's job.

### 6.3 What was not measured here

- **The AI path.** No Groq key in this session, and live calls cost the free quota. To compare: build a test on the same notes with the key set, read the `[testgen]` and `[quality]` log lines, and rate the questions blind (`docs/EVALUATION.md`).
- **Cost and latency of the AI check:** one extra request per build. It sends ≤ 24 questions, each with ~360 characters of source (roughly 3–4k tokens). It is skipped whenever the AI failed earlier in the same build. Measure its time from `llmMs`/`totalMs` once live.
- **Student response statistics:** not enough answers logged yet (see §8).

## 7. Calibrating the thresholds

All thresholds are provisional, set by hand on the fixtures: `MCQ_MIN_CONFIDENCE` 0.45, `QUALITY_WORTH_MIN` 0.5, `QUALITY_MIN_SCORE` 0.55, `QUALITY_MIN_DISTRACTORS` 0.45, and the weights in `worthiness.js` and `questionEvaluator.js`. To calibrate:

1. **Collect.** Run `npm run eval:generate` on real student notes from several subjects (both `--llm` and rules), so the set has questions the gate accepted and rejected. Also export discarded questions with their `quality` record.
2. **Rate.** Two people independently label each question good or bad, with the defect, using the rubric in `docs/EVALUATION.md` and the defect list in `evaluation/benchmark/mcq_benchmark.json`. Settle disagreements and report agreement (Cohen's kappa).
3. **Sweep.** Put the rated questions in a set file with the same shape and run `npm run eval:benchmark -- --set <file>`. The sweep table shows bad-caught against good-rejected for each `QUALITY_MIN_SCORE`. Pick the lowest threshold that rejects ≤ 10% of good questions. The aim is quality over count, but rejecting good questions shortens tests for no reason.
4. **Worthiness.** Label 200+ study sentences as "worth a question" yes or no. Then choose `QUALITY_WORTH_MIN` (and the weights) to maximise F1 on that set. The per-sentence factors are in `worthinessOf` for exactly this purpose.
5. **Hard rules.** For each hard rule, count how often it fires on questions rated good. A rule that is wrong more than about 1 time in 10 should become soft or be narrowed.
6. **Repeat** each term with new notes. The model's own scores are never ground truth.

## 8. Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `LLM_VERIFY` | on | `off` skips the blind AI check, saving one Groq request per build |
| `QUALITY_MIN_SCORE` | 0.55 | Soft-score threshold below which a question is rejected |
| `QUALITY_MIN_DISTRACTORS` | 0.45 | Distractor score below which an MCQ is rejected |
| `QUALITY_WORTH_MIN` | 0.5 | Worthiness a sentence needs to carry an MCQ |

## 9. Known limits and next steps

- **Rules cannot judge meaning.** Without MiniLM (Render) or the AI check, an absurd outside option, or a family the notes do not state, can slip through. Next step: an embedding service outside the 512 MB API, or the checker on every build.
- **The trivial-answer rule is strict.** A one-word concept the notes use but never define or mark (e.g. "collisions" in ALOHA) is no longer a blank answer. Watch `importance:trivial-answer` on the admin data and narrow the rule if good questions are lost.
- **Code-output questions are not generated**, deliberately: running uploaded code on the server is unsafe. A sandboxed runner (e.g. a separate worker with no network) would be needed.
- **The rule writer has no derivation or design questions**, and its theory forms are unchanged.
- **The AI check is the same model family as the writer.** It answers blind, which is independent evidence, but not a second opinion from a different model. A different `LLM_MODEL` for the checker would be stronger.
- **Groq free-tier daily limits:** the AI check adds tokens per build. A circuit breaker (handover §12, step 4) is still to do.
- **Difficulty is not calibrated** from student answers yet. Once enough attempts are logged, use the per-question correct rate and discrimination to adjust labels, and feed reported or low-discrimination questions back as negative examples for the benchmark.
