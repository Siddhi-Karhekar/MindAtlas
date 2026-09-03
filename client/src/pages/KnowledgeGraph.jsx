import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import cytoscape from "cytoscape";
import { api } from "../lib/api.js";

export default function KnowledgeGraph() {
  const { subjectId } = useParams();
  const containerRef = useRef(null);
  const cyRef = useRef(null);
  const [graph, setGraph] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .getGraph(subjectId)
      .then(setGraph)
      .catch((err) => setError(err.message));
  }, [subjectId]);

  useEffect(() => {
    if (!graph || !containerRef.current) return;

    const elements = [
      ...graph.nodes.map((n) => ({ data: { id: n.id, label: n.title } })),
      ...graph.edges.map((e) => ({
        data: {
          id: `${e.source}-${e.target}`,
          source: e.source,
          target: e.target,
          weight: e.weight,
          label: e.sharedKeywords.slice(0, 2).join(", "),
        },
      })),
    ];

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: [
        {
          selector: "node",
          style: {
            "background-color": "#364156",
            label: "data(label)",
            color: "#1f2430",
            "font-size": 11,
            "text-valign": "bottom",
            "text-margin-y": 6,
            width: 34,
            height: 34,
            "border-width": 2,
            "border-color": "#dfe3e8",
          },
        },
        {
          selector: "edge",
          style: {
            width: "mapData(weight, 0, 1, 1, 8)",
            "line-color": "#c98e3d",
            "curve-style": "bezier",
            label: "data(label)",
            "font-size": 9,
            color: "#5a6270",
            "text-rotation": "autorotate",
          },
        },
      ],
      layout: {
        name: "cose",
        animate: false,
        padding: 50,
        nodeRepulsion: () => 40000,
        idealEdgeLength: () => 160,
        componentSpacing: 120,
      },
    });

    cyRef.current = cy;
    return () => cy.destroy();
  }, [graph]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Knowledge graph</h1>
        <Link to={`/subjects/${subjectId}`} className="text-sm font-semibold text-primary hover:underline">
          ← Back to notes
        </Link>
      </div>

      {error && <p className="text-sm text-error">{error}</p>}

      {graph && graph.nodes.length === 0 && (
        <p className="text-ink-soft text-sm">Add a couple of notes to this subject to see them connect here.</p>
      )}

      <div
        ref={containerRef}
        className="w-full h-[520px] rounded-xl border border-black/10 bg-surface"
      />

      {graph && (
        <p className="text-xs text-ink-soft mt-3">
          {graph.nodes.length} note{graph.nodes.length === 1 ? "" : "s"} · {graph.edges.length} connection
          {graph.edges.length === 1 ? "" : "s"}
        </p>
      )}
    </div>
  );
}
