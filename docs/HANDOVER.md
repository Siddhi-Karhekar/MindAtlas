# MindAtlas: handover

Everything a new team member, an evaluator, a future maintainer - or a fresh AI chat - needs to understand, run, change and deploy MindAtlas, and to carry on the work without asking what happened before.

**Updated 22 October 2026**, against `main` at `acb37a7` (PR #42 merged) plus branch `fix/classifier-and-reports` (one commit, delivered as a patch, not yet on GitHub - see §11). Supersedes the 17 October version.

For depth, each section points to the document that owns that topic. Function names are given rather than line numbers where code moves often; search for them (`grep -n "functionName"`).

---

## 0. Start here (for a new chat)

Paste or attach this file at the start of a new chat, then say what you want to do next. The essentials:

- **Who:** Siddhi Karhekar (karhekarsiddhi3@gmail.com), Member 3 of a 4-person capstone team: test generation, marking, feedback, mastery; also notes ingestion work.
- **Repo:** https://github.com/Siddhi-Karhekar/MindAtlas · local copy `D:\fy\capstone\MindAtlas` (Windows, **PowerShell**).
- **Live:** https://mindatlas.onrender.com (web) · https://mindatlas-api.onrender.com/api (API).
- **Constraints:** no paid credits (free tiers only: Render, MongoDB Atlas, Groq free tier); never break things for users or teammates; feature branch + pull request, never push straight to `main`.
- **How Siddhi likes instructions:** short, plain explanations; shell commands **one per line**; in PowerShell plain `cd D:\...` (in cmd, `cd /d D:\...`).
- **How code reaches GitHub:** an AI session usually **cannot push** (the git proxy refuses this repo). Changes are delivered as a `.patch` file written into `D:\fy\capstone\MindAtlas`, which Siddhi applies with `git am` and pushes herself (§13).
- **What is pending right now:** apply and merge `fix/classifier-and-reports` (§11).

---

## 1. What MindAtlas is

MindAtlas turns a student's own notes into a knowledge graph and then into adaptive, exam-style tests whose results show which topics need work.

**Core loop:** sign up → create a subject → add notes (typed, photo, PDF, Word, PowerPoint) → related notes are linked into a graph → build a test from chosen notes → take it one adaptive question at a time → see which topics need attention → the next test targets them.

**What makes it different from asking a chatbot for a quiz:**
- every question quotes the student's own notes and is rejected if the quote is not there;
- only subject matter is asked about (never the college, batch, semester, exercises);
- each sentence is classified as MCQ material or theory-only material, so formulas, code, algorithm steps and comparison tables are never turned into fill-in-the-blanks;
- every question is tagged to a topic, and mastery is tracked per topic across tests (Bayesian Knowledge Tracing); the next test leans toward weak topics;
- the whole app works with no paid AI: every AI step has a rule-based fallback, and the student is told which one wrote their test.

**Short description (for forms and slides):** MindAtlas turns a student's own notes into a personal study coach: it links related ideas into a knowledge graph and builds exam-style tests only from what the student studied - every question quotes its source, passes about 40 quality checks and is never repeated. Definitions and facts become MCQs; formulas, algorithms and comparisons become theory questions. Tests adapt as the student answers, AI marks written answers against a rubric, and every result shows exactly which subtopics to revise. It runs on Groq's Llama 3.3 with a built-in rule-based fallback, so it works at zero cost.

---

## 2. Team and ownership

A 4-person capstone. Branch conventions and working rules are in `CONTRIBUTING.md`.

| Member | Area | Main code |
| --- | --- | --- |
| Member 1 | Notes: ingestion, structure, reading, export | `services/documentText.js`, `documentStructure.js`, `noteExport/`, `noteLifecycle.js` |
| Member 2 | Knowledge graph | `services/tfidf.js`, `graphEngine.js`, `noteEmbedding.js`, `keywordMap.js`, `scripts/relink.mjs` |
| Member 3 (Siddhi) | Tests, marking, feedback, mastery | `services/studyText.js`, `suitability.js`, `keyTerms.js`, `testEngine.js`, `questionQuality.js`, `adaptiveEngine.js`, `gradingEngine.js`, `answerImages.js`, `feedbackEngine.js`, `masteryEngine.js`, `revision.js`, `routes/tests.js`, `routes/attempts.js` |
| Member 4 | Containers, CI, cloud, backups | `Dockerfile`, `docker-compose.yml`, `.github/workflows/`, `render.yaml`, `DEPLOY.md`, `scripts/db-*.mjs` |

Support address shown in the app: set by `SUPPORT_EMAIL` on Render.

---

## 3. Stack at a glance

| Layer | Tools |
| --- | --- |
| Web client | React 19, Vite, Tailwind CSS, React Router, Cytoscape.js (graph), KaTeX (formulas, `trust: false`) |
| API | Node.js 22, Express 4 |
| Database | MongoDB Atlas (official driver); a built-in JSON-file store for local development, same interface (`server/src/db/`) |
| File reading | pdfjs-dist (PDF), mammoth (Word), JSZip (PowerPoint XML), Tesseract.js (photo OCR) |
| Downloads | pdfkit (PDF), docx (Word) |
| AI (optional) | Groq API (OpenAI-compatible): text `llama-3.3-70b-versatile`; vision `qwen/qwen3.8-27b` (reads photos attached to theory answers) |
| AI (optional, local) | all-MiniLM-L6-v2 via `@huggingface/transformers` (sentence embeddings); **not installed on Render** (free plan RAM) |
| Auth and security | bcryptjs, jsonwebtoken in an HttpOnly cookie, own security headers and CSP, rate limits, multer (uploads), nodemailer (optional email) |
| Quality | oxlint, Node test scripts (~1,300 checks), Python Playwright end-to-end scripts, gitleaks, npm audit, GitHub Actions |
| Hosting | Render (static site + web service), MongoDB Atlas free cluster, Docker |

Every id in the API is a plain 24-hex string on both database backends.

### Code map (where things live)

```
client/src/pages/       one file per screen: SubjectWorkspace (notes, upload), KnowledgeGraph, Tests (build),
                        TestAttempt (focus mode), Insights (results), Progress, Home (revision, streak), Admin, auth pages
client/src/components/  AnswerReview, ReportQuestion, AnswerImages, NoteContent, MathText, DownloadMenu, AppShell
client/src/lib/         api.js (the one API client), generation.js ("written by AI (Groq)" / rules lines and badges)
server/src/index.js     wires middleware and routers; config.js = limits from the environment
server/src/middleware/  auth (JWT cookie, requireAuth), validate, once (double-submit), rateLimit, upload, safeRouter
server/src/routes/      auth, subjects, notes, noteItems, graph, tests, attempts, admin  (thin: check, then call services)
server/src/services/    all the logic (see §4); llm.js is the ONLY file that talks to Groq
server/src/models/, db/ collections over mongoStore.js / memoryStore.js
server/test/, verify/   Node checks; Python Playwright end-to-end scripts
docs/                   ARCHITECTURE, ASSESSMENT, SECURITY, EVALUATION, LINK_EVALUATION, LAUNCH, this HANDOVER
```

---

## 4. The four features and how each works

### 4.1 Notes (Member 1)

**What the student gets:** typed notes, or uploads of PDF, Word (.docx), PowerPoint (.pptx) and photos; long files split into subtopics; one formatted reading view with whole key terms highlighted; edit, delete, and download as PDF or Word.

**Workflow** (`routes/notes.js` `POST /api/subjects/:id/notes`):
1. **Upload and check** (`uploadCheck.checkUploadContent`): limit 10 MB (`UPLOAD_MAX_MB`); the real file type is checked, not just the name. Old .doc and .ppt are refused with a "Save As" message.
2. **Extract text with its structure** on its own thread under a time limit (`extractInWorker` → `documentText.js`). PDF: font sizes give headings; running headers and page numbers dropped. Word: heading and list styles kept. PowerPoint: slide titles and outline levels. Photo: Tesseract (`ocr.extractTextFromImage`); line position and letter height give headings and lists back.
3. **Split into subtopics** (`documentStructure.segmentDocument`) from the document's own headings; with none, even parts named by keywords. Paperwork headings (batch/semester lines, "Disclaimer", "References") never become subtopics (`isAdminHeading`). The student previews the split and can keep the file whole.
4. **Store twice:** `rawText` (plain words: questions, grading and keywords use this) and `content` (headings, paragraphs, nested lists, tables, bold terms: display, and the list/heading context the classifier uses). Each subtopic stores its `path` in the outline.
5. **Key terms** (`keyTerms.js` `extractTerms`, `keyTermsFor`) are whole phrases ("data link layer", "local area network (LAN)"), highlighted the first time each appears.
6. **Edit, delete, download** (`noteLifecycle.editNote` / `deleteNote`; `noteExport/`). Tests are snapshots and never change when notes do.

No AI is used in this feature.

### 4.2 Knowledge graph (Member 2)

**What the student gets:** related notes linked automatically, within and across subjects; clusters; a keyword map per note; the power to remove a wrong link.

**Workflow** (`graphEngine.updateGraphForNote`, runs when a note is saved):
1. **Vectorise** with TF-IDF against the subject's other notes (top 12 terms).
2. **Link within a subject** when cosine similarity ≥ **0.11** (`SIMILARITY_THRESHOLD`, tuned on 117 real topics: `docs/LINK_EVALUATION.md`).
3. **Link across subjects** under a stricter rule (`CROSS_SUBJECT_THRESHOLD` 0.25 and ≥ 2 shared top terms; with embeddings, meaning similarity ≥ 0.68 and ≥ 1 shared term). Rejected pairs show under "Considered, not linked" (`classifyPair`).
4. **Cluster** with Louvain community detection (`clusterNotes`).
5. **Show** with Cytoscape.js; a removed link stays removed (`POST /api/graph/edges/:id/correct`).

After changing a linking rule, run `npm run relink` (DEPLOY.md "Relinking the graph").

### 4.3 Tests and marking (Member 3)

Every rule with its code location: `docs/ASSESSMENT.md`. Detailed walkthroughs: the two Claude Docs in §10.

**Building a test** (`routes/tests.js` `buildTest` → `testEngine.generateQuestions`):
1. **Choose.** The student picks notes and a pattern (quick quiz, university unit test, entrance exam): marks per MCQ and per theory question, negative marking (with "Leave blank"), sections. How many MCQs and theory questions is **the student's choice** (`mcqCount`, `theoryCount`, 0-20 each, total 1-20).
2. **History** (`buildTest`): mastery map; `avoid` (every earlier accepted prompt on these topics); `repeatRank`; `recentConcepts` (last 2 tests); `conceptHistory`; and, on the fix branch, `blocked` (questions this student reported as wrong, unclear or not from the notes).
3. **Pool size:** about 1.5× what the student sees, capped at 24 (`poolSizeFor`).
4. **Study sentences** (`keyTerms.studyFor` → `studyText.candidateSentences`): only paragraphs and list entries; `isQuestionWorthy` drops 6-60-word failures, headings, page furniture and paperwork (`BOILERPLATE`: college, "prepared by", semester, batch, B.Tech, academic year, emails, URLs, disclaimers…), questions (`?`), worked calculations (`=` with more than 3 numbers), exercises ("Write…", "Calculate…"), syllabus lines and split-off subscripts ("PU e"). With the embedding model, off-topic sentences are dropped too (`keepRelevant`); without it, sentences with no key term.
5. **MCQ-or-theory classification** (`suitability.classifyText`) - see §4.3.1.
6. **Write the questions** (`generateBatch`, MCQ and theory in parallel): see §5. With Groq, rule-written drafts queue behind the AI's and replace any that fail or repeat.
7. **Quality gate** for every question from either writer:
   - **grounding** (`isValidDraft`): supporting excerpt ≥ 8 characters, verbatim in the notes, not boilerplate;
   - **`questionQuality.validateQuestion`** (~40 rules, reason codes `clarity:*`, `language:*`, `format:*`, `context:refers-back`, `mcq:*`, `blank:*`, `correctness:*`, `theory:*`): exactly 4 distinct options, answer once, no all/none of the above, no option inside another, answer not standing out by length or form, not printed in the question, whole-term blanks, a named subject, theory command word + model answer + key points; small faults repaired;
   - **reported** (fix branch, `testEngine.isReported`): a question the student reported as broken, reworded or the same answer from the same passage → discarded as `reported`;
   - **MCQ suitability re-check** (`mcqSourceProblem`): an MCQ whose quoted passage is theory material is discarded as `suitability:<kind>`.
   Everything rejected is stored as `discarded` with `discardReason` (visible on the admin page).
8. **No repeats** (`pickFresh`, `sameQuestion`, `meaningComparer`): duplicates by wording (Jaccard ≥ 0.75 on words or stems, ≥ 90% containment; different quoted terms never equal), by meaning (cosine ≥ 0.92, only with the model), by concept. Order: concepts never tested → tested before, least often and longest ago → recent concepts reworded. Earlier questions return only to reach the test's length: never shown, then answered poorly, then the rest. Two builds by one student run one after the other (`oneAtATime`).
9. **Store and report** (`createQuestions`, `setTestGeneration`); if nothing passes: **422** `generation_failed` and the test is deleted; if fewer than asked, the test is shortened and the student told.

#### 4.3.1 How MCQ-friendly vs theory-friendly is decided

- **Granularity:** per **sentence / list entry**, not per topic or chapter. The nearest heading and whether the entry is in an (ordered) list are passed as context.
- **Mechanism:** `suitability.classifyText` - a fixed **priority chain of regex/structure rules; the first match wins**. No score, weights, confidence or ML model.
- **Order and results:** empty → explanation · table row (`looksLikeTableRow`) · **code** (statements, `for(`, `printf(`, operators between operands, assembler mnemonics, backticks) · **formula** (LaTeX, maths symbols, `X = Y`) · **derivation** (substituting, we get, proof, derive; *not* "therefore/hence" alone, *not* "derived from" - fix branch) · in a list: **step** (ordered list, "Algorithm/Steps/Procedure/Pass 1/How to" heading, or an imperative opening verb - unless the entry is a noun-led statement like "Load balancing distributes…", fix branch), **fragment** (label – clipped phrase, no verb), **point** (labelled entry under Advantages/Disadvantages/Limitations…) · step in prose under a procedure heading · fragment (no verb, no determiner) · **definition** ("X is a…", "refers to", "is called", "means") · **explanation** (> 40 words and ≥ 4 clauses) · otherwise **fact**.
- **Permissions** (`KINDS`): definition and fact → MCQ + theory; every other kind → theory only.
- **Enforced in four places:** Groq is only shown MCQ sentences when writing MCQs (`renderNote`, `mcqOnly`); the rule writers only blank MCQ sentences (`clozeSentence`, `identifyDraft`, `acronymDraft`, `legacyClozeDraft`); every finished MCQ is re-checked (`mcqSourceProblem`, context from `mcqSourceIndex`; acceptance wins if an excerpt matches both lists); the theory writer alternates toward theory-only forms (`THEORY_ONLY_FORMS` = compare, steps, formula, list).
- **Prompt-only (not enforced in code):** the theory prompt's "prefer tables, steps, formulas, derivations".
- **Not supported:** code-output MCQs, numerical-calculation MCQs, derivation/proof theory forms in the rule writer, open design questions, diagram questions.
- Tests: `server/test/contentSuitability.test.mjs`.

**Taking a test** (`routes/attempts.js`): one question at a time; a **1-up-1-down staircase** over easy/medium/hard (`adaptiveEngine.nextDifficulty`, `pickNextQuestion` - weakest topic wins ties; `typesOwed` keeps the MCQ/theory mix); starting level from mastery (`masteryEngine.startingDifficulty`, "medium" until 3 observations). The server keeps the clock (30 s grace), resumes after a refresh (`currentState`), accepts an answer only for the question it is waiting on, answers are final, and keys/passages/rubrics never reach the browser before submission (`forAttemptTaking`).

**Marking:**
- **MCQ:** at answer time, `answer === answerKey`; negative marks for wrong non-blank answers; a blank scores 0 and does not count against the topic.
- **Theory** (`gradingEngine.gradeTheoryResponse`, at submission, 4 at a time): empty → 0; text addressed to the marker (13 EN/HI/MR patterns) → key points only, flagged, never sent to the AI; **with Groq** (temperature 0.2) the mark is on meaning, capped at the word-matched key-point share + 0.5, not believed if it shares no word with the rubric, capped by the AI's own key-point flags for non-Latin answers; **without Groq or on failure** → key-point matching (a key point is covered if its phrase or ≥ 60% of its word stems appear). On the fix branch the student is told "The AI marker was unavailable…", and the reason is stored (`fallbackReason`) and logged (`[grade] … reason=`).
- **Photos** attached to theory answers are read by the vision model (OCR fallback → provisional mark, `needsReview`).
- **Review** (`GET /api/attempts/:id/review`): each answer, the correct or model answer, key points covered, grader note, source passage. **Re-mark** once per theory answer (temperature 0, key point by key point, averaged with the overall mark; replaces the first mark up or down). **Report this question**: wrong answer, unclear, not in notes, repeated, other.

### 4.4 Feedback, mastery and progress (Member 3)

1. **Rank topics** with a fixed formula (`feedbackEngine.computeTopicScores`): `attentionScore = 0.7 × (1 − accuracy) + 0.3 × normalisedTime`, where `normalisedTime = min(1, topicAvgTime / (2 × attemptAvgTime))`; unanswered questions count as 0. The AI (temperature 0.5) or a template only words the result (`phraseFeedback`); on the fix branch a template fallback is logged (`[feedback]`).
2. **Results page:** marks out of the whole paper (unanswered and unreached questions included), focus topic, best topic, per-subtopic roll-up. Fewer than 3 answers on a topic → "early sign", never "weak". Mastery changes under 0.08 are not claimed as progress.
3. **Mastery: Bayesian Knowledge Tracing** (`masteryEngine.updateMastery`): prior 0.25, learn 0.15, slip 0.1, guess = 1/number of options (theory 0.1); partial credit blends the two posteriors (the team's own documented extension). Example: a correct 4-option MCQ moves a new topic from 0.25 to 0.61.
4. **Steering:** mastery sets the starting difficulty, which topic is served first, how much of each note the AI is shown and which notes the rule writer starts from.
5. **Progress and revision** (`revision.js`): mastery over time, a daily streak, and "worth revising next" (below 60% on ≥ 3 answers, or not practised for 7 days).
6. **What does not learn:** the classifier, difficulty labels and prompts are fixed; reports only affect that student (and, on the fix branch, their future tests on those notes).

---

## 5. Where the AI is used (and what happens without it)

| Step | With Groq | Without Groq (or when it fails) |
| --- | --- | --- |
| Note reading, splitting, key terms, graph, downloads | Never uses AI | Same |
| MCQ and theory questions | Llama 3.3 70B writes them (temperature 0.4); same gates | Rule-based writer; same gates |
| Theory marking | On meaning, capped by key points | Key-point matching; student told (fix branch) |
| Photo answers | Vision model reads the handwriting | OCR, mark provisional, flagged for review |
| Feedback wording | AI wording of a fixed ranking | Template wording, same ranking |

**The switch** (`testEngine.generateBatch`, per question type, per build): Groq is tried only if `GROQ_API_KEY` is set. It is asked for ⌈1.25 × pool⌉ questions (max 30). Any failure → rules: `not-configured`, `auth` (401/403), `quota` (402), `rate-limited` (429), `server-error` (5xx), `timeout` (20 s, `LLM_TIMEOUT_MS`), `network`, `empty-response`, `invalid-response`, `no-questions`. 429, 5xx, timeout and network are retried once (`llm.sendWithRetry`, Retry-After ≤ 5 s). If Groq's questions all fail the checks or all repeat, the reason is `llm-questions-rejected` / `llm-questions-repeated`.

**What the AI sees:** for MCQs, only MCQ-suitable study sentences per `###` note section with its top 10 key terms; for theory, all study sentences plus tables. Plus up to 40 earlier prompts (`<already_asked>`) and up to 25 untested concepts (`<focus_concepts>`). All student text is wrapped as tagged data (`asData`). At most 24,000 characters per request (`LLM_CONTEXT_CHARS`), shared out by weakest topic.

**How to tell which was used:**
- After building a test, a line per type: "written by AI (Groq)", "5 written by AI (Groq), 3 by MindAtlas's built-in rules (reason)", or "written by MindAtlas's built-in rules — reason". Each test in the list carries an AI / AI + rules / Rules badge (`client/src/lib/generation.js`).
- Server log: one `[testgen] mcq: status=… provider=… llm=… fallbackReason=… byLlm=… byRules=…` line per type; `[llm] request failed: <status> <kind>`; on the fix branch `[grade]` and `[feedback]` fallback lines.
- Database: `questions.generatedBy` (+ `promptVersion`, `model`), `tests.generation`, `responses.gradedBy` (+ `fallbackReason`), `feedback_reports.generatedBy`.
- `/api/auth/config` shows `"ai":{"enabled":true,"name":"Groq"}` when a key is set.

**Prompt versions** (`llm.js` `PROMPT_VERSIONS`): `mcq-v5`, `theory-v5`, `grade-v3`, `remark-v2`, `feedback-v3`. Bump a version whenever its prompt's wording changes.

**Privacy:** Groq receives note text, written answers and photos attached to theory answers, never names or emails. Groq's terms say it does not train on inputs, and make the app owner responsible for users under 18.

**Outside services:** Groq API (the only AI API), MongoDB Atlas, SMTP via nodemailer (optional, not set up), Hugging Face (one-time model download, only when installed), jsDelivr (Tesseract language file), Google Fonts.

---

## 6. Hosting and deployment

| Part | Where | Notes |
| --- | --- | --- |
| Client | Render static site `mindatlas` | Built by Vite; `VITE_API_BASE` is baked in at build time; rewrite `/*` → `/index.html` |
| API | Render web service `mindatlas-api`, free plan, Singapore | Build `npm ci` (the MiniLM model is **not** installed: `render.yaml`), start `npm start`, health `/api/health` |
| Database | MongoDB Atlas free cluster (AWS Mumbai) | 0.5 GB; no built-in backups on the free tier (`npm run db:backup`) |
| Deploy | Auto-deploy from `main` | Rollback: Render → Deploys → last good → Rollback |
| Blueprint | `render.yaml` | Record of the live settings; can rebuild from scratch (DEPLOY.md) |

**Free-plan behaviour:** the API sleeps after 15 minutes idle (first request then takes about a minute); 512 MB RAM, which is why `SEMANTIC_MODEL=off` and the model is not installed (with it, a large photo pushed OCR to about 576 MB and the API was killed).

### API environment settings

| Setting | Required | Live value / meaning |
| --- | --- | --- |
| `NODE_ENV` | yes | `production` (refuses to start without `MONGODB_URI` on Render) |
| `MONGODB_URI` | yes | Atlas connection string (exact spelling - a typo once lost every account for days) |
| `JWT_SECRET` | yes | 32+ random characters |
| `CORS_ORIGIN` | yes | `https://mindatlas.onrender.com` |
| `TRUST_PROXY` | yes | `1` |
| `GROQ_API_KEY` | optional | Set (AI on) |
| `SUPPORT_EMAIL` | optional | Set |
| `ADMIN_USER_IDS` | optional | Account ids (not emails) allowed to open `/admin` |
| `SEMANTIC_MODEL` | optional | `off` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `APP_URL` | optional | Not set: email confirmation and password reset are off |
| `LLM_MODEL`, `LLM_API_URL`, `LLM_TIMEOUT_MS`, `LLM_CONTEXT_CHARS`, `LLM_VISION_MODEL` | optional | Defaults: Groq, Llama 3.3 70B, 20000 ms, 24000 characters, qwen vision |
| `ATTEMPT_GRACE_SECONDS`, `UPLOAD_MAX_MB`, `NOTES_MAX_*`, `RATE_LIMIT_*` | optional | Defaults are fine |

Full explanations: `DEPLOY.md` and `server/.env.example`.

---

## 7. Security and privacy (summary)

Every protection, how it was checked, and its limits: `docs/SECURITY.md`.

- **Passwords:** ≥ 10 characters, not a common one, bcrypt; wrong passwords throttled per account.
- **Sessions:** JWT in an HttpOnly cookie, never in browser storage; cross-site requests refused; sign-out or password change ends every session.
- **Isolation:** every query is scoped to the signed-in student (look-up by id **and** owner).
- **Injected scripts:** React escapes text, KaTeX `trust: false`, a content security policy.
- **Uploads:** real file type checked, read on a separate thread under a time limit; only text is stored. Cap: 2,000 notes or 30 million characters per student.
- **AI:** student text is tagged data; answers that address the marker never reach the AI; AI marks are capped by evidence; the topic ranking is fixed before the AI words it.
- **Logs:** never note text, answers or emails.
- **Admin page** (`/admin`): reported questions, discarded questions with reasons, suspending an account, sign-up numbers.

---

## 8. Running it locally

Requires Node.js 18+ (22 in production). From the repo root:

```
cd server
npm install
npm run dev
```

Second terminal:

```
cd client
npm install
npm run dev
```

- Client http://localhost:5173, API http://localhost:4000.
- With no `MONGODB_URI`, data goes to `server/data/mindatlas-db.json`; `DB_FILE=memory` gives a throwaway database.
- Copy `server/.env.example` to `server/.env` (add `GROQ_API_KEY` to try the AI path) and `client/.env.example` to `client/.env.local`.
- `docker compose up` runs the whole app.

### Useful server scripts (`server/`)

| Command | What it does |
| --- | --- |
| `npm test` | All server test files (24; ~1,300 checks; a few minutes). The first block of `mongoStore.test.mjs` prints FAIL lines on purpose ("OLD mongoStore.js, before the fix"); the run must end "All checks passed." |
| `npm run lint` | oxlint; warnings fail |
| `npm run load-test` | 50 simulated students (never against the live site) |
| `npm run semantic:install` / `semantic:check` | Install / check the MiniLM model |
| `npm run relink` | Recompute graph links with the current rules |
| `npm run eval:generate` / `eval:score` | Blind question-quality rating study (`docs/EVALUATION.md`) |
| `npm run eval:links` | Link evaluation (`docs/LINK_EVALUATION.md`) |
| `npm run db:backup` / `db:restore` | Database backup and restore |

Client: `npm run lint` (two old warnings in `KnowledgeGraph.jsx`, not from Member 3's work) and `npm run build`.

---

## 9. Testing and CI

- **CI** (`.github/workflows/ci.yml`) on every push; a merge needs it green: server lint and tests, client lint and build, `npm audit` (high/critical), Docker image build, gitleaks.
- **Key test files for Member 3:** `contentSuitability.test.mjs` (classifier, AI stand-in, formatting, reported questions), `assessment.test.mjs` (clock, marking, AI marker incl. fallbacks, re-mark), `questionQuality.test.mjs`, `keyTerms.test.mjs`, `freshQuestions.test.mjs` (no repeats across tests), `questionPipeline.test.mjs`, `generationQuality.test.mjs`, `questionLeaks.test.mjs`, `masteryEngine.test.mjs`.
- No real AI is called in tests: a local HTTP server stands in for Groq.
- **End-to-end** (`verify/`): Python Playwright scripts for upload, document split, mixed and adaptive tests.
- **Fixtures:** `sample-notes/networks_unit2.*`, `server/test/fixtures/subjects/` (SPOS linker/loader, maths, programming, electrical), `server/test/fixtures/ics_unit3.md`, `server/evaluation/samples/`.

---

## 10. Documents

**In the repo:**

| File | What it holds |
| --- | --- |
| `README.md` | What works today, stack, configuration, layout |
| `CONTRIBUTING.md` | Team roles, branch rules |
| `DEPLOY.md` | Deploying, settings, email, backups, rollback, troubleshooting |
| `docs/ARCHITECTURE.md` | One-page map of the code |
| `docs/ASSESSMENT.md` | Every test, marking and feedback rule with its code location |
| `docs/SECURITY.md` | Every protection, how it was checked, limits |
| `docs/LAUNCH.md` | Pre-launch checklist and open decisions |
| `docs/EVALUATION.md` | Question-quality study protocol and rubric |
| `docs/LINK_EVALUATION.md` | How the linking thresholds were chosen |
| `docs/*.docx` | Feasibility reports |

**Outside the repo (Claude Docs, in Siddhi's claude.ai artifacts):**
- *MindAtlas: documentation-to-code map and MCQ/theory classification engine* (https://claude.ai/artifact/PCVSpgf9kFnWXkKTPVQjxb): feature → code table, architecture, every classification rule with real examples, pipeline, AI/fallback, feedback, code excerpts, bugs, and interview prep (1- and 5-minute explanations, file order, cheat sheet, 24 Q&A).
- *MindAtlas: test generation and feedback engine, technical walkthrough*: stage-by-stage workflow, Groq details, fallback triggers, three execution traces, reference map, improvement plan.
- An evaluation speech, a project report and a Render-changes note (earlier in the project).

---

## 11. Current status (22 October 2026)

**Live and working:** all four features; MongoDB Atlas; Groq AI on; photo answers for theory; MCQ/theory suitability (PR #42); support email shown.

**Merged since the last handover:** `quiz/generation-quality` (PR #32, includes `fix-fresh-questions`), `infra/build-without-model` (PR #39: API built with plain `npm ci`, no MiniLM), `quiz/content-suitability` (PR #42: the classifier, safe LaTeX/code formatting, photo answers).

**Pending - apply and merge:** branch `fix/classifier-and-reports`, delivered as `D:\fy\capstone\MindAtlas\classifier-and-reports-fix.patch` (plus `handover-update.patch` with this file). It contains:
1. Classifier false positives fixed: noun-led bullets ("Load balancing distributes…", "Link state routing floods…", "Update anomaly occurs…") are facts, not steps; "therefore/hence/thus" alone and "derived from" no longer mean derivation; "The == operator…" and "C++…" are not code.
2. Reported questions (wrong answer, unclear, not in notes) are never generated again for that student on those notes (`BLOCKING_REPORTS` in `routes/tests.js`, `testEngine.isReported`, discard reason `reported`).
3. Theory marking without the AI is told to the student, stored (`responses.fallbackReason`) and logged (`[grade]`); feedback template fallback logged (`[feedback]`).
4. README and `docs/ASSESSMENT.md` match the code (BKT, forgot password, link threshold 0.11, cross-subject meaning rule, the classifier).
Lint and the full suite pass. Commands in §13.

**Settings not yet done (check on Render):** `ADMIN_USER_IDS`; `SMTP_*` email; the `/api/*` rewrite on the static site (Safari sign-in cookies, `docs/SECURITY.md`).

**Known limits:**
- the classifier is regex-based: a bullet like "Search engines index pages…" is still read as a step; "explanation" is decided by length; no confidence score;
- no code-output or calculation MCQs; no rule-written derivation questions;
- Groq's theory "prefer non-MCQ material" is a prompt instruction only;
- difficulty labels and BKT parameters are defaults, not fitted to data;
- concept names from the AI are free text, so a synonym can slip past the repeat check;
- meaning-level duplicate detection and relevance filtering are off on Render (no model);
- in-memory locks assume one server instance; no circuit breaker, so a Groq outage costs up to ~45 s per build before the rules take over;
- without the AI, theory answers in other words or another language can lose marks (a re-mark later fixes it);
- the free server sleeps and is slow on sign-in bursts.

**Open decisions for the team:** age policy (18+ or parental consent: India's DPDP Act, Groq's terms); a privacy policy and terms; whether to restrict sign-up to students; a closed beta with 20-30 students and the rated quality study.

---

## 12. Next steps (suggested order)

1. Apply, push and merge `fix/classifier-and-reports` (§13); check a live test build.
2. Set `ADMIN_USER_IDS` and the `SMTP_*` email settings; schedule `npm run db:backup`.
3. Classifier follow-ups (`suitability.js`, `testEngine.js`): store each question's source kind (`sourceKind`) and show counts on the admin page; enforce at least one theory-only-form question when Groq writes the theory section; causal-connector rule for "explanation"; a `derive` theory form; evaluate the classifier on a hand-labelled sentence set (as `LINK_EVALUATION.md` did for links).
4. Groq circuit breaker in `llm.js` (pause the AI for a while after a daily-limit 429, quota or auth error) and JSON mode (`response_format`).
5. Run the blind question-quality study (`docs/EVALUATION.md`) with real notes and two raters.
6. Closed beta with 20-30 students; decide the age and consent policy first.
7. Calibrate difficulty from answers (per-question correct rate) and fit BKT parameters once enough answers are logged.
8. Mark theory answers by meaning with a local model, so marking stays fair without Groq.
9. Platform: a paid instance or native bcrypt for sign-in bursts, a shared lock/rate-limit store, a CAPTCHA at sign-up.

---

## 13. Practical notes for whoever picks this up

### Applying a patch delivered by an AI session (PowerShell, one per line)

Patches land in `D:\fy\capstone\MindAtlas`. For the pending work:

```
cd D:\fy\capstone\MindAtlas
git checkout main
git pull
git checkout -b fix/classifier-and-reports
git am --3way classifier-and-reports-fix.patch
git am --3way handover-update.patch
cd server
npm install
npm test
cd ..
git push -u origin fix/classifier-and-reports
Remove-Item classifier-and-reports-fix.patch
Remove-Item handover-update.patch
```

Then open a pull request on GitHub, wait for CI to go green, and merge; Render redeploys from `main`.

- If `git am` stops: `git am --abort`, then ask for a fresh patch against the current `main`.
- `git stash` saying "No local changes to save" is fine - carry on with the next command.
- Pulling with local changes: `git stash`, then `git pull`, then `git stash pop`.
- After pulling, run `npm install` in both `server` and `client`.

### Conventions

- **Branches:** a short-lived feature branch per change (`notes/…`, `graph/…`, `quiz/…`, `infra/…`, `fix/…`), a pull request, CI green, merge. Never push straight to `main`.
- **Line endings:** files on the Windows machine use CRLF.
- **Fixtures:** `.gitattributes` marks `server/test/fixtures/*` as binary, so patches need `git format-patch --binary`.
- **Changing an AI prompt:** bump its version in `llm.js` `PROMPT_VERSIONS`.
- **Changing a classification rule** (`suitability.js`): add the sentence to the cases table in `contentSuitability.test.mjs` with its expected kind, and keep both writers going through `mcqSourceProblem`.
- **Changing linking rules:** run the relink tool afterwards (DEPLOY.md).
- **Adding a field that holds an id:** store and query it as a string; add a case to `mongoStore.test.mjs`.
- **Logs:** counts and kinds only - never note text, answers, keys or emails.
