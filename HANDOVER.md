# MindAtlas: handover

Everything a new team member, an evaluator or a future maintainer needs to understand, run, change and deploy MindAtlas. Written 17 October 2026, against `main` at `c9ec493` plus the open branch `fix-fresh-questions` (see §11).

For depth, each section points to the document that owns that topic.

---

## 1. What MindAtlas is

MindAtlas turns a student's own notes into a knowledge graph and then into adaptive, exam-style tests whose results show which topics need work.

- **Live site:** https://mindatlas.onrender.com
- **API:** https://mindatlas-api.onrender.com/api (health: `/api/health`)
- **Code:** https://github.com/Siddhi-Karhekar/MindAtlas
- **Core loop:** sign up → create a subject → add notes → related notes are linked into a graph → build a test from chosen notes → take it one adaptive question at a time → see which topics need attention → the next test targets them.

**What makes it different from asking a chatbot for a quiz:**
- every question quotes the student's own notes and is rejected if the quote is not there;
- every question is tagged to a topic, and mastery is tracked per topic across tests;
- the next test leans toward weak topics;
- the whole app works with no paid AI: every AI step has a rule-based fallback.

---

## 2. Team and ownership

A 4-person capstone. Branch conventions and working rules are in `CONTRIBUTING.md`.

| Member | Area | Main code |
| --- | --- | --- |
| Member 1 | Notes: ingestion, structure, reading, export | `services/documentText.js`, `documentStructure.js`, `noteExport/`, `noteLifecycle.js` |
| Member 2 | Knowledge graph | `services/tfidf.js`, `graphEngine.js`, `noteEmbedding.js`, `keywordMap.js`, `scripts/relink.mjs` |
| Member 3 (Siddhi) | Tests, marking, feedback, mastery | `services/studyText.js`, `keyTerms.js`, `testEngine.js`, `questionQuality.js`, `adaptiveEngine.js`, `gradingEngine.js`, `feedbackEngine.js`, `masteryEngine.js`, `revision.js`, `routes/tests.js`, `routes/attempts.js` |
| Member 4 | Containers, CI, cloud, backups | `Dockerfile`, `docker-compose.yml`, `.github/workflows/`, `render.yaml`, `DEPLOY.md`, `scripts/db-*.mjs` |

Support address shown in the app: set by `SUPPORT_EMAIL` on Render.

---

## 3. Stack at a glance

| Layer | Tools |
| --- | --- |
| Web client | React 19, Vite 8, Tailwind CSS, React Router, Cytoscape.js (graph), KaTeX (formulas, `trust: false`) |
| API | Node.js 22, Express 4 |
| Database | MongoDB Atlas (official driver); a built-in JSON-file store for local development, same interface (`server/src/db/`) |
| File reading | pdfjs-dist (PDF), mammoth (Word), JSZip (PowerPoint XML), Tesseract.js (photo OCR) |
| Downloads | pdfkit (PDF), docx (Word) |
| AI (optional) | Groq API, model `llama-3.3-70b-versatile` (Llama 3.3 70B), OpenAI-compatible endpoint |
| AI (optional, local) | all-MiniLM-L6-v2 via `@huggingface/transformers` (sentence embeddings); off on the free Render plan |
| Auth and security | bcryptjs, jsonwebtoken in an HttpOnly cookie, own security headers and CSP, rate limits, multer (uploads), nodemailer (optional email) |
| Quality | oxlint, Node test scripts, Python Playwright end-to-end scripts, gitleaks, npm audit, GitHub Actions |
| Hosting | Render (static site + web service), MongoDB Atlas free cluster, Docker |

Every id in the API is a plain 24-hex string on both database backends (README "One id type everywhere").

---

## 4. The four features and how each works

### 4.1 Notes (Member 1)

**What the student gets:**
- typed notes, or uploads of PDF, Word (.docx), PowerPoint (.pptx) and photos;
- long files split into subtopics;
- one formatted reading view with whole key terms highlighted;
- edit, delete, and download as PDF or Word.

**Workflow:**
1. **Upload and check.** Limit 10 MB; the real file type is checked, not just the name. Old .doc and .ppt files are refused with a "Save As" message.
2. **Extract text with its structure.** Extraction runs on its own thread, under a time limit.
   - PDF: pdf.js; font sizes give headings, and running headers and page numbers are dropped.
   - Word: mammoth; heading and list styles are kept.
   - PowerPoint: JSZip reads the slide XML for titles and outline levels.
   - Photo: Tesseract; line position and letter height give headings and lists back.
3. **Split into subtopics** from the document's own headings (`documentStructure.js`). With no headings, the text is cut into even parts named after their keywords.
   - Paperwork headings (batch/semester lines, "Disclaimer", "References") never become subtopics.
   - The student sees a preview of the split and can keep the file whole instead.
4. **Store twice.** `rawText` holds the plain words, used by questions and marking. `content` holds headings, paragraphs, nested lists, tables and bold terms, used for display. Each subtopic stores its `path` in the outline.
5. **Key terms** (`keyTerms.js`) are whole phrases ("data link layer", "local area network (LAN)"). They are sent as `keyTerms` with every note, and highlighted the first time each appears.
6. **Edit, delete, download.** An edit recomputes terms and links; a delete removes links and mastery. Tests are snapshots and never change. Downloads are built on the server from `content`.

No AI is used in this feature.

### 4.2 Knowledge graph (Member 2)

**What the student gets:**
- related notes linked automatically, within and across subjects;
- clusters of related notes;
- a keyword map per note;
- the power to remove a wrong link.

**Workflow** (runs when a note is saved):
1. **Vectorise.** TF-IDF against the subject's other notes, keeping the top 12 terms. Singular and plural count as one word.
2. **Link within a subject.** A pair whose cosine similarity is ≥ **0.11** is linked. This value was tuned on 117 real topics in 5 subjects (`docs/LINK_EVALUATION.md`).
3. **Link across subjects**, under a stricter rule so that "cell" in Biology does not link to "cell" in Networks.
   - With TF-IDF: ≥ 2 shared top terms and similarity ≥ 0.25.
   - With sentence embeddings (MiniLM, when available): linked by meaning instead. In the evaluation this found about 3× more of the related cross-subject pairs.
4. **Cluster.** Linked notes are grouped with **Louvain** community detection.
5. **Show.** The graph page draws the network with Cytoscape.js; a removed link stays removed.

**Relinking:** after a change to the linking rule, run `npm run relink` (DEPLOY.md "Relinking the graph"). The live site is linked by meaning by running this from a machine that has the model.

### 4.3 Tests and marking (Member 3)

Full rule list with code locations: `docs/ASSESSMENT.md`.

**Building a test:**
1. **Choose.** The student picks notes and a pattern: quick quiz, university unit test or entrance-exam style. A pattern sets marks per MCQ and per theory question, negative marking (with "Leave blank"), and whether the paper is split into sections.
2. **Pick the notes to draw from.** Weak and untested topics get more questions, based on mastery from §4.4.
3. **Keep only study sentences** (`studyText.js`).
   - Removed: titles, college and department, batch and semester lines, usage notices, acknowledgements, references, exercises, sentences containing a question, worked calculations, and text whose subscripts the PDF reader split apart ("PU e").
4. **Write the questions** with one of two writers.
   - **The AI** (Groq, Llama 3.3 70B), when a key is set.
     - The notes are passed as tagged data, kept separate from the instructions.
     - At most 24,000 characters go to the AI per request (`LLM_CONTEXT_CHARS`).
     - Each call has a 20 s time limit and one retry.
   - **The rules** (`testEngine.js`), when there is no key, or the AI fails or is over its limit. Questions take these forms:
     - MCQ, asked directly where the notes allow: "Which of the following carries data as pulses of light…?", "What does CIDR stand for?". Otherwise a fill-in-the-blank that hides a whole key term.
     - Theory: define, explain, give an example, describe how it works, advantages and limitations, differentiate, list and briefly explain.
   - Rule-written questions always queue behind the AI's, so they replace any AI question that fails or repeats.
5. **Quality gate** (`questionQuality.js`, branch `fix-fresh-questions`). Every question from either writer must pass:
   - **Grounding:** its supporting passage exists word for word in the notes, and the answer is in that passage.
   - **Context and clarity:**
     - no opening "It / This / These …" that points at an unseen sentence;
     - no leftover template text;
     - balanced quotes and brackets.
   - **MCQ:**
     - a blank hides a concept, never an article, generic word or verb;
     - exactly 4 distinct options, with the answer among them exactly once;
     - no "all / none of the above", and no option inside another;
     - no option that stands out by length or form;
     - the answer is not printed in the question;
     - no wrong option that the notes would also put in the blank.
   - **Theory:** a command word, a named subject, a model answer and key points; not vague ("Explain the differences.").

   Small faults are repaired. Everything else is stored as `discarded`, with `discardReason`.
6. **No repeats.**
   - The app keeps each student's question history.
   - Duplicates are caught by wording, by meaning (when the embedding model is on) and by concept.
   - Concepts from the last two tests give way to untested ones.
   - Earlier questions return only when the notes run out, in this order: never shown, then answered wrongly, then the rest, oldest first, with the last two tests' questions last.
   - Two tests requested at the same moment are built one after the other (`oneAtATime`).
7. **Pool and shortfall.** About 1.5× the needed questions are made for the adaptive walk. If the notes cannot supply enough, the test is shorter and the student is told.

**Taking a test:**
- **Order:** one question at a time. A **1-up-1-down staircase** over easy / medium / hard picks the next question (`adaptiveEngine.js`); its starting level comes from mastery.
- **Clock:** the server keeps it, with a 30 s grace period, and an open attempt resumes after a page refresh.
- **Integrity:** answer keys, passages and rubrics never reach the browser during an attempt. The server accepts an answer only for the question it is waiting on, and answers are final.

**Marking:**
- **MCQ:** marked at once, with negative marks if the pattern sets them. A blank scores 0 and does not count against the topic.
- **Theory:** marked at submission (`gradingEngine.js`). The AI marks on meaning, capped by the key points covered; without the AI, by key-point matching. Text that tries to address the marker is caught.
- **Review:** each answer, the correct one, key points covered or missing, and the source passage. The student can ask for a theory answer to be marked again, or report a question.

### 4.4 Feedback, mastery and progress (Member 3)

1. **Rank topics** with a fixed formula: `attentionScore = 0.7 × (1 − accuracy) + 0.3 × normalisedTime`. The AI, or a template, only words the result; it never changes the ranking.
2. **Results page:** marks out of the whole paper, the strongest topic, "focus here next", response pace, and a breakdown per subtopic. A topic with fewer than 3 answers is labelled "early sign".
3. **Mastery** with **Bayesian Knowledge Tracing** (`masteryEngine.js`). One probability per topic that the student knows it, updated after every graded answer.
   - Parameters: prior 0.25, plus learn, slip and guess rates.
   - Guess is per question type: about ¼ for a 4-option MCQ, lower for theory.
   - These are literature defaults, not fitted to data.
4. **Steering:** mastery sets how many questions each topic gets and where the staircase starts.
5. **Progress and revision** (`revision.js`):
   - mastery over time per topic;
   - a streak of days with a finished test;
   - "worth revising next": topics below 60% on enough answers, or not practised for 7 days.

---

## 5. Where the AI is used (and what happens without it)

| Step | With Groq | Without Groq (or when it fails) |
| --- | --- | --- |
| Note reading, splitting, key terms, highlighting, graph, downloads | Never uses AI | Same |
| MCQ and theory questions | Llama 3.3 70B writes them; the same quality gate applies | Rule-based writer; the same gate |
| Theory marking | On meaning, capped by key points | Key-point matching (a correct answer in other words, or mostly in Hindi or Marathi, can lose marks; re-marking with the AI later fixes it) |
| Feedback wording | AI wording of a fixed ranking | Template wording, same ranking |

**How to tell which was used:**
- After building a test, a grey line says `MCQs via LLM`, `rule-based fallback`, or `LLM and rules`.
- The results page shows "Phrased via LLM / template".
- `/api/auth/config` shows `"ai":{"enabled":true,"name":"Groq"}` when a key is set.

**Privacy:** Groq receives note text and written answers only, never names or emails. Groq's terms say it does not train on inputs (§4.2), and make the app owner responsible for users under 18 (§6.3).

**Prompt versions** (`llm.js` `PROMPT_VERSIONS`): `mcq-v3`, `theory-v3`, `grade-v3`, `remark-v2`, `feedback-v3`. Every AI-written item stores `promptVersion` and `model`. Bump a version whenever its prompt's wording changes.

**Outside services in use:**

| Service | Role |
| --- | --- |
| Groq API | The only AI API |
| MongoDB Atlas | Database |
| SMTP via nodemailer | Optional email; not set up yet |
| Hugging Face | One-time download of the MiniLM model |
| jsDelivr | Tesseract's English language file |
| Google Fonts | Website fonts |

---

## 6. Hosting and deployment

| Part | Where | Notes |
| --- | --- | --- |
| Client | Render static site `mindatlas` | Built by Vite; `VITE_API_BASE` is baked in at build time; rewrite `/*` → `/index.html` |
| API | Render web service `mindatlas-api`, free plan, Singapore | `npm ci && npm run semantic:install`, `npm start`, health `/api/health` |
| Database | MongoDB Atlas free cluster (AWS Mumbai) | 0.5 GB storage; no built-in backups on the free tier (see §8) |
| Deploy | Auto-deploy from `main` | Rollback: Render → Deploys → last good → Rollback (turns auto-deploy off until re-enabled) |
| Blueprint | `render.yaml` | Written record of the live settings; can rebuild from scratch (DEPLOY.md "Rebuilding from the Blueprint") |

**Free-plan behaviour:**
- **Sleep:** the API sleeps after 15 minutes idle; the first request after that takes about a minute.
- **Monthly hours:** each workspace gets 750 instance hours a month.
- **Memory:** RAM is 512 MB. That is why `SEMANTIC_MODEL=off` on the live site: with the model loaded, a large phone photo pushed OCR to about 576 MB and the API was killed.

### API environment settings

| Setting | Required | Live value / meaning |
| --- | --- | --- |
| `NODE_ENV` | yes | `production` (refuses to start without `MONGODB_URI`) |
| `MONGODB_URI` | yes | Atlas connection string |
| `JWT_SECRET` | yes | 32+ random characters (Render generates it) |
| `CORS_ORIGIN` | yes | `https://mindatlas.onrender.com` |
| `TRUST_PROXY` | yes | `1` |
| `GROQ_API_KEY` | optional | Set (AI on) |
| `SUPPORT_EMAIL` | optional | Set |
| `ADMIN_USER_IDS` | optional | Account ids (not emails) allowed to open `/admin` |
| `SEMANTIC_MODEL` | optional | `off` on the free plan |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `APP_URL` | optional | Not set: email confirmation and password reset are off |
| `LLM_MODEL`, `LLM_API_URL`, `LLM_TIMEOUT_MS`, `LLM_CONTEXT_CHARS` | optional | Defaults: Groq, Llama 3.3 70B, 20000 ms, 24000 characters |
| `ATTEMPT_GRACE_SECONDS`, `NOTES_MAX_*`, `RATE_LIMIT_*` | optional | Defaults are fine |

Full explanations: `DEPLOY.md` and `server/.env.example`.

---

## 7. Security and privacy (summary)

Every protection, how it was checked, and its limits are in `docs/SECURITY.md`.

- **Passwords:** ≥ 10 characters and not a common one; hashed with bcrypt; repeated wrong passwords are throttled per account.
- **Sessions:** a JWT in an HttpOnly cookie, never in browser storage. Cross-site requests are refused. Signing out or changing the password ends every session.
- **Isolation:** every query is scoped to the signed-in student; another student's records answer "not found".
- **Injected scripts:** React escapes all text, KaTeX runs with `trust: false`, and a content security policy blocks scripts.
- **Uploads:** the real file type is checked, and files are read on a separate thread under a time limit. Only text is stored, never the files themselves. Cap: 2,000 notes or 30 million characters per student.
- **Logs:** no note text, answers or emails appear in logs.
- **Admin page** (`/admin`): reported questions, suspending an account (logged with a reason), and sign-up numbers.

---

## 8. Running it locally

Requires Node.js 18+ (22 used in production). From the repo root:

```
cd server
npm install
npm run dev
```

In a second terminal:

```
cd client
npm install
npm run dev
```

- **Addresses:** the client runs at http://localhost:5173 and the API at http://localhost:4000.
- **Database:** with no `MONGODB_URI`, data is saved to `server/data/mindatlas-db.json`. `DB_FILE=memory` gives a throwaway database.
- **Settings:** copy `server/.env.example` to `server/.env`, and `client/.env.example` to `client/.env.local`.
- **Docker:** `docker compose up` runs the whole app.
- **Windows:** in cmd, use `cd /d D:\...` to change drive; in PowerShell, plain `cd D:\...`.

### Useful server scripts (`server/`)

| Command | What it does |
| --- | --- |
| `npm test` | All server test files (about 20) |
| `npm run lint` | oxlint; warnings fail |
| `npm run load-test` | 50 simulated students; last run: 280 requests/s, no errors, 150 ms median |
| `npm run semantic:install` / `semantic:check` | Install / check the MiniLM model |
| `npm run relink` | Recompute graph links with the current rules |
| `npm run eval:generate` / `eval:score` | Blind question-quality rating study (`docs/EVALUATION.md`) |
| `npm run eval:links` | Link evaluation (`docs/LINK_EVALUATION.md`) |
| `npm run db:backup` / `db:restore` | Database backup and restore (Atlas free tier has none) |

---

## 9. Testing and CI

- **CI** (`.github/workflows/ci.yml`) runs on every push, and a merge needs it green:
  - server lint and tests;
  - client lint and build;
  - `npm audit` (fails on high or critical);
  - a Docker image build;
  - a gitleaks secret scan.
- **Server tests** (`server/test/`): about 1,000 checks. Several start the real API with an in-memory database.
  - Key files for Member 3: `assessment.test.mjs`, `questionQuality.test.mjs`, `keyTerms.test.mjs`, `freshQuestions.test.mjs`, `questionPipeline.test.mjs`.
  - `mongoStore.test.mjs` needs a reachable MongoDB and fails in sandboxes without one; that is expected.
- **End-to-end** (`verify/`): Python Playwright scripts for upload, document split, mixed and adaptive tests, and across attempts.
- **Test fixtures:** `sample-notes/networks_unit2.*` (md/pdf/docx/pptx), `server/evaluation/samples/` (DBMS, distributed systems), `server/test/fixtures/ics_unit3.md` (security notes with a batch line, a usage notice and worked examples).

---

## 10. Documents in the repo

| File | What it holds |
| --- | --- |
| `README.md` | What works today, stack, configuration, layout |
| `CONTRIBUTING.md` | Team roles, branch rules, next phase per member |
| `DEPLOY.md` | Deploying, settings, email, backups, rollback, troubleshooting |
| `docs/ARCHITECTURE.md` | One-page map of the code |
| `docs/ASSESSMENT.md` | Every test, marking and feedback rule with its code location |
| `docs/SECURITY.md` | Every protection, how it was checked, limits |
| `docs/LAUNCH.md` | Pre-launch checklist: done, not applicable, open decisions |
| `docs/EVALUATION.md` | Question-quality study protocol and rubric |
| `docs/LINK_EVALUATION.md` | How the linking thresholds were chosen, with results |
| `docs/*.docx` | Feasibility reports (consolidated, and test generation and feedback) |

Also written outside the repo: a project report and an evaluation speech (Claude Docs, shared by Siddhi).

---

## 11. Current status (17 October 2026)

**Live and working:**
- all four features;
- MongoDB Atlas storage;
- Groq AI on;
- support email shown;
- graph linked by meaning, through offline relink.

**Open branch to merge:** `fix-fresh-questions` (pushed, pull request not yet merged). It contains:
- subject-matter-only questions: no batch or semester lines, usage notices, exercise questions or garbled subscripts;
- new questions on every test, with repeats ranked unseen → wrong → oldest;
- an honest "LLM / rules / mixed" label;
- the shared quality gate (`questionQuality.js`), direct-question MCQ forms and new theory forms;
- concept-aware repeats, and one test build at a time per student;
- the new tests `freshQuestions.test.mjs` and `questionPipeline.test.mjs`.

**Settings not yet done:**
- `ADMIN_USER_IDS` (check by signing in and looking for the Admin link under Settings → Account);
- `SMTP_*` email;
- the `/api/*` rewrite on the static site, which fixes sign-in cookies on Safari (`docs/SECURITY.md`).

**Known limits:**
- without the AI, theory answers in other words or another language can lose marks;
- handwriting and formulas inside PDFs and photos are not read reliably;
- the free server sleeps and is slow on sign-in bursts (password hashing shares one core);
- small notes yield few questions, by design: the app tells the student rather than padding the test;
- BKT parameters and question difficulty are defaults, not fitted;
- an occasional cross-subject meaning link is wrong (about half are right in the evaluation).

**Open decisions for the team:**
- age policy: 18+ only, or a parental-consent flow (India's DPDP Act; Groq §6.3);
- a privacy policy and terms;
- whether to restrict sign-up to students;
- a closed beta with 20–30 students and the rated quality study.

---

## 12. Next steps (suggested order)

1. Merge `fix-fresh-questions`, then check the live test builder shows the new question forms.
2. Set `ADMIN_USER_IDS` and the `SMTP_*` email settings; schedule `npm run db:backup`.
3. Run the blind question-quality study (`docs/EVALUATION.md`) with real notes and two raters; report the results.
4. Closed beta with 20–30 students; decide the age and consent policy first.
5. Mark theory answers by meaning with the local MiniLM model, so marking stays fair without Groq.
6. Compute embeddings in the browser with Transformers.js, so linking by meaning works live on the free plan.
7. Notes: summaries, flashcards, textbook linking; handwriting OCR, which needs a paid service.
8. Calibrated (Rasch/IRT) difficulty and fitted BKT parameters once enough answers are logged.
9. Platform: a paid instance or native bcrypt for sign-in bursts, a shared rate-limit store, and a CAPTCHA at sign-up.

---

## 13. Practical notes for whoever picks this up

- **Branches:** a short-lived feature branch per change (`notes/…`, `graph/…`, `quiz/…`, `infra/…`), a pull request, CI green, merge. Never push straight to `main`.
- **Line endings:** files on the Windows machine use CRLF.
- **Fixtures:** `.gitattributes` marks `server/test/fixtures/*` as binary, so patches need `git format-patch --binary`.
- **Patches:** to apply a patch file, `git am --3way <file>.patch`. If it stops, `git am --abort`.
- **Pulling with local changes:** `git stash`, then `git pull`, then `git stash pop`.
- **After pulling**, run `npm install` in both `server` and `client`, since teammates may have added packages.
- **Changing an AI prompt:** bump its version in `llm.js` `PROMPT_VERSIONS`.
- **Changing linking rules:** run the relink tool afterwards (DEPLOY.md).
- **Adding a field that holds an id:** store and query it as a string, and add a case to `mongoStore.test.mjs`.
