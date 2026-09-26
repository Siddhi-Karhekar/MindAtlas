import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { formatDate, readingMinutes, timeAgo, wordCount } from "../lib/format.js";
import Icon from "../components/Icon.jsx";
import { isSplitParent, isTopicNote, noteTree } from "../lib/notes.js";

const CHIP_STYLES = [
  "bg-surface-container text-primary",
  "bg-secondary-container text-on-secondary-container",
  "bg-surface-variant text-on-surface-variant",
  "bg-tertiary-fixed text-on-tertiary-fixed",
];

const SOURCE_LABEL = { typed: "Typed note", image: "Scanned image", file: "Uploaded file" };

// One subtopic row in the shelf, indented under its document.
function SubtopicButton({ note, index, active, onSelect }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid="subtopic-item"
      className={`text-left flex items-baseline gap-space-xs py-space-2xs px-space-sm rounded-lg transition-colors font-ui-body text-ui-body min-w-0 ${
        active ? "bg-surface-container-lowest shadow-sm text-on-surface font-semibold" : "text-on-surface-variant hover:bg-surface-container hover:text-on-surface"
      }`}
    >
      <span className="font-label-sm text-label-sm text-outline shrink-0 w-5 text-right">{index + 1}.</span>
      <span className="truncate">{note.title}</span>
    </button>
  );
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
  }, [subjectId]);

  const tree = useMemo(() => noteTree(notes), [notes]);
  const noteById = useMemo(() => new Map((notes || []).map((n) => [String(n._id), n])), [notes]);
  const topicNotes = useMemo(() => (notes || []).filter(isTopicNote), [notes]);
  const subtopicCount = (notes || []).filter((n) => n.parentNoteId).length;
  const selectedId = params.get("note");
  const selected = (selectedId && noteById.get(selectedId)) || tree.top[0] || null;
  const selectedParent = selected?.parentNoteId ? noteById.get(String(selected.parentNoteId)) : null;
  const siblings = selectedParent ? tree.childrenOf(selectedParent) : [];
  const selectedChildren = useMemo(
    () => (selected && isSplitParent(selected) ? tree.childrenOf(selected) : []),
    [selected, tree]
  );
  // the document whose subtopics are open in the shelf
  const openDocId = String(selectedParent?._id || (selected && isSplitParent(selected) ? selected._id : ""));

  const titleById = useMemo(() => new Map(graph.nodes.map((n) => [String(n.id), n.title])), [graph]);
  // "contains" edges (document -> subtopic) are structure, not relatedness
  const linkEdges = useMemo(() => graph.edges.filter((e) => e.edgeType !== "contains"), [graph]);

  // Neighbours of the selected note, strongest link first. For a split
  // document: what any of its subtopics links to outside the document.
  const neighbours = useMemo(() => {
    if (!selected) return [];
    const own = new Set(
      isSplitParent(selected) ? selectedChildren.map((c) => String(c._id)) : [String(selected._id)]
    );
    const best = new Map();
    for (const e of linkEdges) {
      const s = String(e.source);
      const t = String(e.target);
      if (own.has(s) === own.has(t)) continue;
      const other = own.has(s) ? t : s;
      if (!best.has(other) || best.get(other).weight < e.weight)
        best.set(other, { id: other, weight: e.weight, shared: e.sharedKeywords || [] });
    }
    return [...best.values()].sort((a, b) => b.weight - a.weight);
  }, [linkEdges, selected, selectedChildren]);

  const linkedCount = useMemo(() => {
    const s = new Set();
    linkEdges.forEach((e) => {
      s.add(String(e.source));
      s.add(String(e.target));
    });
    return s.size;
  }, [linkEdges]);

  const totalWords = useMemo(() => topicNotes.reduce((n, x) => n + wordCount(x.rawText), 0), [topicNotes]);
  const linkedPct = topicNotes.length ? Math.round((linkedCount / topicNotes.length) * 100) : 0;

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
            <span className="text-tertiary font-medium">
              {notes
                ? `${tree.top.length} ${tree.top.length === 1 ? "note" : "notes"}${subtopicCount ? ` · ${subtopicCount} subtopics` : ""}`
                : "…"}
            </span>
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
              const subs = location.state?.subtopicCount || 0;
              const what = `${n > 1 ? `${n} notes added` : "Note added"}${subs ? ` (split into ${subs} subtopics)` : ""}`;
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
            <span>Curated Folio ({tree.top.length})</span>
          </div>

          <div className="flex flex-col gap-space-xs">
            {notes === null && <p className="font-body-sm text-body-sm text-on-surface-variant px-space-xs">Loading…</p>}
            {tree.top.map((n) => {
              const active = selected && String(n._id) === String(selected._id);
              const kids = tree.childrenOf(n);
              const isDoc = kids.length > 0;
              const open = isDoc && openDocId === String(n._id);
              return (
                <div key={n._id} className="flex flex-col gap-space-2xs">
                <button
                  type="button"
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
                    {isDoc ? (
                      <p className="font-body-sm text-body-sm text-on-surface-variant flex items-center gap-space-2xs">
                        <Icon name={open ? "expand_more" : "chevron_right"} className="text-sm" />
                        <span>{kids.length} subtopics</span>
                      </p>
                    ) : (
                      <p className="font-body-sm text-body-sm text-on-surface-variant line-clamp-2">{n.rawText}</p>
                    )}
                  </div>
                </button>
                {open && (
                  <div className="flex flex-col gap-space-2xs pl-space-md ml-space-sm border-l-2 border-secondary/30" data-testid="subtopic-list">
                    {kids.map((c, i) => (
                      <SubtopicButton
                        key={c._id}
                        note={c}
                        index={i}
                        active={selected && String(c._id) === String(selected._id)}
                        onSelect={() => setParams({ note: c._id })}
                      />
                    ))}
                  </div>
                )}
                </div>
              );
            })}
          </div>

          {notes && notes.length > 0 && (
            <div className="mt-space-lg p-space-md rounded-xl bg-surface-container-low flex flex-col gap-space-sm">
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
                {linkedCount} of {topicNotes.length} {subtopicCount ? "topics" : "notes"} linked
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
                    <span>{readingMinutes(selected.rawText)} min read · {SOURCE_LABEL[selected.sourceType] || selected.sourceType}</span>
                  </div>
                </div>
                {selectedParent && (
                  <div className="flex items-center justify-between gap-space-sm flex-wrap font-label-md text-label-md" data-testid="subtopic-breadcrumb">
                    <button
                      type="button"
                      onClick={() => setParams({ note: selectedParent._id })}
                      className="flex items-center gap-space-2xs text-secondary hover:text-primary min-w-0"
                    >
                      <Icon name="description" className="text-sm shrink-0" />
                      <span className="truncate">{selectedParent.title}</span>
                    </button>
                    <span className="text-on-surface-variant shrink-0">
                      Subtopic {(selected.order ?? 0) + 1} of {siblings.length}
                      {selected.sectionGroup ? ` · ${selected.sectionGroup}` : ""}
                    </span>
                  </div>
                )}
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
              {selectedChildren.length > 0 && (
                <section className="flex flex-col gap-space-sm mb-space-xl" data-testid="document-subtopics">
                  <span className="font-label-md text-label-md uppercase tracking-wider text-on-surface-variant font-bold">
                    {selectedChildren.length} subtopics in this document
                  </span>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-space-sm">
                    {selectedChildren.map((c, i) => (
                      <button
                        type="button"
                        key={c._id}
                        onClick={() => setParams({ note: c._id })}
                        className="text-left p-space-md rounded-lg bg-surface-container-low hover:bg-surface-container transition-colors flex flex-col gap-space-2xs min-w-0"
                      >
                        <span className="font-label-sm text-label-sm text-on-surface-variant truncate">
                          {i + 1}. {c.sectionGroup || "Subtopic"} · {wordCount(c.rawText)} words
                        </span>
                        <span className="font-ui-title text-ui-title text-on-surface font-semibold truncate">{c.title}</span>
                        <span className="font-body-sm text-body-sm text-on-surface-variant truncate">
                          {(c.keywords || []).slice(0, 4).join(" · ")}
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              )}
              {selectedChildren.length > 0 ? (
                <details className="group">
                  <summary className="cursor-pointer font-ui-body text-ui-body text-secondary hover:text-primary font-medium list-none flex items-center gap-space-2xs">
                    <Icon name="chevron_right" className="text-base group-open:rotate-90 transition-transform" />
                    Read the full document
                  </summary>
                  <section className="mt-space-lg font-body-lg text-body-lg text-on-surface leading-relaxed flex flex-col gap-space-lg">
                    {paragraphs.map((p, i) => (
                      <p key={i} className="whitespace-pre-line">{p}</p>
                    ))}
                  </section>
                </details>
              ) : (
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
              )}
              {selectedParent && siblings.length > 1 && (
                <nav className="mt-space-xl pt-space-lg border-t border-surface-container-high flex items-center justify-between gap-space-md">
                  {(() => {
                    const idx = siblings.findIndex((c) => String(c._id) === String(selected._id));
                    const prev = siblings[idx - 1];
                    const next = siblings[idx + 1];
                    return (
                      <>
                        {prev ? (
                          <button type="button" onClick={() => setParams({ note: prev._id })} className="flex items-center gap-space-2xs text-secondary hover:text-primary font-ui-body text-ui-body min-w-0">
                            <Icon name="arrow_back" className="text-sm shrink-0" />
                            <span className="truncate">{prev.title}</span>
                          </button>
                        ) : <span />}
                        {next ? (
                          <button type="button" onClick={() => setParams({ note: next._id })} className="flex items-center gap-space-2xs text-secondary hover:text-primary font-ui-body text-ui-body min-w-0">
                            <span className="truncate">{next.title}</span>
                            <Icon name="arrow_forward" className="text-sm shrink-0" />
                          </button>
                        ) : <span />}
                      </>
                    );
                  })()}
                </nav>
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
                  {selectedChildren.length > 0
                    ? neighbours.length === 0
                      ? `A document of ${selectedChildren.length} subtopics, not yet linked to other notes.`
                      : `A document of ${selectedChildren.length} subtopics; they link to ${neighbours.length} other ${neighbours.length === 1 ? "note" : "notes"}.`
                    : neighbours.length === 0
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
