// Download the knowledge graph, or one note's keyword map, as a PDF.
//
//   exportGraph({ subject, graph, body, timeZone })
//       graph - the subject's graph from buildSubjectGraph()
//       body  - what the page sent: { positions: { <note id>: [x, y] },
//               colorBy: "links" | "clusters" }
//   exportKeywordMap({ note, subjectName, body, timeZone })
//       body  - { keyword }: the keyword open on the page, or nothing
//
// Both return { buffer, fileName, contentType }, for sendExport() in
// services/noteExport/index.js. The page sends only where its nodes are -
// a student can drag them, so only the page knows - and how they are
// coloured. Every title, link and cluster comes from the database, so a
// request cannot put words of its own into the file. Nothing is stored.

import { InputError, text } from "../../middleware/validate.js";
import { dateLabel } from "../noteExport/model.js";
import { buildKeywordMap } from "../keywordMap.js";
import { drawnNodeIds, graphModel, keywordMapModel } from "./model.js";

// Positions are in the page's canvas units (a 1000 x 640 canvas). Dragging
// can take a node off it, but never this far.
const MAX_COORDINATE = 100_000;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isCoordinate = (v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MAX_COORDINATE;

/** The page's node positions for every node the graph draws, as a Map of id -> [x, y]. */
export function readPositions(value, graph) {
  if (!isPlainObject(value)) throw new InputError("positions must be an object of note id -> [x, y]");
  const positions = new Map();
  let missing = 0;
  for (const id of drawnNodeIds(graph)) {
    const p = Object.hasOwn(value, id) ? value[id] : undefined;
    if (p === undefined) missing += 1;
    else if (!Array.isArray(p) || p.length !== 2 || !p.every(isCoordinate)) throw new InputError("each position must be [x, y], two numbers");
    else positions.set(id, [p[0], p[1]]);
  }
  // a note added (in another tab, say) since the page drew the graph has no place on it yet
  if (missing) throw new InputError("This graph has changed since the page was opened. Reload the page and download it again.", 409);
  return positions;
}

async function write(model) {
  const { renderGraphPdf } = await import("./pdf.js");
  return { buffer: await renderGraphPdf(model), fileName: `${model.fileName}.pdf`, contentType: "application/pdf" };
}

export async function exportGraph({ subject, graph, body, timeZone }) {
  if (!graph.nodes.length) throw new InputError("this subject has no notes to draw yet", 404);
  const positions = readPositions(body?.positions, graph);
  const colorBy = body?.colorBy === "clusters" ? "clusters" : "links";
  return write(graphModel({ subject, graph, positions, colorBy, date: dateLabel(new Date(), timeZone) }));
}

export async function exportKeywordMap({ note, subjectName, body, timeZone }) {
  const keywords = buildKeywordMap(note);
  const asked = text(body?.keyword, "keyword", { required: false, max: 100 });
  // a keyword the note no longer has is shown closed, as the page would show it
  const open = keywords.some((k) => k.keyword === asked) ? asked : null;
  return write(keywordMapModel({ note, subjectName, keywords, open, date: dateLabel(new Date(), timeZone) }));
}
