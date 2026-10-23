import { useState } from "react";
import { api } from "../lib/api.js";
import { termsOf } from "../lib/noteFormat.js";
import Icon from "./Icon.jsx";

// A note's key terms under its title, and - for a note that is a topic in its
// own right (not a split document) - a way for the student to change them:
// add a term the note contains, or take one away. Saved with
// PUT /api/notes/:id/key-terms; the server ranks added terms first, never
// shows removed ones, and uses both in the next test (services/keyTermSignals.js).
// Each term says where it came from when it was not only the note's text:
// "yours", "AI" (suggested when the note was saved) or "syllabus".
// The page gives it key={note id}, so another note starts out of edit mode.

const SOURCE_LABEL = { you: "yours", ai: "AI", syllabus: "syllabus" };
const SHOWN = 10;
const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

function detailsOf(note) {
  if (Array.isArray(note?.keyTermDetails)) return note.keyTermDetails;
  return termsOf(note).map((term) => ({ term, sources: ["notes"] }));
}

export default function KeyTermEditor({ note, editable = true, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [add, setAdd] = useState([]);
  const [remove, setRemove] = useState([]);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const start = () => {
    setAdd([...(note?.keyTermMarks?.add || [])]);
    setRemove([...(note?.keyTermMarks?.remove || [])]);
    setInput("");
    setError("");
    setEditing(true);
  };

  const details = detailsOf(note);
  if (!details.length && !editable) return null;

  const shown = editing
    ? [
        ...add.filter((t) => !details.some((d) => same(d.term, t))).map((term) => ({ term, sources: ["you"] })),
        ...details.filter((d) => !remove.some((r) => same(r, d.term))),
      ]
    : details.slice(0, SHOWN);

  const takeAway = (term) => {
    if (add.some((t) => same(t, term))) setAdd(add.filter((t) => !same(t, term)));
    else if (!remove.some((t) => same(t, term))) setRemove([...remove, term]);
  };
  const putBack = (term) => setRemove(remove.filter((t) => !same(t, term)));
  const addTerm = () => {
    const term = input.trim().replace(/\s+/g, " ");
    if (!term) return;
    const text = `${note.title || ""}\n${note.rawText || ""}`.toLowerCase();
    if (!text.includes(term.toLowerCase())) {
      setError(`“${term}” is not in this note - a key term has to be written in it.`);
      return;
    }
    setError("");
    setInput("");
    if (remove.some((t) => same(t, term))) return putBack(term);
    if (!add.some((t) => same(t, term)) && !details.some((d) => same(d.term, term) && d.sources.includes("you"))) setAdd([...add, term]);
  };
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const out = await api.setKeyTerms(note._id, { add, remove });
      onSaved?.(out.note);
      setEditing(false);
    } catch (err) {
      setError(err.message || "Could not save the key terms.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-space-xs pt-space-2xs" data-testid="note-keywords">
      <div className="flex flex-wrap gap-space-xs items-center">
        {shown.map((d) => {
          const tags = d.sources.map((s) => SOURCE_LABEL[s]).filter(Boolean);
          return (
            <span
              key={d.term}
              title={tags.length ? `Key term from: ${tags.join(", ")}${d.sources.includes("notes") ? ", the note" : ""}` : "Key term found in the note"}
              className="inline-flex items-center gap-space-2xs px-space-sm py-space-2xs rounded font-label-md text-label-md font-semibold tracking-wide bg-topic-soft text-topic"
            >
              {d.term}
              {tags.length > 0 && <span className="font-label-sm text-label-sm font-normal opacity-70">· {tags.join(" · ")}</span>}
              {editing && (
                <button type="button" onClick={() => takeAway(d.term)} aria-label={`Remove ${d.term}`} className="ml-space-2xs hover:text-error">
                  <Icon name="close" className="text-sm" />
                </button>
              )}
            </span>
          );
        })}
        {editable && !editing && (
          <button
            type="button"
            onClick={start}
            data-testid="key-terms-edit"
            className="inline-flex items-center gap-space-2xs px-space-sm py-space-2xs rounded font-label-md text-label-md text-secondary hover:text-primary hover:bg-surface-container"
          >
            <Icon name="edit" className="text-sm" />
            {details.length ? "Edit key terms" : "Add key terms"}
          </button>
        )}
      </div>
      {editing && (
        <div className="flex flex-col gap-space-xs p-space-md rounded-lg bg-surface-container-low" data-testid="key-terms-editor">
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            Add a term exactly as it is written in this note, or remove one with ×. Your terms are asked about first in tests; removed ones are not used.
          </p>
          <div className="flex gap-space-xs flex-wrap">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTerm();
                }
              }}
              maxLength={80}
              placeholder="e.g. translation lookaside buffer"
              aria-label="Key term to add"
              className="flex-1 min-w-[12rem] h-9 px-space-sm rounded-lg bg-surface-container-lowest border border-outline-variant font-ui-body text-ui-body text-on-surface"
            />
            <button type="button" onClick={addTerm} data-testid="key-terms-add" className="h-9 px-space-md rounded-lg bg-surface-container-high text-primary font-semibold hover:bg-surface-container-highest">
              Add
            </button>
          </div>
          {remove.length > 0 && (
            <div className="flex flex-wrap gap-space-xs items-center font-label-md text-label-md text-on-surface-variant">
              <span>Removed:</span>
              {remove.map((t) => (
                <button key={t} type="button" onClick={() => putBack(t)} className="inline-flex items-center gap-space-2xs px-space-xs rounded line-through hover:no-underline hover:text-primary" title="Put back">
                  {t}
                  <Icon name="undo" className="text-sm" />
                </button>
              ))}
            </div>
          )}
          {error && <p className="font-body-sm text-body-sm text-error" role="alert">{error}</p>}
          <div className="flex gap-space-xs justify-end">
            <button type="button" onClick={() => setEditing(false)} disabled={saving} className="h-8 px-space-md rounded-lg text-on-surface-variant hover:bg-surface-container">
              Cancel
            </button>
            <button type="button" onClick={save} disabled={saving} data-testid="key-terms-save" className="h-8 px-space-md rounded-lg bg-primary text-on-primary font-semibold hover:opacity-90 disabled:opacity-60">
              {saving ? "Saving…" : "Save key terms"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
