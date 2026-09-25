# Working as a 4-person team on Mind Atlas

This maps your four roles onto the codebase that's already running (see
root `README.md` for what exists today), and lays out how to divide work
so four people can build in parallel without constantly blocking on each
other or fighting merge conflicts.

## 0. Saturday prototype scope — read this first

This week's target is a submittable **prototype**, not the full system
described in Section 3 below. Two scope decisions for the prototype only —
the rest of this file stays the long-term plan, resume it after Saturday:

**No probabilistic/statistical models for now.** No Bayesian Knowledge
Tracing, no IRT, no logistic-regression difficulty calibration. Concretely:

- `adaptiveEngine.js`'s within-attempt staircase (1-up-1-down across
  easy/medium/hard) is *already* plain rule-based — keep it as is, just
  strip the "IRT-inspired" framing from its comments/docs so nobody has to
  defend a statistical model this build doesn't have calibration data for.
- `masteryEngine.js`'s Bayesian Knowledge Tracing update is the one part
  that's genuinely probabilistic (a Bayes-rule posterior, `pKnown`). Replace
  it with a deterministic rule: track `correctCount` / `totalCount` per
  topic and use plain accuracy (`correctCount / totalCount`) everywhere
  `pKnown` is read today. Reuse the existing cut points unchanged
  (`accuracy < 0.4` → easy, `> 0.75` → hard, else medium) and the existing
  `MIN_OBSERVATIONS_TO_ADAPT = 3` guard — only the number's meaning changes,
  not the surrounding logic, which keeps this a contained, low-risk swap.
  Full details are in the prompt used to build this (ask whoever ran it, or
  see `docs/Test_Generation_Feedback_Feasibility_Report.docx` §5's Future
  Scope for why BKT is deferred rather than dropped for good).

**Build order — don't start the next step until the previous one is tested
end to end:**

1. **Notes ingestion.** Verify text, OCR, PDF and DOCX all work reliably —
   this is mostly *already built* (both backend and the `NoteEditor.jsx`
   upload UI accept all four), so this step is testing and hardening, not
   new construction. See Member 1's section below for the checklist.
2. **Knowledge graph, with ambiguity handling.** The real gap: today's
   `graphEngine.js` only links notes within the same subject. See Member 2's
   section below for the specific rule-based disambiguation to add.
3. **Rule-based test-taking.** Mostly the mastery-engine swap described
   above, plus removing IRT/BKT language from anything user-facing. See
   Member 3's section below.

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

**Prototype status (updated):** typed notes, image OCR (tesseract.js), and
PDF/DOCX ingestion (`services/documentText.js`, using `mammoth` for DOCX and
`pdfjs-dist` for PDF — not `pdf-parse` as originally planned) are all built
and wired end to end, backend and `NoteEditor.jsx` frontend both. **For
Saturday, this step is verification, not new construction:** upload one real
file of each type (a clean PDF, a scanned/photographed page, a `.docx`, a
plain `.txt`/`.md`) into a subject and confirm each produces a usable note
with sane extracted text. Check the edge cases the code already tries to
handle gracefully: a password-protected or corrupt PDF, a photo with no
readable text (OCR returns empty), a file over the 10MB limit. Fix anything
that breaks silently rather than returning the error message it's designed
to show.

What's missing (post-Saturday backlog, not this week):
1. **Summarization** — a new endpoint that takes a note's raw text (or a
   linked textbook chunk) and returns an LLM-generated summary via the
   Groq API. Ground it the same way Diagram 3's question drafting is
   grounded in the architecture doc: the summary prompt should only be
   allowed to use the note's own extracted text as context, never
   open-domain — that's what keeps it from hallucinating facts that
   aren't in the source material.
2. **Textbook linking** — the `textbooks` collection from the schema
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

**Prototype requirement for Saturday — this is the biggest real gap, and
the one place this week's plan asks for something genuinely new.** Keep it
rule-based (no MiniLM download, no external graph library — both are
post-Saturday backlog, item 1 below):

1. **Cross-subject linking, with disambiguation.** Right now
   `updateGraphForNote()` only compares a new note against others in the
   *same* subject. Extend it to also compare against the user's notes in
   *other* subjects — but guard against false matches (e.g. "cell" in a
   Biology note and "cell" in a Computer Networks note): only create a
   cross-subject edge when a pair clears **both** of two conditions, not
   either alone:
   - shares at least one top-12 TF-IDF keyword (from `computeTfidf()`'s
     `keywords` array), **and**
   - clears a *stricter* cosine-similarity threshold than the same-subject
     one — e.g. `0.25` vs the existing `0.12` — so two notes that are only
     coincidentally using the same word, but are otherwise topically
     unrelated, don't get linked just because they share that one token.
     A pair that shares a keyword but fails the stricter threshold is the
     "ambiguous" case: log it (or store it with `edgeType: "rejected"`) so
     it's visible in a demo that the system is actually distinguishing
     senses, not just skipping the check.
   - Tag every edge with `edgeType: "same-subject"` or `"cross-subject"` in
     `models/GraphEdge.js` so the graph UI and any writeup can show the
     distinction.

   **Status: done** (branch `graph/cross-subject-disambiguation`), with one
   change to the rule above: a cross-subject edge needs **two** shared
   keywords, not one. Tested on real notes, the one-keyword version still
   linked Biology "Cell structure" to Chemistry "Electrochemical cells"
   (similarity 0.252, sharing only "cell") - one word repeated often enough
   in both notes lifts the similarity past 0.25 on its own. A `rejected` edge
   is stored only when the pair would have passed the same-subject threshold
   (0.12), so the list shows genuinely ambiguous pairs rather than every
   coincidental shared word. The graph API keeps `nodes`/`edges` meaning
   same-subject only (Home, the subject page and the note editor read them)
   and adds `crossSubjectEdges`, `rejectedEdges` and `externalNodes`; note
   creation's `edgesCreated` also stays same-subject, with
   `crossSubjectEdgesCreated` alongside it. Tests:
   `server/test/graphEngine.test.mjs` (part of `npm test`).
2. **Lightweight clustering as a Louvain stand-in.** Full community
   detection is post-Saturday backlog (item 3 below); for the prototype, a
   plain connected-components pass over each subject's notes+edges (BFS or
   union-find, no dependency needed) is enough to group related notes and
   is easy to explain as "notes connected directly or through a chain of
   shared topics form one cluster." Surface `clusterId` per note from
   `/api/subjects/:id/graph` so `KnowledgeGraph.jsx` can optionally color by
   cluster — nice for the demo, but treat the coloring itself as optional
   if time runs short; the clustering data being correct matters more than
   the visual.

   **Status: done** (same branch). `clusterNotes()` in `graphEngine.js` is a
   union-find pass over the subject's same-subject edges, computed on every
   graph request rather than stored, so clusters never go stale. Each node
   gets a `clusterId`, and the response adds `clusters: [{ id, size,
   keywords }]` - numbered from 1 largest-first, so the same notes always get
   the same numbers; `keywords` are up to three shared by 2+ of its notes.
   Cross-subject links do not merge clusters (a cluster is a group within one
   subject). The graph page has a "Colour by: Links | Clusters" switch
   (default Links, so nothing changes until it is used). Only the three
   largest clusters get their own colour - the most that stay
   colour-blind-distinguishable when any two can sit side by side - and the
   rest share an "Other clusters" grey; every node also shows its cluster
   number (C1, C2...) so colour is never the only cue.

Post-Saturday backlog (do not start before the two items above are done and
tested):
1. **Real sentence embeddings** — swap the TF-IDF vector for a MiniLM
   embedding from `@xenova/transformers` (runs in Node, no Python, no
   GPU). `computeTfidf()`'s signature (`text -> {vector, keywords}`) is
   the only contract the rest of the app depends on, so this is a
   contained change to `tfidf.js` plus whatever's needed to keep
   `cosineSimilarity()` working on the new vector shape.
2. **Real Louvain/Leiden community detection** in place of the
   connected-components stand-in above, and the **correction loop**: a
   `POST /api/graph/edges/:id/correct` route (already named in the
   deep-dive doc's route table) that lets a student fix a mislinked edge
   and feeds that correction back into the scoring — even a simple
   logistic-regression refit is enough to match the architecture's intent.

   **Status: first half done** (branch `graph/remove-wrong-link`). The route
   exists: `POST /api/graph/edges/:id/correct` with `{ action: "remove" }`
   or `{ action: "restore" }`. A removed link is flagged
   (`correction: "removed"`), never deleted, and the linker never overwrites
   that flag, so a new note can't bring it back. Removed links drop out of
   `edges`, the cross-subject lists, clusters and every count, and are
   listed in the graph response's `removedEdges` so the graph page can offer
   Undo / Restore. Ownership is checked on the two notes an edge joins
   (edges have no owner field); someone else's link is a 404. Still open:
   feeding corrections back into the linking rule itself.

### Member 3 — Test generation & feedback
**Owns:** `server/src/routes/tests.js`, `server/src/routes/attempts.js`,
`server/src/services/testEngine.js`, `adaptiveEngine.js`, `gradingEngine.js`,
`feedbackEngine.js`, and `client/src/pages/Tests.jsx` / `TestAttempt.jsx` /
`Insights.jsx`.

**Status:** steps 1-4 below are built and verified end to end (grounded MCQ
and theory generation with the hallucination gate, an adaptive staircase
attempt flow, deterministic per-topic feedback). Cross-attempt mastery
(`masteryEngine.js`) currently uses Bayesian Knowledge Tracing, per the
feasibility report's top recommendation — **for the Saturday prototype,
replace it with the plain rule-based version described in Section 0 above**
(rolling accuracy per topic instead of a Bayesian posterior; same cut points
and observation guard, so `adaptiveEngine.js` and `feedbackEngine.js` don't
need to change). Keep BKT as the documented post-prototype upgrade, don't
delete the reasoning for it — just don't ship it running this week. Still
open after that: a countdown timer that enforces `durationMinutes` and
optional webcam proctoring (both unrelated to this swap, lower priority for
Saturday). The original build order, following Diagram 3 in the deep-dive
doc, is kept below for reference:
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
