import jwt from "jsonwebtoken";

const DEV_SECRET = "dev-only-insecure-secret-change-me";

// Read lazily (not at import time) so it never depends on whether dotenv
// has already run relative to this module being evaluated.
function secret() {
  return process.env.JWT_SECRET?.trim() || DEV_SECRET;
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

export function signToken(user) {
  return jwt.sign({ sub: String(user._id), email: user.email }, secret(), {
    expiresIn: "7d",
  });
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing bearer token" });

  try {
    const payload = jwt.verify(token, secret());
    req.user = { id: payload.sub, email: payload.email };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
