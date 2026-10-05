// Slowing down guesses at one account's password.
//
// The per-address rate limit (middleware/rateLimit.js) stops one machine
// hammering the sign-in form. It does nothing against guesses at ONE account
// spread over many addresses, and it must stay loose enough for a classroom
// that shares an address. So sign-in attempts are also counted per account:
//   - 5 wrong passwords for an account from one address: that pair is locked
//     for 15 minutes;
//   - 100 wrong passwords for an account from anywhere: the account's sign-in
//     is locked for 15 minutes, whoever asks. This one can be used to keep a
//     student out for a while by someone with many addresses, which is why it
//     is set high: with the password rules in place, 400 guesses an hour gets
//     an attacker nowhere, and it takes real effort to trip.
//
// An attempt is counted the moment it arrives, BEFORE the password is
// checked, and un-counted if it turns out right. Counting afterwards would
// let a burst of parallel requests all slip past the limit while the first
// was still being checked. Counts live in memory: one server instance, as
// with the rate limiter.

import { envNumber } from "../config.js";

const WINDOW_MS = 15 * 60_000;
const attempts = new Map(); // key -> { count, resetAt }

const pairLimit = () => envNumber("LOGIN_MAX_FAILURES", 5);
const accountLimit = () => envNumber("LOGIN_MAX_FAILURES_ACCOUNT", 100);
const keys = (email, ip) => [`${email}|${ip || "unknown"}`, `${email}|*`];

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [k, e] of attempts) if (e.resetAt <= now) attempts.delete(k);
}, 60_000);
sweeper.unref?.();

const live = (key) => {
  const e = attempts.get(key);
  return e && e.resetAt > Date.now() ? e : null;
};

/** Seconds until this account may be tried again from this address, or 0 if it may be now. */
export function lockedFor(email, ip) {
  const [pair, account] = keys(email, ip);
  const now = Date.now();
  const p = live(pair);
  const a = live(account);
  if (p && p.count >= pairLimit()) return Math.ceil((p.resetAt - now) / 1000);
  if (a && a.count >= accountLimit()) return Math.ceil((a.resetAt - now) / 1000);
  return 0;
}

/**
 * Count a sign-in attempt that is about to be checked. Returns 0 when it may
 * go ahead, or the seconds to wait when the account is locked (nothing is
 * counted then). Synchronous on purpose: see the top of this file.
 */
export function beginAttempt(email, ip) {
  const wait = lockedFor(email, ip);
  if (wait) return wait;
  for (const key of keys(email, ip)) {
    const e = live(key) || { count: 0, resetAt: Date.now() + WINDOW_MS };
    e.count += 1;
    attempts.set(key, e);
  }
  return 0;
}

/** The attempt counted by beginAttempt had the right password: forget this address's count, and take it off the account's. */
export function recordSuccess(email, ip) {
  const [pair, account] = keys(email, ip);
  attempts.delete(pair);
  const a = live(account);
  if (a) a.count = Math.max(0, a.count - 1);
}
