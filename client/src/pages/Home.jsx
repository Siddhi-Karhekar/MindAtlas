import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api.js";
import { useAuth } from "../lib/AuthContext.jsx";
import { forgetSubject, getLastSubject, getSubjectVisits, setLastSubject } from "../lib/recent.js";
import { timeAgo } from "../lib/format.js";
import Icon from "../components/Icon.jsx";
import Ring from "../components/Ring.jsx";
import { isSplitParent } from "../lib/notes.js";

const ICONS = ["psychology", "lan", "balance", "biotech", "science", "calculate", "history_edu", "menu_book", "public", "architecture"];
function iconFor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ICONS[h % ICONS.length];
}

// Summarise one subject from its graph payload: how many notes, how many of
// them have at least one link to another note, and when the newest one landed.
// A split document counts as one note here; its subtopics are what can be
// linked, and document -> subtopic "contains" edges are structure, not links.
function summarise(subject, graph) {
  const nodes = graph?.nodes || [];
  const edges = (graph?.edges || []).filter((e) => e.edgeType !== "contains");
  const topLevel = nodes.filter((n) => !n.parentNoteId);
  const topics = nodes.filter((n) => !isSplitParent(n));
  const linked = new Set();
  for (const e of edges) {
    linked.add(String(e.source));
    linked.add(String(e.target));
  }
  const latest = [...topLevel].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
  return {
    subject,
    noteCount: topLevel.length,
    edgeCount: edges.length,
    linkedPct: topics.length ? Math.round((linked.size / topics.length) * 100) : 0,
    latest,
  };
}

export default function Home() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [group, setGroup] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(null);
  const [organising, setOrganising] = useState(false);
  const [deleting, setDeleting] = useState(null); // subject id awaiting confirmation

  async function load() {
    api.getRevision().then(setRevision).catch(() => setRevision(null));
    try {
      const { subjects } = await api.listSubjects();
      const graphs = await Promise.all(
        subjects.map((s) => api.getGraph(s._id).catch(() => ({ nodes: [], edges: [] })))
      );
      setRows(subjects.map((s, i) => summarise(s, graphs[i])));
    } catch (err) {
      setError(err.message);
      setRows([]);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleCreate(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const { subject } = await api.createSubject(name.trim(), group.trim() || undefined);
      setName("");
      setGroup("");
      setLastSubject(subject._id);
      navigate(`/subjects/${subject._id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // A new student's first minute: a ready-made subject from a real set of
  // lecture notes, split into topics and linked, to try a test on at once.
  async function handleDemo() {
    setBusy(true);
    setError("");
    try {
      const { default: content } = await import("../lib/demoNotes.md?raw");
      const { subject } = await api.createSubject("Sample: Computer Networks", "Sample");
      await api.createNote(subject._id, { title: "Computer Networks - Unit 2", content });
      setLastSubject(subject._id);
      navigate(`/subjects/${subject._id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeSubject(subjectId) {
    try {
      await api.deleteSubject(subjectId);
      setDeleting(null);
      setRows((list) => list.filter((r) => r.subject._id !== subjectId));
      forgetSubject(subjectId);
      api.getRevision().then(setRevision).catch(() => setRevision(null));
    } catch (err) {
      setError(err.message);
    }
  }

  async function moveTo(subjectId, folder) {
    try {
      const { subject } = await api.updateSubject(subjectId, { group: folder });
      setRows((list) => list.map((r) => (r.subject._id === subjectId ? { ...r, subject } : r)));
    } catch (err) {
      setError(err.message);
    }
  }

  const visits = getSubjectVisits();
  const lastActive = (r) => visits[r.subject._id] || new Date(r.latest?.createdAt || r.subject.createdAt).getTime();

  const hero = useMemo(() => {
    if (!rows || rows.length === 0) return null;
    const remembered = rows.find((r) => r.subject._id === getLastSubject());
    return remembered || [...rows].sort((a, b) => lastActive(b) - lastActive(a))[0];
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const totals = useMemo(() => {
    const r = rows || [];
    return {
      subjects: r.length,
      notes: r.reduce((n, x) => n + x.noteCount, 0),
      links: r.reduce((n, x) => n + x.edgeCount, 0),
    };
  }, [rows]);

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  // subjects by folder (a semester, a year); folders A-Z, unfiled last
  const folders = useMemo(() => {
    const byFolder = new Map();
    for (const r of rows || []) {
      const key = r.subject.group || "";
      if (!byFolder.has(key)) byFolder.set(key, []);
      byFolder.get(key).push(r);
    }
    return [...byFolder.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, undefined, { numeric: true })));
  }, [rows]);
  const folderNames = folders.map(([f]) => f).filter(Boolean);

  return (
    <div className="flex flex-col w-full">
      <section className="flex items-center justify-between py-space-sm px-space-md mb-space-lg bg-surface-container-low rounded-lg shadow-sm">
        <div className="flex items-center gap-space-sm">
          <div className="w-7 h-7 rounded-full bg-tertiary-fixed flex items-center justify-center text-tertiary">
            <Icon name="hub" filled className="text-sm" />
          </div>
          <div className="flex items-center gap-space-xs text-on-surface-variant font-label-md text-label-md tracking-normal flex-wrap">
            <span className="text-on-surface font-semibold">{plural(totals.subjects, "subject")}</span>
            <span className="text-outline-variant font-normal">•</span>
            <span>{plural(totals.notes, "note")}</span>
            <span className="text-outline-variant font-normal">•</span>
            <span>{plural(totals.links, "connection")} found</span>
          </div>
        </div>
        <div className="hidden sm:flex items-center gap-space-xs text-secondary">
          <span className="w-2 h-2 rounded-full bg-secondary"></span>
          <span className="font-label-md text-label-md tracking-wider">{user?.email}</span>
        </div>
      </section>

      {rows === null && <p className="text-on-surface-variant font-body-md">Loading…</p>}

      {hero && (
        <section className="relative w-full mb-space-2xl">
          <div className="relative bg-surface-container-lowest rounded-xl p-space-xl shadow-sm overflow-hidden group">
            <div className="absolute -right-16 -top-16 w-80 h-80 rounded-full bg-secondary-container/40 blur-3xl pointer-events-none"></div>
            <div className="relative flex flex-col md:flex-row md:items-center justify-between gap-space-xl">
              <div className="flex-1 max-w-2xl">
                <div className="flex items-center gap-space-sm mb-space-sm flex-wrap">
                  <span className="px-space-sm py-space-2xs rounded bg-surface-container-high text-primary font-label-md text-label-md">
                    Continue where you left off
                  </span>
                  <span className="font-ui-body text-ui-body text-on-surface-variant">
                    Last opened {timeAgo(lastActive(hero))}
                  </span>
                </div>
                <h2 className="font-headline-lg text-headline-lg text-on-surface mb-space-xs tracking-tight">
                  {hero.subject.name}
                </h2>
                <p className="font-body-md text-body-md text-on-surface-variant line-clamp-2 max-w-xl">
                  {hero.latest
                    ? `Latest note: “${hero.latest.title}”${hero.latest.keywords?.length ? ` — ${hero.latest.keywords.slice(0, 5).join(", ")}` : ""}.`
                    : "No notes yet. Add your first note and Mind Atlas will start linking related ideas."}
                </p>
                <div className="mt-space-lg flex items-center gap-space-md max-w-md">
                  <div className="flex-1 h-1.5 bg-surface-container-high rounded-full overflow-hidden">
                    <div
                      className="h-full bg-secondary rounded-full transition-all duration-700"
                      style={{ width: `${hero.linkedPct}%` }}
                    ></div>
                  </div>
                  <span className="font-label-md text-label-md text-on-surface font-semibold whitespace-nowrap">
                    {hero.linkedPct}% of notes linked
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-space-sm shrink-0">
                <Link
                  to={`/subjects/${hero.subject._id}`}
                  className="px-space-md py-space-sm rounded-lg text-primary hover:bg-surface-container-high transition-colors font-ui-title text-ui-title flex items-center gap-space-xs"
                >
                  <Icon name="auto_stories" className="text-base" />
                  <span>Open notes</span>
                </Link>
                <Link
                  to={`/subjects/${hero.subject._id}/tests`}
                  className="px-space-lg py-space-sm rounded-lg bg-primary text-on-primary font-ui-title text-ui-title shadow-sm hover:opacity-90 transition-all flex items-center gap-space-xs"
                >
                  <span>Tests</span>
                  <Icon name="arrow_forward" className="text-base" />
                </Link>
              </div>
            </div>
          </div>
        </section>
      )}

      {revision && (revision.streak.days > 0 || revision.due.length > 0) && (
        <section className="mb-space-2xl bg-surface-container-lowest rounded-xl p-space-lg shadow-sm flex flex-col md:flex-row gap-space-lg" data-testid="revision-card">
          <div className="flex items-center gap-space-md md:w-64 shrink-0">
            <Icon name="local_fire_department" className="text-tertiary text-[32px]" />
            <div>
              <p className="font-headline-sm text-headline-sm text-on-surface">
                {revision.streak.days > 0 ? `${plural(revision.streak.days, "day")} in a row` : "Start a streak"}
              </p>
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                {revision.streak.today
                  ? "You finished a test today - nice work."
                  : revision.streak.days > 0
                    ? "Finish a test today to keep it going."
                    : "Finish a test today to start one."}
              </p>
            </div>
          </div>
          {revision.due.length > 0 && (
            <div className="flex-1 flex flex-col gap-space-xs">
              <p className="font-label-md text-label-md uppercase tracking-wider text-secondary">Worth revising next</p>
              <ul className="flex flex-col gap-space-2xs">
                {revision.due.map((d) => (
                  <li key={d.topicId}>
                    <Link
                      to={`/subjects/${d.subjectId}/tests?topic=${d.topicId}`}
                      className="flex items-center justify-between gap-space-md px-space-md py-space-xs rounded-lg bg-surface-container-low hover:bg-surface-container"
                    >
                      <span className="font-ui-body text-ui-body text-on-surface truncate">
                        {d.topic} <span className="text-on-surface-variant">· {d.subject}</span>
                      </span>
                      <span className="font-label-sm text-label-sm text-on-surface-variant shrink-0">
                        {d.reason === "shaky" ? `${Math.round(d.pKnown * 100)}% so far - practise it` : `last practised ${d.daysSince} days ago`}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {rows && (
        <>
          <section className="flex items-baseline justify-between mb-space-md px-space-xs">
            <div className="flex items-center gap-space-sm">
              <span className="font-label-sm text-label-sm uppercase tracking-widest text-on-surface-variant font-bold">
                Workspace Indices
              </span>
              <span className="text-outline-variant text-label-md font-body-sm">
                — {rows.length === 0 ? "no subjects yet" : plural(rows.length, "subject")}
              </span>
            </div>
          </section>

          {rows.length === 0 && (
            <section className="mb-space-lg p-space-xl rounded-xl bg-surface-container-lowest shadow-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-space-md" data-testid="demo-offer">
              <div className="flex items-start gap-space-md">
                <Icon name="school" className="text-secondary text-[32px]" />
                <div>
                  <p className="font-ui-title text-ui-title text-on-surface font-semibold">New here? Try a sample subject first.</p>
                  <p className="font-body-sm text-body-sm text-on-surface-variant max-w-xl">
                    A set of Computer Networks lecture notes, split into topics and linked for you - build a test from it in a
                    minute and see how feedback works. Delete it whenever you like (Organise into folders, below).
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleDemo}
                disabled={busy}
                data-testid="try-demo"
                className="px-space-lg py-space-sm rounded-lg bg-primary text-on-primary font-ui-title text-ui-title shadow-sm hover:opacity-90 disabled:opacity-50 shrink-0"
              >
                {busy ? "Setting it up…" : "Try the sample"}
              </button>
            </section>
          )}

          {folders.map(([folder, list]) => (
            <section key={folder || "-"} className="mb-space-lg flex flex-col gap-space-sm">
              {folderNames.length > 0 && (
                <h3 className="font-label-md text-label-md uppercase tracking-widest text-on-surface-variant font-bold px-space-xs flex items-center gap-space-xs">
                  <Icon name="folder" className="text-sm" />
                  {folder || "Not in a folder"}
                </h3>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-space-md">
              {[...list]
                .sort((a, b) => lastActive(b) - lastActive(a))
                .map((r) => (
                  <Link
                    key={r.subject._id}
                    to={`/subjects/${r.subject._id}`}
                    className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm hover:shadow-md transition-shadow flex flex-col justify-between h-56 group"
                  >
                    <div>
                      <div className="flex items-center justify-between mb-space-sm">
                        <span className="w-8 h-8 rounded-lg bg-surface-container-low flex items-center justify-center text-primary group-hover:bg-secondary-container transition-colors">
                          <Icon name={iconFor(r.subject.name)} className="text-lg" />
                        </span>
                        <span title={`${r.linkedPct}% of notes linked to another note`}>
                          <Ring value={r.linkedPct}>
                            <span className="font-label-sm text-label-sm text-on-surface">{r.linkedPct}</span>
                          </Ring>
                        </span>
                      </div>
                      <h3 className="font-ui-title text-ui-title text-on-surface group-hover:text-secondary transition-colors mb-space-2xs">
                        {r.subject.name}
                      </h3>
                      <p className="font-label-md text-label-md text-on-surface-variant font-medium">
                        {plural(r.noteCount, "note")}
                      </p>
                    </div>
                    <div className="pt-space-sm flex items-center justify-between font-label-md text-label-md text-on-surface-variant">
                      <span>{r.latest ? `Updated ${timeAgo(r.latest.createdAt)}` : `Created ${timeAgo(r.subject.createdAt)}`}</span>
                      <Icon
                        name="arrow_forward"
                        className="text-base opacity-0 group-hover:opacity-100 transition-opacity text-primary"
                      />
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          ))}

          {rows.length > 0 && (
            <div className="mb-space-md px-space-xs">
              <button
                type="button"
                onClick={() => setOrganising((o) => !o)}
                className="font-label-md text-label-md text-secondary hover:underline flex items-center gap-space-xs"
                data-testid="organise"
              >
                <Icon name="drive_file_move" className="text-sm" />
                {organising ? "Done organising" : "Organise into folders (semesters, years…), or delete a subject"}
              </button>
              {organising && (
                <div className="mt-space-sm flex flex-col gap-space-xs p-space-md rounded-xl bg-surface-container-low">
                  {rows.map((r) => (
                    <div key={r.subject._id} className="flex flex-col gap-space-2xs">
                    <label className="flex items-center justify-between gap-space-md font-ui-body text-ui-body text-on-surface">
                      <span className="truncate flex-1">{r.subject.name}</span>
                      <input
                        defaultValue={r.subject.group || ""}
                        list="folder-names"
                        maxLength={60}
                        placeholder="No folder"
                        aria-label={`Folder for ${r.subject.name}`}
                        onBlur={(e) => {
                          if (e.target.value.trim() !== (r.subject.group || "")) moveTo(r.subject._id, e.target.value.trim());
                        }}
                        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                        className="w-48 bg-surface-container-lowest px-space-sm py-space-2xs rounded-lg text-on-surface placeholder:text-outline"
                      />
                      <button
                        type="button"
                        onClick={() => setDeleting(r.subject._id)}
                        aria-label={`Delete ${r.subject.name}`}
                        data-testid="delete-subject"
                        className="text-on-surface-variant hover:text-error"
                      >
                        <Icon name="delete" className="text-base" />
                      </button>
                    </label>
                    {deleting === r.subject._id && (
                      <div className="flex items-center justify-end gap-space-sm font-body-sm text-body-sm" role="alert">
                        <span className="text-error">Delete “{r.subject.name}” with all its notes, tests and results? This cannot be undone.</span>
                        <button type="button" onClick={() => removeSubject(r.subject._id)} className="px-space-sm py-space-2xs rounded bg-error-container text-on-error-container" data-testid="confirm-delete-subject">
                          Delete
                        </button>
                        <button type="button" onClick={() => setDeleting(null)} className="px-space-sm py-space-2xs rounded hover:bg-surface-container-high">
                          Cancel
                        </button>
                      </div>
                    )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <datalist id="folder-names">
            {folderNames.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>

          <section className="mt-space-xl p-space-md rounded-xl bg-surface-container-low flex flex-col sm:flex-row items-center justify-between gap-space-md">
            <div className="flex items-center gap-space-md">
              <Icon name="stylus_note" className="text-secondary" />
              <div>
                <p className="font-ui-title text-ui-title text-on-surface font-semibold">Starting on something new?</p>
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  Each subject is its own knowledge graph — notes you add are linked to related ones automatically.
                </p>
              </div>
            </div>
            <form onSubmit={handleCreate} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-space-sm w-full sm:w-auto">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-label="New subject name"
                className="bg-surface-container-lowest px-space-md py-space-xs rounded-lg font-ui-body text-ui-body text-on-surface placeholder:text-outline focus:outline-none focus:ring-2 focus:ring-primary/20 w-full sm:w-56 shadow-inner"
                placeholder="e.g. Neuroscience"
              />
              <input
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                list="folder-names"
                maxLength={60}
                aria-label="Folder (optional)"
                className="bg-surface-container-lowest px-space-md py-space-xs rounded-lg font-ui-body text-ui-body text-on-surface placeholder:text-outline focus:outline-none focus:ring-2 focus:ring-primary/20 w-full sm:w-40 shadow-inner"
                placeholder="Folder (optional)"
              />
              <button
                disabled={busy || !name.trim()}
                className="px-space-md py-space-xs rounded-lg bg-surface-container-high text-primary hover:bg-primary hover:text-on-primary transition-colors font-label-md text-label-md shrink-0 disabled:opacity-50"
              >
                New subject
              </button>
            </form>
          </section>
          {error && <p className="mt-space-md font-body-sm text-body-sm text-error">{error}</p>}
        </>
      )}
    </div>
  );
}
