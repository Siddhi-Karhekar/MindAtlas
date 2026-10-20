import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import Icon from "./Icon.jsx";
import { ACCEPTED, DEFAULT_IMAGE_LIMITS, imageProblem, shrinkImage } from "../lib/answerImages.js";

// Pictures on a theory answer: a photo of handwritten working, a formula or a
// diagram that is hard to type. Each picture is shrunk in the browser
// (lib/answerImages.js) and stored on the server straight away, so it is kept
// across a refresh or a dropped connection; it is saved with the answer when
// the student moves on, and read and marked with it at submission.

// A picture from the API as an object URL (fetched with the session).
function useImageUrl(imageId, fallback = null) {
  const [url, setUrl] = useState(fallback);
  useEffect(() => {
    if (!imageId || fallback) return undefined;
    let live = true;
    let made = null;
    api
      .answerImageBlob(imageId)
      .then((blob) => {
        if (!live) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => live && setUrl(null));
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [imageId, fallback]);
  return url;
}

function Thumb({ item, onRemove, disabled }) {
  const url = useImageUrl(item.id, item.localUrl || null);
  return (
    <li className="relative w-28 h-28 rounded-lg overflow-hidden border border-outline-variant bg-surface-container-low" data-testid="answer-image">
      {url ? (
        <img src={url} alt="Your attached page" className={`w-full h-full object-cover ${item.status === "uploading" ? "opacity-50" : ""}`} />
      ) : (
        <span className="w-full h-full flex items-center justify-center text-on-surface-variant">
          <Icon name="image" />
        </span>
      )}
      {item.status === "uploading" && (
        <span className="absolute inset-x-0 bottom-0 text-center text-[11px] bg-surface/80 text-on-surface py-0.5">Uploading…</span>
      )}
      {onRemove && item.status !== "uploading" && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onRemove(item)}
          aria-label="Remove this picture"
          className="absolute top-1 right-1 w-7 h-7 rounded-full bg-surface/90 text-on-surface shadow flex items-center justify-center hover:bg-error-container"
        >
          <Icon name="close" className="text-sm" />
        </button>
      )}
    </li>
  );
}

/**
 * The attach / take-a-photo control with previews, for the question being answered.
 * `onCountChange(n)` is told how many pictures are attached and uploaded.
 */
export default function AnswerImages({ attemptId, questionId, disabled = false, onCountChange }) {
  const [items, setItems] = useState([]); // { key, id?, localUrl?, status: "uploading" | "done" }
  const [error, setError] = useState("");
  const [max, setMax] = useState(DEFAULT_IMAGE_LIMITS.maxPerAnswer);
  const fileRef = useRef(null);
  const cameraRef = useRef(null);
  const latest = useRef(items);
  useEffect(() => {
    latest.current = items;
  }, [items]);

  // the pictures already added to this answer (after a refresh, or reopening
  // the test). The component is keyed by question, so it starts empty.
  useEffect(() => {
    let live = true;
    api
      .listAnswerImages(attemptId, questionId)
      .then((d) => {
        if (!live) return;
        setMax(d.max || DEFAULT_IMAGE_LIMITS.maxPerAnswer);
        setItems(d.images.map((im) => ({ key: im._id, id: im._id, status: "done" })));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [attemptId, questionId]);

  useEffect(() => {
    onCountChange?.(items.filter((i) => i.status === "done").length);
  }, [items, onCountChange]);

  // object URLs of local previews are released when they are no longer shown
  useEffect(
    () => () => {
      for (const i of latest.current) if (i.localUrl) URL.revokeObjectURL(i.localUrl);
    },
    []
  );

  const add = useCallback(
    async (fileList) => {
      setError("");
      const files = Array.from(fileList || []);
      let count = latest.current.length;
      for (const file of files) {
        const problem = imageProblem(file, { count, limits: { maxPerAnswer: max, maxMb: DEFAULT_IMAGE_LIMITS.maxMb } });
        if (problem) {
          setError(problem);
          continue;
        }
        count++;
        const key = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        let localUrl = null;
        try {
          const blob = await shrinkImage(file);
          localUrl = URL.createObjectURL(blob);
          setItems((prev) => [...prev, { key, localUrl, status: "uploading" }]);
          const out = await api.uploadAnswerImage(attemptId, questionId, blob, `${(file.name || "page").replace(/\.[^.]+$/, "")}.jpg`);
          setItems((prev) => prev.map((i) => (i.key === key ? { ...i, id: out.image._id, status: "done" } : i)));
        } catch (err) {
          count--;
          if (localUrl) URL.revokeObjectURL(localUrl);
          setItems((prev) => prev.filter((i) => i.key !== key));
          setError(err.message || "The picture could not be uploaded - check your connection and try again.");
        }
      }
    },
    [attemptId, questionId, max]
  );

  async function remove(item) {
    setError("");
    try {
      if (item.id) await api.deleteAnswerImage(attemptId, item.id);
      if (item.localUrl) URL.revokeObjectURL(item.localUrl);
      setItems((prev) => prev.filter((i) => i.key !== item.key));
    } catch (err) {
      setError(err.message || "The picture could not be removed - try again.");
    }
  }

  const full = items.length >= max;
  return (
    <div className="mt-space-sm flex flex-col gap-space-sm text-left" data-testid="answer-images">
      <div className="flex flex-wrap items-center gap-space-sm">
        <button
          type="button"
          disabled={disabled || full}
          onClick={() => fileRef.current?.click()}
          className="px-space-md py-space-xs rounded-lg border border-outline-variant bg-surface-container-lowest text-on-surface font-label-md text-label-md flex items-center gap-space-xs hover:bg-surface-container disabled:opacity-50"
        >
          <Icon name="attach_file" className="text-base" /> Attach image
        </button>
        <button
          type="button"
          disabled={disabled || full}
          onClick={() => cameraRef.current?.click()}
          className="px-space-md py-space-xs rounded-lg border border-outline-variant bg-surface-container-lowest text-on-surface font-label-md text-label-md flex items-center gap-space-xs hover:bg-surface-container disabled:opacity-50"
        >
          <Icon name="photo_camera" className="text-base" /> Take photo
        </button>
        <span className="font-label-sm text-label-sm text-on-surface-variant">
          Handwritten working, formulas or diagrams · {items.length} of {max}
        </span>
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPTED}
          multiple
          className="hidden"
          data-testid="answer-image-input"
          onChange={(e) => {
            add(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            add(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      {items.length > 0 && (
        <ul className="flex flex-wrap gap-space-sm">
          {items.map((item) => (
            <Thumb key={item.key} item={item} onRemove={remove} disabled={disabled} />
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="font-body-sm text-body-sm text-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** The pictures of a submitted answer, for the review: click one to open it full size. */
export function AnswerImageThumbs({ images }) {
  if (!images?.length) return null;
  return (
    <ul className="flex flex-wrap gap-space-sm" data-testid="review-images">
      {images.map((im) => (
        <ReviewThumb key={im._id} id={im._id} />
      ))}
    </ul>
  );
}

function ReviewThumb({ id }) {
  const url = useImageUrl(id);
  return (
    <li className="w-28 h-28 rounded-lg overflow-hidden border border-outline-variant bg-surface-container-low">
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" title="Open full size">
          <img src={url} alt="Your attached page" className="w-full h-full object-cover" />
        </a>
      ) : (
        <span className="w-full h-full flex items-center justify-center text-on-surface-variant">
          <Icon name="image" />
        </span>
      )}
    </li>
  );
}
