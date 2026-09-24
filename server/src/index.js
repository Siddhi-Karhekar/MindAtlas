import "dotenv/config";
import express from "express";
import cors from "cors";
import { connectDB } from "./db/index.js";
import { assertAuthConfig } from "./middleware/auth.js";
import { rateLimit } from "./middleware/rateLimit.js";
import authRoutes from "./routes/auth.js";
import subjectRoutes from "./routes/subjects.js";
import noteRoutes from "./routes/notes.js";
import testRoutes from "./routes/tests.js";
import attemptRoutes from "./routes/attempts.js";
import textbookRoutes from "./routes/textbooks.js";

assertAuthConfig();

const app = express();
app.disable("x-powered-by");

// Behind a proxy (Render, Railway, Fly, nginx...) req.ip would otherwise be
// the proxy's address, which would make the rate limiter treat every user
// as one client. Set TRUST_PROXY=1 (number of proxy hops) when deployed.
if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

// CORS allowlist. CORS_ORIGIN is a comma-separated list of exact origins
// (e.g. "https://mindatlas.vercel.app"). Unset: the local Vite dev origins
// are allowed outside production, and NO cross-origin browser access is
// allowed in production. Requests with no Origin header (curl, server to
// server, same-origin) are unaffected.
const configuredOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const allowedOrigins =
  configuredOrigins.length > 0
    ? configuredOrigins
    : process.env.NODE_ENV === "production"
      ? []
      : ["http://localhost:5173", "http://127.0.0.1:5173"];

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
  })
);

// Baseline security headers (a small, dependency-free subset of what
// `helmet` would set - swap for helmet if you want the full set).
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (req, res) => res.json({ ok: true }));

// Rate limits: a generous ceiling for the whole API, a tight one on
// register/login (credential stuffing / brute force), and a tight one on
// test building since that is the endpoint that fans out to the paid LLM.
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
app.use("/api", rateLimit({ windowMs: 15 * 60_000, max: num(process.env.RATE_LIMIT_API_MAX, 600) }));
app.use(
  "/api/auth",
  rateLimit({
    windowMs: 15 * 60_000,
    max: num(process.env.RATE_LIMIT_AUTH_MAX, 30),
    message: "too many sign-in attempts, please try again later",
  })
);
app.post(
  "/api/subjects/:id/tests",
  rateLimit({
    windowMs: 15 * 60_000,
    max: num(process.env.RATE_LIMIT_TEST_BUILD_MAX, 20),
    message: "too many test builds, please try again later",
  })
);

app.use("/api/auth", authRoutes);
app.use("/api/subjects", subjectRoutes);
// notes routes are nested under /api/subjects/:id/notes
app.use("/api/subjects", noteRoutes);
// tests routes cover both /api/subjects/:id/tests and /api/tests/:id
app.use("/api", testRoutes);
// attempts routes cover both /api/tests/:id/attempts and /api/attempts/:id/...
app.use("/api", attemptRoutes);
app.use("/api", textbookRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});

const PORT = process.env.PORT || 4000;

connectDB()
  .then(() => {
    app.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
  })
  .catch((err) => {
    console.error("[server] failed to start:", err);
    process.exit(1);
  });
