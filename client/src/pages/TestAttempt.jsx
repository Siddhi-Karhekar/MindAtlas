import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api.js";

// Delivery is adaptive: the server sends one question at a time (not a
// fixed array to page through) and picks the next one based on how the
// previous one went - see the staircase controller in
// server/src/services/adaptiveEngine.js. This component just renders
// whatever question the server hands it and reports progress from
// {shown, target}, since the total isn't a fixed list length anymore.
export default function TestAttempt() {
  const { testId } = useParams();
  const navigate = useNavigate();
  const [attempt, setAttempt] = useState(null);
  const [question, setQuestion] = useState(null);
  const [progress, setProgress] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const questionStartedAt = useRef(Date.now());

  useEffect(() => {
    api
      .startAttempt(testId)
      .then((d) => {
        setAttempt(d.attempt);
        setQuestion(d.question);
        setProgress(d.progress);
        setSelected(d.question?.type === "theory" ? "" : null);
        questionStartedAt.current = Date.now();
      })
      .catch((err) => setError(err.message));
  }, [testId]);

  const isTheory = question?.type === "theory";
  const canAdvance = isTheory ? selected?.trim() : selected;
  const isLast = progress && progress.shown >= progress.target;

  async function handleNext() {
    if (!canAdvance) return;
    setBusy(true);
    setError("");
    try {
      const timeMs = Date.now() - questionStartedAt.current;
      const { nextQuestion, progress: nextProgress } = await api.submitResponse(attempt._id, {
        questionId: question._id,
        answer: selected,
        timeMs,
      });

      if (!nextQuestion) {
        await api.submitAttempt(attempt._id);
        navigate(`/attempts/${attempt._id}/feedback`);
      } else {
        setQuestion(nextQuestion);
        setProgress(nextProgress);
        setSelected(nextQuestion.type === "theory" ? "" : null);
        questionStartedAt.current = Date.now();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !question) return <p className="text-sm text-error">{error}</p>;
  if (!question) return <p className="text-sm text-ink-soft">Loading…</p>;

  return (
    <div className="max-w-xl mx-auto">
      <div className="flex items-center justify-between mb-6 text-sm text-ink-soft">
        <span>Focus mode · adaptive</span>
        <span>
          Question {progress.shown} of {progress.target}
        </span>
      </div>

      <div className="rounded-xl border border-black/10 bg-surface p-6">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs uppercase tracking-wide text-tertiary font-semibold">{question.topic}</span>
          {isTheory && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-secondary-container text-secondary uppercase tracking-wide">
              Theory
            </span>
          )}
        </div>
        <p className="font-medium mb-5">{question.prompt}</p>

        {isTheory ? (
          <textarea
            value={selected || ""}
            onChange={(e) => setSelected(e.target.value)}
            rows={6}
            placeholder="Write your answer here…"
            className="w-full rounded-lg border border-black/15 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        ) : (
          <div className="space-y-2">
            {question.options.map((opt) => (
              <button
                key={opt}
                onClick={() => setSelected(opt)}
                className={`w-full text-left rounded-lg border px-4 py-2.5 text-sm transition ${
                  selected === opt
                    ? "border-primary bg-primary-container text-primary font-semibold"
                    : "border-black/15 hover:bg-page"
                }`}
              >
                {opt}
              </button>
            ))}
          </div>
        )}

        {error && <p className="text-sm text-error mt-4">{error}</p>}

        <button
          onClick={handleNext}
          disabled={!canAdvance || busy}
          className="mt-6 w-full rounded-lg bg-primary text-white py-2.5 text-sm font-semibold hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Saving…" : isLast ? "Submit test" : "Next question"}
        </button>
      </div>
    </div>
  );
}
