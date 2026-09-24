import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { formatDate, wordCount } from "../lib/format.js";
import Icon from "../components/Icon.jsx";
import Ring from "../components/Ring.jsx";

const W = 1000;
const H = 640;

// Fruchterman-Reingold style layout, run once per graph. Deterministic: nodes
// start evenly spaced on a circle, so the same notes always land in the same
// arrangement. Result is rescaled to fill the W x H logical canvas.
function layout(nodes, edges) {
  const n = nodes.length;
  const pos = new Map();
  if (n === 0) return pos;
  if (n === 1) {
    pos.set(String(nodes[0].id), [W / 2, H / 2]);
    return pos;
  }
  const idx = new Map(nodes.map((nd, i) => [String(nd.id), i]));
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  nodes.forEach((_, i) => {
    const a = (i / n) * Math.PI * 2;
    px[i] = W / 2 + Math.cos(a) * 260;
    py[i] = H / 2 + Math.sin(a) * 200;
  });
  const links = edges
    .map((e) => [idx.get(String(e.source)), idx.get(String(e.target)), e.weight || 0.3])
    .filter(([a, b]) => a !== undefined && b !== undefined);
  const k = Math.sqrt((W * H) / n) * 0.75;
  let temp = W / 8;
  const iterations = 320;
  for (let it = 0; it < iterations; it++) {
    const dx = new Float64Array(n);
    const dy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ex = px[i] - px[j];
        let ey = py[i] - py[j];
        let d = Math.hypot(ex, ey) || 0.01;
        const f = (k * k) / d;
        ex /= d;
        ey /= d;
        dx[i] += ex * f;
        dy[i] += ey * f;
        dx[j] -= ex * f;
        dy[j] -= ey * f;
      }
    }
    for (const [a, b, w] of links) {
      let ex = px[a] - px[b];
      let ey = py[a] - py[b];
      const d = Math.hypot(ex, ey) || 0.01;
      const f = ((d * d) / k) * (0.5 + w);
      ex /= d;
      ey /= d;
      dx[a] -= ex * f;
      dy[a] -= ey * f;
      dx[b] += ex * f;
      dy[b] += ey * f;
    }
    for (let i = 0; i < n; i++) {
      // gentle gravity keeps disconnected components on screen
      dx[i] += (W / 2 - px[i]) * 0.02 * k * 0.1;
      dy[i] += (H / 2 - py[i]) * 0.02 * k * 0.1;
      const d = Math.hypot(dx[i], dy[i]) || 0.01;
      const m = Math.min(d, temp);
      px[i] += (dx[i] / d) * m;
      py[i] += (dy[i] / d) * m;
    }
    temp *= 0.985;
  }
  const minX = Math.min(...px), maxX = Math.max(...px);
  const minY = Math.min(...py), maxY = Math.max(...py);
  const padX = 150, padY = 70;
  const sx = maxX - minX > 1 ? (W - 2 * padX) / (maxX - minX) : 1;
  const sy = maxY - minY > 1 ? (H - 2 * padY) / (maxY - minY) : 1;
  nodes.forEach((nd, i) => {
    pos.set(String(nd.id), [padX + (px[i] - minX) * sx, padY + (py[i] - minY) * sy]);
  });
  return pos;
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// The other end of every edge touching `id`, strongest link first.
function linksOf(edges, id) {
  if (!id) return [];
  return edges
    .filter((e) => String(e.source) === id || String(e.target) === id)
    .map((e) => ({
      id: String(e.source) === id ? String(e.target) : String(e.source),
      weight: e.weight,
      shared: e.sharedKeywords || [],
    }))
    .sort((a, b) => b.weight - a.weight);
}

// Why an ambiguous cross-subject pair was not linked - mirrors classifyPair()
// in server/src/services/graphEngine.js (two shared keywords AND similarity
// of at least 0.25 are both required across subjects).
function rejectReason(shared) {
  if (shared.length === 1) return `Only “${shared[0]}” in common, likely with a different meaning`;
  return `Shares ${shared.join(", ")}, but the notes are otherwise too different`;
}

export default function KnowledgeGraph() {
  const { subjectId } = useParams();
  const [graph, setGraph] = useState(null);
  const [notes, setNotes] = useState([]);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [pos, setPos] = useState(new Map());
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const viewportRef = useRef(null);
  const dragRef = useRef(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    Promise.all([api.getGraph(subjectId), api.listNotes(subjectId)])
      .then(([g, n]) => {
        setGraph(g);
        setNotes(n.notes);
      })
      .catch((err) => setError(err.message));
  }, [subjectId]);

  // Links per note in this subject, counting links to other subjects too - a
  // note linked only across subjects is not "isolated". Keyed by this
  // subject's notes only; other subjects' notes are not counted here.
  const degree = useMemo(() => {
    const d = new Map();
    graph?.nodes.forEach((n) => d.set(String(n.id), 0));
    [...(graph?.edges || []), ...(graph?.crossSubjectEdges || [])].forEach((e) => {
      for (const id of [String(e.source), String(e.target)]) if (d.has(id)) d.set(id, d.get(id) + 1);
    });
    return d;
  }, [graph]);

  // Other subjects' notes, from the graph route's additive fields. Only notes
  // with an accepted cross-subject link are drawn; rejected (ambiguous) pairs
  // are listed in the inspector instead.
  const crossEdges = useMemo(() => graph?.crossSubjectEdges || [], [graph]);
  const rejectedEdges = useMemo(() => graph?.rejectedEdges || [], [graph]);
  const externalById = useMemo(() => new Map((graph?.externalNodes || []).map((n) => [String(n.id), n])), [graph]);
  const drawnExternal = useMemo(() => {
    const linked = new Set(crossEdges.flatMap((e) => [String(e.source), String(e.target)]));
    return [...externalById.values()].filter((n) => linked.has(String(n.id)));
  }, [crossEdges, externalById]);

  useEffect(() => {
    if (!graph) return;
    setPos(layout([...graph.nodes, ...drawnExternal], [...graph.edges, ...crossEdges]));
    // start on the best-connected note
    let best = null;
    for (const [id, dg] of degree) if (best === null || dg > degree.get(best)) best = id;
    setSelectedId(best);
  }, [graph]); // eslint-disable-line react-hooks/exhaustive-deps

  const fit = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    if (!width || !height) return;
    const k = Math.min(width / W, height / H, 1.2) * 0.98;
    setView({ k, x: (width - W * k) / 2, y: (height - H * k) / 2 });
  }, []);

  useEffect(() => {
    if (!graph || graph.nodes.length === 0) return undefined;
    fit();
    const ro = new ResizeObserver(() => fit());
    if (viewportRef.current) ro.observe(viewportRef.current);
    return () => ro.disconnect();
  }, [graph, fit]);

  // Wheel zoom around the cursor. Registered natively so preventDefault works.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const v = viewRef.current;
      const k = Math.max(0.3, Math.min(2.5, v.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      setView({ k, x: mx - ((mx - v.x) / v.k) * k, y: my - ((my - v.y) / v.k) * k });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [graph]);

  function zoomBy(factor) {
    const el = viewportRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const v = viewRef.current;
    const k = Math.max(0.3, Math.min(2.5, v.k * factor));
    const mx = width / 2, my = height / 2;
    setView({ k, x: mx - ((mx - v.x) / v.k) * k, y: my - ((my - v.y) / v.k) * k });
  }

  // Pointer handling: drag background = pan; drag a node = move it; click a node = select.
  function onPointerDown(e, nodeId) {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = {
      nodeId,
      sx: e.clientX,
      sy: e.clientY,
      view: viewRef.current,
      start: nodeId ? pos.get(nodeId) : null,
      moved: false,
    };
    if (nodeId) e.stopPropagation();
  }
  function onPointerMove(e) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    if (d.nodeId) {
      const k = d.view.k;
      setPos((p) => new Map(p).set(d.nodeId, [d.start[0] + dx / k, d.start[1] + dy / k]));
    } else {
      setView({ ...d.view, x: d.view.x + dx, y: d.view.y + dy });
    }
  }
  function onPointerUp() {
    const d = dragRef.current;
    dragRef.current = null;
    if (d?.nodeId && !d.moved) setSelectedId(d.nodeId);
  }

  const noteById = useMemo(() => new Map(notes.map((n) => [String(n._id), n])), [notes]);
  const nodeById = useMemo(() => new Map((graph?.nodes || []).map((n) => [String(n.id), n])), [graph]);
  const selected = selectedId ? nodeById.get(selectedId) : null;
  const selectedNote = selectedId ? noteById.get(selectedId) : null;
  const selectedExternal = selectedId ? externalById.get(selectedId) : null;

  const neighbours = useMemo(() => linksOf(graph?.edges || [], selectedId), [graph, selectedId]);
  const crossNeighbours = useMemo(() => linksOf(crossEdges, selectedId), [crossEdges, selectedId]);
  const rejectedNeighbours = useMemo(() => linksOf(rejectedEdges, selectedId), [rejectedEdges, selectedId]);

  const q = query.trim().toLowerCase();
  const textMatch = (n) =>
    !q || n.title.toLowerCase().includes(q) || (n.keywords || []).some((k) => k.toLowerCase().includes(q));
  const matches = (n) => {
    const id = String(n.id);
    const deg = degree.get(id) || 0;
    if (filter === "linked" && deg === 0) return false;
    if (filter === "isolated" && deg > 0) return false;
    return textMatch(n);
  };
  // Other subjects' notes have no links inside this subject, so the
  // Linked/Isolated filters dim them; otherwise only the search applies.
  const matchesExternal = (n) => filter === "all" && textMatch(n);
  const matchesAny = (id) =>
    nodeById.has(id) ? matches(nodeById.get(id)) : externalById.has(id) && matchesExternal(externalById.get(id));
  const visibleCount = graph ? graph.nodes.filter(matches).length : 0;

  const tone = (deg) =>
    deg >= 3 ? { dot: "bg-tertiary", label: "Hub" } : deg >= 1 ? { dot: "bg-secondary", label: "Linked" } : { dot: "bg-primary-container", label: "Isolated" };

  // Connectivity is the share of this subject's other notes the selected note
  // links to, so it counts same-subject links only and never passes 100%.
  const maxLinks = graph ? Math.max(1, graph.nodes.length - 1) : 1;
  const connectivity = selected ? Math.round((neighbours.length / maxLinks) * 100) : 0;
  const connectivityText =
    (degree.get(selectedId) || 0) === 0
      ? "Not connected to any other note"
      : neighbours.length === 0
        ? `Linked only to other subjects (${crossNeighbours.length})`
        : `${connectivity}% of the other notes${crossNeighbours.length ? ` · ${crossNeighbours.length} in other subjects` : ""}`;
  const chip = (active) =>
    `px-space-sm py-1 rounded-full font-label-md text-label-md transition-colors ${
      active ? "bg-primary-container text-on-primary-container shadow-sm" : "text-on-surface-variant hover:bg-surface-container-high"
    }`;

  if (error) return <p className="font-body-md text-error">{error}</p>;
  if (!graph) return <p className="font-body-md text-on-surface-variant">Loading…</p>;

  if (graph.nodes.length === 0) {
    return (
      <div className="w-full h-[calc(100vh-6.5rem)] rounded-xl bg-surface-container-low flex flex-col items-center justify-center text-center gap-space-md p-space-xl">
        <Icon name="hub" className="text-secondary text-[40px]" />
        <h2 className="font-headline-md text-headline-md text-on-surface">Nothing to map yet</h2>
        <p className="font-body-md text-body-md text-on-surface-variant max-w-sm">
          Add a couple of notes to this subject and they will appear here, connected by the ideas they share.
        </p>
        <Link
          to={`/subjects/${subjectId}/new`}
          className="px-space-lg py-space-sm rounded-lg bg-primary text-on-primary font-ui-title text-ui-title shadow-sm hover:opacity-90"
        >
          Write a note
        </Link>
      </div>
    );
  }

  return (
    <div className="relative w-full h-[calc(100vh-6.5rem)] rounded-xl overflow-hidden bg-surface-container-low shadow-inner flex select-none">
      <div
        ref={viewportRef}
        data-testid="graph-viewport"
        className="relative flex-1 h-full overflow-hidden cursor-grab active:cursor-grabbing touch-none"
        onPointerDown={(e) => onPointerDown(e, null)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div
          className="absolute inset-0 opacity-25 pointer-events-none"
          style={{ backgroundImage: "radial-gradient(var(--c-outline) 0.75px, transparent 0.75px)", backgroundSize: "24px 24px" }}
        ></div>

        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{ width: W, height: H, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
        >
          <svg className="absolute left-0 top-0 pointer-events-none" width={W} height={H} style={{ overflow: "visible" }}>
            {graph.edges.map((e) => {
              const a = pos.get(String(e.source));
              const b = pos.get(String(e.target));
              if (!a || !b) return null;
              const touches = String(e.source) === selectedId || String(e.target) === selectedId;
              const dim = q || filter !== "all" ? !(matches(nodeById.get(String(e.source))) && matches(nodeById.get(String(e.target)))) : false;
              return (
                <line
                  key={e.id}
                  x1={a[0]}
                  y1={a[1]}
                  x2={b[0]}
                  y2={b[1]}
                  style={{ stroke: touches ? "var(--c-secondary)" : "var(--c-outline)" }}
                  strokeWidth={1 + (e.weight || 0.3) * 4}
                  strokeDasharray={touches ? undefined : "4 3"}
                  opacity={dim ? 0.08 : touches ? 0.85 : 0.4}
                />
              );
            })}
            {crossEdges.map((e) => {
              const a = pos.get(String(e.source));
              const b = pos.get(String(e.target));
              if (!a || !b) return null;
              const touches = String(e.source) === selectedId || String(e.target) === selectedId;
              const dim = q || filter !== "all" ? !(matchesAny(String(e.source)) && matchesAny(String(e.target))) : false;
              return (
                <line
                  key={e.id}
                  data-testid="graph-cross-edge"
                  x1={a[0]}
                  y1={a[1]}
                  x2={b[0]}
                  y2={b[1]}
                  style={{ stroke: "var(--c-tertiary)" }}
                  strokeWidth={1 + (e.weight || 0.3) * 4}
                  strokeDasharray="1 6"
                  strokeLinecap="round"
                  opacity={dim ? 0.08 : touches ? 0.9 : 0.55}
                />
              );
            })}
          </svg>

          {graph.nodes.map((n) => {
            const id = String(n.id);
            const p = pos.get(id);
            if (!p) return null;
            const deg = degree.get(id) || 0;
            const t = tone(deg);
            const isSel = id === selectedId;
            const dim = !matches(n);
            return isSel ? (
              <div
                key={id}
                data-testid="graph-node"
                onPointerDown={(e) => onPointerDown(e, id)}
                className="absolute z-20 -translate-x-1/2 -translate-y-1/2 flex items-center gap-space-sm p-space-sm pl-space-md pr-space-lg rounded-full bg-surface shadow-xl cursor-pointer ring-2 ring-secondary"
                style={{ left: p[0], top: p[1], opacity: dim ? 0.3 : 1 }}
              >
                <div className="relative flex items-center justify-center w-8 h-8 rounded-full bg-secondary text-on-secondary">
                  <Icon name="hub" className="text-sm" />
                  <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-tertiary-fixed border-2 border-surface"></span>
                </div>
                <div className="flex flex-col text-left">
                  <span className="font-ui-title text-ui-title text-on-surface leading-tight whitespace-nowrap">{clip(n.title, 30)}</span>
                  <span className="font-label-sm text-label-sm text-secondary uppercase tracking-widest">
                    Selected • {deg} {deg === 1 ? "link" : "links"}
                  </span>
                </div>
              </div>
            ) : (
              <div
                key={id}
                data-testid="graph-node"
                onPointerDown={(e) => onPointerDown(e, id)}
                title={n.title}
                className="absolute z-10 -translate-x-1/2 -translate-y-1/2 flex items-center gap-space-xs p-space-xs px-space-md rounded-full bg-surface-container shadow-md cursor-pointer hover:scale-105 transition-transform"
                style={{ left: p[0], top: p[1], opacity: dim ? 0.3 : 1 }}
              >
                <div className={`w-3.5 h-3.5 rounded-full ${t.dot}`}></div>
                <span className="font-ui-body text-ui-body text-on-surface whitespace-nowrap">{clip(n.title, 26)}</span>
                <span className="font-label-sm text-label-sm text-on-surface-variant bg-surface-container-high px-1.5 py-0.5 rounded">{deg}</span>
              </div>
            );
          })}

          {drawnExternal.map((n) => {
            const id = String(n.id);
            const p = pos.get(id);
            if (!p) return null;
            const isSel = id === selectedId;
            const dim = !matchesExternal(n);
            return (
              <div
                key={id}
                data-testid="graph-external-node"
                onPointerDown={(e) => onPointerDown(e, id)}
                title={`${n.subjectName}: ${n.title}`}
                className={`absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-start px-space-md py-space-xs rounded-2xl border border-dashed cursor-pointer transition-transform ${
                  isSel
                    ? "z-20 bg-surface border-tertiary ring-2 ring-tertiary shadow-xl"
                    : "z-10 bg-surface-container-lowest/80 border-outline shadow-sm hover:scale-105"
                }`}
                style={{ left: p[0], top: p[1], opacity: dim ? 0.3 : isSel ? 1 : 0.85 }}
              >
                <span className="font-label-sm text-label-sm text-tertiary uppercase tracking-widest leading-tight whitespace-nowrap">
                  {clip(n.subjectName, 24)}
                </span>
                <span className="font-ui-body text-ui-body text-on-surface-variant leading-tight whitespace-nowrap">{clip(n.title, 26)}</span>
              </div>
            );
          })}
        </div>
      </div>

      <header className="absolute top-space-base left-space-base right-[23.5rem] z-30 flex items-center justify-between gap-space-md pointer-events-none flex-wrap">
        <div className="flex items-center gap-space-sm p-space-xs pl-space-md pr-space-xs bg-surface/90 backdrop-blur-md rounded-full shadow-lg pointer-events-auto">
          <Icon name="search" className="text-primary text-base" />
          <input
            aria-label="Search notes"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-48 bg-transparent font-ui-body text-ui-body text-on-surface placeholder:text-outline focus:outline-none"
            placeholder="Search a note or keyword..."
            type="text"
          />
          <div className="h-4 w-px bg-outline-variant/60 mx-space-xs"></div>
          <div className="flex items-center gap-space-2xs">
            <button type="button" className={chip(filter === "all")} onClick={() => setFilter("all")}>All Notes</button>
            <button type="button" className={chip(filter === "linked")} onClick={() => setFilter("linked")}>Linked</button>
            <button type="button" className={chip(filter === "isolated")} onClick={() => setFilter("isolated")}>Isolated</button>
          </div>
        </div>
        <div className="flex items-center gap-space-2xs p-space-xs bg-surface/90 backdrop-blur-md rounded-full shadow-lg pointer-events-auto">
          <button type="button" onClick={() => zoomBy(1.2)} title="Zoom in" aria-label="Zoom in" className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface-container text-on-surface transition-colors">
            <Icon name="add" className="text-base" />
          </button>
          <button type="button" onClick={() => zoomBy(1 / 1.2)} title="Zoom out" aria-label="Zoom out" className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface-container text-on-surface transition-colors">
            <Icon name="remove" className="text-base" />
          </button>
          <div className="h-4 w-px bg-outline-variant/60"></div>
          <button type="button" onClick={fit} title="Reset viewport" className="px-space-sm h-8 flex items-center justify-center rounded-full hover:bg-surface-container text-on-surface font-label-md text-label-md transition-colors">
            Reset
          </button>
        </div>
      </header>

      <div className="absolute bottom-space-base left-space-base z-30 flex items-center gap-space-md p-space-xs px-space-md bg-surface/90 backdrop-blur-md rounded-xl shadow-md pointer-events-auto flex-wrap">
        <div className="flex items-center gap-space-xs">
          <span className="w-2.5 h-2.5 rounded-full bg-tertiary"></span>
          <span className="font-label-sm text-label-sm text-on-surface-variant">Hub (3+ links)</span>
        </div>
        <div className="flex items-center gap-space-xs">
          <span className="w-2.5 h-2.5 rounded-full bg-secondary"></span>
          <span className="font-label-sm text-label-sm text-on-surface-variant">Linked (1–2)</span>
        </div>
        <div className="flex items-center gap-space-xs">
          <span className="w-2.5 h-2.5 rounded-full bg-primary-container"></span>
          <span className="font-label-sm text-label-sm text-on-surface-variant">Isolated</span>
        </div>
        {drawnExternal.length > 0 && (
          <div className="flex items-center gap-space-xs">
            <span className="w-2.5 h-2.5 rounded-full border border-dashed border-tertiary"></span>
            <span className="font-label-sm text-label-sm text-on-surface-variant">Other subject</span>
          </div>
        )}
        <div className="h-3 w-px bg-outline-variant/60"></div>
        <span className="font-label-sm text-label-sm text-secondary font-semibold">
          {visibleCount === graph.nodes.length
            ? `${graph.nodes.length} ${graph.nodes.length === 1 ? "note" : "notes"} · ${graph.edges.length} ${graph.edges.length === 1 ? "connection" : "connections"}${
                crossEdges.length ? ` · ${crossEdges.length} across subjects` : ""
              }`
            : `${visibleCount} of ${graph.nodes.length} notes shown`}
        </span>
      </div>

      <aside className="w-[340px] h-full bg-surface shadow-2xl flex flex-col justify-between overflow-y-auto z-40 shrink-0" id="inspector-panel">
        {selected && (
          <>
            <div className="flex flex-col p-space-lg gap-space-md">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-space-xs text-secondary font-label-md text-label-md uppercase tracking-wider">
                  <Icon name="grain" className="text-sm" />
                  <span>Note Node</span>
                </div>
                <Link
                  to={`/subjects/${subjectId}?note=${selected.id}`}
                  title="Open the full note"
                  aria-label="Open the full note"
                  className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-surface-container text-on-surface-variant transition-colors"
                >
                  <Icon name="open_in_new" className="text-sm" />
                </Link>
              </div>
              <div className="flex flex-col gap-space-2xs">
                <h2 className="font-headline-md text-headline-md text-on-surface tracking-tight" data-testid="inspector-title">
                  {selected.title}
                </h2>
                <div className="flex items-center gap-space-xs text-on-surface-variant font-label-md text-label-md">
                  <Icon name="menu_book" className="text-sm text-primary" />
                  <span className="truncate">
                    {{ image: "Scanned image", file: "Uploaded file" }[selected.sourceType] || "Typed note"} · {formatDate(selected.createdAt)}
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-between p-space-md rounded-xl bg-surface-container-low shadow-sm">
                <div className="flex flex-col">
                  <span className="font-label-sm text-label-sm text-on-surface-variant uppercase tracking-wide">Connectivity</span>
                  <div className="flex items-baseline gap-space-xs">
                    <span className="font-display-lg text-display-lg text-on-surface font-bold leading-none">{degree.get(selectedId) || 0}</span>
                    <span className="font-label-md text-label-md text-tertiary font-semibold">
                      {(degree.get(selectedId) || 0) === 1 ? "link" : "links"}
                    </span>
                  </div>
                  <span className="font-body-sm text-body-sm text-outline mt-space-2xs">{connectivityText}</span>
                </div>
                <Ring className="w-14 h-14" stroke={3.5} value={connectivity} track="text-surface-container-highest">
                  <Icon name="trending_up" className="text-secondary text-sm" />
                </Ring>
              </div>

              {neighbours.length > 0 && (
                <div className="flex flex-col gap-space-xs pt-space-xs">
                  <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">
                    Linked Notes ({neighbours.length})
                  </span>
                  <div className="flex flex-wrap gap-space-xs mt-space-2xs">
                    {neighbours.map((nb) => {
                      const node = nodeById.get(nb.id);
                      if (!node) return null;
                      return (
                        <button
                          type="button"
                          key={nb.id}
                          onClick={() => setSelectedId(nb.id)}
                          title={nb.shared.length ? `Shared: ${nb.shared.join(", ")}` : undefined}
                          className="flex items-center gap-1.5 px-space-sm py-1 rounded-lg bg-surface-container hover:bg-surface-container-high transition-colors text-on-surface font-ui-body text-ui-body"
                        >
                          <span className={`w-2 h-2 rounded-full ${tone(degree.get(nb.id) || 0).dot}`}></span>
                          <span>{clip(node.title, 24)}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {crossNeighbours.length > 0 && (
                <div className="flex flex-col gap-space-xs pt-space-xs" data-testid="cross-subject-links">
                  <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">
                    Linked in other subjects ({crossNeighbours.length})
                  </span>
                  <div className="flex flex-col gap-space-xs mt-space-2xs">
                    {crossNeighbours.map((nb) => {
                      const ext = externalById.get(nb.id);
                      if (!ext) return null;
                      return (
                        <button
                          type="button"
                          key={nb.id}
                          onClick={() => setSelectedId(nb.id)}
                          className="flex flex-col items-start gap-0.5 px-space-sm py-space-xs rounded-lg bg-surface-container hover:bg-surface-container-high transition-colors text-left"
                        >
                          <span className="font-label-sm text-label-sm text-tertiary uppercase tracking-wider">{ext.subjectName}</span>
                          <span className="font-ui-body text-ui-body text-on-surface">{clip(ext.title, 34)}</span>
                          <span className="font-body-sm text-body-sm text-on-surface-variant">Shares {nb.shared.join(", ")}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {rejectedNeighbours.length > 0 && (
                <div className="flex flex-col gap-space-xs pt-space-xs" data-testid="rejected-links">
                  <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">
                    Considered, not linked ({rejectedNeighbours.length})
                  </span>
                  <ul className="flex flex-col gap-space-xs mt-space-2xs">
                    {rejectedNeighbours.map((nb) => {
                      const ext = externalById.get(nb.id);
                      if (!ext) return null;
                      return (
                        <li key={nb.id} className="flex items-start gap-space-xs px-space-sm py-space-xs rounded-lg bg-surface-container-low">
                          <Icon name="link_off" className="text-sm text-outline mt-0.5" />
                          <div className="flex flex-col gap-0.5 min-w-0">
                            <span className="font-ui-body text-ui-body text-on-surface-variant">
                              {ext.subjectName}: {clip(ext.title, 30)}
                            </span>
                            <span className="font-body-sm text-body-sm text-outline">{rejectReason(nb.shared)}</span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {selected.keywords?.length > 0 && (
                <div className="flex flex-col gap-space-xs">
                  <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Keywords</span>
                  <div className="flex flex-wrap gap-space-xs">
                    {selected.keywords.slice(0, 8).map((k) => (
                      <span key={k} className="px-space-sm py-space-2xs rounded bg-secondary-container text-on-secondary-container font-label-md text-label-md">
                        {k}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {selectedNote && (
                <div className="flex flex-col gap-space-xs p-space-md rounded-xl bg-surface-container-highest/60">
                  <span className="font-label-sm text-label-sm uppercase tracking-wider text-secondary">Excerpt</span>
                  <p className="font-body-sm text-body-sm text-on-surface-variant leading-relaxed line-clamp-6">{selectedNote.rawText}</p>
                  <span className="font-label-sm text-label-sm text-outline">{wordCount(selectedNote.rawText)} words</span>
                </div>
              )}
            </div>

            <div className="p-space-lg bg-surface-container-low flex flex-col gap-space-sm">
              <Link
                to={`/subjects/${subjectId}/tests`}
                className="w-full h-11 flex items-center justify-center gap-space-sm rounded-lg bg-primary text-on-primary font-ui-title text-ui-title shadow-md hover:opacity-90 transition-colors"
              >
                <Icon name="quiz" className="text-base" />
                <span>Build a test from your notes</span>
              </Link>
              <div className="flex items-center justify-between px-space-xs">
                <span className="font-label-sm text-label-sm text-on-surface-variant">Drag nodes to rearrange</span>
                <Link to={`/subjects/${subjectId}?note=${selected.id}`} className="font-label-sm text-label-sm text-secondary font-semibold hover:underline">
                  Read note
                </Link>
              </div>
            </div>
          </>
        )}

        {selectedExternal && (
          <>
            <div className="flex flex-col p-space-lg gap-space-md" data-testid="external-inspector">
              <div className="flex items-center gap-space-xs text-tertiary font-label-md text-label-md uppercase tracking-wider">
                <Icon name="link" className="text-sm" />
                <span>From another subject</span>
              </div>
              <div className="flex flex-col gap-space-2xs">
                <h2 className="font-headline-md text-headline-md text-on-surface tracking-tight" data-testid="inspector-title">
                  {selectedExternal.title}
                </h2>
                <span className="font-label-md text-label-md text-on-surface-variant">{selectedExternal.subjectName}</span>
              </div>

              {crossNeighbours.length > 0 && (
                <div className="flex flex-col gap-space-xs pt-space-xs">
                  <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">
                    Linked to this subject ({crossNeighbours.length})
                  </span>
                  <div className="flex flex-col gap-space-xs mt-space-2xs">
                    {crossNeighbours.map((nb) => {
                      const node = nodeById.get(nb.id);
                      if (!node) return null;
                      return (
                        <button
                          type="button"
                          key={nb.id}
                          onClick={() => setSelectedId(nb.id)}
                          className="flex flex-col items-start gap-0.5 px-space-sm py-space-xs rounded-lg bg-surface-container hover:bg-surface-container-high transition-colors text-left"
                        >
                          <span className="font-ui-body text-ui-body text-on-surface">{clip(node.title, 34)}</span>
                          <span className="font-body-sm text-body-sm text-on-surface-variant">Shares {nb.shared.join(", ")}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {selectedExternal.keywords?.length > 0 && (
                <div className="flex flex-col gap-space-xs">
                  <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Keywords</span>
                  <div className="flex flex-wrap gap-space-xs">
                    {selectedExternal.keywords.slice(0, 8).map((k) => (
                      <span key={k} className="px-space-sm py-space-2xs rounded bg-tertiary-container text-on-tertiary-container font-label-md text-label-md">
                        {k}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="p-space-lg bg-surface-container-low flex flex-col gap-space-sm">
              <Link
                to={`/subjects/${selectedExternal.subjectId}/graph`}
                className="w-full h-11 flex items-center justify-center gap-space-sm rounded-lg bg-tertiary text-on-tertiary font-ui-title text-ui-title shadow-md hover:opacity-90 transition-colors"
              >
                <Icon name="hub" className="text-base" />
                <span>Open the {clip(selectedExternal.subjectName, 20)} graph</span>
              </Link>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
