// Who is making this request.
//
// A session is a signed token (JWT, HS256) naming the user. It reaches the
// server one of two ways:
//   - in a cookie the browser cannot read from JavaScript (HttpOnly), sent
//     only over HTTPS in production (Secure), and only for this site
//     (SameSite). This is how the web client signs in. A script injected into
//     the page cannot steal the session, which is the reason it is not kept
//     in localStorage any more;
//   - in an "Authorization: Bearer" header, for programs (the tests, scripts)
//     and as the web client's fallback where a browser refuses the cookie.
//
// A token is checked against the account on every request, not just against
// its signature: it stops working when the account is deleted and when the
// password is changed after it was issued.

import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { findUserById } from "../models/User.js";
import { mailStatus } from "../services/mailer.js";

const DEV_SECRET = "dev-only-insecure-secret-change-me";
const SESSION_DAYS = 7;
const ALGORITHM = "HS256";

// Read lazily (not at import time) so it never depends on whether dotenv
// has already run relative to this module being evaluated.
function secret() {
  return process.env.JWT_SECRET?.trim() || DEV_SECRET;
}

/** A key derived from the server secret for another purpose, so no two uses share a key. */
export function derivedKey(purpose) {
  return crypto.createHmac("sha256", secret()).update(`mindatlas:${purpose}`).digest();
}

/**
 * Call once at startup. In production a missing or weak JWT_SECRET is a
 * hard failure - falling back to the public dev default would let anyone
 * mint valid tokens. Outside production it only warns, so local dev keeps
 * working with zero setup.
 */
export function assertAuthConfig() {
  const configured = process.env.JWT_SECRET?.trim();
  if (process.env.NODE_ENV === "production") {
    if (!configured) throw new Error("JWT_SECRET must be set when NODE_ENV=production");
    if (configured.length < 32) throw new Error("JWT_SECRET must be at least 32 characters in production");
    return;
  }
  if (!configured) {
    console.warn(
      "[auth] JWT_SECRET is not set - using an INSECURE built-in dev secret. " +
        "Fine for local dev; set JWT_SECRET in server/.env before deploying."
    );
  }
}

// `sv` is the account's session version at sign-in. Changing the password
// raises the account's version, and every token carrying an older one stops
// working at that moment (see authenticate below).
// `jti` makes every session's token different, even two started in the same
// second, so signing out of one does not sign out of another.
export function signToken(user) {
  const claims = { sub: String(user._id), email: user.email, sv: user.sessionVersion || 0, jti: crypto.randomBytes(9).toString("base64url") };
  return jwt.sign(claims, secret(), { expiresIn: `${SESSION_DAYS}d`, algorithm: ALGORITHM });
}

// Tokens signed out before they expired. A token is its own proof, so signing
// out can only clear the browser's copy of it - unless the server remembers
// that it was given up. Kept in memory until each would have expired anyway:
// a restart forgets the list, which leaves a signed-out token usable only by
// someone who had already copied it, for the rest of its seven days.
const revoked = new Map(); // token signature -> expiry (ms)
const signatureOf = (token) => String(token).slice(String(token).lastIndexOf(".") + 1);
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [sig, exp] of revoked) if (exp <= now) revoked.delete(sig);
}, 10 * 60_000);
sweeper.unref?.();

function verifyToken(token) {
  try {
    // the algorithm is pinned: a token claiming "none" or another scheme is refused
    const payload = jwt.verify(token, secret(), { algorithms: [ALGORITHM] });
    return revoked.has(signatureOf(token)) ? null : payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The session cookie
// ---------------------------------------------------------------------------

// Over HTTPS the cookie takes the "__Host-" prefix: a browser only accepts
// such a cookie if it is Secure, has no Domain and Path=/, so another site on
// a shared parent domain (every *.onrender.com app is one) cannot plant it.
const cookieName = (req) => (req.secure ? "__Host-ma_session" : "ma_session");

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

// The web client and the API can live at one address or at two. A cookie set
// by a different host than the page is "cross-site": browsers only send it
// with SameSite=None, which requires HTTPS, and "Partitioned" keeps it tied to
// this one site so it cannot be used to follow someone around the web. At one
// address, SameSite=Lax is stricter and all that is needed.
function crossHost(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).hostname !== req.hostname;
  } catch {
    return false;
  }
}

function cookieAttributes(req) {
  const parts = ["Path=/", "HttpOnly"];
  if (req.secure) parts.push("Secure");
  if (req.secure && crossHost(req)) parts.push("SameSite=None", "Partitioned");
  else parts.push("SameSite=Lax");
  return parts;
}

/** Start a session: put the token in the cookie. Returns the token. */
export function startSession(req, res, user) {
  const token = signToken(user);
  res.append("Set-Cookie", [`${cookieName(req)}=${token}`, `Max-Age=${SESSION_DAYS * 86400}`, ...cookieAttributes(req)].join("; "));
  return token;
}

/** End the session in this browser. */
export function endSession(req, res) {
  res.append("Set-Cookie", [`${cookieName(req)}=`, "Max-Age=0", ...cookieAttributes(req)].join("; "));
}

const bearerOf = (req) => {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
};

/** Sign-out: the token this request came with stops being accepted. */
export function revokeSession(req) {
  for (const token of [bearerOf(req), readCookie(req, cookieName(req))]) {
    const payload = token ? verifyToken(token) : null;
    if (payload?.exp && revoked.size < 100_000) revoked.set(signatureOf(token), payload.exp * 1000);
  }
}

/** True when the request carries a session cookie and no bearer token: the case forged cross-site requests rely on. */
export const usesCookieSession = (req) => !bearerOf(req) && Boolean(readCookie(req, cookieName(req)));

/**
 * "u:<user id>" for a request with a validly signed token, else null. For
 * rate limiting only (no database lookup): it lets a classroom behind one
 * address be counted per student instead of as one client.
 */
export function sessionKey(req) {
  const token = bearerOf(req) || readCookie(req, cookieName(req));
  const payload = token ? verifyToken(token) : null;
  return payload?.sub ? `u:${payload.sub}` : null;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

async function authenticate(req) {
  const bearer = bearerOf(req);
  const token = bearer || readCookie(req, cookieName(req));
  if (!token) return { error: "sign in to continue" };
  const payload = verifyToken(token);
  if (!payload?.sub) return { error: "your session has expired - sign in again" };
  const user = await findUserById(String(payload.sub));
  if (!user) return { error: "your session has expired - sign in again" };
  // a token from before the last password change no longer counts
  if ((payload.sv || 0) !== (user.sessionVersion || 0)) return { error: "your password was changed - sign in again" };
  return { user, via: bearer ? "bearer" : "cookie" };
}

function attach(req, user, via) {
  req.user = { id: String(user._id), email: user.email };
  req.account = user; // the full record, for routes that need the password hash
  req.authVia = via;
}

/**
 * A signed-in account. Use on the /auth routes that must work before an
 * email address is confirmed (who am I, resend the email, sign out).
 */
export async function requireSession(req, res, next) {
  const result = await authenticate(req);
  if (result.error) return res.status(401).json({ error: result.error });
  attach(req, result.user, result.via);
  next();
}

/** True when this account still has to confirm its email address before using the app. */
export const mustVerifyEmail = (user) => mailStatus().enabled && user.emailVerified === false;

/**
 * A signed-in account that may use the app: when email is set up, the
 * address has to have been confirmed. Accounts made before that was asked
 * for have no `emailVerified` field and are let through.
 */
export async function requireAuth(req, res, next) {
  const result = await authenticate(req);
  if (result.error) return res.status(401).json({ error: result.error });
  if (mustVerifyEmail(result.user)) {
    return res.status(403).json({ error: "confirm your email address to continue - check your inbox for the link", code: "email_unverified" });
  }
  attach(req, result.user, result.via);
  next();
}
