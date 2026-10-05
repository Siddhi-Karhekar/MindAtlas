// Response headers that tell the browser what this site may and may not do,
// and the HTTPS-only rule. Written out here rather than taken from a package
// so each line can say why it is there.

import { isProduction } from "../config.js";

// What a page of the web app may load, when this server also serves the
// client (the single-service deploy). Scripts only from this site: an
// injected <script> or inline handler does not run. Styles and fonts also
// from Google Fonts, which index.html uses. 'unsafe-inline' is for style
// attributes only (React sets them); it does not allow inline scripts.
// client/vite.config.js writes the same policy into the built index.html, so
// it also applies where the client is hosted separately as static files.
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

// An API answer is data, never a page: it may load nothing and be framed nowhere.
const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export function securityHeaders(req, res, next) {
  // Express matches routes without regard to case, so "/API/..." is the API too
  const api = req.path.toLowerCase().startsWith("/api");
  res.setHeader("Content-Security-Policy", api ? API_CSP : APP_CSP);
  // never guess a file's type from its content
  res.setHeader("X-Content-Type-Options", "nosniff");
  // may not be shown inside another site's frame (clickjacking); for browsers without frame-ancestors
  res.setHeader("X-Frame-Options", "DENY");
  // never tell another site which page a link was followed from - a reset
  // link's token is in the address
  res.setHeader("Referrer-Policy", "no-referrer");
  // a page opened from here gets no handle on this one, and other sites cannot embed these responses
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  // the app uses none of these device features, so no script in it may
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()");
  // once seen over HTTPS, a browser refuses plain HTTP for a year
  if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  // answers hold a student's own notes and results: not for any shared cache.
  // (A route that sets its own Cache-Control afterwards replaces this.)
  if (api) res.setHeader("Cache-Control", "no-store");
  next();
}

/**
 * Production only: refuse plain HTTP. The host's proxy says how the request
 * arrived (X-Forwarded-Proto); a GET is sent to the same address over HTTPS,
 * anything else is refused, because a redirected POST would already have sent
 * its body - a password - in the clear. Requests that did not come through a
 * proxy (the host's own health check, a container on a private network) carry
 * no such header and are let through. FORCE_HTTPS=off disables it.
 */
export function requireHttps(req, res, next) {
  if (!isProduction() || process.env.FORCE_HTTPS === "off") return next();
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  if (proto !== "http") return next();
  if (req.method === "GET" || req.method === "HEAD") return res.redirect(308, `https://${req.headers.host}${req.originalUrl}`);
  res.status(403).json({ error: "this server only accepts HTTPS" });
}
