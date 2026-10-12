// Making automated sign-ups harder, without a third-party CAPTCHA.
//
// Three cheap checks that a person filling in the form passes without
// noticing and a script posting to the form does not:
//   - a hidden field ("website") that people never see and form-filling bots
//     fill in. A sign-up with it filled is refused;
//   - a challenge the form asks the server for when it opens and sends back
//     with the sign-up. It is signed, so it cannot be made up, and it carries
//     the time it was issued: a sign-up that arrives sooner than a person
//     could type an address and a password, or with a stale challenge, is
//     refused;
//   - a limit on sign-ups per address (index.js).
// This stops casual scripts, not a determined attacker. Confirming the email
// address (when email is set up) is the stronger filter: an unconfirmed
// account can do nothing. A real CAPTCHA would need an outside service.
//
// Required in production; off elsewhere so the tests and scripts can create
// accounts directly. SIGNUP_CHALLENGE=on / off overrides.

import crypto from "node:crypto";
import { envNumber, isProduction } from "../config.js";
import { derivedKey } from "../middleware/auth.js";

const MAX_AGE_MS = 2 * 60 * 60_000;
const minAgeMs = () => envNumber("SIGNUP_MIN_SECONDS", 2) * 1000;

export function challengeRequired() {
  const setting = String(process.env.SIGNUP_CHALLENGE || "").trim().toLowerCase();
  if (setting === "on") return true;
  if (setting === "off") return false;
  return isProduction();
}

// Challenges already used for an account, until they would have expired: one
// challenge is good for one sign-up, so a script cannot fetch one and reuse it.
const used = new Map(); // challenge body -> expiry (ms)
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [body, exp] of used) if (exp <= now) used.delete(body);
}, 10 * 60_000);
sweeper.unref?.();

/** Call once the sign-up it came with has created an account. */
export function spendChallenge(fields) {
  const token = fields?.challenge;
  if (typeof token !== "string" || !challengeRequired()) return;
  const body = token.slice(0, token.lastIndexOf("."));
  if (used.size < 200_000) used.set(body, Number(body.split(".")[0]) + MAX_AGE_MS);
}

const sign = (body) => crypto.createHmac("sha256", derivedKey("signup-challenge")).update(body).digest("base64url");

/** A fresh challenge for the sign-up form. */
export function issueChallenge(now = Date.now()) {
  const body = `${now}.${crypto.randomBytes(9).toString("base64url")}`;
  return `${body}.${sign(body)}`;
}

/** Why this sign-up looks automated, or null. `fields` is the request body. */
export function challengeProblem(fields, now = Date.now()) {
  // the hidden field: checked whether or not the challenge is required
  if (fields?.website !== undefined && fields.website !== "") return "this sign-up could not be accepted";
  if (!challengeRequired()) return null;
  const token = fields?.challenge;
  if (typeof token !== "string") return "reload the page and try again";
  const cut = token.lastIndexOf(".");
  const body = token.slice(0, cut);
  const given = Buffer.from(token.slice(cut + 1));
  const expected = Buffer.from(sign(body));
  if (cut < 0 || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return "reload the page and try again";
  const age = now - Number(body.split(".")[0]);
  if (!(age >= 0) || age > MAX_AGE_MS) return "this form has been open too long - reload the page and try again";
  if (age < minAgeMs()) return "that was too fast - wait a moment and try again";
  if (used.has(body)) return "reload the page and try again";
  return null;
}
