import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { formatDate, readingMinutes, timeAgo, wordCount } from "../lib/format.js";
import Icon from "../components/Icon.jsx";
import NoteContent from "../components/NoteContent.jsx";
import { flattenOutline, isSplitParent, isTopicNote, noteTree, outlineTree } from "../lib/notes.js";
import { stableColorIndex, topicClass } from "../lib/noteFormat.js";

const SOURCE_LABEL = { typed: "Typed note", image: "Scanned image", file: "Uploaded file" };

// The note title shrinks as the topic gets deeper in its document's outline:
// a main topic is the largest, a subtopic of a subtopic the smallest.
const TITLE_SIZE = [
  "font-display-lg text-display-lg font-bold",
  "font-headline-lg text-headline-lg font-semibold",
  "font-headline-md text-headline-md font-semibold",
];

// One row of a document's outline in the shelf, with the rows under it.
// A main topic (depth 0) carries its topic colour and the heaviest type; each
// level below is lighter and indented. A row is a button when it is a note, a
// plain heading when it only groups other notes, and both for a chapter that
// has an introduction of its own.
function OutlineNode({ node, selectedId, onSelect, collapsed, onToggle }) {
  const active = node.item && String(node.item._id) === String(selectedId);
  const hasKids = node.children.length > 0;
  const closed = collapsed.has(node.key);
  const main = node.depth === 0;
  const text = main
    ? "font-ui-title text-[13px] leading-[18px] font-bold text-topic"
    : node.depth === 1
      ? "font-ui-body text-ui-body font-semibold"
      : "font-ui-body text-[12px] leading-[16px] font-medium";
  const tone = main ? "" : active ? "text-on-surface" : "text-on-surface-variant";
  return (
    <div className={`flex flex-col gap-space-2xs min-w-0 ${main ? topicClass(node.colorIndex) : ""}`} data-depth={node.depth}>
      <div className={`flex items-center gap-space-2xs rounded-lg min-w-0 ${active ? "bg-surface-container-lowest shadow-sm" : ""}`}>
        {hasKids ? (
          <button
            type="button"
            onClick={() => onToggle(node.key)}
            aria-label={`${closed ? "Expand" : "Collapse"} ${node.title}`}
            aria-expanded={!closed}
            className="shrink-0 w-5 h-6 flex items-center justify-center text-on-surface-variant hover:text-on-surface"
          >
            <Icon name={closed ? "chevron_right" : "expand_more"} className="text-sm" />
          </button>
        ) : (
          <span className="shrink-0 w-5 h-6 flex items-center justify-center" aria-hidden="true">
            <span className={`rounded-full bg-topic ${main ? "w-2 h-2" : "w-1 h-1 opacity-60"}`}></span>
          </span>
        )}
        {node.item ? (
          <button
            type="button"
            onClick={() => onSelect(node.item._id)}
            data-testid="subtopic-item"
            title={node.title}
            className={`flex-1 text-left py-space-2xs pr-space-sm truncate transition-colors hover:text-on-surface ${text} ${tone}`}
          >
            {node.title}
          </button>
        ) : (
          <span data-testid="outline-group" title={node.title} className={`flex-1 py-space-2xs pr-space-sm truncate ${text} ${tone}`}>
            {node.title}
          </span>
        )}
      </div>
      {hasKids && !closed && (
        <div className="flex flex-col gap-space-2xs ml-[9px] pl-space-sm border-l border-topic-soft">
          {node.children.map((c) => (
            <OutlineNode key={c.key} node={c} selectedId={selectedId} onSelect={onSelect} collapsed={collapsed} onToggle={onToggle} />
          ))}
        </div>
      )}
    </div>
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
  const [collapsed, setCollapsed] = useState(() => new Set());
  const toggleGroup = (key) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

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
  const openDoc = selectedParent || (selected && isSplitParent(selected) ? selected : null);
  const openDocId = String(openDoc?._id || "");
  // That document's subtopics as a nested outline (Unit > Chapter > Topic),
  // rebuilt from each subtopic's `path`. Each main topic gets a colour, which
  // everything under it shares - in the shelf and in the reading pane.
  const outline = useMemo(() => {
    const doc = openDocId ? noteById.get(openDocId) : null;
    return doc ? outlineTree(tree.childrenOf(doc)) : [];
  }, [openDocId, noteById, tree]);
  const outlineById = useMemo(() => {
    const flat = flattenOutline(outline);
    return {
      byNote: new Map(flat.filter((n) => n.item).map((n) => [String(n.item._id), n])),
      // main-topic title -> colour, to colour the full document the same way
      colorByTitle: new Map(outline.map((n) => [n.title.trim().toLowerCase(), n.colorIndex])),
    };
  }, [outline]);
  const selectedNode = selected ? outlineById.byNote.get(String(selected._id)) : null;
  // A subtopic wears its main topic's colour; a note that stands alone gets a
  // colour of its own (the same one every time); a whole document has none -
  // it is a container of topics, coloured section by section.
  const selectedColor = !selected
    ? null
    : selectedNode
      ? selectedNode.colorIndex
      : isSplitParent(selected)
        ? null
        : stableColorIndex(selected._id);
  const sectionColorOf = useMemo(
    () => (heading) => outlineById.colorByTitle.get(String(heading).trim().toLowerCase()) ?? null,
    [outlineById]
  );
  // a note holding several top-level sections is coloured section by section
  const manySections = (selected?.content || []).filter((b) => b.type === "heading" && b.level === 1).length >= 2;

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
                  <div className="flex flex-col gap-space-xs pl-space-xs" data-testid="subtopic-list">
                    {outline.map((node) => (
                      <OutlineNode
                        key={node.key}
                        node={node}
                        selectedId={selected?._id}
                        onSelect={(id) => setParams({ note: id })}
                        collapsed={collapsed}
                        onToggle={toggleGroup}
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
            <article
              className={`w-full max-w-[720px] bg-surface-container-lowest p-space-xl lg:p-space-2xl rounded-xl shadow-sm flex flex-col ${topicClass(selectedColor)}`}
              data-testid="note-article"
            >
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
                    {/* where this subtopic sits: Document › Unit › Chapter */}
                    <div className="flex items-center gap-space-2xs min-w-0 flex-wrap">
                      <button
                        type="button"
                        onClick={() => setParams({ note: selectedParent._id })}
                        className="flex items-center gap-space-2xs text-secondary hover:text-primary min-w-0"
                      >
                        <Icon name="description" className="text-sm shrink-0" />
                        <span className="truncate">{selectedParent.title}</span>
                      </button>
                      {(selectedNode?.trail || []).map((t, i) => (
                        <span key={i} className="flex items-center gap-space-2xs min-w-0 text-topic">
                          <Icon name="chevron_right" className="text-sm shrink-0 text-outline" />
                          <span className="truncate">{t}</span>
                        </span>
                      ))}
                    </div>
                    <span className="text-on-surface-variant shrink-0">
                      Subtopic {(selected.order ?? 0) + 1} of {siblings.length}
                    </span>
                  </div>
                )}
                <h2
                  data-testid="note-title"
                  className={`leading-tight tracking-tight ${TITLE_SIZE[Math.min(selectedNode?.depth || 0, TITLE_SIZE.length - 1)]} ${
                    selectedColor === null || (!selectedNode && manySections) ? "text-on-surface" : "text-topic"
                  }`}
                >
                  {selected.title}
                </h2>
                {selected.keywords?.length > 0 && (
                  <div className="flex flex-wrap gap-space-xs items-center pt-space-2xs" data-testid="note-keywords">
                    {selected.keywords.slice(0, 8).map((k) => (
                      <span key={k} className="px-space-sm py-space-2xs rounded font-label-md text-label-md font-semibold tracking-wide bg-topic-soft text-topic">
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
                  {/* one block per main topic, in its colour, listing what sits under it */}
                  <div className="flex flex-col gap-space-md">
                    {outline.map((top) => {
                      const leaves = flattenOutline([top]).filter((n) => n.item);
                      return (
                        <div key={top.key} className={`flex flex-col gap-space-xs ${topicClass(top.colorIndex)}`} data-testid="document-topic">
                          <div className="flex items-center gap-space-xs min-w-0">
                            <span className="w-2 h-2 rounded-full bg-topic shrink-0"></span>
                            <span className="font-ui-title text-ui-title font-bold text-topic truncate">{top.title}</span>
                            <span className="font-label-sm text-label-sm text-on-surface-variant shrink-0">
                              {leaves.length} {leaves.length === 1 ? "subtopic" : "subtopics"}
                            </span>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-space-sm">
                            {leaves.map((n) => (
                              <button
                                type="button"
                                key={n.key}
                                onClick={() => setParams({ note: n.item._id })}
                                className="text-left p-space-md rounded-lg bg-surface-container-low hover:bg-surface-container transition-colors flex flex-col gap-space-2xs min-w-0 border-l-2 border-topic"
                              >
                                <span className="font-label-sm text-label-sm text-on-surface-variant truncate">
                                  {n.trail.slice(1).length ? `${n.trail.slice(1).join(" › ")} · ` : ""}
                                  {wordCount(n.item.rawText)} words
                                </span>
                                <span className="font-ui-title text-ui-title text-on-surface font-semibold truncate">{n.title}</span>
                                <span className="font-body-sm text-body-sm text-on-surface-variant truncate">
                                  {(n.item.keywords || []).slice(0, 4).join(" · ")}
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}
              {selectedChildren.length > 0 ? (
                <details className="group">
                  <summary className="cursor-pointer font-ui-body text-ui-body text-secondary hover:text-primary font-medium list-none flex items-center gap-space-2xs">
                    <Icon name="chevron_right" className="text-base group-open:rotate-90 transition-transform" />
                    Read the full document
                  </summary>
                  {/* the whole document, each main topic in the same colour as above */}
                  <NoteContent
                    className="mt-space-lg"
                    content={selected.content}
                    keywords={selected.keywords?.slice(0, 8)}
                    bySection
                    colorOf={sectionColorOf}
                  />
                </details>
              ) : (
                <NoteContent
                  content={selected.content}
                  keywords={selected.keywords?.slice(0, 8)}
                  colorIndex={selectedColor ?? 0}
                  bySection={!selectedNode}
                  shrink={Math.min(selectedNode?.depth || 0, 2)}
                />
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
