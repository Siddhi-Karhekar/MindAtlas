import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";
import Icon from "./Icon.jsx";
import ReportQuestion from "./ReportQuestion.jsx";

const fmt = (n) => String(Number(Number(n).toFixed(2))); // 1, 0.25, -1
const marksText = (item) => `${fmt(item.marksAwarded)} / ${fmt(item.marks)} ${item.marks === 1 ? "mark" : "marks"}`;

function MarksBadge({ item }) {
  const share = item.marks ? item.marksAwarded / item.marks : 0;
  const tone =
    share >= 0.999
      ? "bg-secondary-container text-on-secondary-container"
      : share > 0
        ? "bg-tertiary-container text-on-tertiary-container"
        : "bg-error-container text-on-error-container";
  return <span className={`font-label-md text-label-md font-semibold px-space-xs py-space-2xs rounded shrink-0 ${tone}`}>{marksText(item)}</span>;
}

function McqAnswer({ item }) {
  return (
    <ul className="flex flex-col gap-space-xs">
      {item.options.map((opt, i) => {
        const right = opt === item.correctAnswer;
        const chosen = opt === item.answer;
        return (
          <li
            key={opt}
            className={`flex items-center gap-space-sm rounded-lg px-space-md py-space-xs font-body-sm text-body-sm ${
              right ? "bg-secondary-container/60 text-on-surface" : chosen ? "bg-error-container/60 text-on-surface" : "text-on-surface-variant"
            }`}
          >
            <span className="w-5 shrink-0 font-label-md">{String.fromCharCode(65 + i)}</span>
            <span className="flex-1">{opt}</span>
            {right && (
              <span className="flex items-center gap-space-2xs font-label-md text-secondary">
                <Icon name="check" className="text-sm" /> correct answer
              </span>
            )}
            {chosen && !right && (
              <span className="flex items-center gap-space-2xs font-label-md text-error">
                <Icon name="close" className="text-sm" /> your answer
              </span>
            )}
            {chosen && right && <span className="font-label-md text-secondary">your answer</span>}
          </li>
        );
      })}
    </ul>
  );
}

function TheoryAnswer({ item }) {
  return (
    <div className="flex flex-col gap-space-sm">
      <div>
        <p className="font-label-md text-label-md uppercase tracking-wider text-on-surface-variant">Your answer</p>
        <p className="font-body-sm text-body-sm text-on-surface whitespace-pre-wrap">{item.answer || "Not answered."}</p>
      </div>
      {item.keyPoints?.length > 0 && (
        <div>
          <p className="font-label-md text-label-md uppercase tracking-wider text-on-surface-variant">Key points a full answer mentions</p>
          <ul className="flex flex-col gap-space-2xs mt-space-2xs" data-testid="key-points">
            {item.keyPoints.map((k) => (
              <li key={k.point} className="flex items-center gap-space-xs font-body-sm text-body-sm">
                <Icon name={k.covered ? "check_circle" : "cancel"} className={`text-sm ${k.covered ? "text-secondary" : "text-error"}`} />
                <span className={k.covered ? "text-on-surface" : "text-on-surface-variant"}>{k.point}</span>
                <span className="font-label-sm text-label-sm text-on-surface-variant">{k.covered ? "covered" : "missing"}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <p className="font-label-md text-label-md uppercase tracking-wider text-on-surface-variant">Model answer</p>
        <p className="font-body-sm text-body-sm text-on-surface">{item.modelAnswer}</p>
      </div>
    </div>
  );
}

function Remark({ attemptId, item, onDone }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (item.remark) {
    const before = item.remark.before * item.marks;
    const after = item.remark.after * item.marks;
    return (
      <p className="font-label-md text-label-md text-on-surface-variant" data-testid="remark-result">
        Marked again: {fmt(before)} → {fmt(after)} {item.marks === 1 ? "mark" : "marks"}
        {after === before ? " (no change)" : ""}.
      </p>
    );
  }
  if (!item.canRemark) return null;
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="font-label-md text-label-md text-secondary hover:underline flex items-center gap-space-xs"
        data-testid="ask-remark"
      >
        <Icon name="rate_review" className="text-sm" /> Ask for this to be marked again
      </button>
    );
  }
  async function send() {
    setBusy(true);
    setError("");
    try {
      const out = await api.remarkAnswer(attemptId, item.questionId, reason.trim() || undefined);
      onDone(out);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }
  return (
    <div className="rounded-lg bg-surface-container-low p-space-md flex flex-col gap-space-sm" data-testid="remark-form">
      <p className="font-body-sm text-body-sm text-on-surface">
        A second, independent marking checks your answer against each key point again. Its mark replaces this one, so it can go up or down. You can ask once
        per question.
      </p>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={1000}
        rows={2}
        placeholder="Why do you think it deserves more? (optional, kept with the request)"
        className="w-full rounded-lg bg-surface-container-lowest border border-outline-variant p-space-sm font-body-sm text-body-sm text-on-surface focus:outline-none focus:border-primary"
      />
      {error && (
        <p role="alert" className="font-body-sm text-body-sm text-error">
          {error}
        </p>
      )}
      <div className="flex items-center gap-space-sm">
        <button type="button" onClick={send} disabled={busy} className="h-9 px-space-lg rounded-lg bg-primary text-on-primary font-ui-body text-ui-body disabled:opacity-50">
          {busy ? "Marking…" : "Mark it again"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="h-9 px-space-md rounded-lg text-on-surface-variant font-ui-body text-ui-body hover:bg-surface-container-high">
          Cancel
        </button>
      </div>
    </div>
  );
}

// Question by question, after a test: what was asked, the student's answer,
// the right one (or the model answer and which key points were covered), the
// marks and the reason, and the passage of the notes it came from - with a
// link to that note, a re-marking request for theory answers and "Report
// this question".
export default function AnswerReview({ attemptId, subjectId, onMarksChanged }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  const [onlyLost, setOnlyLost] = useState(false);

  useEffect(() => {
    api
      .getReview(attemptId)
      .then((d) => setItems(d.items))
      .catch((err) => setError(err.message));
  }, [attemptId]);

  if (error) {
    return (
      <section className="bg-surface-container-lowest rounded-xl p-space-xl shadow-sm">
        <p className="font-body-md text-body-md text-on-surface-variant">The question-by-question review could not be loaded: {error}</p>
      </section>
    );
  }
  if (!items) {
    return (
      <section className="bg-surface-container-lowest rounded-xl p-space-xl shadow-sm">
        <p className="font-body-md text-body-md text-on-surface-variant">Loading your answers…</p>
      </section>
    );
  }

  const lost = items.filter((i) => i.marksAwarded < i.marks);
  const shown = onlyLost ? lost : items;

  return (
    <section className="bg-surface-container-lowest rounded-xl p-space-xl shadow-sm flex flex-col gap-space-lg" data-testid="answer-review">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-space-sm">
        <div className="flex flex-col">
          <span className="font-label-md text-label-md uppercase tracking-wider text-secondary">Question by question</span>
          <h3 className="font-headline-sm text-headline-sm text-primary">Where the marks went</h3>
        </div>
        {lost.length > 0 && lost.length < items.length && (
          <label className="flex items-center gap-space-xs font-label-md text-label-md text-on-surface-variant cursor-pointer">
            <input type="checkbox" checked={onlyLost} onChange={(e) => setOnlyLost(e.target.checked)} />
            Only questions that lost marks ({lost.length})
          </label>
        )}
      </div>

      {shown.map((item) => (
        <article key={item.questionId} className="rounded-xl bg-surface-container-low p-space-lg flex flex-col gap-space-md" data-testid="review-item">
          <div className="flex items-start justify-between gap-space-md">
            <div className="min-w-0">
              <p className="font-label-md text-label-md text-on-surface-variant">
                Question {item.number}
                {item.type === "theory" ? " · Theory" : ""} · {item.subtopic || item.topic}
                {item.parentTopic ? <span> in {item.parentTopic}</span> : null}
              </p>
              <p className="font-ui-title text-ui-title text-on-surface mt-space-2xs">{item.prompt}</p>
            </div>
            <MarksBadge item={item} />
          </div>

          {item.skipped ? (
            <p className="font-body-sm text-body-sm text-on-surface-variant">Left blank - no marks, and no penalty.</p>
          ) : (
            !item.answered && <p className="font-body-sm text-body-sm text-error">Not answered - time ran out or the test was submitted before it.</p>
          )}
          {item.type === "theory" ? <TheoryAnswer item={item} /> : <McqAnswer item={item} />}

          {item.graderNote && item.answered && item.type === "theory" && (
            <p className="font-body-sm text-body-sm text-on-surface flex gap-space-xs">
              <Icon name="info" className="text-sm text-secondary mt-[2px]" />
              <span>
                <strong>Why this mark:</strong> {item.graderNote}
              </span>
            </p>
          )}

          {item.source && (
            <blockquote className="border-l-4 border-secondary pl-space-md font-body-sm text-body-sm text-on-surface-variant">
              <span className="block font-label-sm text-label-sm uppercase tracking-wider mb-space-2xs">From your notes</span>“{item.source}”
              {subjectId && item.topicId && (
                <Link to={`/subjects/${subjectId}?note=${item.topicId}`} className="block mt-space-2xs text-secondary hover:underline font-label-md text-label-md">
                  Re-read this section
                </Link>
              )}
            </blockquote>
          )}

          <div className="flex flex-col gap-space-sm">
            <Remark
              attemptId={attemptId}
              item={item}
              onDone={(out) => {
                setItems((list) =>
                  list.map((i) =>
                    i.questionId === item.questionId
                      ? {
                          ...i,
                          marksAwarded: Number((out.remark.after * i.marks).toFixed(2)),
                          keyPoints: out.remark.keyPoints || i.keyPoints,
                          graderNote: out.remark.note || i.graderNote,
                          remark: { before: out.remark.before, after: out.remark.after },
                          canRemark: false,
                        }
                      : i
                  )
                );
                onMarksChanged?.(out);
              }}
            />
            <ReportQuestion questionId={item.questionId} attemptId={attemptId} reported={item.reported} />
          </div>
        </article>
      ))}
    </section>
  );
}
