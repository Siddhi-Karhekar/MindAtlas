import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api.js";

export default function SubjectWorkspace() {
  const { subjectId } = useParams();
  const [notes, setNotes] = useState(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [file, setFile] = useState(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);

  function refresh() {
    api.listNotes(subjectId).then((d) => setNotes(d.notes));
  }

  useEffect(refresh, [subjectId]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setInfo("");
    setBusy(true);
    try {
      let result;
      if (file) {
        result = await api.uploadNoteImage(subjectId, file, title);
      } else {
        if (!title.trim() || !content.trim()) throw new Error("title and content are required");
        result = await api.createNote(subjectId, { title: title.trim(), content: content.trim() });
      }
      setTitle("");
      setContent("");
      setFile(null);
      setInfo(
        result.edgesCreated > 0
          ? `Note added — linked to ${result.edgesCreated} related note${result.edgesCreated > 1 ? "s" : ""}.`
          : "Note added — no strongly related notes yet."
      );
      refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Notes</h1>
        <Link
          to={`/subjects/${subjectId}/graph`}
          className="text-sm font-semibold text-primary hover:underline"
        >
          View knowledge graph →
        </Link>
      </div>

      <form onSubmit={handleSubmit} className="rounded-xl border border-black/10 bg-surface p-5 mb-8 space-y-3">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Note title"
          className="w-full rounded-lg border border-black/15 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          disabled={!!file}
          rows={4}
          placeholder="Type or paste the note's text…"
          className="w-full rounded-lg border border-black/15 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:bg-page disabled:text-ink-soft"
        />
        <div className="flex items-center justify-between gap-3">
          <label className="text-xs text-ink-soft flex items-center gap-2">
            <input
              type="file"
              accept="image/*"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
            or scan an image (OCR)
          </label>
          <button
            disabled={busy}
            className="rounded-lg bg-primary text-white px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-60"
          >
            {busy ? "Processing…" : "Add note"}
          </button>
        </div>
        {error && <p className="text-sm text-error">{error}</p>}
        {info && <p className="text-sm text-secondary">{info}</p>}
      </form>

      {notes === null ? (
        <p className="text-ink-soft text-sm">Loading…</p>
      ) : notes.length === 0 ? (
        <p className="text-ink-soft text-sm">No notes yet.</p>
      ) : (
        <ul className="space-y-3">
          {notes.map((n) => (
            <li key={n._id} className="rounded-xl border border-black/10 bg-surface p-4">
              <div className="flex items-center justify-between mb-1">
                <span className="font-semibold">{n.title}</span>
                <span className="text-xs text-ink-soft uppercase tracking-wide">{n.sourceType}</span>
              </div>
              <p className="text-sm text-ink-soft line-clamp-2">{n.rawText}</p>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {n.keywords.slice(0, 6).map((k) => (
                  <span key={k} className="text-[11px] px-2 py-0.5 rounded-full bg-tertiary-container text-tertiary">
                    {k}
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
