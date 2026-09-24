import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { formatDate, readingMinutes, timeAgo, wordCount } from "../lib/format.js";
import Icon from "../components/Icon.jsx";

const CHIP_STYLES = [
  "bg-surface-container text-primary",
  "bg-secondary-container text-on-secondary-container",
  "bg-surface-variant text-on-surface-variant",
  "bg-tertiary-fixed text-on-tertiary-fixed",
];

const SOURCE_LABEL = { typed: "Typed note", image: "Scanned image", file: "Uploaded file" };
const FILE_LABEL = { pdf: "PDF", docx: "Word document", text: "Text file", image: "Scanned image" };

function sourceLabel(note) {
  const kind = FILE_LABEL[note.fileType] || SOURCE_LABEL[note.sourceType] || note.sourceType;
  if (!note.sourceFile) return kind;
  const section = typeof note.sectionIndex === "number" ? ` §${note.sectionIndex + 1}` : "";
  return `${kind} · ${note.sourceFile}${section}`;
}

export default function SubjectWorkspace() {
  const { subjectId } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const justAdded = location.state?.edgesCreated;
  const [subject, setSubject] = useState(null);
  const [notes, setNotes] = useState(null);
  const [graph, setGraph] = useState({ nodes: [], edges: [] });
  const [error, setError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [textbooks, setTextbooks] = useState([]);
  const [bookUpload, setBookUpload] = useState({ busy: false, message: "", error: "" });
  const [passages, setPassages] = useState({}); // chunkId -> passage | "loading" | { error }

  useEffect(() => {
    setNotes(null);
    setError("");
    Promise.all([api.listSubjects(), api.listNotes(subjectId), api.getGraph(subjectId)])
      .then(([s, n, g]) => {
        setSubject(s.subjects.find((x) => String(x._id) === String(subjectId)) || null);
        setNotes(n.notes);
        setGraph(g);
      })
      .catch((err) => {
        setError(err.message);
        setNotes([]);
      });
    api.listTextbooks(subjectId).then((d) => setTextbooks(d.textbooks)).catch(() => setTextbooks([]));
  }, [subjectId]);

  async function handleTextbookUpload(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBookUpload({ busy: true, message: "", error: "" });
    try {
      const r = await api.uploadTextbook(subjectId, file);
      const [t, n] = await Promise.all([api.listTextbooks(subjectId), api.listNotes(subjectId)]);
      setTextbooks(t.textbooks);
      setNotes(n.notes); // notes were re-linked to the new book's passages
      setBookUpload({
        busy: false,
        error: "",
        message: `Indexed ${r.chunkCount} passages — ${r.notesLinked} ${r.notesLinked === 1 ? "note" : "notes"} linked.`,
      });
    } catch (err) {
      setBookUpload({ busy: false, message: "", error: err.message });
    }
  }

  async function togglePassage(ref) {
    if (passages[ref.chunkId]) {
      setPassages((p) => {
        const next = { ...p };
        delete next[ref.chunkId];
        return next;
      });
      return;
    }
    setPassages((p) => ({ ...p, [ref.chunkId]: "loading" }));
    try {
      const { chunk } = await api.getTextbookPassage(ref.textbookId, ref.chunkId);
      setPassages((p) => ({ ...p, [ref.chunkId]: chunk }));
    } catch (err) {
      setPassages((p) => ({ ...p, [ref.chunkId]: { error: err.message } }));
    }
  }

  // Newest first, but the sections of one split document stay in their
  // original reading order.
  const sorted = useMemo(
    () =>
      [...(notes || [])].sort((a, b) => {
        if (a.sourceFile && a.sourceFile === b.sourceFile && typeof a.sectionIndex === "number" && typeof b.sectionIndex === "number") {
          return a.sectionIndex - b.sectionIndex;
        }
        return new Date(b.createdAt) - new Date(a.createdAt);
      }),
    [notes]
  );
  const selectedId = params.get("note");
  const selected = sorted.find((n) => String(n._id) === selectedId) || sorted[0] || null;

  const titleById = useMemo(() => new Map(graph.nodes.map((n) => [String(n.id), n.title])), [graph]);

  // Neighbours of the selected note, strongest link first.
  const neighbours = useMemo(() => {
    if (!selected) return [];
    const id = String(selected._id);
    return graph.edges
      .filter((e) => String(e.source) === id || String(e.target) === id)
      .map((e) => ({
        id: String(e.source) === id ? String(e.target) : String(e.source),
        weight: e.weight,
        shared: e.sharedKeywords || [],
      }))
      .sort((a, b) => b.weight - a.weight);
  }, [graph, selected]);

  const linkedCount = useMemo(() => {
    const s = new Set();
    graph.edges.forEach((e) => {
      s.add(String(e.source));
      s.add(String(e.target));
    });
    return s.size;
  }, [graph]);

  const totalWords = useMemo(() => (notes || []).reduce((n, x) => n + wordCount(x.rawText), 0), [notes]);
  const linkedPct = notes?.length ? Math.round((linkedCount / notes.length) * 100) : 0;

  const paragraphs = selected ? selected.rawText.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean) : [];

  return (
    <div className="flex flex-col w-full">
      <div className="flex items-center justify-between pb-space-lg mb-space-base gap-space-md flex-wrap">
        <div className="flex items-center gap-space-md min-w-0">
          <div className="flex items-center gap-space-xs font-label-md text-label-md text-on-surface-variant uppercase tracking-wider">
            <Link to="/" className="px-space-xs py-space-2xs rounded bg-surface-container text-secondary font-ui-title text-label-sm font-semibold hover:text-primary">
              Subject Index
            </Link>
            <span>/</span>
            <span className="text-tertiary font-medium">{notes ? `${notes.length} ${notes.length === 1 ? "note" : "notes"}` : "…"}</span>
          </div>
          <span className="w-1.5 h-1.5 rounded-full bg-secondary-fixed-dim"></span>
          <h1 className="font-headline-md text-headline-md text-on-surface truncate">{subject?.name || "Subject"}</h1>
        </div>
        <div className="flex items-center gap-space-md">
          <div className="inline-flex p-space-2xs rounded-lg bg-surface-container-high">
            <span className="px-space-md py-space-xs rounded font-ui-body text-ui-body font-semibold bg-surface-container-lowest text-primary shadow-sm flex items-center gap-space-xs">
              <Icon name="article" className="text-base" />
              <span>Note view</span>
            </span>
            <Link
              to={`/subjects/${subjectId}/graph`}
              className="px-space-md py-space-xs rounded font-ui-body text-ui-body font-medium text-on-surface-variant hover:text-on-surface flex items-center gap-space-xs"
            >
              <Icon name="hub" className="text-base" />
              <span>Graph view</span>
            </Link>
          </div>
          <Link
            to={`/subjects/${subjectId}/progress`}
            className="px-space-md py-space-xs rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors font-ui-body text-ui-body font-medium flex items-center gap-space-xs"
          >
            <Icon name="lightbulb" className="text-base" />
            <span>Progress</span>
          </Link>
          <Link
            to={`/subjects/${subjectId}/tests`}
            className="px-space-md py-space-xs rounded-lg bg-surface-container-high text-primary hover:bg-primary hover:text-on-primary transition-colors font-ui-body text-ui-body font-medium flex items-center gap-space-xs"
          >
            <Icon name="fact_check" className="text-base" />
            <span>Tests</span>
          </Link>
        </div>
      </div>

      {error && <p className="font-body-sm text-body-sm text-error mb-space-md">{error}</p>}
      {typeof justAdded === "number" && (
        <div className="flex items-center gap-space-sm py-space-sm px-space-md mb-space-lg bg-secondary-container/50 text-on-secondary-container rounded-lg font-label-md text-label-md">
          <Icon name="check_circle" filled className="text-base" />
          <span>
            {(() => {
              const n = location.state?.addedCount || 1;
              const what = n > 1 ? `${n} notes added` : "Note added";
              return justAdded > 0
                ? `${what} — ${justAdded} new link${justAdded > 1 ? "s" : ""} to related notes.`
                : `${what} — no strongly related notes yet.`;
            })()}
          </span>
        </div>
      )}

      <div className="grid grid-cols-12 gap-space-xl items-start">
        {/* Note shelf */}
        <aside className="col-span-12 lg:col-span-3 flex flex-col gap-space-md">
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className="w-full flex items-center justify-between px-space-md py-space-sm rounded-lg bg-primary text-on-primary font-ui-body text-ui-body hover:opacity-90 transition-colors shadow-sm"
            >
              <span className="flex items-center gap-space-xs">
                <Icon name="add" className="text-sm" />
                <span className="font-medium">New Record</span>
              </span>
              <Icon name="expand_more" className="text-sm text-on-primary/70" />
            </button>
            {menuOpen && (
              <div className="absolute top-full left-0 mt-space-xs w-full bg-surface-container-lowest rounded-xl shadow-xl z-30 p-space-xs flex flex-col gap-space-2xs">
                <button
                  type="button"
                  onClick={() => navigate(`/subjects/${subjectId}/new`)}
                  className="w-full flex items-center gap-space-md px-space-md py-space-sm rounded-lg text-left text-on-surface hover:bg-surface-container transition-colors font-ui-body text-ui-body"
                >
                  <Icon name="edit_note" className="text-base text-secondary" />
                  <div>
                    <p className="font-semibold leading-tight">Typed Note</p>
                    <p className="text-on-surface-variant text-label-sm font-label-sm">Write or paste your text</p>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => navigate(`/subjects/${subjectId}/new?mode=upload`)}
                  className="w-full flex items-center gap-space-md px-space-md py-space-sm rounded-lg text-left text-on-surface hover:bg-surface-container transition-colors font-ui-body text-ui-body"
                >
                  <Icon name="upload_file" className="text-base text-secondary" />
                  <div>
                    <p className="font-semibold leading-tight">Upload Notes</p>
                    <p className="text-on-surface-variant text-label-sm font-label-sm">PDF, Word, text, or photos</p>
                  </div>
                </button>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between px-space-xs pt-space-xs font-label-md text-label-md text-on-surface-variant tracking-wider uppercase">
            <span>Curated Folio ({notes?.length ?? 0})</span>
          </div>

          <div className="flex flex-col gap-space-xs">
            {notes === null && <p className="font-body-sm text-body-sm text-on-surface-variant px-space-xs">Loading…</p>}
            {sorted.map((n) => {
              const active = selected && String(n._id) === String(selected._id);
              return (
                <button
                  type="button"
                  key={n._id}
                  onClick={() => setParams({ note: n._id })}
                  className={`text-left group relative p-space-md rounded-xl transition-all ${
                    active
                      ? "bg-surface-container-lowest shadow-sm"
                      : "bg-surface-container-low hover:bg-surface-container"
                  }`}
                >
                  {active && <div className="absolute left-0 top-3 bottom-3 w-1 bg-secondary rounded-r"></div>}
                  <div className={active ? "pl-space-xs" : ""}>
                    <div className="flex items-center justify-between gap-space-xs mb-space-2xs">
                      <h3 className={`font-ui-title text-ui-title text-on-surface truncate ${active ? "font-semibold" : "font-medium"}`}>
                        {n.title}
                      </h3>
                      <span className="font-label-sm text-label-sm text-on-surface-variant shrink-0">{timeAgo(n.createdAt)}</span>
                    </div>
                    <p className="font-body-sm text-body-sm text-on-surface-variant line-clamp-2">{n.rawText}</p>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="mt-space-lg p-space-md rounded-xl bg-surface-container-low flex flex-col gap-space-sm">
            <span className="font-label-sm text-label-sm uppercase tracking-widest text-on-surface-variant">Reference Textbooks</span>
            {textbooks.length === 0 && (
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                Add a textbook and each note links to the pages that cover the same topic.
              </p>
            )}
            {textbooks.map((t) => (
              <div key={t._id} className="flex items-start gap-space-xs">
                <Icon name="menu_book" className="text-base text-secondary mt-[2px]" />
                <div className="min-w-0">
                  <p className="font-ui-body text-ui-body text-on-surface font-medium truncate" title={t.title}>{t.title}</p>
                  <p className="font-label-sm text-label-sm text-on-surface-variant">
                    {t.pageCount ? `${t.pageCount} pages · ` : ""}
                    {t.chunkCount} passages
                  </p>
                </div>
              </div>
            ))}
            <label
              className={`font-ui-body text-ui-body text-secondary hover:text-primary font-medium flex items-center gap-space-2xs ${
                bookUpload.busy ? "opacity-60 pointer-events-none" : "cursor-pointer"
              }`}
            >
              <Icon name={bookUpload.busy ? "sync" : "upload_file"} className={`text-sm ${bookUpload.busy ? "animate-spin" : ""}`} />
              <span>{bookUpload.busy ? "Indexing textbook…" : "Add a textbook"}</span>
              <input
                type="file"
                accept=".pdf,.docx,.txt,.md"
                className="sr-only"
                onChange={handleTextbookUpload}
                disabled={bookUpload.busy}
              />
            </label>
            {bookUpload.message && <p className="font-label-md text-label-md text-on-surface-variant">{bookUpload.message}</p>}
            {bookUpload.error && <p role="alert" className="font-label-md text-label-md text-error">{bookUpload.error}</p>}
          </div>

          {notes && notes.length > 0 && (
            <div className="p-space-md rounded-xl bg-surface-container-low flex flex-col gap-space-sm">
              <span className="font-label-sm text-label-sm uppercase tracking-widest text-on-surface-variant">Archival Density</span>
              <div className="flex items-baseline gap-space-xs">
                <span className="font-headline-md text-headline-md font-semibold text-primary">
                  {totalWords.toLocaleString()}
                </span>
                <span className="font-ui-body text-ui-body text-on-surface-variant">words across your notes</span>
              </div>
              <div className="w-full h-1.5 rounded-full bg-surface-container-high overflow-hidden">
                <div className="h-full bg-secondary-fixed-dim rounded-full" style={{ width: `${linkedPct}%` }}></div>
              </div>
              <span className="font-label-md text-label-md text-on-surface-variant">
                {linkedCount} of {notes.length} notes linked
              </span>
            </div>
          )}
        </aside>

        {/* Reading pane */}
        <div className="col-span-12 lg:col-span-9 xl:col-span-6 flex justify-center">
          {selected ? (
            <article className="w-full max-w-[720px] bg-surface-container-lowest p-space-xl lg:p-space-2xl rounded-xl shadow-sm flex flex-col">
              <header className="flex flex-col gap-space-md pb-space-lg mb-space-lg">
                <div className="flex flex-wrap items-center justify-between gap-space-sm text-on-surface-variant font-label-md text-label-md">
                  <div className="flex items-center gap-space-xs">
                    <Icon name="history_edu" className="text-sm text-secondary" />
                    <span>Added {formatDate(selected.createdAt)}</span>
                  </div>
                  <div className="flex items-center gap-space-xs">
                    <Icon name="schedule" className="text-sm" />
                    <span>{readingMinutes(selected.rawText)} min read · {sourceLabel(selected)}</span>
                  </div>
                </div>
                <h2 className="font-display-lg text-display-lg text-on-surface leading-tight tracking-tight">{selected.title}</h2>
                {selected.keywords?.length > 0 && (
                  <div className="flex flex-wrap gap-space-xs items-center pt-space-2xs">
                    {selected.keywords.slice(0, 8).map((k, i) => (
                      <span
                        key={k}
                        className={`px-space-sm py-space-2xs rounded font-label-md text-label-md font-semibold tracking-wide ${CHIP_STYLES[i % CHIP_STYLES.length]}`}
                      >
                        {k}
                      </span>
                    ))}
                  </div>
                )}
              </header>
              <section className="font-body-lg text-body-lg text-on-surface leading-relaxed flex flex-col gap-space-lg">
                {paragraphs.map((p, i) => (
                  <p
                    key={i}
                    className={`whitespace-pre-line ${
                      i === 0
                        ? "first-letter:font-display-lg first-letter:text-display-lg first-letter:float-left first-letter:mr-space-sm first-letter:leading-none first-letter:text-primary"
                        : ""
                    }`}
                  >
                    {p}
                  </p>
                ))}
              </section>
              {selected.textbookRefs?.length > 0 && (
                <section className="mt-space-xl pt-space-lg border-t border-outline-variant flex flex-col gap-space-sm">
                  <span className="font-label-md text-label-md uppercase tracking-wider text-on-surface-variant font-bold flex items-center gap-space-xs">
                    <Icon name="menu_book" className="text-sm text-secondary" />
                    From your textbook
                  </span>
                  {selected.textbookRefs.map((ref) => {
                    const passage = passages[ref.chunkId];
                    return (
                      <div key={ref.chunkId} className="rounded-lg bg-surface-container-low p-space-md flex flex-col gap-space-xs">
                        <div className="flex items-start justify-between gap-space-sm">
                          <div className="min-w-0">
                            <p className="font-ui-body text-ui-body font-semibold text-on-surface">{ref.label || "Passage"}</p>
                            <p className="font-label-md text-label-md text-on-surface-variant truncate">
                              {ref.textbookTitle}
                              {ref.sections?.length ? ` — ${ref.sections.slice(0, 2).join(", ")}` : ""}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => togglePassage(ref)}
                            className="shrink-0 font-label-md text-label-md text-secondary hover:text-primary font-medium"
                          >
                            {passage ? "Hide" : "Read passage"}
                          </button>
                        </div>
                        {passage === "loading" && <p className="font-body-sm text-body-sm text-on-surface-variant">Loading…</p>}
                        {passage?.error && <p className="font-body-sm text-body-sm text-error">{passage.error}</p>}
                        {passage?.text && (
                          <p className="font-body-sm text-body-sm text-on-surface whitespace-pre-line max-h-80 overflow-y-auto pr-space-xs">
                            {passage.text}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </section>
              )}
            </article>
          ) : (
            notes && (
              <div className="w-full max-w-[720px] bg-surface-container-lowest p-space-2xl rounded-xl shadow-sm flex flex-col items-center text-center gap-space-md">
                <Icon name="edit_note" className="text-secondary text-[40px]" />
                <h2 className="font-headline-md text-headline-md text-on-surface">Your folio is empty</h2>
                <p className="font-body-md text-body-md text-on-surface-variant max-w-sm">
                  Add a note and Mind Atlas will pull out its keywords and link it to related notes.
                </p>
                <Link
                  to={`/subjects/${subjectId}/new`}
                  className="px-space-lg py-space-sm rounded-lg bg-primary text-on-primary font-ui-title text-ui-title shadow-sm hover:opacity-90 flex items-center gap-space-xs"
                >
                  <Icon name="add" className="text-base" />
                  <span>Write the first note</span>
                </Link>
              </div>
            )
          )}
        </div>

        {/* Inspector */}
        <aside className="col-span-12 xl:col-span-3 hidden xl:flex flex-col gap-space-lg">
          {selected && (
            <div className="p-space-lg rounded-xl bg-surface-container-lowest shadow-sm flex flex-col gap-space-md">
              <div className="flex items-center justify-between">
                <span className="font-label-md text-label-md uppercase tracking-wider text-on-surface-variant font-bold">
                  Active Graph Node
                </span>
                <span className="inline-flex items-center px-space-xs py-space-2xs rounded bg-secondary-fixed text-on-secondary-fixed font-label-sm text-label-sm font-bold">
                  Degree: {neighbours.length}
                </span>
              </div>
              <div className="flex flex-col gap-space-xs">
                <span className="font-ui-title text-ui-title font-semibold text-on-surface">{selected.title}</span>
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  {neighbours.length === 0
                    ? "Not linked to any other note yet."
                    : `Linked directly to ${neighbours.length} other ${neighbours.length === 1 ? "note" : "notes"}.`}
                </p>
              </div>
              {neighbours.length > 0 && (
                <div className="p-space-md rounded-xl bg-surface-container-low flex flex-col gap-space-sm">
                  <span className="font-label-sm text-label-sm font-bold uppercase tracking-wider text-on-surface-variant">
                    Linked Concepts
                  </span>
                  <div className="flex flex-col gap-space-xs font-ui-body text-ui-body">
                    {neighbours.slice(0, 6).map((nb) => (
                      <button
                        type="button"
                        key={nb.id}
                        onClick={() => setParams({ note: nb.id })}
                        title={nb.shared.length ? `Shared: ${nb.shared.join(", ")}` : undefined}
                        className="text-left text-secondary hover:text-primary transition-colors flex items-center justify-between py-space-2xs gap-space-xs"
                      >
                        <span className="truncate">{titleById.get(nb.id) || "Untitled"}</span>
                        <Icon name="arrow_outward" className="text-sm shrink-0" />
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="pt-space-xs flex items-center gap-space-xs text-on-surface-variant font-label-md text-label-md">
                <Icon name="notes" className="text-sm" />
                <span>{wordCount(selected.rawText)} words</span>
              </div>
            </div>
          )}
          {notes && notes.length > 0 && (
            <div className="p-space-lg rounded-xl bg-surface-container-lowest shadow-sm flex flex-col gap-space-sm">
              <span className="font-label-md text-label-md uppercase tracking-wider text-on-surface-variant font-bold">
                Ready to test yourself?
              </span>
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                Build a test from any of these notes; questions adapt to how you answer.
              </p>
              <Link
                to={`/subjects/${subjectId}/tests`}
                className="font-ui-body text-ui-body text-secondary hover:text-primary font-medium flex items-center gap-space-2xs"
              >
                <span>Open tests</span>
                <Icon name="arrow_forward" className="text-sm" />
              </Link>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
