# Working as a 4-person team on Mind Atlas

This maps your four roles onto the codebase that's already running (see
root `README.md` for what exists today), and lays out how to divide work
so four people can build in parallel without constantly blocking on each
other or fighting merge conflicts.

## 1. Get a shared repo first

Everything so far has been built in one place. Before anyone writes new
code, turn this into a real shared repository so all four of you are
working off the same history:

1. One person creates an empty repo on GitHub (or GitLab) — call it
   `mind-atlas`. Don't let GitHub add a README/.gitignore, since this
   project already has both.
2. In the `MindAtlas` folder on your machine:
   ```bash
   git remote add origin <your repo URL>
   git push -u origin main
   ```
3. Everyone else clones it: `git clone <repo URL>`.
4. Protect `main` in the repo settings (require a pull request before
   merging, at minimum). Nobody pushes straight to `main` — see the
   branch workflow below.

## 2. Branch convention

One branch per person per piece of work, named `<role>/<short-description>`:

```
notes/summarization
notes/pdf-docx-ingest
graph/real-embeddings
graph/cross-subject-disambiguation
tests/question-generation
tests/feedback-engine
infra/dockerfiles
infra/ci-pipeline
```

Open a pull request into `main` when a piece is working end to end
(build passes, you tested it manually). Small, frequent PRs beat one
giant branch per person — easier to review, easier to unstick if
something's broken.

## 3. Who owns what

### Member 1 — Notes ingestion & summarization
**Owns:** `server/src/routes/notes.js`, `server/src/services/ocr.js`,
new `server/src/services/summarize.js`.

What's already there: typed notes and image-upload OCR (tesseract.js).
What's missing, in order:
1. **PDF and DOCX ingestion** — the `Note.sourceType` enum already has
   `pdf` and `docx` as options, the routes don't handle them yet. Use
   `pdf-parse` for PDFs and `mammoth` for DOCX (both pure npm, no native
   binary, no network dependency at runtime).
2. **Summarization** — a new endpoint that takes a note's raw text (or a
   linked textbook chunk) and returns an LLM-generated summary via the
   Groq API. Ground it the same way Diagram 3's question drafting is
   grounded in the architecture doc: the summary prompt should only be
   allowed to use the note's own extracted text as context, never
   open-domain — that's what keeps it from hallucinating facts that
   aren't in the source material.
3. **Textbook linking** — the `textbooks` collection from the schema
   (Section E of the deep-dive doc) isn't built yet: upload a textbook,
   chunk it, and let a note reference it so summaries and later the test
   generator can pull grounded context from it.

### Member 2 — Knowledge graph generation
**Owns:** `server/src/services/tfidf.js`, `server/src/services/graphEngine.js`,
the `/api/subjects/:id/graph` route, `client/src/pages/KnowledgeGraph.jsx`.

What's already there: TF-IDF keyword extraction + cosine-similarity
edge creation within a subject — this is deliberately a stand-in for
Diagram 2's "dual extraction" step (see the code comments in
`tfidf.js`).

What's missing, in order:
1. **Real sentence embeddings** — swap the TF-IDF vector for a MiniLM
   embedding from `@xenova/transformers` (runs in Node, no Python, no
   GPU). `computeTfidf()`'s signature (`text -> {vector, keywords}`) is
   the only contract the rest of the app depends on, so this is a
   contained change to `tfidf.js` plus whatever's needed to keep
   `cosineSimilarity()` working on the new vector shape.
2. **Cross-subject disambiguation** — right now notes only ever link
   within their own subject. Diagram 2's "term seen in another subject?"
   branch (cross-encoder re-score + word-sense check) isn't built.
3. **Louvain community detection** as a sanity pass before writing edges,
   and the **correction loop**: a `POST /api/graph/edges/:id/correct`
   route (already named in the deep-dive doc's route table) that lets a
   student fix a mislinked edge and feeds that correction back into the
   scoring — even a simple logistic-regression refit is enough to match
   the architecture's intent.

### Member 3 — Test generation & feedback
**Owns:** entirely new — `server/src/routes/tests.js`,
`server/src/services/testEngine.js`, `server/src/services/feedbackEngine.js`,
new `client/src/pages/TestBuilder.jsx` / `TestAttempt.jsx` / `Insights.jsx`.

Nothing here exists yet — this is the biggest open piece of the project.
Build order, following Diagram 3 in the deep-dive doc:
1. **Test model + builder UI** — subject, topics, MCQ/theory mix, marks,
   duration (the `tests` collection is already in the schema doc).
2. **LLM-drafted questions**, RAG-only against the subject's own notes
   (and linked textbook chunks once Member 1 has that), with the
   "hallucination gate": every candidate question must be discarded if
   its answer key isn't supported by the source passage, before a
   student ever sees it.
3. **Test-taking flow**: adaptive difficulty (an IRT-inspired staircase
   controller is enough — doesn't need to be fancy), timestamps per
   question. Webcam proctoring is the one piece explicitly designed to
   be optional in the source doc (`consentGiven` branches to a fully
   supported non-camera mode) — treat it as a stretch goal, not a
   blocker.
4. **Feedback engine** — deterministic first: fuse correctness + time
   (+ expression signal, if proctoring exists) into a per-topic score
   with a plain formula, no LLM. Only after that score exists does an
   LLM get called, and only to phrase it as readable feedback text. This
   ordering (score first, LLM narrates second) is the specific design
   decision the architecture doc calls out as what keeps the feedback
   auditable — don't invert it.

### Member 4 — Containerization & cloud
**Owns:** new — `server/Dockerfile`, `client/Dockerfile`,
`docker-compose.yml`, `.github/workflows/ci.yml`, hosting configs.

This is the most parallelizable role — it doesn't need to wait on the
other three to finish anything. Start now:
1. **Dockerfiles**: a slim multi-stage build for the Express API
   (`server/`), and a static-build + nginx (or serve) image for the
   Vite client (`client/`).
2. **docker-compose.yml** for local dev — API + client + (optionally) a
   real `mongo` container, so nobody needs the in-memory dev DB once
   this exists.
3. **CI** (GitHub Actions): lint → install → build → (as tests get added
   by the others) run tests → `npm audit` — fail the build on
   high/critical findings, per the security checklist in the deep-dive
   doc.
4. **Deploy targets**: static client to Vercel or Netlify; API + any
   split-out services to Render, Railway, or Fly.io; MongoDB Atlas for
   the real database (free M0 tier is enough for a capstone). Document
   every required env var in each service's `.env.example` — that file
   *is* the deployment contract the other three members need to keep in
   sync with as they add new env vars (`GROQ_API_KEY` is already there
   for Member 3 to use).
5. **Secrets hygiene**: confirm `.env` is git-ignored (it already is),
   add a `gitleaks` scan step to CI as a second line of defense.

## 4. The shared contracts (read this before you start)

These are the things all four of you are implicitly depending on — change
them in a PR that says so explicitly, not as a side effect of unrelated work.

- **Auth**: every route except `/api/auth/*` requires
  `Authorization: Bearer <jwt>`. `req.user = { id, email }` is set by
  `middleware/auth.js` — use it, don't re-implement auth per route.
- **Ids**: every id in the API is a plain string, 24 hex chars, whether
  the DB backing it is the in-memory dev store or real MongoDB (see
  `server/src/db/`). Never assume a Mongoose `ObjectId` — there isn't one.
- **Adding a new route file**: create it under `server/src/routes/`,
  then add one `app.use(...)` line in `server/src/index.js`. That file
  is the one place everyone's work touches — keep your addition to a
  single line to minimize merge conflicts with the other three people
  doing the same thing.
- **Env vars**: every new one goes in `server/.env.example` (or
  `client/.env.example`) in the same PR that starts using it, with a
  one-line comment saying what it's for. This file is what Member 4's
  deploy configs are built from.
- **Ports**: API on `4000`, client dev server on `5173`, both
  configurable via `PORT` / `vite.config.js` — don't hardcode either
  elsewhere.

## 5. Suggested first two weeks

Everyone can start immediately and mostly in parallel — nobody is fully
blocked on anyone else for the first stretch:

- Member 4 opens the Docker/CI PR first (it touches no shared code, so
  merge it early and it's out of everyone's way).
- Members 1 and 2 both build against the existing `Note` model — no
  new coordination needed beyond what's already documented above.
- Member 3 can start on the test builder UI and the `tests`/`attempts`
  models immediately; the LLM question-drafting step is the one part
  that benefits from Member 1's summarization landing first (better
  grounding context), so sequence that piece second if you want the
  best results, or stub it against raw note text in the meantime and
  swap the source in later.
