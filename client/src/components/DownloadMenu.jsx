import { useEffect, useRef, useState } from "react";
import Icon from "./Icon.jsx";

// Hand a file to the browser to save. The link is clicked from code because
// the file comes from a request that carries the sign-in token, which a plain
// <a href> cannot send.
function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // let the download start before the address is given back
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const FORMATS = [
  { key: "pdf", label: "PDF", icon: "picture_as_pdf" },
  { key: "docx", label: "Word", icon: "description" },
];

/**
 * A download button that opens a small menu: one row per thing that can be
 * downloaded, each as a PDF or a Word file.
 *
 * `choices`: [{ key, label, hint, fetch(format) -> Promise<{ blob, fileName }>, fallbackName }]
 */
export default function DownloadMenu({ choices }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(""); // "<choice key>:<format>" while a file is being made
  const [error, setError] = useState("");
  const root = useRef(null);

  // close on a click elsewhere or Escape
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (root.current && !root.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function download(choice, format) {
    setBusy(`${choice.key}:${format}`);
    setError("");
    try {
      const { blob, fileName } = await choice.fetch(format);
      saveBlob(blob, fileName || `${choice.fallbackName || "notes"}.${format}`);
      setOpen(false);
    } catch (err) {
      setError(err.message || "The download failed. Please try again.");
    } finally {
      setBusy("");
    }
  }

  if (!choices?.length) return null;
  return (
    <div className="relative" ref={root}>
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          setError("");
        }}
        data-testid="note-download"
        aria-label="Download"
        aria-haspopup="true"
        aria-expanded={open}
        title="Download as PDF or Word"
        className={`w-7 h-7 rounded-full flex items-center justify-center hover:bg-surface-container-high hover:text-on-surface ${
          open ? "bg-surface-container-high text-on-surface" : "text-on-surface-variant"
        }`}
      >
        <Icon name="download" className="text-base" />
      </button>
      {open && (
        <div
          role="group"
          aria-label="Download"
          data-testid="download-menu"
          className="absolute right-0 top-9 z-30 w-[min(320px,calc(100vw-8.5rem))] rounded-xl bg-surface-container-lowest border border-outline-variant shadow-lg p-space-sm flex flex-col gap-space-2xs text-on-surface"
        >
          <p className="px-space-sm pt-space-xs pb-space-2xs font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant font-bold">
            Download
          </p>
          {choices.map((choice) => (
            <div key={choice.key} className="flex items-center justify-between gap-space-sm px-space-sm py-space-xs rounded-lg" data-testid={`download-${choice.key}`}>
              <div className="min-w-0">
                <p className="font-ui-body text-ui-body font-semibold">{choice.label}</p>
                {choice.hint && <p className="font-label-sm text-label-sm text-on-surface-variant truncate">{choice.hint}</p>}
              </div>
              <div className="flex items-center gap-space-2xs shrink-0">
                {FORMATS.map((f) => {
                  const working = busy === `${choice.key}:${f.key}`;
                  return (
                    <button
                      key={f.key}
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={() => download(choice, f.key)}
                      data-testid={`download-${choice.key}-${f.key}`}
                      aria-label={`${choice.label} as ${f.label}`}
                      className="h-8 px-space-sm rounded-lg bg-surface-container-high hover:bg-surface-container-highest font-label-md text-label-md font-semibold flex items-center gap-space-2xs disabled:opacity-60"
                    >
                      <Icon name={working ? "progress_activity" : f.icon} className={`text-base ${working ? "animate-spin" : ""}`} />
                      {f.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {error ? (
            <p role="alert" className="px-space-sm py-space-xs font-body-sm text-body-sm text-error">
              {error}
            </p>
          ) : (
            <p className="px-space-sm pb-space-xs font-label-sm text-label-sm text-on-surface-variant">
              With a contents list and the same topic colours as here.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
