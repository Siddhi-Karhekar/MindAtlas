import { Router } from "express";
import bcrypt from "bcryptjs";
import { createUser, findUserByEmail, findUserById } from "../models/User.js";
import { signToken, requireAuth } from "../middleware/auth.js";

const router = Router();

router.post("/register", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || password.length < 8) {
    return res
      .status(400)
      .json({ error: "email and a password of at least 8 characters are required" });
  }

  const normalizedEmail = email.toLowerCase();
  const existing = await findUserByEmail(normalizedEmail);
  if (existing) return res.status(409).json({ error: "an account with that email already exists" });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await createUser({ email: normalizedEmail, passwordHash });

  res.status(201).json({ token: signToken(user), user: { id: user._id, email: user.email } });
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  const user = await findUserByEmail((email || "").toLowerCase());
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
