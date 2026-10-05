import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import { connectDB, dbInfo, flushDB } from "./db/index.js";
import { allowedOrigins, envNumber, isProduction } from "./config.js";
import { assertAuthConfig, sessionKey } from "./middleware/auth.js";
import { originGuard } from "./middleware/origin.js";
import { rateLimit } from "./middleware/rateLimit.js";
import { securityHeaders, requireHttps } from "./middleware/securityHeaders.js";
import { checkRequestShape } from "./middleware/validate.js";
import authRoutes from "./routes/auth.js";
import subjectRoutes from "./routes/subjects.js";
import noteRoutes from "./routes/notes.js";
import testRoutes from "./routes/tests.js";
import attemptRoutes from "./routes/attempts.js";
import graphRoutes from "./routes/graph.js";
import noteItemRoutes from "./routes/noteItems.js";
import { semanticStatus, warmSemanticModel } from "./services/embeddings.js";
import { mailStatus } from "./services/mailer.js";

assertAuthConfig();

// A promise nobody handled must never take the server down for everyone
// (Node's default). Routes pass their errors to the error handler below
// (middleware/safeRouter.js); this is for anything else, such as background
// work started after a response was sent.
process.on("unhandledRejection", (err) => {
  console.error("[server] unhandled rejection:", err);
});

const app = express();
app.disable("x-powered-by");

// Behind a proxy (Render, Railway, Fly, nginx...) req.ip would otherwise be
// the proxy's address, which would make the rate limiter treat every user
// as one client. Set TRUST_PROXY=1 (number of proxy hops) when deployed.
const trustProxy = (process.env.TRUST_PROXY || "").trim();
if (/^(true|yes|on)$/i.test(trustProxy)) app.set("trust proxy", 1); // "true" means one hop, not "believe any header"
else if (trustProxy && !/^(false|no|off|0)$/i.test(trustProxy)) app.set("trust proxy", Number(trustProxy) || trustProxy);
if (!app.get("trust proxy") && isProduction()) {
  console.warn(
    "[server] TRUST_PROXY is not set. Behind a host's proxy (Render, Railway, nginx) set TRUST_PROXY=1: without it the " +
      "server cannot tell that a request came over HTTPS, so the session cookie is not marked Secure, and every visitor " +
      "counts as one address for rate limiting."
  );
}

// HTTPS only in production, and the headers that tell browsers what this
// site may and may not do (middleware/securityHeaders.js).
app.use(requireHttps);
app.use(securityHeaders);

// CORS allowlist. CORS_ORIGIN is a comma-separated list of exact origins
// (e.g. "https://mindatlas.vercel.app"). Unset: the local Vite dev origins
// are allowed outside production, and NO cross-origin browser access is
// allowed in production. Requests with no Origin header (curl, server to
// server, same-origin) are unaffected. Never "*": the session travels in a
// cookie, and only named origins may send it.
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins().includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    // the session cookie is sent on cross-origin requests from allowed origins
    credentials: true,
    // lets the web client read the file name of a download (notes as PDF / Word)
    exposedHeaders: ["Content-Disposition"],
  })
);

// `db` says where accounts and notes are stored and whether they survive a
// restart - open /api/health on the live site to check the deployment.
// `semantic.active`: whether questions are ranked by meaning (the optional
// embedding model) or by rules alone. `email.enabled`: whether the server can
// send confirmation and reset emails. Anyone can read this, so in production
// it says what is on and off and nothing about how the server is set up.
app.get("/api/health", (req, res) => {
  const { kind, persistent } = dbInfo();
  const semantic = semanticStatus();
  res.json({
    ok: true,
    db: { kind, persistent },
    semantic: isProduction() ? { active: semantic.active, state: semantic.state } : semantic,
    email: { enabled: mailStatus().enabled },
  });
});

// Rate limits come before a request's body is read, so a flood of large
// requests is turned away without being parsed. The whole API: counted per
// signed-in student, and per address for anyone not signed in - a classroom
// shares one address and must not share one limit. (The health page above is
// not counted: the host polls it.)
const MINUTES = 60_000;
app.use("/api", rateLimit({ windowMs: 15 * MINUTES, max: envNumber("RATE_LIMIT_API_MAX", 600), key: sessionKey }));

app.use(express.json({ limit: "2mb" }));
// Every /api request: a plain JSON object without database operators, plain
// text query parameters (middleware/validate.js), and - for anything that
// changes data - a site that is allowed to ask (middleware/origin.js).
app.use("/api", checkRequestShape, originGuard);

// Local file database: persist a write request's changes before answering it.
app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  const send = res.json.bind(res);
  res.json = (body) => {
    try {
      flushDB();
    } catch (err) {
      console.error("[db] failed to save:", err.message);
    }
    return send(body);
  };
  next();
});

// The limits for particular routes, per 15 minutes unless said otherwise.
// Anything that takes a password or sends an email: per address, tight. (The
// per-account limit on wrong passwords is in services/loginThrottle.js.)
const credentialLimit = rateLimit({
  windowMs: 15 * MINUTES,
  max: envNumber("RATE_LIMIT_AUTH_MAX", 60),
  message: "too many sign-in attempts, please try again later",
});
for (const route of ["login", "register", "forgot", "reset", "verify-email", "resend-verification", "password"]) {
  app.post(`/api/auth/${route}`, credentialLimit);
}
app.delete("/api/auth/me", credentialLimit);
// New accounts and reset emails from one address, per hour.
app.post(
  "/api/auth/register",
  rateLimit({ windowMs: 60 * MINUTES, max: envNumber("RATE_LIMIT_REGISTER_MAX", 40), message: "too many new accounts from this address - try again in an hour" })
);
app.post(
  "/api/auth/forgot",
  rateLimit({ windowMs: 60 * MINUTES, max: envNumber("RATE_LIMIT_FORGOT_MAX", 10), message: "too many reset emails asked for - try again in an hour" })
);
// Test building is the endpoint that fans out to the LLM, whose free quota is
// shared by everyone: limited per student, and per address as well, so that
// making many accounts does not multiply the allowance.
app.post(
  "/api/subjects/:id/tests",
  rateLimit({ windowMs: 15 * MINUTES, max: envNumber("RATE_LIMIT_TEST_BUILD_MAX", 20), message: "too many test builds, please try again later", key: sessionKey }),
  rateLimit({ windowMs: 15 * MINUTES, max: envNumber("RATE_LIMIT_TEST_BUILD_MAX", 20) * 5, message: "too many test builds from this address, please try again later" })
);
// Building a PDF or Word file is the heaviest thing a single request can ask
// of this server, so downloads get their own ceiling.
const exportLimit = rateLimit({
  windowMs: 15 * MINUTES,
  max: envNumber("RATE_LIMIT_EXPORT_MAX", 60),
  message: "too many downloads, please try again in a few minutes",
  key: sessionKey,
});
app.get("/api/notes/:id/export", exportLimit);
app.get("/api/subjects/:id/export", exportLimit);
// Reading an uploaded file (OCR, PDF parsing) is the next heaviest.
const uploadLimit = rateLimit({
  windowMs: 15 * MINUTES,
  max: envNumber("RATE_LIMIT_UPLOAD_MAX", 60),
  message: "too many uploads, please try again in a few minutes",
  key: sessionKey,
});
app.post("/api/subjects/:id/notes", uploadLimit);
app.post("/api/subjects/:id/notes/preview", uploadLimit);

app.use("/api/auth", authRoutes);
app.use("/api/subjects", subjectRoutes);
// notes routes are nested under /api/subjects/:id/notes
app.use("/api/subjects", noteRoutes);
app.use("/api/graph", graphRoutes);
app.use("/api/notes", noteItemRoutes);
// tests routes cover both /api/subjects/:id/tests and /api/tests/:id
app.use("/api", testRoutes);
// attempts routes cover both /api/tests/:id/attempts and /api/attempts/:id/...
app.use("/api", attemptRoutes);

// Unknown API routes get a JSON 404 rather than the SPA's index.html.
app.use("/api", (req, res) => res.status(404).json({ error: "not found" }));

// Single-service deploy: if the React client has been built (client/dist),
// serve it from this same server so the whole app lives on one URL and the
// browser never makes a cross-origin call. Any non-API path falls back to
// index.html so React Router's client-side routes survive a page refresh.
const clientDist = process.env.CLIENT_DIST
  ? path.resolve(process.env.CLIENT_DIST)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client/dist");
if (fs.existsSync(path.join(clientDist, "index.html"))) {
  app.use(express.static(clientDist, { index: false, maxAge: "1h" }));
  app.use("/assets", express.static(path.join(clientDist, "assets"), { immutable: true, maxAge: "1y" }));
  app.get("*", (req, res) => res.sendFile(path.join(clientDist, "index.html")));
  console.log(`[server] serving web client from ${clientDist}`);
}

// The last stop for every error. A problem with the request is answered with
// what was wrong; anything else is logged here and answered with a plain
// "internal server error" - never a stack trace, a file path or a database
// message, in any environment.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "the request body is not valid JSON" });
  if (err?.type === "entity.too.large") return res.status(413).json({ error: "the request is too large" });
  if (err?.expose === true && err.status >= 400 && err.status < 500 && err.name !== "BadRequestError") {
    return res.status(err.status).json({ error: err.message });
  }
  if (err?.status >= 400 && err.status < 500) return res.status(err.status).json({ error: "the request could not be understood" });
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});

const PORT = process.env.PORT || 4000;

connectDB()
  .then(() => {
    app.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
    warmSemanticModel(); // background; a no-op unless the add-on is installed
  })
  .catch((err) => {
    console.error("[server] failed to start:", err);
    process.exit(1);
  });
