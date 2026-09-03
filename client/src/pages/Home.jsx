import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";

export default function Home() {
  const [subjects, setSubjects] = useState(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function refresh() {
    api.listSubjects().then((d) => setSubjects(d.subjects));
  }

  useEffect(refresh, []);

  async function handleCreate(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError("");
    try {
      await api.createSubject(name.trim());
      setName("");
      refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-1">Your subjects</h1>
      <p className="text-ink-soft mb-6">
        Each subject is its own knowledge graph. Add notes to a subject and Mind Atlas links the related ones automatically.
      </p>

      <form onSubmit={handleCreate} className="flex gap-2 mb-8 max-w-md">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Neuroscience"
          className="flex-1 rounded-lg border border-black/15 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        <button
          disabled={busy}
          className="rounded-lg bg-primary text-white px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-60"
        >
          New subject
        </button>
      </form>
      {error && <p className="text-sm text-error mb-4">{error}</p>}

      {subjects === null ? (
        <p className="text-ink-soft text-sm">Loading…</p>
      ) : subjects.length === 0 ? (
        <p className="text-ink-soft text-sm">No subjects yet — create your first one above.</p>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {subjects.map((s) => (
            <Link
              key={s._id}
              to={`/subjects/${s._id}`}
              className="block rounded-xl border border-black/10 bg-surface p-5 hover:shadow-sm hover:border-primary/30 transition"
            >
              <div className="w-9 h-9 rounded-lg bg-secondary-container text-secondary grid place-items-center font-semibold mb-3">
                {s.name.slice(0, 1).toUpperCase()}
              </div>
              <div className="font-semibold">{s.name}</div>
              <div className="text-xs text-ink-soft mt-1">
                Created {new Date(s.createdAt).toLocaleDateString()}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
