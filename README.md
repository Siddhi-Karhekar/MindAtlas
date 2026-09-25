# Mind Atlas

A capstone project that turns a student's notes into a knowledge graph and
then into adaptive, grounded tests with deterministic feedback:

sign up → create a subject → add notes (typed or scanned via OCR) → Mind
Atlas links related notes into a graph → build a test from selected notes →
take it one adaptive question at a time → see which topics need attention.

The larger design lives in `Mind_Atlas_System_Design_Architecture.docx`; this
repo is the working implementation of its core loop. The test-generation and
feedback workstream is assessed in
[`docs/Test_Generation_Feedback_Feasibility_Report.docx`](docs/Test_Generation_Feedback_Feasibility_Report.docx).
Team roles and branch conventions are in [`CONTRIBUTING.md`](CONTRIBUTING.md).

> **Prototype scope for this week's submission:** the adaptive testing
> pipeline below runs on plain rule-based logic only (no Bayesian Knowledge
> Tracing, no IRT/logistic-regression calibration) while the team finishes
> notes ingestion and the knowledge graph's cross-subject disambiguation.
> See [`CONTRIBUTING.md` §0](CONTRIBUTING.md#0-saturday-prototype-scope--read-this-first)
> for the exact scope and build order.

## What works today

**Notes and knowledge graph**
- Email/password auth (bcrypt + JWT), subjects, and notes from four input
  paths: typed text, an uploaded image (read with Tesseract OCR), a PDF, or
  a Word (.docx) file — all four wired end to end, backend and upload UI.
- Every new note gets a TF-IDF vector and top keywords; cosine similarity
  against the other notes in the *same* subject creates weighted graph edges
  (threshold 0.12), rendered with Cytoscape.js.
- Notes are also compared across a student's subjects, under a stricter rule
  so a word used in two senses ("cell" in Biology, Chemistry and Computer
  Networks) doesn't link unrelated notes: a cross-subject edge needs **at
  least two** shared top keywords **and** similarity of at least 0.25. A pair
  that shares a keyword but fails that rule is stored as `rejected` and shown
  on the graph page under "Considered, not linked", so the disambiguation is
  visible. Other subjects' linked notes appear as faded nodes.
- A student can remove a link they think is wrong (and undo or restore it
  later) from the graph page; a removed link stays removed even as new notes
  are added, and no longer counts anywhere.
- Each note has a keyword map: the note in the middle, its keywords around
  it (bigger = more important to the note); opening a keyword shows the
  words it appears with, the sentences that use it, and the other notes in
  the subject that share it.
- Notes linked directly or through a chain of links form a cluster
  (connected components - a stand-in for Louvain community detection). The
  graph page can colour notes by cluster, labelled with shared keywords.

**Tests, attempts and feedback**
- **Grounded question generation** - MCQ and theory (short-answer) questions,
  in any mix. With a `GROQ_API_KEY` an LLM drafts them from the selected
  notes only; every question must quote a supporting excerpt that appears
  verbatim in those notes (the "hallucination gate") or it is discarded.
  Without a key, a rule-based fallback builds cloze MCQs and
  explain-the-keyword theory questions from TF-IDF keywords.
- **Adaptive delivery** - each test builds a pool about 1.5x larger than
  what a student sees; a 1-up-1-down staircase over easy/medium/hard tiers
  picks the next question one at a time, in a timed "focus mode".
- **Grading** - MCQs are scored instantly; theory answers are graded at
  submission (LLM meaning-based score, or keyword-overlap fallback), 0 to 1.
- **Feedback** - a deterministic per-topic
  `attentionScore = 0.7 x (1 - accuracy) + 0.3 x normalizedTime` ranks topics
  weakest-first, with total marks. An LLM (or a template) only *phrases* the
  already-fixed ranking; it never influences it.
- **Integrity** - answer keys, excerpts and rubrics are never sent to the
  client mid-attempt; an attempt only accepts an answer for the question it
  is currently waiting on, answers are final, and correctness is revealed
  only after submission.

Every LLM-backed step degrades gracefully to a deterministic or template
path, so the whole app runs with no API key at all.

## Stack

- **client/** - React (Vite) + Tailwind CSS + React Router; Cytoscape.js for
  the graph.
- **server/** - Node.js + Express REST API.
- **Database** - no setup required. With no `MONGODB_URI` the server uses a
  small built-in in-memory database (data resets on restart). Set
  `MONGODB_URI` in `server/.env` to use MongoDB Atlas - same API, no code
  changes. See "Why not mongodb-memory-server?" below.

## Running it locally

Requires Node.js 18+.

```bash
# terminal 1 - API
cd server
npm install
npm run dev        # listens on http://localhost:4000

# terminal 2 - frontend
cd client
npm install
npm run dev        # opens on http://localhost:5173
```

Open http://localhost:5173, create an account and a subject, add a couple of
notes on related topics (they connect on the "Knowledge graph" page), then
open "Tests" to build and take a test.

The database-backend checks run with no servers and no MongoDB needed:

```bash
cd server && npm test
```

These exercise the real MongoDB wrapper against a stand-in collection that
matches values **type-sensitively**, the way a real server does. That is the
one behaviour the in-memory dev store cannot reproduce (it compares with
`String()` on both sides), so it is where id-type bugs get caught without a
live Atlas cluster. See "One id type everywhere" below.

The end-to-end browser checks in `verify/` (Playwright, Python) run against
the two dev servers above:

```bash
pip install playwright && playwright install chromium
python verify/e2e_adaptive_test.py     # screenshots land in verify/
python verify/e2e_mixed_test.py
# different frontend URL:  MINDATLAS_URL=http://localhost:4173 python ...
```

## Configuration

Copy `server/.env.example` to `server/.env` and `client/.env.example` to
`client/.env.local`. Every server variable is optional in development:

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | MongoDB Atlas connection string; blank = in-memory dev DB |
| `JWT_SECRET` | 32+ random characters. **Required in production** (server refuses to start without it); dev falls back to an insecure default with a warning |
| `GROQ_API_KEY` | Enables LLM question drafting, theory grading and feedback phrasing |
| `NODE_ENV` | Set to `production` when deployed |
| `CORS_ORIGIN` | Comma-separated allowed browser origins. Blank in dev allows `localhost:5173`; blank in production blocks cross-origin browser access |
| `TRUST_PROXY` | Reverse-proxy hop count (`1` on most hosts) so rate limiting sees real client IPs |
| `RATE_LIMIT_*` | Optional per-IP limits per 15 minutes (API 600, auth 30, test builds 20) |

`client/.env.local` takes `VITE_API_BASE` if the API isn't on
`localhost:4000`.

## Why not mongodb-memory-server?

The usual zero-setup MongoDB for dev (`mongodb-memory-server`) downloads a
real `mongod` binary on first run, which was blocked in the sandbox this
project started in. `server/src/db/` instead implements a tiny MongoDB-shaped
interface (`insertOne` / `findOne` / `find` / `findOneAndUpdate`) with two
interchangeable backends - `memoryStore.js` (in-memory) and `mongoStore.js`
(the official driver, for Atlas) - selected in `db/index.js` by whether
`MONGODB_URI` is set.

## One id type everywhere

Every id in the API is a plain 24-hex string, on both database backends. The
MongoDB store generates them itself (`db/ids.js`) instead of letting the
driver assign BSON `ObjectId`s.

This matters more than it looks. MongoDB's equality matching is
type-sensitive, so the string `"507f..."` does not match `ObjectId("507f...")`.
Mixing the two means a query silently matches nothing and returns `null`
rather than raising an error - and because the in-memory dev store compares
with `String()` on both sides, it treats them as equal and the mismatch never
shows up locally. Keeping a single id type removes the whole class of bug.

If you add a field holding an id, store it and query it as a string, and add
a case to `server/test/mongoStore.test.mjs`.

## What's next

1. **Bayesian Knowledge Tracing** - per-topic mastery that accumulates across
   attempts instead of a single-attempt snapshot (the feasibility report's
   top recommendation). Implemented in `services/masteryEngine.js`, but
   swapped out for a plain rolling-accuracy rule for this week's prototype
   (see CONTRIBUTING.md §0) - reinstate it once the prototype is submitted.
2. **Notes summarization and textbook linking** - PDF/DOCX/OCR ingestion
   itself is done (see "What works today" above); summarization and
   textbook-linked context are the remaining pieces.
3. **Better graph, phase 2** - real sentence embeddings in place of TF-IDF
   vectors (a contained change to `services/tfidf.js`) and true Louvain/Leiden
   community detection in place of this week's connected-components stand-in,
   plus feeding students' link corrections back into the linking rule.
   Rule-based cross-subject disambiguation, clustering and removing a wrong
   link are already in (see "What works today").
4. **Test timer** - `durationMinutes` is stored and shown but not yet
   enforced with a countdown in the attempt screen.
5. **Quality upgrades from the report** - distractor gating for the LLM path,
   TextRank keywords, fuzzy (non-verbatim) excerpt matching, stricter theory
   grading prompt, calibrated Rasch difficulties once there is response data.
6. **Optional proctoring** and splitting the API into independently
   deployable services.
7. **Deployment** - Dockerfiles, docker-compose, CI (lint, build, tests,
   `npm audit`, secret scan) and hosting configs.
8. **Production hardening still open** - the API now has a CORS allowlist,
   per-IP rate limiting, a hard failure on a missing production
   `JWT_SECRET`, and basic security headers; consider `helmet`, a shared
   rate-limit store for multi-instance deploys, and secret rotation.

## Project layout

```
server/src/
  db/            in-memory + real-MongoDB backends behind one interface
  models/        thin repositories (users, subjects, notes, graph_edges,
                 tests, questions, attempts, responses, feedback_reports)
  middleware/    JWT auth, in-memory rate limiter
  routes/        auth, subjects (+ graph), notes, tests, attempts
  services/      ocr, tfidf, graphEngine, llm, testEngine (question
                 generation + gate), adaptiveEngine (staircase),
                 gradingEngine (theory answers), feedbackEngine (scoring)

client/src/
  lib/           API client + auth context
  components/    shared app shell (nav, sign-out)
  pages/         SignIn, Home, SubjectWorkspace, KnowledgeGraph,
                 Tests (builder), TestAttempt (focus mode), Insights

verify/          Playwright end-to-end scripts + their screenshots
docs/            feasibility report
```
