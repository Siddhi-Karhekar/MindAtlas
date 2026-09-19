// Minimal fixed-window, in-memory rate limiter - no dependency, keyed by
// client IP. Good enough for a single-instance deployment (this project's
// current shape). If the API is ever scaled to several instances, swap this
// for a shared-store limiter (e.g. express-rate-limit + Redis); the call
// sites in index.js stay the same.
//
// Behind a reverse proxy / PaaS load balancer, set TRUST_PROXY=1 (see
// server/.env.example) so req.ip is the real client and not the proxy.

export function rateLimit({ windowMs, max, message = "too many requests, please try again later" }) {
  const hits = new Map(); // ip -> { count, resetAt }

  // Drop expired entries so the map can't grow without bound. unref() so
  // this timer never keeps the process alive on its own.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) if (entry.resetAt <= now) hits.delete(ip);
  }, Math.max(windowMs, 60_000));
  sweeper.unref?.();

  return function limiter(req, res, next) {
    const now = Date.now();
    const key = req.ip || "unknown";
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - entry.count)));

    if (entry.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}
