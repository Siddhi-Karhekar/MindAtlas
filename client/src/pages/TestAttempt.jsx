import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api.js";

export default function TestAttempt() {
  const { testId } = useParams();
  const navigate = useNavigate();
  const [attempt, setAttempt] = useState(null);
  const [questions, setQuestions] = useState(null);
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const questionStartedAt = useRef(Date.now());

  useEffect(() => {
    api
      .startAttempt(testId)
      .then((d) => {
        setAttempt(d.attempt);
        setQuestions(d.questions);
        questionStartedAt.current = Date.now();
      })
      .catch((err) => setError(err.message));
  }, [testId]);

  const question = questions?.[index];
  const isLast = questions && index === questions.length - 1;

  async function handleNext() {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const timeMs = Date.now() - questionStartedAt.current;
      await api.submitResponse(attempt._id, { questionId: question._id, answer: selected, timeMs });

      if (isLast) {
        await api.submitAttempt(attempt._id);
        navigate(`/attempts/${attempt._id}/feedback`);
      } else {
        setIndex((i) => i + 1);
        setSelected(null);
        questionStartedAt.current = Date.now();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !questions) return <p className="text-sm text-error">{error}</p>;
  if (!questions) return <p className="text-sm text-ink-soft">Loading…</p>;

  return (
    <div className="max-w-xl mx-auto">
      <div className="flex items-center justify-between mb-6 text-sm text-ink-soft">
        <span>Focus mode</span>
        <span>
          Question {index + 1} of {questions.length}
        </span>
      </div>

      <div className="rounded-xl border border-black/10 bg-surface p-6">
        <div className="text-xs uppercase tracking-wide text-tertiary font-semibold mb-2">{question.topic}</div>
        <p className="font-medium mb-5">{question.prompt}</p>

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

        {error && <p className="text-sm text-error mt-4">{error}</p>}

        <button
          onClick={handleNext}
          disabled={!selected || busy}
          className="mt-6 w-full rounded-lg bg-primary text-white py-2.5 text-sm font-semibold hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Saving…" : isLast ? "Submit test" : "Next question"}
        </button>
      </div>
    </div>
  );
}
