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
> See [`CONTRIBUTING.md` §0a](CONTRIBUTING.md#0a-saturday-prototype-scope-26-sep-2026--kept-for-reference)
> for the exact scope and build order.

## What works today

**Notes and knowledge graph**
- Email/password auth (bcrypt + JWT), subjects, and notes from four input
  paths: typed text, an uploaded image (read with Tesseract OCR), a PDF, or
  a Word (.docx) file — all four wired end to end, backend and upload UI.
- **Long documents are split into subtopics.** A multi-section PDF, Word
  file, PowerPoint deck (.pptx) or long markdown file becomes one *parent*
  note plus one *child* note per subtopic, found from the document's own
  structure: Word heading styles, slide titles, font-size headings in PDFs
  (running headers and page numbers are ignored), `#` headings in markdown,
  and - when there are no headings at all - evenly sized parts named by their
  keywords. The upload screen previews the detected subtopics first and can
  keep a file whole instead. Because questions, mastery and feedback are all
  keyed on note ids, every subtopic is its own topic: the results page says
  "Paging in Unit 3 needs attention", not just "Unit 3". Logic lives in
  `services/documentStructure.js` (splitting) and `services/documentText.js`
  (extraction); `verify/e2e_document_split_test.py` covers it end to end.
- **Subtopics keep their place in the document's outline.** Each subtopic
  records its `path` - every heading above it, outermost first
  (`["3. Data Link Layer"]`, or `["Unit 3", "Memory", ...]` for a deeper
  document) - and the notes shelf shows the document as a collapsible tree to
  any depth. Storage stays two levels (document -> subtopics), so tests,
  mastery and the graph are untouched. PowerPoint sections and "Section
  Header" slides count as a level; headings too thin to be notes of their own
  stay inside their note as sub-headings.
- **Notes keep their structure and are shown in one style.** Every note is
  stored twice: `rawText` (plain text - what keywords, links, questions and
  grading use, word for word) and `content` (the same words as headings,
  paragraphs, bulleted and numbered lists with their nesting, tables and the
  terms the author set in bold). All five inputs produce it: Word list and
  heading styles, slide outline levels, bullets / numbering / bold fonts and
  indentation in PDFs, markdown or plain typed text (`- `, `1.`, `**term**`,
  a title-like line of its own), and photos, where OCR's line positions and
  letter heights give headings and lists back. The reading pane formats it
  the same way whatever the source (`client/src/components/NoteContent.jsx`):
  each main topic has a colour that only its headings and key terms wear,
  heading size and weight follow the level, and lists get real markers.
  Rule-based throughout - no API key. Notes saved before this get their
  `content` worked out when they are read. Old `.doc` / `.ppt` files are
  refused with a "Save As .docx / .pptx" message.
- **Notes can be edited and deleted** (`services/noteLifecycle.js`). A note
  opens for editing as text - `#` headings, `-` bullets, `**key terms**` -
  whatever it was uploaded as, and saving recomputes its keywords and its
  links (links the student removed by hand stay removed). Deleting a note
  removes its links and its mastery record; a split document goes with its
  subtopics, and a subtopic can be edited or deleted on its own, with the
  document's full text rebuilt from what remains. Tests are snapshots: a
  question carries its own text, so editing or deleting a note never changes
  a test, attempt or feedback report that already exists.
- **Account controls**: change password (asks for the current one) and
  delete account, which removes every subject, note, link, test, attempt and
  progress record the account owns. There is no "forgot password" yet - that
  needs an email service.
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
  Without a key, a rule-based generator builds fill-in-the-blank MCQs and
  exam-style theory questions (see the next three points).
- **Only subject matter is asked about.** Questions are built from a note's
  *study sentences* (`services/studyText.js`): text from its paragraphs and
  list entries that states a fact. The college and department, "prepared by",
  contents pages, references, and exercises ("Write a program ...",
  "Calculate ...") never qualify. An LLM, when configured, is given only
  those sentences too.
- **Key terms are whole terms.** `services/keyTerms.js` finds a note's terms
  as phrases - "distributed computing", "two-phase locking", "Remote
  Procedure Call (RPC)" - from words that recur together, headings, bold
  type and the term a list entry opens with. A blank hides the whole term,
  everywhere in the sentence, and the wrong options are other whole terms
  matched in length, number and capitals. (TF-IDF keywords are single words,
  which is why blanks used to hide half a term; they are still what the
  knowledge graph links on.)
- **Theory questions are worded like a question paper**, with a command
  word chosen from what the note says about the term - *Define* (it has a
  defining sentence), *Explain*, *List and briefly explain* (a list under a
  heading), *Differentiate between* (two terms of the same kind) - plus the
  marks and how much to write.
- **Optional: ranking by meaning.** `npm run semantic:install` (in `server/`)
  adds a small embedding model, all-MiniLM-L6-v2, run locally through
  `@huggingface/transformers` - free, no key, no API. With it, relevance,
  term ranking and distractors are judged by meaning rather than rules
  (`services/embeddings.js`); `/api/health` reports whether it is active.
  It is an add-on on purpose: it needs about 500 MB on disk and about 125 MB
  of memory, so a default install, CI and the deploy do not include it, and
  everything works without it. `SEMANTIC_MODEL=off` switches it off.
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
  small built-in database that is saved to `server/data/mindatlas-db.json`,
  so accounts, notes, tests and progress survive restarts (the folder is
  git-ignored; delete the file to start fresh). Set `MONGODB_URI` in
  `server/.env` to use MongoDB Atlas - same API, no code changes. See "Why
  not mongodb-memory-server?" below.

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
python verify/e2e_document_split_test.py   # SPLIT_FILE=path/to/your.pdf to try your own
# different frontend URL:  MINDATLAS_URL=http://localhost:4173 python ...
```

## Deploying

See [`DEPLOY.md`](DEPLOY.md): one Render web service (the API also serves the
built client) plus a free MongoDB Atlas cluster.

## Configuration

Copy `server/.env.example` to `server/.env` and `client/.env.example` to
`client/.env.local`. Every server variable is optional in development:

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | MongoDB Atlas connection string; blank = local file database (`server/data/mindatlas-db.json`) |
| `DB_FILE` | Where the local database file lives (when `MONGODB_URI` is blank). `DB_FILE=memory` = throwaway in-memory DB, wiped on restart |
| `JWT_SECRET` | 32+ random characters. **Required in production** (server refuses to start without it); dev falls back to an insecure default with a warning |
| `GROQ_API_KEY` | Enables LLM question drafting, theory grading and feedback phrasing |
| `SEMANTIC_MODEL` | `off` disables the optional embedding model even when it is installed (`npm run semantic:install`) |
| `SEMANTIC_MODEL_PATH` | A local folder holding the model, to skip its one-time download |
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
interface (`insertOne` / `findOne` / `find` / `findOneAndUpdate` / `deleteMany`) with two
interchangeable backends - `memoryStore.js` (in memory, saved to a JSON file
between restarts) and `mongoStore.js`
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

## Evaluating question quality

`server/evaluation/` measures how good the generated questions are, for a
report: it builds questions from the same notes with the earlier TF-IDF
generator, the current rule-based one, and (if installed) the embedding
model, writes a shuffled rating sheet that hides which wrote which, and
turns the raters' sheets into scores with intervals, significance tests and
inter-rater agreement. It also computes automatic measures such as how often
a blank hides only part of a term.

```bash
cd server
npm run eval:generate -- evaluation/samples --out evaluation-output/try
# raters fill in copies of rating_sheet.csv, saved as ratings_<name>.csv
npm run eval:score -- evaluation-output/try
```

[`docs/EVALUATION.md`](docs/EVALUATION.md) has the protocol, the rating
rubric and the limits to state. No results exist yet: they need real notes
and at least two raters.

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
   fuzzy (non-verbatim) excerpt matching, stricter theory grading prompt,
   calibrated Rasch difficulties once there is response data. Whole key terms
   and meaning-based relevance are in (see "What works today"); next for the
   embedding model: grading theory answers by meaning instead of keyword
   overlap, and linking notes in the graph with it (item 3).
6. **Optional proctoring** and splitting the API into independently
   deployable services.
7. **Deployment** - a single-service Render + MongoDB Atlas setup and a
   Dockerfile are in place (see [`DEPLOY.md`](DEPLOY.md)); still open: CI
   (lint, build, tests, `npm audit`, secret scan).
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
  routes/        auth (+ password, delete account), subjects (+ graph),
                 notes (create / list), noteItems (read / edit / delete
                 one note), tests, attempts
  services/      ocr, documentText (PDF/DOCX/PPTX/text extraction, with
                 structure), documentStructure (split long documents into
                 subtopics; a note's formatted `content`),
                 tfidf, graphEngine, llm, studyText (which sentences are
                 subject matter), keyTerms (whole key terms), embeddings
                 (optional local model), testEngine (question generation +
                 gate), adaptiveEngine (staircase),
                 gradingEngine (theory answers), feedbackEngine (scoring)

client/src/
  lib/           API client + auth context; notes (outline tree),
                 noteFormat (key terms and topic colours)
  components/    shared app shell (nav, sign-out); NoteContent (the one
                 place a note's text is formatted)
  pages/         SignIn, Home, SubjectWorkspace, KnowledgeGraph,
                 Tests (builder), TestAttempt (focus mode), Insights

server/evaluation/
                 question-quality evaluation: generate.mjs (rating sheet +
                 automatic measures), score.mjs (results from the raters'
                 sheets), baseline/ (the earlier TF-IDF generator, frozen),
                 samples/ (notes for trying it)

verify/          Playwright end-to-end scripts + their screenshots;
                 fixtures/ holds sample multi-section PDF/DOCX/PPTX files
docs/            feasibility report; EVALUATION.md (evaluation protocol)
```
