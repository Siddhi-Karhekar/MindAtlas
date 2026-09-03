import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api.js";

export default function Tests() {
  const { subjectId } = useParams();
  const [notes, setNotes] = useState(null);
  const [tests, setTests] = useState(null);
  const [title, setTitle] = useState("");
  const [selectedNoteIds, setSelectedNoteIds] = useState([]);
  const [mcqCount, setMcqCount] = useState(4);
  const [marksPerQuestion, setMarksPerQuestion] = useState(2);
  const [durationMinutes, setDurationMinutes] = useState(10);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  function refresh() {
    api.listNotes(subjectId).then((d) => setNotes(d.notes));
    api.listTests(subjectId).then((d) => setTests(d.tests));
  }

  useEffect(refresh, [subjectId]);

  function toggleNote(id) {
    setSelectedNoteIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function handleBuild(e) {
    e.preventDefault();
    setError("");
    setResult(null);
    if (!title.trim()) return setError("title is required");
    if (selectedNoteIds.length === 0) return setError("pick at least one note to build the test from");

    setBusy(true);
    try {
      const data = await api.createTest(subjectId, {
        title: title.trim(),
        noteIds: selectedNoteIds,
        mcqCount: Number(mcqCount),
        marksPerQuestion: Number(marksPerQuestion),
        durationMinutes: Number(durationMinutes),
      });
      setResult(data);
      setTitle("");
      setSelectedNoteIds([]);
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
        <h1 className="text-2xl font-semibold">Tests</h1>
        <Link to={`/subjects/${subjectId}`} className="text-sm font-semibold text-primary hover:underline">
          ← Back to notes
        </Link>
      </div>

      <form onSubmit={handleBuild} className="rounded-xl border border-black/10 bg-surface p-5 mb-8 space-y-4">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Test title, e.g. Neuro quiz 1"
          className="w-full rounded-lg border border-black/15 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        />

        <div>
          <p className="text-sm font-medium mb-2">Draw questions from these notes</p>
          {notes === null ? (
            <p className="text-sm text-ink-soft">Loading notes…</p>
          ) : notes.length === 0 ? (
            <p className="text-sm text-ink-soft">Add some notes to this subject first.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {notes.map((n) => (
                <label
                  key={n._id}
                  className={`text-sm px-3 py-1.5 rounded-full border cursor-pointer ${
                    selectedNoteIds.includes(n._id)
                      ? "bg-primary text-white border-primary"
                      : "border-black/15 hover:bg-page"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="hidden"
                    checked={selectedNoteIds.includes(n._id)}
                    onChange={() => toggleNote(n._id)}
                  />
                  {n.title}
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-ink-soft mb-1">Questions</label>
            <input
              type="number"
              min={1}
              max={20}
              value={mcqCount}
              onChange={(e) => setMcqCount(e.target.value)}
              className="w-full rounded-lg border border-black/15 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-ink-soft mb-1">Marks / question</label>
            <input
              type="number"
              min={1}
              value={marksPerQuestion}
              onChange={(e) => setMarksPerQuestion(e.target.value)}
              className="w-full rounded-lg border border-black/15 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-ink-soft mb-1">Duration (min)</label>
            <input
              type="number"
              min={1}
              value={durationMinutes}
              onChange={(e) => setDurationMinutes(e.target.value)}
              className="w-full rounded-lg border border-black/15 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <button
          disabled={busy}
          className="rounded-lg bg-primary text-white px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-60"
        >
          {busy ? "Generating…" : "Build test"}
        </button>

        {error && <p className="text-sm text-error">{error}</p>}
        {result && (
          <p className="text-sm text-secondary">
            Generated {result.accepted} question{result.accepted === 1 ? "" : "s"} grounded in your notes
            {result.discarded > 0 ? ` (${result.discarded} discarded — not supported by the source text)` : ""}.{" "}
            <span className="text-ink-soft">via {result.generatedBy === "llm" ? "LLM" : "rule-based fallback"}</span>
          </p>
        )}
      </form>

      {tests === null ? (
        <p className="text-sm text-ink-soft">Loading…</p>
      ) : tests.length === 0 ? (
        <p className="text-sm text-ink-soft">No tests yet — build one above.</p>
      ) : (
        <ul className="space-y-3">
          {tests.map((t) => (
            <li
              key={t._id}
              className="flex items-center justify-between rounded-xl border border-black/10 bg-surface p-4"
            >
              <div>
                <div className="font-semibold">{t.title}</div>
                <div className="text-xs text-ink-soft">
                  {t.durationMinutes} min · {t.marksPerQuestion} marks/question
                </div>
              </div>
              <Link
                to={`/tests/${t._id}/attempt`}
                className="text-sm font-semibold text-primary hover:underline"
              >
                Take test →
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
