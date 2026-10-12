import { useState } from "react";
import { api } from "../lib/api.js";
import Icon from "./Icon.jsx";

const REPORT_REASONS = [
  { value: "wrong-answer", label: "The marked answer is wrong" },
  { value: "unclear", label: "The question is unclear" },
  { value: "not-in-notes", label: "It is not from my notes" },
  { value: "repeated", label: "I have been asked this before" },
  { value: "other", label: "Something else" },
];

const labelOf = (value) => REPORT_REASONS.find((r) => r.value === value)?.label || value;

// "Report this question": a small link that opens a choice of reasons and an
// optional comment. A reported question is not used in the student's later
// attempts at the test; during a test it still has to be answered, so
// reporting is never a way to skip one.
export default function ReportQuestion({ questionId, attemptId, reported = null, onReported, during = false }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(reported);

  if (done) {
    return (
      <p className="font-label-md text-label-md text-on-surface-variant flex items-center gap-space-xs" data-testid="question-reported">
        <Icon name="flag" className="text-sm text-tertiary" />
        Reported: {labelOf(done).toLowerCase()}. Your next attempts at this test will use other questions where there are any.
      </p>
    );
  }
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="font-label-md text-label-md text-on-surface-variant hover:text-on-surface flex items-center gap-space-xs"
        data-testid="report-question"
      >
        <Icon name="flag" className="text-sm" />
        Report this question
      </button>
    );
  }

  async function send() {
    setBusy(true);
    setError("");
    try {
      await api.reportQuestion(questionId, { reason, comment: comment.trim() || undefined, attemptId });
      setDone(reason);
      onReported?.(reason);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg bg-surface-container-low p-space-md flex flex-col gap-space-sm text-left" data-testid="report-form">
      <p className="font-ui-body text-ui-body text-on-surface font-semibold">What is wrong with this question?</p>
      <div className="flex flex-col gap-space-xs">
        {REPORT_REASONS.map((r) => (
          <label key={r.value} className="flex items-center gap-space-sm font-body-sm text-body-sm text-on-surface cursor-pointer">
            <input type="radio" name={`report-${questionId}`} value={r.value} checked={reason === r.value} onChange={() => setReason(r.value)} />
            {r.label}
          </label>
        ))}
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        maxLength={500}
        rows={2}
        placeholder="Anything to add? (optional)"
        className="w-full rounded-lg bg-surface-container-lowest border border-outline-variant p-space-sm font-body-sm text-body-sm text-on-surface focus:outline-none focus:border-primary"
      />
      {during && (
        <p className="font-label-sm text-label-sm text-on-surface-variant">You still need to answer it in this test; your later attempts use other questions where there are any.</p>
      )}
      {error && (
        <p role="alert" className="font-body-sm text-body-sm text-error">
          {error}
        </p>
      )}
      <div className="flex items-center gap-space-sm">
        <button
          type="button"
          onClick={send}
          disabled={!reason || busy}
          className="h-9 px-space-lg rounded-lg bg-primary text-on-primary font-ui-body text-ui-body disabled:opacity-50"
        >
          {busy ? "Sending…" : "Send report"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="h-9 px-space-md rounded-lg text-on-surface-variant font-ui-body text-ui-body hover:bg-surface-container-high">
          Cancel
        </button>
      </div>
    </div>
  );
}
