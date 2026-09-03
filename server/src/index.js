import "dotenv/config";
import express from "express";
import cors from "cors";
import { connectDB } from "./db/index.js";
import authRoutes from "./routes/auth.js";
import subjectRoutes from "./routes/subjects.js";
import noteRoutes from "./routes/notes.js";
import testRoutes from "./routes/tests.js";
import attemptRoutes from "./routes/attempts.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api/subjects", subjectRoutes);
// notes routes are nested under /api/subjects/:id/notes
app.use("/api/subjects", noteRoutes);
// tests routes cover both /api/subjects/:id/tests and /api/tests/:id
app.use("/api", testRoutes);
// attempts routes cover both /api/tests/:id/attempts and /api/attempts/:id/...
app.use("/api", attemptRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});

const PORT = process.env.PORT || 4000;

connectDB()
  .then(() => {
    app.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
  })
  .catch((err) => {
    console.error("[server] failed to start:", err);
    process.exit(1);
  });
