import crypto from "node:crypto";

// A double tap on "Create", "Build test" or "Start" sends the same request
// twice within a moment. Without this, that makes two subjects, two tests or
// two attempts. With it, a request identical to one the same student has
// running (same route, same body, same file) waits for it and gets its
// answer, and so does one arriving up to two seconds after it finished. The
// window is kept that short on purpose: a student who deletes what they made
// and makes it again a little later must get a new one.
//
// Kept in this server process's memory, like the rate limits
// (docs/SECURITY.md): enough for a double tap, which reaches one server.

const WINDOW_MS = 2_000;
const MAX_KEYS = 5000;
// answers bigger than this (a long note's text) are shared while running but
// not kept afterwards, so memory stays small
const MAX_KEPT_BYTES = 64 * 1024;
const inFlight = new Map(); // key -> promise of { status, body }
const recent = new Map(); // key -> { at, status, body }

function keyFor(req) {
  const hash = crypto.createHash("sha256");
  hash.update(`${req.user?.id || req.ip}|${req.method}|${req.baseUrl}${req.path}|`);
  hash.update(JSON.stringify(req.body ?? null));
  if (req.file?.buffer) hash.update(req.file.buffer);
  return hash.digest("hex");
}

function remember(key, value) {
  const now = Date.now();
  for (const [k, v] of recent) if (now - v.at > WINDOW_MS) recent.delete(k); // expired ones go every time
  if (recent.size >= MAX_KEYS) recent.clear();
  if (JSON.stringify(value.body ?? null).length > MAX_KEPT_BYTES) return;
  recent.set(key, { at: now, ...value });
}

/**
 * Route middleware: answer a repeat of the same request with the first one's
 * answer. `remember: false` only shares the answer of a request still
 * running, for routes whose answer changes once it is done (starting a test
 * resumes the attempt at whatever question it has reached by then).
 */
export function once({ remember: keep = true } = {}) {
  return async (req, res, next) => {
    const key = keyFor(req);
    const done = keep && recent.get(key);
    if (done && Date.now() - done.at < WINDOW_MS) return res.status(done.status).json(done.body);
    const running = inFlight.get(key);
    if (running) {
      const first = await running;
      if (first) return res.status(first.status).json(first.body);
      return next(); // the first one failed: this one runs on its own
    }
    let settle;
    inFlight.set(key, new Promise((r) => (settle = r)));
    const send = res.json.bind(res);
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      inFlight.delete(key);
      if (value && keep) remember(key, value);
      settle(value);
    };
    res.json = (body) => {
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      finish(ok ? { status: res.statusCode, body } : null);
      return send(body);
    };
    res.on("close", () => finish(null)); // ended without an answer (an error, a dropped connection)
    next();
  };
}
