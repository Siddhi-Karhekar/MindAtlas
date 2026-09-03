import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api.js";

export default function Insights() {
  const { attemptId } = useParams();
  const [feedback, setFeedback] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .getFeedback(attemptId)
      .then((d) => setFeedback(d.feedback))
      .catch((err) => setError(err.message));
  }, [attemptId]);

  if (error) return <p className="text-sm text-error">{error}</p>;
  if (!feedback) return <p className="text-sm text-ink-soft">Loading…</p>;

  const maxScore = Math.max(...feedback.topicScores.map((t) => t.attentionScore), 0.01);

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-semibold mb-1">Your results</h1>
      <p className="text-ink-soft mb-6">
        Weakest topics first — this is a deterministic score (correctness + response time), not an LLM guess.
      </p>

      <div className="rounded-xl border border-black/10 bg-surface p-5 mb-6">
        <p className="text-sm leading-relaxed">{feedback.feedbackText}</p>
        <p className="text-xs text-ink-soft mt-3">phrased via {feedback.generatedBy === "llm" ? "LLM" : "template"}</p>
      </div>

      <div className="space-y-3">
        {feedback.topicScores.map((t) => (
          <div key={t.topic} className="rounded-xl border border-black/10 bg-surface p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="font-semibold">
                #{t.rank} {t.topic}
              </span>
              <span className="text-xs text-ink-soft">
                {Math.round(t.accuracy * 100)}% correct · {Math.round(t.avgTimeMs / 1000)}s avg
              </span>
            </div>
            <div className="h-2 rounded-full bg-page overflow-hidden">
              <div
                className="h-full bg-tertiary rounded-full"
                style={{ width: `${(t.attentionScore / maxScore) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      <Link to="/" className="inline-block mt-8 text-sm font-semibold text-primary hover:underline">
        ← Back home
      </Link>
    </div>
  );
}
