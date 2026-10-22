# From notes to tests: concept records and the integrated pipeline

How an uploaded file becomes formatted notes, then machine-readable **concept records**, and how the test engine uses those records to choose what to ask, in which format, and how to check it. Written 22 October 2026 for branch `quiz/question-quality`, building on `docs/QUESTION_QUALITY.md` (the quality evaluator, the blind AI check, worthiness).

**In one sentence:** every note now has concept records next to its human-readable `content`. A concept plan is built from those records before any question is written, and Groq, the rule-based writer and the quality gate all work from that plan instead of from loose sentences.

---

## 1. Audit: what existed before this change

| Stage | File · function | What it produced |
| --- | --- | --- |
| Upload, type check | `routes/notes.js` `POST /api/subjects/:id/notes`, `uploadCheck.checkUploadContent` | the file (never stored) |
| Extraction / OCR | `documentText.extractDocument` (PDF, Word, PowerPoint), `ocr.extractTextFromImage` (Tesseract) | text + blocks |
| Cleaning, structure, split | `documentStructure.blocksFromPlainText`, `normalizeContent`, `segmentDocument` | blocks: heading (level), para, item (ordered, depth), table (rows), label; bold terms (`strong`) |
| Storage | `models/Note.js` `createNote` | **`rawText`** (plain) + **`content`** (blocks), keywords, vector, `path`, `parentNoteId` |
| Reading view | `noteView.publicNote`, `withKeyTerms` | the note + key terms for highlighting |
| Study sentences | `studyText.candidateSentences` | sentences/list entries with section, lead, `suit` (MCQ/theory kind) |
| Key terms | `keyTerms.studyFor`, `extractTerms` | whole terms ranked; per-sentence term keys |
| MCQ/theory classification | `suitability.classifyText` | a kind per sentence (with confidence, on this branch) |
| Question writing | `testEngine.generateMcqFallback` / `generateTheoryFallback` (rules), `generateMcqWithLLM` / `generateTheoryWithLLM` (Groq) | drafts |
| Validation | `testEngine.gateDraft`, `questionQuality.validateQuestion`, `questionEvaluator.evaluateQuestion`, `verifyWithLLM` | accepted / discarded |
| Dedup, assembly | `testEngine.pickFresh`, `sameQuestion`, `routes/tests.js` `buildTest` | test pool; questions stored with `concept`, `form` |
| Taking, marking, feedback | `routes/attempts.js`, `adaptiveEngine`, `gradingEngine`, `feedbackEngine`, `masteryEngine` | unchanged by this work |
| Client | `pages/TestAttempt.jsx`, `components/AnswerReview.jsx` | reads `prompt`, `options`, `type`; review reads `correctAnswer`, `modelAnswer`, `keyPoints`, `source` |

## 2. Integration gaps

**Confirmed (and fixed here):**
1. **No formatter changes existed.** The brief assumed improved formatting, but GitHub had none. There was no concept-level or machine-readable representation: only `content` blocks, which serve the reading view.
2. **The test engine never stored or reused structured metadata.** Each build re-derived sentences and terms from scratch and threw them away. Nothing was kept, served by the API or traceable.
3. **Groq received loose sentences** grouped only by note (`renderNote`), with no concept identity. Its answers could not be tied to a concept, and it was never told which concepts were theory-only beyond the filtering.
4. **Questions carried a free-text `concept`** (a term key or an AI phrase). There was no stable id, so the history could not tell a concept from a synonym or record how it was asked.
5. **Concepts were picked by rank bands** of TF-IDF terms (`pickUnusedTerm`): "easy = most central, hard = most obscure". Importance, suitability and history did not decide what was asked; the order of drafting did.
6. **Misread text was not detected.** OCR confidence was used only to drop words, and a misread page still produced questions (3 from the sample OCR page).
7. **Context-dependent content** (sentences opening "It…", "As shown above…") still produced MCQs: 4 from the sample page.
8. **Explanations:** rule-based MCQs had none, and an AI explanation was never checked against the notes.

**Possible, not confirmed (left as is):**
- **Page numbers are not kept** by the PDF/PowerPoint readers, so provenance is the note plus the verbatim passage, not a page. Adding pages means changing `documentText.js` (Member 1's area).
- **Separate processes building the same subject** could race on storing records; the last write wins. This is harmless, because records are rebuilt from the text.

## 3. The architecture now

```
file ─► extraction / OCR (+ OCR confidence) ─► blocks ─► content + rawText      (unchanged)
                                                              │
                     studyFor (sentences, key terms) + worthiness + relations
                                                              │
                                            CONCEPT RECORDS  (conceptRecords.js)
                    stored on the note at save and edit · served by GET /api/notes/:id/concepts
                    rebuilt by a test build when missing or out of date (fingerprint)
                                                              │
                                            CONCEPT PLAN  (conceptSelection.js)
          per type: eligible concepts by label · importance × reading confidence × novelty
          uncertain importance → reserve · low → excluded · per note, mastery-weighted
                     ┌────────────────────────┴─────────────────────────┐
             Groq (mcq-v7, theory-v6)                               rule-based writer
     sees only planned concepts, each under a                pickPlannedConcept (MCQ) / plan-sorted
     ⟦concept id | name | type | formats | importance⟧       drafts (theory); numerical from planned
     header; must return conceptId                            formulas; new approach first
                     └────────────────────────┬─────────────────────────┘
                     gateDraft: grounding · format rules · reported · suitability ·
                     CONCEPT CHECK (id exists; allowed for this type; else inferred from the quote)
                                                              │
                     verifyWithLLM (blind) ─► evaluateQuestion (hard rules + score;
                     theory: answer and key points must be in the notes)
                                                              │
                     explanation kept only if grounded ─► pickFresh (new concepts first,
                     then concepts asked a NEW way) ─► test, each question with conceptId + approach
```

## 4. Data contract

**A concept record** (`note.concepts.records[]`, served in full by `GET /api/notes/:id/concepts`; stored compactly with each passage once). Real output for the DBMS sample:

```json
{
  "id": "c-1bc49f41d4", "key": "transaction", "title": "transaction",
  "kind": "term", "type": "definition",
  "topicPath": ["Database Management Systems - Unit 4", "Transactions"],
  "definition": "A transaction is a logical unit of work that takes the database from one consistent state to another.",
  "statements": [
    { "text": "A transaction is a logical unit of work …", "kind": "definition", "role": "definition", "mcq": true, "confidence": 0.9, "worth": 0.985, "leansOnContext": false },
    { "text": "Every transaction must either complete entirely or have no effect at all.", "kind": "fact", "mcq": true, "confidence": 0.7, "worth": 0.82, "leansOnContext": false }
  ],
  "examples": [], "formulas": [],
  "suitability": { "label": "both", "mcq": true, "theory": true, "reasons": [] },
  "importance": { "score": 0.994, "band": "high", "uncertain": false, "factors": { "bestWorth": 0.985, "centrality": 1, "defined": true, "marked": true } },
  "difficulty": { "level": "easy", "why": "a definition or single fact" },
  "prerequisites": [], "relations": { "siblings": [], "parents": [] },
  "confidence": 1,
  "source": { "noteId": "…", "passages": ["A transaction is a logical unit …", "Every transaction must …"] },
  "exclusion": null
}
```

| Field | Values |
| --- | --- |
| `kind` | `term` · `process` (steps; carries `steps`) · `comparison` (a two-way table; carries `rows`) · `list` · `formula` |
| `suitability.label` | `both` (MCQ and theory) · `mcq` · `theory` · `context-dependent` (every sentence leans on one the student cannot see; theory only with 2+ sentences) · `unsuitable` (listed under `excluded`, with `exclusion`) |
| A formula | `both` only when it can be applied numerically: the MCQ is then **computed** (`numerical.js`), never blanked |
| `importance.uncertain` | within 0.08 of the cut-off (0.45): used only after surer concepts; below 0.37 the concept is excluded |
| `confidence` | 1 for clean text; the OCR confidence for a photo; ≤ 0.45 when common words look misread ("tbe", "callcd", "rnernory"). Below 0.5, nothing is asked. |

A note's stored `concepts` object is `{ version, fingerprint, builtAt, extraction, passages, records, excluded }`. The fingerprint is a hash of the title, `rawText`, `content` and `CONCEPTS_VERSION`.

**A question** keeps every existing field: `type`, `prompt`, `options`, `answerKey`, `keyPoints`, `supportingExcerpt`, `difficulty`, `marks`, `topic…`, `status`, `generatedBy`. It adds:

| Field | Meaning |
| --- | --- |
| `conceptId` | the record it tests (checked, or inferred from its quote) |
| `concept` | the concept's name (as before) |
| `approach` | how it is asked: `describe`, `identify`, `cloze`, `numerical`, `define`, `steps`, `compare` … |
| `explanation` | why the answer is right, from the notes; for "describe", also why the closest wrong option is wrong |
| `quality`, `cognitiveLevel`, `sourceKind`, `classification`, `verification`, `computation` | the evaluator's record (QUESTION_QUALITY.md) |

**Hidden during an attempt:** the answer key, excerpt, key points, quality, verification, computation, explanation, distractor reasons and classification. The review shows `explanation` for MCQs.

**The build's `generation.<type>.concepts`** (stored on the test) is `{ considered, eligible, reserve, excluded: {reason: n}, used }`. It is also logged as `[concepts] mcq: considered=… eligible=… used=… excluded=…`.

**Compatibility.** Existing tests, attempts, responses and scoring are untouched. The client needs no change to take tests, and the review only adds a "Why" line. A note saved before records existed gets them on its next test build (through `onConcepts`) or the first time `/concepts` is requested. Nothing has to be migrated by hand.

## 5. Before and after, on the DBMS sample (rules only)

**Existing representation (still kept, for reading):**
```json
{ "type": "para", "text": "A transaction is a logical unit of work that takes the database from one consistent state to another. Every transaction must either complete entirely or have no effect at all.", "strong": ["transaction"] }
```
**Structured representation:** the record in §4. **How it guides selection:** importance 0.99 (high), label `both`, never tested, so it is near the top of both plans. The word "database" in the same note is excluded (`answer-not-a-concept`: only repeated, never defined). The build reports `considered=64 eligible=24 excluded={unsuitable:28, no-statement:2, low-importance:1} used=10`.

**A resulting MCQ** (from the ACID list record; concept `c-0415f17374`, approach `describe`, quality 0.84):
> Which statement describes "isolation"?
> - each transaction is unaware of other transactions executing concurrently ✔
> - either all operations of the transaction are reflected in the database or none are
> - after a transaction completes, its changes persist even if the system fails
> - the transaction can read the item but cannot write it
>
> *Why:* The notes say: "Isolation: each transaction is unaware of other transactions executing concurrently." The option "after a transaction completes, its changes persist …" is from: "Durability: after a transaction completes, its changes persist even if the system fails."

**A resulting theory question** (a `list` record, concept `c-8f052aaffe`, hard):
> List and briefly explain the transaction states. *(Give 5 points.)*
> Key points: Active · Partially committed · Failed · Aborted · Committed. The model answer is the notes' own five entries.

**A weak question that is now rejected:**
- *Before:* from the context-less sample page, "It picks the process that has waited longest. This avoids starvation…", the old engine wrote 4 questions.
- *Now:* its three records are `context-dependent` (`every-statement-leans-on-context`), so the plan has nothing eligible and the build says `excluded=context-dependent:3`. No question is written.

Likewise, an AI MCQ that cites the id of the linker's "pass 1" steps is refused with `concept:not-eligible-for-mcq:theory`, and one citing an id that does not exist with `concept:invalid-reference`.

## 6. What changed

| File | Change |
| --- | --- |
| `services/conceptRecords.js` (new) | `buildConceptRecords`, stable ids, labels, importance, difficulty, prerequisites, relations, provenance; `extractionConfidence` (OCR confidence, misread common words); `recordForExcerpt` |
| `services/conceptSelection.js` (new) | `selectConcepts`: eligibility by label, priority = importance × confidence × novelty, a reserve for uncertain importance, stats |
| `services/testEngine.js` | `conceptsOfNote`, `buildConceptsForNotes`, `compactConcepts` / `expandConcepts`. The plan is built in `generateQuestions`. `pickPlannedConcept` for MCQs; the theory writer is plan-sorted and leaves shared concepts to MCQs when MCQ material is scarce; a note with nothing left passes its turn on. Groq context via `renderConcepts`. Concept-reference check in `gateDraft`; `groundedExplanation`; `approach`; `pickFresh` puts new approaches first. The theory drafts carry their structure. Prompts `mcq-v7` / `theory-v6`. |
| `services/questionEvaluator.js` | Theory answerability: `theory:answer-unsupported` and `theory:key-point-unsupported` for AI answers not in the notes |
| `services/ocr.js`, `models/Note.js`, `routes/notes.js` | OCR mean confidence stored as `ocrConfidence`; records built and stored when a note (or its subtopics) is saved |
| `services/noteLifecycle.js` | records rebuilt when a note is edited |
| `routes/noteItems.js` | `GET /api/notes/:id/concepts` (owner only; builds when missing or stale) |
| `routes/tests.js` | `approachHistory` from earlier questions; `onConcepts` stores rebuilt records |
| `routes/attempts.js`, `client/.../AnswerReview.jsx` | the review shows the MCQ's grounded explanation ("Why:") |
| `services/noteView.js` | the record set is not sent with every note |
| `test/conceptPipeline.test.mjs` (new) | 47 checks: records, selection, the rule writer, a stand-in Groq, legacy notes, the API |
| `test/generationQuality.test.mjs`, `test/questionPipeline.test.mjs` | Adjusted for intended behaviour. A concept may recur in a later test, but not the same way. Discarded drafts may be the same in two builds; only accepted questions must differ. Answers of all forms are checked as whole terms. |
| `evaluation/pipeline.mjs`, `evaluation/pipeline/` (new) | `npm run eval:pipeline`: the evaluation set and metrics below |

## 7. Test results (run in this session)

- **Server:** `npm test` passes all 26 files (about 1,600 checks). The only FAIL lines are the intentional "OLD mongoStore" demonstration. `npm run lint` is clean.
- **Client:** `npm run build` succeeds. `npm run lint` shows 9 warnings, all of which existed before; none are new.
- **Not covered by automated tests:**
  - the real Groq API (a stand-in server is used);
  - OCR of real photos (the OCR language file is downloaded at run time; the misread-text detector is tested on text);
  - the client in a browser: there is no client test runner in the repo, and the Python end-to-end scripts were not run here.

## 8. Quality comparison (`npm run eval:pipeline -- --before <old checkout>`)

Rules only, on the same 14 inputs (13 files plus a legacy copy), 10 MCQ and 4 theory asked, 3 consecutive tests each.

**Note metrics (new side).** Provenance is 100% for every file: every record passage is verbatim in its note. Formulas are 100% held in the files that have them. MCQ-worthy sentences reached by an MCQ-eligible concept range from 50% to 100% (about 80% for networks). Records are complete (every required field) in 100% of cases. The misread OCR page reads at confidence 0.3 with 0 records; the context-less page gives 3 context-dependent records. Concept ids agree between the Markdown, PDF, Word and PowerPoint versions of the same unit in 98-100% of cases.

| Side | Accepted | Rejected by the new gate | Several defensible answers | Questions from the misread or context-less pages | Top-10 concepts covered | Same concept asked the same way again (tests 2-3) | Build time |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Before | 141 | 27 | 0 | 7 | 45% | 40% | 10.5 s |
| After | 139 | 0 (built under it) | 0 | 0 | 60% | 25% | 16.5 s |

**What this shows:**
- Bad sources no longer produce questions.
- More of the most important concepts are tested.
- Repeat tests vary the approach more often.
- About the same number of questions is accepted.

**What it costs and where it is worse:**
- Builds are about 55% slower, mainly from building records.
- Concept repetition is worse on the cryptography sample (35% → 45%), whose concept pool runs out by the third test.
- One topic's share of a test is higher on the distributed-systems sample (45% → 55%), because notes with nothing eligible pass their turn on.

**Still needs people:** whether keys are correct, ambiguity as students meet it, distractor plausibility, theory answerability, and reviewer acceptance. Use `docs/EVALUATION.md` and the `QUESTION_QUALITY.md` §7 calibration. The "rejected by the new gate" column is an automatic measure from the same gate, not evidence of quality.

## 9. Walkthrough

1. **Reading the upload** works as before: `documentText.js` for PDF, Word and PowerPoint, `ocr.js` for photos, `documentStructure.js` to split and format. Two things are new: the photo's OCR confidence is kept, and as soon as the note and its subtopics are saved, `buildConceptsForNotes` turns each one into concept records.
2. **Concept records** (`conceptRecords.js`) say what the note teaches, concept by concept:
   - what the concept is (a definition, a fact, a cause, a process, a comparison, a list, a formula);
   - whether it can be an MCQ, a theory question, both, only with more context, or not at all, and why;
   - how important it is (how central its terms are, how worth asking its best sentence is, whether the notes define or mark it);
   - how hard it is (what kind of knowledge, how many other concepts it is explained with);
   - how reliably its text was read;
   - exactly which passages state it.
3. **Building a test** (`routes/tests.js` → `testEngine.generateQuestions`) rebuilds the records if the text changed, then makes a **plan** (`conceptSelection.js`). For each question type, the plan lists the eligible concepts, best first: important, reliably read, and not tested recently, or tested only in another way.
4. **The rule-based writer** takes concepts from the plan in order. It asks a concept a way it has not been asked before when it can ("Which statement describes…", "Which of the following…", a computed numerical, then a blank). It leaves theory-only concepts to the theory writer, and gives every question its concept id and an explanation from the notes.
5. **Groq** is sent only the planned concepts, each under a header with its id, type, allowed formats and importance, followed by its own sentences. It must name the concept it used. The gate refuses an id that does not exist, or an MCQ on a concept kept for theory. Questions without an id are matched to a concept by their quote. An explanation Groq adds is kept only if it is in the notes. If Groq is unavailable, the rule writer fills the test from the same plan; the reason is reported as before (`fallbackReason`), alongside the plan's numbers.
6. **Every question, from either writer,** then passes the same gate, the blind AI check (when Groq answered) and the quality evaluator (`QUESTION_QUALITY.md`). `pickFresh` assembles the test: new concepts first, then concepts asked in a new way, and earlier questions only to reach the test's length.
7. **What students see:** the same test screens. After submission, an MCQ in the review can show a short "Why" from the notes. What the system records is a concept id and an approach on every question, so later tests can vary how each concept is asked, not just avoid repeating its wording.

**Realistic limits:**
- **The rule writer is not an LLM.** It cannot paraphrase freely, write scenarios, or judge meaning without MiniLM. Its strength is that everything it writes is grounded and checkable.
- **The records are built by rules too.** Labels, importance and difficulty are transparent but hand-tuned; calibrate them as `QUESTION_QUALITY.md` §7 describes.
- **Gaps from this round:** no page numbers yet, no code-output questions, and no derivation questions from the rules.
