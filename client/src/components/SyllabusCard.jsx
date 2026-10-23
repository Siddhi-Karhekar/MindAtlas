import { useState } from "react";
import { api } from "../lib/api.js";
import Icon from "./Icon.jsx";

// The subject's syllabus: its topics as plain text ("Unit 3: paging,
// segmentation, deadlocks ..."). Terms of this subject's notes that the
// syllabus names rank higher as key terms, and so are asked about first
// (server: services/keyTermSignals.js). Saved with PATCH /api/subjects/:id.

const MAX = 20_000;

export default function SyllabusCard({ subject, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  if (!subject) return null;

  const current = subject.syllabus || "";
  const lines = current.split(/\n+/).filter((l) => l.trim()).length;

  const save = async (value) => {
    setSaving(true);
    setError("");
    try {
      const out = await api.updateSubject(subject._id, { syllabus: value });
      onSaved?.(out.subject);
      setEditing(false);
    } catch (err) {
      setError(err.message || "Could not save the syllabus.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-space-md rounded-xl bg-surface-container-low flex flex-col gap-space-sm" data-testid="syllabus-card">
      <div className="flex items-center justify-between gap-space-xs">
        <span className="font-label-sm text-label-sm uppercase tracking-widest text-on-surface-variant">Syllabus</span>
        {!editing && (
          <button
            type="button"
            onClick={() => {
              setText(current);
              setError("");
              setEditing(true);
            }}
            data-testid="syllabus-edit"
            className="inline-flex items-center gap-space-2xs font-label-md text-label-md text-secondary hover:text-primary"
          >
            <Icon name={current ? "edit" : "add"} className="text-sm" />
            {current ? "Edit" : "Add"}
          </button>
        )}
      </div>
      {!editing &&
        (current ? (
          <p className="font-body-sm text-body-sm text-on-surface-variant line-clamp-3 whitespace-pre-line">{current}</p>
        ) : (
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            Paste the course topics, and terms they name are asked about first.
          </p>
        ))}
      {!editing && current && (
        <span className="font-label-sm text-label-sm text-on-surface-variant">
          {lines} {lines === 1 ? "line" : "lines"} · used to rank key terms
        </span>
      )}
      {editing && (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={MAX}
            rows={6}
            aria-label="Syllabus"
            placeholder={"Unit 3: Memory management - paging, page table, TLB, segmentation\nUnit 4: Deadlocks - conditions, prevention, banker's algorithm"}
            className="w-full p-space-sm rounded-lg bg-surface-container-lowest border border-outline-variant font-body-sm text-body-sm text-on-surface"
          />
          {error && <p className="font-body-sm text-body-sm text-error" role="alert">{error}</p>}
          <div className="flex gap-space-xs justify-end flex-wrap">
            {current && (
              <button type="button" onClick={() => save("")} disabled={saving} className="h-8 px-space-sm rounded-lg text-error hover:bg-surface-container mr-auto">
                Clear
              </button>
            )}
            <button type="button" onClick={() => setEditing(false)} disabled={saving} className="h-8 px-space-sm rounded-lg text-on-surface-variant hover:bg-surface-container">
              Cancel
            </button>
            <button type="button" onClick={() => save(text)} disabled={saving} data-testid="syllabus-save" className="h-8 px-space-md rounded-lg bg-primary text-on-primary font-semibold hover:opacity-90 disabled:opacity-60">
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
