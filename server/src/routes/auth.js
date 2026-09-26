import { Router } from "express";
import bcrypt from "bcryptjs";
import { createUser, findUserByEmail, findUserById } from "../models/User.js";
import { signToken, requireAuth } from "../middleware/auth.js";

const router = Router();

// Emails are matched case- and whitespace-insensitively. Phones and password
// managers often add a trailing space when autofilling; without the trim, an
// account registered as "me@x.com " could never be logged into as "me@x.com"
// (and signing up again with "me@x.com" would appear to work).
const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

router.post("/register", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || password.length < 8) {
    return res
      .status(400)
      .json({ error: "email and a password of at least 8 characters are required" });
  }

  const normalizedEmail = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return res.status(400).json({ error: "enter a valid email address" });
  }
  const existing = await findUserByEmail(normalizedEmail);
  if (existing) return res.status(409).json({ error: "an account with that email already exists" });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await createUser({ email: normalizedEmail, passwordHash });

  res.status(201).json({ token: signToken(user), user: { id: user._id, email: user.email } });
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  const typed = String(email || "").toLowerCase();
  // accounts created before emails were trimmed may be stored with the space
  const user = (await findUserByEmail(normalizeEmail(email))) || (typed !== normalizeEmail(email) ? await findUserByEmail(typed) : null);
  if (!user) return res.status(401).json({ error: "invalid email or password" });

  const ok = await bcrypt.compare(password || "", user.passwordHash);
  if (!ok) return res.status(401).json({ error: "invalid email or password" });

  res.json({ token: signToken(user), user: { id: user._id, email: user.email } });
});

router.get("/me", requireAuth, async (req, res) => {
  const user = await findUserById(req.user.id);
  if (!user) return res.status(404).json({ error: "user not found" });
  res.json({ user: { id: user._id, email: user.email, createdAt: user.createdAt } });
});

export default router;
