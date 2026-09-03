# Mind Atlas

A working vertical slice of the Mind Atlas capstone: sign up → create a
subject → add notes (typed or scanned via OCR) → watch Mind Atlas
automatically link related notes into a knowledge graph you can see.

This is deliberately the first slice, not the whole system described in
`Mind_Atlas_System_Design_Architecture.docx`. It proves the core loop end
to end with real, running code. Test-taking, proctoring, and the
feedback/recommendation engine are not built yet - see "What's next" below.

## Stack

- **client/** - React (Vite) + Tailwind CSS + React Router. Renders the
  knowledge graph with Cytoscape.js, matching the architecture doc.
- **server/** - Node.js + Express REST API. JWT auth, notes ingestion +
  OCR (tesseract.js), and the knowledge-graph pipeline (TF-IDF keyword
  extraction + cosine-similarity edge scoring).
- **Database** - no setup required out of the box. With no `MONGODB_URI`
  configured, the server uses a small built-in in-memory database (see
  "Why not mongodb-memory-server" below) so you can run everything
  immediately. Data resets whenever the server restarts. Set
  `MONGODB_URI` in `server/.env` to point at a real MongoDB Atlas cluster
  any time - no code changes needed, same API either way.

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
npm run dev         # opens on http://localhost:5173
```

Open http://localhost:5173, create an account, create a subject, and add
a couple of notes on related topics - you'll see them connect on the
"Knowledge graph" page.

## Going from dev to real infrastructure

Copy the `.env.example` files to `.env` in both `server/` and (as
`.env.local`) `client/`, then fill in:

- `server/.env` → `MONGODB_URI` (MongoDB Atlas connection string),
  `JWT_SECRET` (any long random string), `GROQ_API_KEY` (for the
  LLM-drafted test questions feature, not used by this slice yet).
- `client/.env.local` → `VITE_API_BASE` if the API isn't on
  `localhost:4000`.

## Why not mongodb-memory-server?

The usual way to get a zero-setup MongoDB for local dev
(`mongodb-memory-server`) downloads a real `mongod` binary from
mongodb.org on first run. That download is blocked in the sandboxed
environment this project was built in, so `server/src/db/` instead
implements a tiny MongoDB-shaped interface
(`insertOne`/`findOne`/`find`/`findOneAndUpdate`) with two
interchangeable backends: an in-memory one (`memoryStore.js`, zero
setup) and a real one (`mongoStore.js`, the official `mongodb` driver
talking to Atlas). `server/src/db/index.js` picks one based on whether
`MONGODB_URI` is set. On your own machine you're free to install
`mongodb-memory-server` or a local MongoDB instead if you'd rather - the
interface in `db/index.js` is the only place that would need to change.

## What's next

Roughly in the order the architecture doc's own diagrams suggest:

1. **Diagram 3 - Test → proctor → feedback.** Test builder UI +
   LLM-drafted questions (Groq) grounded in a subject's notes, adaptive
   difficulty, and the deterministic feedback-scoring engine.
2. **Swap the TF-IDF similarity vector for a real sentence embedding**
   (e.g. `@xenova/transformers` running MiniLM in Node - no Python
   needed) - the note schema and similarity code are already shaped so
   this is a one-file change (`server/src/services/tfidf.js` /
   `graphEngine.js`).
3. **Cross-subject term disambiguation** (Section B.3 of the deep-dive
   doc) - currently notes only link within their own subject.
4. **Video proctoring & expression analysis service.**
5. **Split into the five independently-deployable microservices** the
   architecture describes - right now notes ingestion, OCR, and the
   graph engine are cleanly separated modules inside one API for
   simplicity, but nothing about the code shape blocks pulling any of
   them out into their own service later.
6. **Auth hardening for production**: rate limiting, CORS allowlist,
   security headers, real secret rotation - `server/.env.example` calls
   out where these plug in.

## Project layout

```
server/src/
  db/            in-memory + real-MongoDB backends behind one interface
  models/        thin repositories (users, subjects, notes, graph_edges)
  middleware/    JWT auth
  routes/        auth, subjects, notes (+ nested graph endpoint)
  services/      OCR, TF-IDF/similarity, graph-edge creation

client/src/
  lib/           API client + auth context
  components/    shared app shell (nav, sign-out)
  pages/         SignIn, Home, SubjectWorkspace, KnowledgeGraph
```
