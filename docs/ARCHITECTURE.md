# Architecture

A one-page map for a new teammate (or a fresh AI session): what runs where,
how a request flows, and where to change things. Details live in the files
named here and in [`ASSESSMENT.md`](ASSESSMENT.md), [`SECURITY.md`](SECURITY.md)
and [`EVALUATION.md`](EVALUATION.md).

## Pieces

| Piece | Where | What |
| --- | --- | --- |
| Web app | `client/` (React 19, Vite, Tailwind) | Pages in `src/pages`, shared parts in `src/components`, the one API client in `src/lib/api.js`. |
| API | `server/src` (Node 22, Express 4) | `index.js` wires middleware and routes; `routes/` are thin; the work is in `services/`; storage in `models/`. |
| Database | MongoDB Atlas in production; a JSON file (or memory) locally | Both behind the same small interface (`db/mongoStore.js`, `db/memoryStore.js`). |
| AI (optional) | Groq, or any OpenAI-compatible API | Only through `services/llm.js`. Everything has a rule-based fallback, so the app works with no AI key. |
| Hosting | Render, one service | The API also serves the built web app. `render.yaml`, [`DEPLOY.md`](../DEPLOY.md). |

## The main flows

```
upload a note ──> routes/notes.js
                    ├─ middleware/upload.js + services/uploadCheck.js   (what the file really is, size limits)
                    ├─ services/extractInWorker.js -> documentText.js    (text out of PDF/Word/slides; OCR for photos)
                    ├─ services/documentStructure.js                     (headings -> one note per subtopic)
                    ├─ services/tfidf.js, keyTerms.js                    (key terms)
                    └─ services/graphEngine.js                           (links to related notes = the knowledge graph)

build a test ───> routes/tests.js -> services/testEngine.js
                    (questions only from the chosen notes; each quotes its source;
                     no repeats; exam pattern: marks per type, negative marking, sections)

take a test ────> routes/attempts.js
                    ├─ services/adaptiveEngine.js   (next question: difficulty steps, the MCQ/theory mix)
                    ├─ services/gradingEngine.js    (theory marking against the rubric)
                    ├─ services/feedbackEngine.js   (marks, per-topic ranking, the written feedback)
                    └─ services/masteryEngine.js    (per-topic mastery across attempts: BKT)
```

## Rules that hold everywhere

- **Every route is owner-checked.** A record is looked up by id *and* owner.
  Routers are made with `middleware/safeRouter.js`, so an async error reaches
  the error handler instead of crashing the server.
- **Every input is checked** (`middleware/validate.js`); nothing a client
  sends goes to the database unchecked.
- **Student text is data, not instructions,** for the AI (`llm.js asData`).
- **Nothing the AI says is trusted alone:** questions must quote the notes,
  marks are checked against the key points, the ranking is fixed before the
  AI words it.
- **Logs never hold notes, answers or email addresses** (`services/log.js`).
- **Tests are snapshots:** editing or deleting a note never changes a test
  or a past result (`services/noteLifecycle.js`).

## Where to change things

| To change | Look in |
| --- | --- |
| How questions are written | `services/testEngine.js` (bump the version in `llm.js PROMPT_VERSIONS` when an AI prompt changes) |
| How answers are marked | `services/gradingEngine.js` |
| What a student sees after a test | `client/src/pages/Insights.jsx`, `components/AnswerReview.jsx` |
| The test screen | `client/src/pages/TestAttempt.jsx` |
| A limit (rate, size, storage) | `server/src/index.js`, `routes/notes.js`; all are settings in `server/.env.example` |
| The AI provider or model | settings only: `LLM_API_URL`, `LLM_MODEL`, `GROQ_API_KEY` |

## Checks

`cd server && npm run lint && npm test` (about 900 checks, a few minutes),
`cd client && npm run lint && npm run build`, and the browser scripts in
`verify/`. CI runs the first two on every push. `npm run load-test` in
`server/` measures many students at once (never against the live site).
