// Refusing requests another website made on a signed-in student's behalf
// (cross-site request forgery).
//
// A browser attaches the session cookie to any request to this API, whichever
// page made it. So a page on another site could submit a form here and it
// would arrive signed in. What that page cannot do is choose the Origin
// header: the browser sets it to the page's own address. Every request that
// changes something is therefore checked:
//   - it names an Origin: it must be this server's own address or one of the
//     allowed ones (CORS_ORIGIN), whoever is signed in or not - this also
//     stops another site signing a visitor in to an account of its choosing;
//   - it names none: only programs do that (browsers always send Origin with
//     a POST). It is let through unless it rides on the session cookie.
// A request carrying a bearer token is not at risk - another site cannot make
// a browser send that header - and is not checked.

import { allowedOrigins } from "../config.js";
import { usesCookieSession } from "./auth.js";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export function isAllowedOrigin(origin, req) {
  if (allowedOrigins().includes(origin)) return true;
  // the server's own address: the single-service deploy, where it serves the client too
  return origin === `${req.protocol}://${req.get("host")}`;
}

export function originGuard(req, res, next) {
  if (SAFE.has(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    if (isAllowedOrigin(origin, req)) return next();
    return res.status(403).json({ error: "this request came from a site that is not allowed to use this API" });
  }
  if (usesCookieSession(req)) {
    return res.status(403).json({ error: "this request did not say which site it came from" });
  }
  next();
}
