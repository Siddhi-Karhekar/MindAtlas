import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { readingMinutes, wordCount } from "../lib/format.js";
import Icon from "../components/Icon.jsx";

// Small static preview of the subject's current graph: nodes on a circle, real
// edges between them. Just enough to show where a new note will land.
function MiniGraph({ graph }) {
  const nodes = graph.nodes.slice(0, 14);
  const pos = new Map();
  nodes.forEach((n, i) => {
    const a = (i / Math.max(nodes.length, 1)) * Math.PI * 2 - Math.PI / 2;
    pos.set(String(n.id), [140 + Math.cos(a) * 88, 70 + Math.sin(a) * 46]);
  });
  const edges = graph.edges.filter((e) => pos.has(String(e.source)) && pos.has(String(e.target)));
  return (
    <svg className="w-full h-full text-secondary" fill="none" viewBox="0 0 280 140" xmlns="http://www.w3.org/2000/svg">
      {edges.map((e) => {
        const [x1, y1] = pos.get(String(e.source));
        const [x2, y2] = pos.get(String(e.target));
        return <line key={e.id} x1={x1} y1={y1} x2={x2} y2={y2} stroke="currentColor" strokeOpacity="0.35" strokeWidth="1.5" />;
      })}
      {nodes.map((n) => {
        const [x, y] = pos.get(String(n.id));
        return <circle key={n.id} cx={x} cy={y} r="7" className="fill-surface-container-highest stroke-secondary" strokeWidth="2" />;
      })}
    </svg>
  );
}

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = ".pdf,.docx,.txt,.md,.markdown,.csv,image/*";
const EXT_OK = /\.(pdf|docx|txt|md|markdown|text|csv|png|jpe?g|gif|webp|bmp|tiff?)$/i;

function fileProblem(f) {
  if (!(EXT_OK.test(f.name) || f.type.startsWith("image/") || f.type.startsWith("text/")))
    return "Unsupported type — use PDF, Word (.docx), text/markdown or an image";
  if (f.size > MAX_BYTES) return "Larger than 10 MB";
  return "";
}

function fileIcon(name, type) {
  if (type?.startsWith("image/")) return "image";
  if (/\.pdf$/i.test(name)) return "picture_as_pdf";
  if (/\.docx$/i.test(name)) return "description";
  return "article";
}

function prettySize(n) {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function NoteEditor() {
  const { subjectId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const fileRef = useRef(null);

  const [mode, setMode] = useState(["scan", "upload"].includes(params.get("mode")) ? "upload" : "typed");
  const [subject, setSubject] = useState(null);
  const [graph, setGraph] = useState({ nodes: [], edges: [] });
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  // Uploaded files: [{ id, file, status: "ready" | "working" | "done" | "error", error }]
  const [files, setFiles] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listSubjects().then((d) => setSubject(d.subjects.find((s) => String(s._id) === String(subjectId)) || null)).catch(() => {});
    api.getGraph(subjectId).then(setGraph).catch(() => {});
  }, [subjectId]);

  const words = useMemo(() => wordCount(content), [content]);
  const pending = files.filter((f) => f.status !== "done");
  const doneCount = files.length - pending.length;
  const canSave = mode === "upload" ? pending.length > 0 : title.trim() && content.trim();

  function addFiles(list) {
    const incoming = Array.from(list || []);
    if (!incoming.length) return;
    setError("");
    setFiles((prev) => {
      const seen = new Set(prev.map((p) => `${p.file.name}:${p.file.size}`));
      const next = [...prev];
      for (const f of incoming) {
        const key = `${f.name}:${f.size}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const problem = fileProblem(f);
        next.push({ id: `${key}:${Math.random().toString(36).slice(2, 7)}`, file: f, status: problem ? "error" : "ready", error: problem });
      }
      return next;
    });
  }

  function removeFile(id) {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }

  const setStatus = (id, patch) => setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));

  async function handleUpload() {
    // One note per file, uploaded one after another so the server links each
    // new note to the ones before it.
    const queue = files.filter((f) => f.status === "ready" || (f.status === "error" && !fileProblem(f.file)));
    if (!queue.length) {
      setError("Nothing to upload — remove the files marked with a problem or choose others.");
      return;
    }
    const single = files.length === 1;
    let edges = 0;
    let added = doneCount;
    let lastId = null;
    let failed = 0;
    for (const item of queue) {
      setStatus(item.id, { status: "working", error: "" });
      try {
        const r = await api.uploadNoteImage(subjectId, item.file, single ? title.trim() : "");
        edges += r.edgesCreated || 0;
        // a long document with headings comes back split into one note per section
        added += r.notes?.length || 1;
        lastId = r.note._id;
        setStatus(item.id, { status: "done", noteId: r.note._id });
      } catch (err) {
        failed += 1;
        setStatus(item.id, { status: "error", error: err.message });
      }
    }
    setBusy(false);
    if (failed === 0) {
      navigate(added === 1 ? `/subjects/${subjectId}?note=${lastId}` : `/subjects/${subjectId}`, {
        state: { edgesCreated: edges, addedCount: added },
      });
    } else {
      setError(`${added} of ${files.length} uploaded. Fix or remove the files marked below, then try again.`);
    }
  }

  async function handleSave(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    if (mode === "upload") return handleUpload();
    try {
      const result = await api.createNote(subjectId, { title: title.trim(), content: content.trim() });
      navigate(`/subjects/${subjectId}?note=${result.note._id}`, { state: { edgesCreated: result.edgesCreated } });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const pill = (active) =>
    `inline-flex items-center gap-space-2xs px-space-sm py-space-2xs rounded-full font-label-md text-label-md transition-colors ${
      active ? "bg-primary-container text-on-primary-container font-semibold" : "bg-surface-container-high text-on-surface-variant hover:text-on-surface"
    }`;

  return (
    <form onSubmit={handleSave} className="flex flex-col w-full max-w-[1360px] mx-auto pb-space-2xl">
      <div className="flex items-center justify-between py-space-sm px-space-md mb-space-lg bg-surface-container-low rounded-lg shadow-sm border border-outline-variant/30">
        <div className="flex items-center gap-space-md">
          <Link
            to={`/subjects/${subjectId}`}
            className="w-7 h-7 rounded-full bg-secondary-container flex items-center justify-center text-secondary shrink-0 hover:opacity-80"
            aria-label="Back to notes"
          >
            <Icon name="arrow_back" className="text-base" />
          </Link>
          <div className="flex items-center gap-space-xs font-label-md text-label-md">
            <span className="font-semibold text-on-surface">{mode === "upload" ? "Upload notes to" : "New note in"} {subject?.name || "this subject"}</span>
            <span className="text-outline-variant">•</span>
            <span className="text-secondary font-medium">{mode === "upload" ? `${files.length} selected` : "Unsaved draft"}</span>
          </div>
        </div>
        <div className="flex items-center gap-space-sm">
          <Link
            to={`/subjects/${subjectId}`}
            className="px-space-md py-space-xs rounded-lg text-on-surface-variant hover:bg-surface-container-high transition-colors font-ui-body text-ui-body"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={busy || !canSave}
            className="px-space-md py-space-xs rounded-lg bg-primary text-on-primary font-ui-body text-ui-body hover:opacity-90 transition-colors disabled:opacity-50 flex items-center gap-space-xs"
          >
            <Icon name={busy ? "sync" : "check"} className={`text-base ${busy ? "animate-spin" : ""}`} />
            <span>
              {busy
                ? mode === "upload"
                  ? "Uploading…"
                  : "Saving…"
                : mode === "upload"
                  ? pending.length > 1
                    ? `Add ${pending.length} notes`
                    : "Add note"
                  : "Save note"}
            </span>
          </button>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-space-xl items-start w-full">
        <article className="flex-1 w-full bg-surface-container-lowest rounded-xl shadow-sm p-space-xl lg:p-space-2xl min-w-0 border border-outline-variant/20">
          <div className="flex items-center justify-between gap-space-md mb-space-xl pb-space-sm border-b border-surface-container-high flex-wrap">
            <div className="flex items-center gap-space-sm flex-wrap">
              <button type="button" className={pill(mode === "typed")} onClick={() => setMode("typed")}>
                <Icon name="edit_note" className="text-sm" />
                Type
              </button>
              <button type="button" className={pill(mode === "upload")} onClick={() => setMode("upload")}>
                <Icon name="upload_file" className="text-sm" />
                Upload files
              </button>
              {subject && (
                <span className="inline-flex items-center gap-space-2xs px-space-sm py-space-2xs rounded-full bg-surface-container font-label-md text-label-md text-secondary">
                  <span className="w-1.5 h-1.5 rounded-full bg-secondary"></span>
                  {subject.name}
                </span>
              )}
            </div>
            {mode === "typed" && (
              <span className="font-label-sm text-label-sm text-outline tracking-wider uppercase">
                {words} {words === 1 ? "word" : "words"} · {readingMinutes(content)} min read
              </span>
            )}
          </div>

          {(mode === "typed" || files.length === 1) && (
          <input
            aria-label="Note title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full bg-transparent font-headline-lg text-headline-lg lg:font-display-lg lg:text-display-lg text-on-surface font-semibold focus:outline-none placeholder-outline mb-space-lg tracking-tight"
            placeholder={mode === "upload" ? "Title (optional — defaults to the file name)" : "Untitled Note..."}
            type="text"
            autoFocus={mode === "typed"}
          />
          )}

          {mode === "typed" ? (
            <textarea
              aria-label="Note body"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={16}
              className="w-full bg-transparent resize-y min-h-[320px] text-on-surface font-body-lg text-body-lg leading-relaxed focus:outline-none placeholder-outline"
              placeholder="Type or paste the note's text. Leave a blank line between paragraphs."
            />
          ) : (
            <div className="flex flex-col gap-space-lg">
              <div
                className={`group relative rounded-xl border-2 border-dashed p-space-xl transition-all cursor-pointer text-center ${
                  dragOver
                    ? "border-secondary bg-surface-container-low"
                    : "border-outline-variant/60 hover:border-secondary bg-surface-container-low/40 hover:bg-surface-container-low"
                }`}
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  addFiles(e.dataTransfer.files);
                }}
              >
                <input
                  ref={fileRef}
                  data-testid="note-file-input"
                  type="file"
                  multiple
                  accept={ACCEPT}
                  className="hidden"
                  onChange={(e) => {
                    addFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
                <div className="flex flex-col items-center justify-center gap-space-sm pointer-events-none">
                  <div className="w-12 h-12 rounded-full bg-surface-container-highest flex items-center justify-center text-primary group-hover:scale-105 group-hover:bg-secondary-container group-hover:text-secondary transition-all">
                    <Icon name="cloud_upload" className="text-2xl" />
                  </div>
                  <div className="flex flex-col gap-space-2xs">
                    <p className="font-ui-title text-ui-title text-on-surface font-semibold">
                      {files.length ? "Add more files" : "Drop your existing notes here"}
                    </p>
                    <p className="font-body-sm text-body-sm text-on-surface-variant max-w-md mx-auto">
                      Or click to browse. Each file becomes its own note and is linked to the rest of this subject
                      automatically.
                    </p>
                  </div>
                  <div className="flex items-center gap-space-sm mt-space-xs text-outline font-label-md text-label-md flex-wrap justify-center">
                    <span>PDF</span>
                    <span>•</span>
                    <span>Word (.docx)</span>
                    <span>•</span>
                    <span>TXT / Markdown</span>
                    <span>•</span>
                    <span>Photos (OCR)</span>
                    <span>•</span>
                    <span>10 MB each</span>
                  </div>
                </div>
              </div>

              {files.length > 0 && (
                <ul className="flex flex-col gap-space-xs" data-testid="upload-list">
                  {files.map((f) => (
                    <li
                      key={f.id}
                      className={`flex items-center gap-space-md px-space-md py-space-sm rounded-lg border ${
                        f.status === "error"
                          ? "border-error/40 bg-error-container/30"
                          : "border-outline-variant/30 bg-surface-container-low"
                      }`}
                    >
                      <Icon
                        name={f.status === "done" ? "check_circle" : fileIcon(f.file.name, f.file.type)}
                        filled={f.status === "done"}
                        className={`text-xl shrink-0 ${f.status === "done" ? "text-secondary" : "text-primary"}`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="font-ui-body text-ui-body text-on-surface font-medium truncate">{f.file.name}</p>
                        <p className={`font-label-md text-label-md ${f.status === "error" ? "text-error" : "text-on-surface-variant"}`}>
                          {f.status === "error"
                            ? f.error
                            : f.status === "working"
                              ? "Reading and linking…"
                              : f.status === "done"
                                ? "Added"
                                : prettySize(f.file.size)}
                        </p>
                      </div>
                      {f.status === "working" ? (
                        <Icon name="sync" className="text-base animate-spin text-secondary" />
                      ) : f.status !== "done" ? (
                        <button
                          type="button"
                          onClick={() => removeFile(f.id)}
                          aria-label={`Remove ${f.file.name}`}
                          className="w-7 h-7 rounded-full flex items-center justify-center text-on-surface-variant hover:bg-surface-container-high"
                        >
                          <Icon name="close" className="text-base" />
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              <p className="font-label-md text-label-md text-on-surface-variant">
                Long documents with numbered headings (like a whole unit's notes) are split into one note per
                section. Scanned PDFs have no readable text — upload those as photos instead so they go through OCR.
              </p>
            </div>
          )}

          {error && (
            <p role="alert" className="mt-space-lg font-body-sm text-body-sm text-error">
              {error}
            </p>
          )}
        </article>

        <aside className="w-full lg:w-inspector-width shrink-0 flex flex-col gap-space-lg">
          <div className="bg-surface-container-lowest rounded-xl shadow-sm p-space-lg border border-outline-variant/20">
            <div className="flex items-center justify-between mb-space-md">
              <span className="font-ui-title text-ui-title text-primary font-semibold">Graph Topology</span>
            </div>
            <div className="relative h-40 rounded-lg bg-surface-container-low overflow-hidden flex items-center justify-center p-space-sm border border-outline-variant/30">
              {graph.nodes.length > 0 ? (
                <MiniGraph graph={graph} />
              ) : (
                <p className="font-body-sm text-body-sm text-on-surface-variant text-center">
                  This will be the first note in the graph.
                </p>
              )}
            </div>
            <div className="mt-space-md flex items-center justify-between text-on-surface-variant font-label-md text-label-md">
              <span>
                {graph.nodes.length} {graph.nodes.length === 1 ? "note" : "notes"} · {graph.edges.length}{" "}
                {graph.edges.length === 1 ? "link" : "links"}
              </span>
              <Link
                to={`/subjects/${subjectId}/graph`}
                className="text-secondary hover:text-primary flex items-center gap-space-2xs transition-colors font-medium"
              >
                <span>Open graph</span>
                <Icon name="arrow_forward" className="text-xs" />
              </Link>
            </div>
          </div>

          <div className="bg-surface-container-low rounded-xl p-space-lg border border-outline-variant/20">
            <div className="flex items-center gap-space-xs mb-space-sm text-tertiary">
              <Icon name="hub" className="text-base" />
              <span className="font-ui-title text-ui-title font-semibold">How linking works</span>
            </div>
            <p className="font-body-sm text-body-sm text-on-surface leading-normal">
              When you save, Mind Atlas extracts this note&apos;s most distinctive keywords (TF-IDF) and connects it to
              any existing note in this subject that shares enough of them. No manual tagging needed.
            </p>
          </div>
        </aside>
      </div>
    </form>
  );
}
