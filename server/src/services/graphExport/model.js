// What a graph download shows, before it is a PDF: a drawing (lines, nodes
// and a legend, in the page's own canvas units) for the first page and tables
// for the pages after it. pdf.js draws whatever this returns.
//
// The drawing copies the knowledge graph page (client/src/pages/
// KnowledgeGraph.jsx) with nothing selected and nothing dimmed: the same node
// shapes, labels clipped to the same lengths, the same colours and badges for
// the Links and Clusters views. Sizes are the page's CSS pixels; pdf.js scales
// them. Lines join nodes by id, so they follow a node that pdf.js moves. Two
// things change for paper: the drop shadows become a thin border, and the
// faint lines are drawn a little stronger, as a printer loses them.

import { safeFileName } from "../noteExport/model.js";

// The light theme (client/src/index.css): paper is white, whatever theme the
// student has on screen.
export const COLOR = {
  container: "#f8f7f1", // --c-surface-container: a note's pill
  containerHigh: "#efeee6", // a badge
  lowest: "#ffffff",
  border: "#d7d4c5", // stands in for the screen's drop shadow
  outline: "#b9b6a6",
  ink: "#33352e", // --c-on-surface
  muted: "#6a6d63", // --c-on-surface-variant
  primary: "#364156",
  primaryContainer: "#dfe3e8",
  onPrimaryContainer: "#263140",
  primaryFixedDim: "#b7c2cc",
  secondary: "#5d7a68",
  tertiary: "#c98e3d",
  link: "#b9b6a6", // --c-graph-link
  cluster: ["#2a78d6", "#eb6834", "#1baf7a"], // --c-cluster-1..3
};

// How many clusters get a colour of their own, as on the page.
const CLUSTER_COLOURS = 3;
// The page's canvas (KnowledgeGraph.jsx: W x H); the keyword map is laid out on it.
const W = 1000;
const H = 640;

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isSplitParent = (n) => !n.parentNoteId && (n.childCount || 0) > 0;
const key = (v) => String(v);

/** The ids of every node the graph draws: this subject's notes and the other subjects' notes it links to. */
export function drawnNodeIds(graph) {
  const crossLinked = new Set(graph.crossSubjectEdges.flatMap((e) => [key(e.source), key(e.target)]));
  return [...graph.nodes.map((n) => key(n.id)), ...graph.externalNodes.map((n) => key(n.id)).filter((id) => crossLinked.has(id))];
}

// The dot for a cluster: its colour, grey for "Other clusters", or a hollow
// ring for a note in no cluster (a cluster of one).
function clusterDot(cluster) {
  if (!cluster || cluster.size < 2) return { stroke: COLOR.outline };
  return { fill: cluster.id <= CLUSTER_COLOURS ? COLOR.cluster[cluster.id - 1] : COLOR.outline };
}

const tone = (deg) =>
  deg >= 3
    ? { fill: COLOR.tertiary, label: "Hub (3+ links)" }
    : deg >= 1
      ? { fill: COLOR.secondary, label: "Linked (1–2)" }
      : // the pale dot of an isolated note gets an edge, so it still shows on paper
        { fill: COLOR.primaryContainer, stroke: COLOR.primaryFixedDim, label: "Isolated" };

const reason = (e) => {
  const shared = e.sharedKeywords || [];
  if (e.meaning !== null && e.meaning !== undefined) return shared.length ? `Close in meaning · shares ${shared.join(", ")}` : "Close in meaning";
  return shared.length ? `Shares ${shared.join(", ")}` : "—";
};
const strength = (e) => (Number(e.weight) || 0).toFixed(2);

/**
 * The subject's graph. `positions` is a Map of node id -> [x, y] for every id
 * drawnNodeIds() gives; `colorBy` is "links" or "clusters".
 */
export function graphModel({ subject, graph, positions, colorBy, date }) {
  const hasClusters = Array.isArray(graph.clusters);
  const byCluster = colorBy === "clusters" && hasClusters;
  const clusters = graph.clusters || [];
  const clusterById = new Map(clusters.map((c) => [c.id, c]));
  const realClusters = clusters.filter((c) => c.size > 1);
  const cross = graph.crossSubjectEdges;
  const drawn = new Set(drawnNodeIds(graph));
  const external = graph.externalNodes.filter((n) => drawn.has(key(n.id)));
  const titleOf = new Map([...graph.nodes, ...graph.externalNodes].map((n) => [key(n.id), n.title]));
  const subjectOf = new Map(graph.externalNodes.map((n) => [key(n.id), n.subjectName]));

  // links per note, counting links to other subjects, as the page does
  const degree = new Map(graph.nodes.map((n) => [key(n.id), 0]));
  for (const e of [...graph.edges, ...cross]) {
    for (const id of [key(e.source), key(e.target)]) if (degree.has(id)) degree.set(id, degree.get(id) + 1);
  }
  const docs = graph.nodes.filter(isSplitParent);
  const topics = graph.nodes.filter((n) => !isSplitParent(n));

  // ---- the drawing
  const at = (id) => positions.get(key(id));
  const lines = [];
  const join = (e, style) => {
    if (at(e.source) && at(e.target)) lines.push({ from: key(e.source), to: key(e.target), ...style });
  };
  for (const e of graph.containsEdges) join(e, { color: COLOR.primary, width: 1.25, opacity: 0.35 });
  for (const e of graph.edges) join(e, { color: COLOR.link, width: 1 + (e.weight || 0.3) * 4, dash: [4, 3], opacity: 0.95 });
  // amber marks other subjects, except in the Clusters view, where colour means cluster only
  for (const e of cross) {
    join(e, { color: byCluster ? COLOR.link : COLOR.tertiary, width: 1 + (e.weight || 0.3) * 4, dash: [1, 6], cap: "round", opacity: 0.85 });
  }

  const nodes = [];
  for (const n of graph.nodes) {
    const [x, y] = at(n.id);
    if (isSplitParent(n)) {
      nodes.push({
        id: key(n.id), x, y, shape: "box", padX: 12, padY: 4, gap: 4,
        fill: COLOR.primaryContainer, stroke: COLOR.border,
        glyph: { kind: "document", color: COLOR.onPrimaryContainer, size: 16 },
        lines: [{ text: clip(n.title, 28), size: 15, color: COLOR.onPrimaryContainer, bold: true }],
        badge: { text: String(n.childCount), fill: "#e5e8ea", color: COLOR.onPrimaryContainer },
      });
      continue;
    }
    const deg = degree.get(key(n.id)) || 0;
    const cluster = clusterById.get(n.clusterId);
    const inCluster = cluster?.size > 1;
    // in the Clusters view the badge names the cluster, so identity never rests on colour alone
    const badge = !byCluster ? String(deg) : inCluster ? `C${cluster.id}` : null;
    nodes.push({
      id: key(n.id), x, y, shape: "pill", padX: 12, padY: 4, gap: 4,
      fill: COLOR.container, stroke: COLOR.border,
      dot: { ...(byCluster ? clusterDot(cluster) : tone(deg)), size: 14 },
      lines: [{ text: clip(n.title, 26), size: 13, color: COLOR.ink }],
      badge: badge && { text: badge, fill: COLOR.containerHigh, color: COLOR.muted },
    });
  }
  for (const n of external) {
    const [x, y] = at(n.id);
    nodes.push({
      id: key(n.id), x, y, shape: "card", padX: 12, padY: 4, gap: 0,
      fill: COLOR.lowest, stroke: COLOR.outline, dash: true, opacity: 0.85,
      lines: [
        { text: clip(n.subjectName, 24).toUpperCase(), size: 10, color: byCluster ? COLOR.muted : COLOR.tertiary, tracking: 0.1 },
        { text: clip(n.title, 26), size: 13, color: COLOR.muted },
      ],
    });
  }

  const legend = [];
  if (byCluster) {
    for (const c of realClusters.slice(0, CLUSTER_COLOURS)) {
      legend.push({ swatch: { kind: "dot", ...clusterDot(c) }, text: `C${c.id}${c.keywords.length ? ` · ${clip(c.keywords.slice(0, 2).join(", "), 24)}` : ""} (${c.size})` });
    }
    if (realClusters.length > CLUSTER_COLOURS) {
      legend.push({ swatch: { kind: "dot", fill: COLOR.outline }, text: `Other clusters (${realClusters.length - CLUSTER_COLOURS})` });
    }
    if (clusters.some((c) => c.size === 1)) legend.push({ swatch: { kind: "dot", stroke: COLOR.outline }, text: "No cluster" });
  } else {
    for (const deg of [3, 1, 0]) {
      const t = tone(deg);
      legend.push({ swatch: { kind: "dot", fill: t.fill, stroke: t.stroke }, text: t.label });
    }
  }
  legend.push({ swatch: { kind: "line", color: COLOR.link, dash: [4, 3], width: 2.2 }, text: "Link (thicker = stronger)" });
  if (docs.length) legend.push({ swatch: { kind: "box", fill: COLOR.primaryContainer }, text: "Document → subtopics" });
  if (external.length) {
    legend.push({ swatch: { kind: "line", color: byCluster ? COLOR.link : COLOR.tertiary, dash: [1, 4], cap: "round", width: 2.2 }, text: "Link to another subject" });
  }

  // ---- the tables
  const sections = [];
  if (hasClusters && topics.length) {
    const rows = realClusters.map((c) => [
      { dot: clusterDot(c), runs: [{ text: `C${c.id}`, bold: true }] },
      c.keywords.join(", ") || "—",
      topics.filter((n) => n.clusterId === c.id).map((n) => n.title).join("  ·  "),
    ]);
    const alone = topics.filter((n) => !(clusterById.get(n.clusterId)?.size > 1));
    if (alone.length) rows.push([{ dot: clusterDot(null), runs: [{ text: "No cluster" }] }, "—", alone.map((n) => n.title).join("  ·  ")]);
    sections.push({
      title: "Clusters",
      intro: "Groups of notes that are linked to each other more than to the rest of the subject, largest first. The keywords are ones at least two of the group's notes share.",
      columns: [{ title: "Cluster", width: 1.1 }, { title: "Shared keywords", width: 2.4 }, { title: "Notes", width: 6.5 }],
      rows,
    });
  }

  const unlinked = topics.filter((n) => (degree.get(key(n.id)) || 0) === 0).map((n) => n.title);
  sections.push({
    title: "Links between notes",
    intro: "Strength is how alike the two notes' wording is, from 0 to 1; the graph draws stronger links thicker.",
    columns: [{ title: "Note", width: 2.6 }, { title: "Linked to", width: 2.6 }, { title: "Why they are linked", width: 3.8 }, { title: "Strength", width: 1 }],
    rows: [...graph.edges].sort((a, b) => b.weight - a.weight).map((e) => [titleOf.get(key(e.source)) || "", titleOf.get(key(e.target)) || "", reason(e), strength(e)]),
    empty: "No notes in this subject are linked yet.",
    after: unlinked.length ? `Not linked to any other note: ${unlinked.join("  ·  ")}` : "",
  });

  if (cross.length) {
    const own = new Set(graph.nodes.map((n) => key(n.id)));
    sections.push({
      title: "Links to other subjects",
      columns: [{ title: "Note", width: 2.4 }, { title: "Other subject", width: 1.6 }, { title: "Linked to", width: 2.4 }, { title: "Why they are linked", width: 2.6 }, { title: "Strength", width: 1 }],
      rows: [...cross]
        .sort((a, b) => b.weight - a.weight)
        .map((e) => {
          const [mine, theirs] = own.has(key(e.source)) ? [e.source, e.target] : [e.target, e.source];
          return [titleOf.get(key(mine)) || "", subjectOf.get(key(theirs)) || "", titleOf.get(key(theirs)) || "", reason(e), strength(e)];
        }),
    });
  }

  if (docs.length) {
    sections.push({
      title: "Documents split into subtopics",
      columns: [{ title: "Document", width: 3 }, { title: "Subtopics, in order", width: 7 }],
      rows: docs.map((d) => [
        d.title,
        graph.nodes
          .filter((n) => key(n.parentNoteId) === key(d.id))
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
          .map((n) => n.title)
          .join("  ·  "),
      ]),
    });
  }

  const subtopics = topics.filter((n) => n.parentNoteId).length;
  const meta = [
    docs.length ? `${plural(topics.length, "topic")} (${subtopics} from ${plural(docs.length, "document")})` : plural(graph.nodes.length, "note"),
    plural(graph.edges.length, "connection"),
    ...(hasClusters ? [plural(realClusters.length, "cluster")] : []),
    ...(cross.length ? [`${cross.length} across subjects`] : []),
    `coloured by ${byCluster ? "cluster" : "links"}`,
    date,
  ].join("  ·  ");

  return {
    kicker: "Knowledge graph",
    title: subject.name,
    meta,
    fileName: `${safeFileName(subject.name)} - knowledge graph`,
    drawing: { lines, nodes, legend },
    sections,
  };
}

// The keyword map's layout, as on the page (keywordMapLayout in
// KnowledgeGraph.jsx): the note in the middle, its keywords on an ellipse
// around it (strongest at the top, then clockwise), and the open keyword's
// related words fanned out beyond it.
export function keywordMapLayout(keywords, openKeyword) {
  const cx = W / 2;
  const cy = H / 2 + 10;
  const pos = new Map([["root", [cx, cy]]]);
  keywords.forEach((k, i) => {
    const a = -Math.PI / 2 + (i / keywords.length) * Math.PI * 2;
    pos.set(`kw:${k.keyword}`, [cx + Math.cos(a) * 270, cy + Math.sin(a) * 180]);
    if (k.keyword !== openKeyword) return;
    const m = k.subKeywords.length;
    k.subKeywords.forEach((s, j) => {
      const b = a + (j - (m - 1) / 2) * 0.3;
      pos.set(`sub:${s}`, [cx + Math.cos(b) * 400, cy + Math.sin(b) * 268]);
    });
  });
  return pos;
}

// A sentence as text runs with `word` (singular or plural) in bold.
function marked(sentence, word) {
  const escape = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const forms = [word, `${word}s`, `${word}es`, ...(word.endsWith("y") ? [`${word.slice(0, -1)}ies`] : [])];
  const runs = [];
  let last = 0;
  for (const m of sentence.matchAll(new RegExp(`\\b(?:${forms.map(escape).join("|")})\\b`, "gi"))) {
    if (m.index > last) runs.push({ text: sentence.slice(last, m.index) });
    runs.push({ text: m[0], bold: true, color: COLOR.secondary });
    last = m.index + m[0].length;
  }
  if (last < sentence.length) runs.push({ text: sentence.slice(last) });
  return runs;
}

/**
 * One note's keyword map (services/keywordMap.js) with `open` - one of its
 * keywords, or null - expanded as on the page.
 */
export function keywordMapModel({ note, subjectName, keywords, open, date }) {
  const pos = keywordMapLayout(keywords, open);
  const opened = keywords.find((k) => k.keyword === open) || null;
  const [rx, ry] = pos.get("root");

  const lines = [];
  for (const k of keywords) {
    const isOpen = k.keyword === open;
    lines.push({ from: "root", to: `kw:${k.keyword}`, color: isOpen ? COLOR.secondary : COLOR.link, width: isOpen ? 2.5 : 1 + k.weight * 2, opacity: isOpen ? 0.9 : 0.75 });
  }
  for (const s of opened?.subKeywords || []) {
    lines.push({ from: `kw:${open}`, to: `sub:${s}`, color: COLOR.secondary, width: 1.5, dash: [4, 3], opacity: 0.8 });
  }

  const nodes = [
    {
      id: "root", x: rx, y: ry, shape: "pill", padX: 12, padY: 8, padR: 16, gap: 8,
      fill: "#f4f3ee", ring: COLOR.secondary,
      dot: { fill: COLOR.secondary, size: 32 },
      lines: [
        { text: clip(note.title, 30), size: 15, color: COLOR.ink },
        { text: plural(keywords.length, "keyword").toUpperCase(), size: 10, color: COLOR.secondary, tracking: 0.1 },
      ],
    },
    ...keywords.map((k) => {
      const [x, y] = pos.get(`kw:${k.keyword}`);
      const isOpen = k.keyword === open;
      return {
        id: `kw:${k.keyword}`, x, y, shape: "pill", padX: 12, padY: 4, gap: 0,
        fill: isOpen ? COLOR.secondary : COLOR.container, stroke: isOpen ? null : COLOR.border,
        lines: [{ text: k.keyword, size: 12 + Math.round(k.weight * 6), color: isOpen ? "#ffffff" : COLOR.ink }],
      };
    }),
    ...(opened?.subKeywords || []).map((s) => {
      const [x, y] = pos.get(`sub:${s}`);
      return {
        id: `sub:${s}`, x, y, shape: "pill", padX: 8, padY: 2, gap: 0,
        fill: COLOR.lowest, stroke: COLOR.secondary, dash: true,
        lines: [{ text: s, size: 11, color: COLOR.muted }],
      };
    }),
  ];

  const legend = [{ swatch: { kind: "dot", fill: COLOR.secondary }, text: "Keyword (bigger = matters more to this note)" }];
  if (opened) legend.push({ swatch: { kind: "dot", stroke: COLOR.secondary, dash: true }, text: `Appears with “${open}”` });

  return {
    kicker: "Keyword map",
    title: note.title,
    meta: [subjectName, plural(keywords.length, "keyword"), date].filter(Boolean).join("  ·  "),
    fileName: `${safeFileName(note.title)} - keyword map`,
    drawing: { lines, nodes, legend },
    sections: [
      {
        title: "Keywords",
        intro: "Weight is how much a keyword matters to this note, against its strongest keyword (100%). “Appears with” are the words used most often in the same sentences.",
        columns: [{ title: "Keyword", width: 1.5 }, { title: "Weight", width: 0.8 }, { title: "Appears with", width: 2.2 }, { title: "Where it is used", width: 6.5 }],
        rows: keywords.map((k) => {
          const used = k.sentences.flatMap((s, i) => [...(i ? [{ text: "\n" }] : []), ...marked(s, k.keyword)]);
          if (k.sentenceCount > k.sentences.length) used.push({ text: `\n${k.sentences.length} of ${k.sentenceCount} sentences shown`, color: COLOR.muted });
          return [
            { runs: [{ text: k.keyword, bold: true }] },
            `${Math.round(k.weight * 100)}%`,
            k.subKeywords.join(", ") || "—",
            used.length ? { runs: used } : "—",
          ];
        }),
        empty: "This note has no keywords yet.",
      },
    ],
  };
}
