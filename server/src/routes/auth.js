import bcrypt from "bcryptjs";
import {
  createUser,
  deleteUserAndData,
  findUserByEmail,
  findUserById,
  markEmailVerified,
  publicUser,
  updateUserPassword,
  upgradePasswordHash,
} from "../models/User.js";
import { endSession, mustVerifyEmail, requireAuth, requireSession, revokeSession, startSession } from "../middleware/auth.js";
import { safeRouter } from "../middleware/safeRouter.js";
import { InputError, LIMITS, email as emailField, text } from "../middleware/validate.js";
import { envNumber, supportEmail } from "../config.js";
import { llmAvailable, llmProvider } from "../services/llm.js";
import { MIN_LENGTH, passwordProblem } from "../services/passwordPolicy.js";
import { beginAttempt, recordSuccess } from "../services/loginThrottle.js";
import { challengeProblem, challengeRequired, issueChallenge, spendChallenge } from "../services/signupChallenge.js";
import { mailStatus } from "../services/mailer.js";
import { redact } from "../services/log.js";
import { consumeToken, findToken, lastIssuedAt, sendResetEmail, sendVerificationEmail } from "../services/emailTokens.js";

const router = safeRouter();

// Passwords are stored as bcrypt hashes, never as text. The cost is how much
// work one guess takes: 10 is the accepted minimum and what the free hosting
// tier's slow CPU can do without making sign-in drag; raise BCRYPT_ROUNDS on
// a faster host. A hash made at a lower cost is redone at the next sign-in.
const rounds = () => Math.min(14, Math.max(10, Math.round(envNumber("BCRYPT_ROUNDS", 10))));
const hash = (password) => bcrypt.hash(password, rounds());

// Compared against when the email is unknown, so "no such account" takes as
// long to answer as "wrong password" and the two cannot be told apart by timing.
let dummyHash = null;
const getDummyHash = async () => (dummyHash ||= await hash("no-account-has-this-password"));

// A password as sent: text, and not so long that hashing it is a way to keep
// the server busy.
const passwordField = (value, name = "password") => text(value, name, { max: 200, trim: false });

const registering = new Set(); // addresses with a sign-up in progress

const EMAIL_GAP_MS = 60_000; // between two emails of the same kind to one account
// Confirmation emails one account may ask for in a day: the address may not
// be the asker's own, and must not be made a target for a stream of mail.
const RESENDS_PER_DAY = 5;
const resends = new Map(); // user id -> { count, resetAt }
const resendAllowed = (userId) => {
  const now = Date.now();
  let e = resends.get(userId);
  if (!e || e.resetAt <= now) {
    if (resends.size > 10_000) resends.clear(); // bounded, whatever happens
    e = { count: 0, resetAt: now + 24 * 3600_000 };
    resends.set(userId, e);
  }
  e.count += 1;
  return e.count <= RESENDS_PER_DAY;
};
const tooSoon = async (user, purpose) => {
  const last = await lastIssuedAt(user._id, purpose);
  return last !== null && Date.now() - last < EMAIL_GAP_MS;
};

// GET /api/auth/config - what the sign-in pages need to know before anyone
// signs in: a challenge for the sign-up form (see signupChallenge.js), whether
// this server sends email, and the password length rule.
router.get("/config", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    signup: { challenge: issueChallenge(), challengeRequired: challengeRequired() },
    email: { enabled: mailStatus().enabled },
    password: { minLength: MIN_LENGTH },
    // where students can write for help or with a complaint (SUPPORT_EMAIL)
    support: { email: supportEmail() },
    // whether notes and answers are sent to an AI service, and which: shown
    // to students on the Settings page
    ai: llmAvailable() ? { enabled: true, ...llmProvider() } : { enabled: false, name: null, trainsOnInputs: null },
  });
});

// POST /api/auth/register  { email, password, challenge?, website? }
router.post("/register", async (req, res) => {
  const body = req.body || {};
  const email = emailField(body.email);
  const password = passwordField(body.password);
  const weak = passwordProblem(password, { email });
  if (weak) throw new InputError(weak);
  const automated = challengeProblem(body);
  if (automated) throw new InputError(automated);

  // Two sign-ups for one address arriving together would both find it free.
  // Only one is let through at a time here; with MongoDB a unique index on
  // the address (db/mongoStore.js) holds across server instances too.
  const taken = () => res.status(409).json({ error: "an account with that email already exists" });
  if (registering.has(email)) return taken();
  registering.add(email);
  // With email set up, the address has to be confirmed before the account can
  // be used; the session starts now so the "check your inbox" page can offer
  // to send the link again.
  const confirm = mailStatus().enabled;
  let user;
  try {
    if (await findUserByEmail(email)) return taken();
    user = await createUser({ email, passwordHash: await hash(password), emailVerified: !confirm });
  } catch (err) {
    if (err?.code === 11000) return taken(); // MongoDB: the unique index refused a duplicate
    throw err;
  } finally {
    registering.delete(email);
  }
  spendChallenge(body);
  let verificationSent = false;
  if (confirm) {
    try {
      await sendVerificationEmail(user);
      verificationSent = true;
    } catch (err) {
      console.error("[mail] could not send the confirmation email:", redact(err.message));
    }
  }
  const token = startSession(req, res, user);
  res.status(201).json({ token, user: publicUser(user), emailVerificationRequired: confirm, verificationSent });
});

// POST /api/auth/login  { email, password }
router.post("/login", async (req, res) => {
  const body = req.body || {};
  // not held to the address format: accounts made before it was checked still sign in
  const typed = text(body.email, "email", { max: LIMITS.email, trim: false }).toLowerCase();
  const email = typed.trim();
  const password = passwordField(body.password);

  // counted before anything is awaited, so parallel guesses cannot all get in
  const wait = beginAttempt(email, req.ip);
  if (wait) {
    res.setHeader("Retry-After", String(wait));
    return res.status(429).json({ error: `too many wrong passwords for this account - try again in ${Math.ceil(wait / 60)} minutes` });
  }

  // accounts created before emails were trimmed may be stored with the space
  const user = (await findUserByEmail(email)) || (typed !== email ? await findUserByEmail(typed) : null);
  const ok = await bcrypt.compare(password, user ? user.passwordHash : await getDummyHash());
  if (!user || !ok) return res.status(401).json({ error: "invalid email or password" });
  recordSuccess(email, req.ip);
  if (user.suspended) return res.status(403).json({ error: "this account has been suspended - contact support if you think this is a mistake", code: "suspended" });
  if (bcrypt.getRounds(user.passwordHash) < rounds()) await upgradePasswordHash(user._id, await hash(password));

  const token = startSession(req, res, user);
  res.json({ token, user: publicUser(user), emailVerificationRequired: mustVerifyEmail(user) });
});

// POST /api/auth/logout - end the session in this browser.
router.post("/logout", (req, res) => {
  revokeSession(req); // the token itself stops working, wherever a copy of it is
  endSession(req, res);
  res.json({ ok: true });
});

// POST /api/auth/session - put the session of a valid bearer token into the
// cookie. The web client calls it once for students who were signed in when
// their token was still kept in localStorage, so the upgrade does not sign
// them out.
router.post("/session", requireSession, (req, res) => {
  startSession(req, res, req.account);
  res.json({ ok: true, user: publicUser(req.account) });
});

router.get("/me", requireSession, (req, res) => {
  res.json({ user: publicUser(req.account), emailVerificationRequired: mustVerifyEmail(req.account) });
});

// POST /api/auth/password  { currentPassword, newPassword }
// Change the password of the signed-in account. The current password is asked
// for again, so an unattended, signed-in browser is not enough to take the
// account over. Every other session of the account ends; this one continues.
router.post("/password", requireAuth, async (req, res) => {
  const body = req.body || {};
  const current = passwordField(body.currentPassword, "the current password");
  const next = passwordField(body.newPassword, "the new password");
  const user = req.account;
  if (!(await bcrypt.compare(current, user.passwordHash))) {
    return res.status(401).json({ error: "the current password is not correct" });
  }
  if (await bcrypt.compare(next, user.passwordHash)) {
    return res.status(400).json({ error: "the new password is the same as the current one" });
  }
  const weak = passwordProblem(next, { email: user.email });
  if (weak) throw new InputError(weak);
  const updated = await updateUserPassword(user._id, await hash(next));
  const token = startSession(req, res, updated);
  res.json({ ok: true, token });
});

// DELETE /api/auth/me  { password }
// Delete the account and everything in it: subjects, notes, links, tests,
// attempts, feedback and mastery. Not reversible, so the password is required.
router.delete("/me", requireSession, async (req, res) => {
  const password = passwordField(req.body?.password);
  if (!(await bcrypt.compare(password, req.account.passwordHash))) {
    return res.status(401).json({ error: "the password is not correct" });
  }
  const removed = await deleteUserAndData(req.account._id);
  endSession(req, res);
  res.json({ ok: true, removed });
});

// ---------------------------------------------------------------------------
// Email: confirming an address and resetting a forgotten password. Both need
// the server to be able to send email (services/mailer.js); without it these
// answer 503 and the web client does not offer them.
// ---------------------------------------------------------------------------

const EMAIL_OFF = "email is not set up on this server";

// POST /api/auth/verify-email  { token }  - the link in the confirmation email
router.post("/verify-email", async (req, res) => {
  const token = text(req.body?.token, "token", { max: 200 });
  const row = await findToken(token, "verify");
  // using the link up must succeed exactly once: of two requests racing with
  // the same link, only one gets past this line
  if (!row || !(await consumeToken(row))) return res.status(400).json({ error: "this link is no longer valid - sign in and ask for a new one" });
  await markEmailVerified(row.userId);
  res.json({ ok: true });
});

// POST /api/auth/resend-verification - send the confirmation link again
router.post("/resend-verification", requireSession, async (req, res) => {
  if (!mailStatus().enabled) return res.status(503).json({ error: EMAIL_OFF });
  if (req.account.emailVerified !== false) return res.json({ ok: true, alreadyVerified: true });
  if (await tooSoon(req.account, "verify")) {
    return res.status(429).json({ error: "an email was sent a moment ago - check your inbox, and your spam folder, before asking again" });
  }
  if (!resendAllowed(req.user.id)) {
    return res.status(429).json({ error: "too many confirmation emails asked for today - try again tomorrow" });
  }
  await sendVerificationEmail(req.account);
  res.json({ ok: true });
});

// POST /api/auth/forgot  { email }
// Always answers the same way, at once, whether or not the address has an
// account: otherwise this would be a way to find out who uses the app.
router.post("/forgot", async (req, res) => {
  if (!mailStatus().enabled) return res.status(503).json({ error: `${EMAIL_OFF}, so a password cannot be reset by email` });
  const email = emailField(req.body?.email);
  res.json({ ok: true });
  try {
    const user = await findUserByEmail(email);
    if (user && !(await tooSoon(user, "reset"))) await sendResetEmail(user);
  } catch (err) {
    console.error("[mail] could not send the reset email:", redact(err.message));
  }
});

// POST /api/auth/reset  { token, password }  - the link in the reset email
router.post("/reset", async (req, res) => {
  const token = text(req.body?.token, "token", { max: 200 });
  const password = passwordField(req.body?.password);
  const row = await findToken(token, "reset");
  const user = row ? await findUserById(row.userId) : null;
  if (!user) return res.status(400).json({ error: "this link is no longer valid - ask for a new one" });
  if (user.suspended) return res.status(403).json({ error: "this account has been suspended - contact support if you think this is a mistake", code: "suspended" });
  // checked before the link is used up, so a refused password does not cost the student the link
  const weak = passwordProblem(password, { email: user.email });
  if (weak) throw new InputError(weak);
  if (!(await consumeToken(row))) return res.status(400).json({ error: "this link is no longer valid - ask for a new one" });
  // changing the password ends every session of the account
  const updated = await updateUserPassword(user._id, await hash(password));
  // opening the link proved the address is theirs
  if (updated.emailVerified === false) await markEmailVerified(user._id);
  const sessionToken = startSession(req, res, updated);
  res.json({ ok: true, token: sessionToken, user: publicUser({ ...updated, emailVerified: true }) });
});

export default router;
