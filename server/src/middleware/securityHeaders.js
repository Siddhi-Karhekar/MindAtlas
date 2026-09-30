import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import helmet from "helmet";

// Security headers via helmet, tuned for both deploy shapes:
//   - two services (live on Render): this server only answers JSON to the
//     static site on another domain, so the policy mostly doesn't matter;
//   - one service (Dockerfile / docker compose / render.yaml single mode):
//     this server also serves the built React app, so the
//     Content-Security-Policy must allow exactly what client/index.html uses.
//
// index.html has one inline script (applies the saved theme before first
// paint). Rather than allowing all inline scripts, the policy allows that
// script by its SHA-256 hash, read from the built index.html at startup - so
// editing the script can never silently break the page or the policy.

const clientDist = process.env.CLIENT_DIST
  ? path.resolve(process.env.CLIENT_DIST)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../client/dist");

function inlineScriptHashes() {
  try {
    const html = fs.readFileSync(path.join(clientDist, "index.html"), "utf8");
    return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
      ([, body]) => `'sha256-${crypto.createHash("sha256").update(body).digest("base64")}'`
    );
  } catch {
    return []; // no built client here (API-only deploy, or local dev): nothing inline to allow
  }
}

export function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", ...inlineScriptHashes()],
        // Google Fonts (Manrope + Material Symbols) in index.html. Inline
        // styles are allowed because React and cytoscape set style attributes.
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    // The live static site calls this API from another domain (CORS). Keep
    // the API readable cross-origin; CORS_ORIGIN still decides who may call it.
    crossOriginResourcePolicy: { policy: "cross-origin" },
    frameguard: { action: "deny" },
    referrerPolicy: { policy: "no-referrer" },
  });
}
