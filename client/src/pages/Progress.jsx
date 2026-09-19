import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { timeAgo } from "../lib/format.js";
import Icon from "../components/Icon.jsx";
import Ring from "../components/Ring.jsx";

// The progress view is what makes cross-attempt adaptivity visible. Without it
// the mastery model is invisible machinery: the student sees questions get
// easier or harder and has no way to know why. Each topic shows where they
// stand, which difficulty tier that currently earns them, and how the number
// has moved across attempts.

const TIER_STYLE = {
  easy: { label: "Easy questions next", cls: "bg-tertiary-container text-on-tertiary-container" },
  medium: { label: "Medium questions next", cls: "bg-secondary-container text-on-secondary-container" },
  hard: { label: "Hard questions next", cls: "bg-primary-container text-on-primary-container" },
};

// A small inline sparkline of a topic's mastery across attempts. Drawn as an
// SVG polyline rather than pulling in a chart library for one shape.
function Trend({ points }) {
  if (!points || points.length < 2) return null;
  const w = 108;
  const h = 26;
  const step = w / (points.length - 1);
  const path = points.map((p, i) => `${(i * step).toFixed(1)},${(h - p.value * h).toFixed(1)}`).join(" ");
  const rising = points[points.length - 1].value >= points[0].value;
  return (
    <svg width={w} height={h} className="shrink-0" aria-hidden="true" style={{ overflow: "visible" }}>
      <polyline
        points={path}
        fill="none"
        style={{ stroke: rising ? "var(--c-secondary)" : "var(--c-tertiary)" }}
        strokeWidth="1.75"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function Progress() {
  const { subjectId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setData(null);
    api
      .getProgress(subjectId)
      .then(setData)
      .catch((err) => setError(err.message));
  }, [subjectId]);

  if (error) return <p className="font-body-md text-error">{error}</p>;
  if (!data) return <p className="font-body-md text-on-surface-variant">Loading…</p>;

  const { topics, history } = data;
  const overall = topics.length
    ? Math.round((topics.reduce((n, t) => n + t.pKnown, 0) / topics.length) * 100)
    : null;

  return (
    <div className="max-w-6xl mx-auto w-full flex flex-col gap-space-2xl pb-space-xl">
      <section className="relative bg-surface-container-lowest rounded-xl p-space-xl shadow-sm flex flex-col md:flex-row md:items-end justify-between gap-space-xl">
        <div className="flex flex-col gap-space-sm max-w-2xl">
          <div className="flex items-center gap-space-xs text-secondary font-label-md text-label-md">
            <Icon name="lightbulb" className="text-base" />
            <Link to={`/subjects/${subjectId}`} className="uppercase tracking-wider hover:underline">
              {data.subject?.name || "Subject"}
            </Link>
            <span className="text-outline-variant">/</span>
            <span className="uppercase tracking-wider">Insights</span>
          </div>
          <h1 className="font-headline-lg text-headline-lg text-primary tracking-tight">Your progress</h1>
          <p className="font-body-md text-body-md text-on-surface-variant">
            What you know per topic, built up across every attempt. Your next test draws more questions from the weaker
            topics, and starts at a difficulty that matches.
          </p>
        </div>
        {overall !== null && (
          <div className="flex items-center gap-space-lg bg-surface-container-low px-space-lg py-space-md rounded-lg self-start md:self-auto shadow-sm">
            <Ring className="w-16 h-16" value={overall} stroke={3.2} track="text-surface-container-highest">
              <span className="font-headline-sm text-headline-sm text-primary font-semibold">{overall}%</span>
            </Ring>
            <div className="flex flex-col">
              <span className="font-label-md text-label-md uppercase tracking-wider text-secondary">Average mastery</span>
              <span className="font-headline-sm text-headline-sm text-primary leading-tight">
                {topics.length} {topics.length === 1 ? "topic" : "topics"} tracked
              </span>
            </div>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-space-md">
        <div className="flex items-baseline justify-between px-space-xs">
          <span className="font-label-sm text-label-sm uppercase tracking-widest text-on-surface-variant font-bold">
            Mastery by topic
          </span>
          <span className="font-label-md text-label-md text-on-surface-variant">Weakest first</span>
        </div>
        {topics.length === 0 ? (
          <div className="bg-surface-container-low rounded-xl p-space-xl shadow-sm flex items-start gap-space-md">
            <Icon name="insights" className="text-secondary text-[28px]" />
            <div className="flex flex-col gap-space-xs">
              <p className="font-ui-title text-ui-title text-on-surface">No attempts yet</p>
              <p className="font-body-md text-body-md text-on-surface-variant">
                Take a test and your per-topic mastery will start building here — from the second attempt onward, the
                difficulty adapts to it.
              </p>
              <Link to={`/subjects/${subjectId}/tests`} className="text-secondary hover:text-primary font-ui-body text-ui-body font-medium flex items-center gap-space-2xs">
                <span>Go to tests</span>
                <Icon name="arrow_forward" className="text-sm" />
              </Link>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-space-md">
            {topics.map((t) => {
              const tier = TIER_STYLE[t.tier] || TIER_STYLE.medium;
              const pct = Math.round(t.pKnown * 100);
              return (
                <div key={t.topicId} className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm flex flex-col gap-space-md">
                  <div className="flex items-start justify-between gap-space-md">
                    <div className="min-w-0">
                      <h3 className="font-ui-title text-ui-title text-on-surface font-semibold truncate">{t.topic}</h3>
                      <p className="font-label-md text-label-md text-on-surface-variant">
                        {t.observations} {t.observations === 1 ? "question" : "questions"} answered
                        {t.observations < 3 ? " · still gathering evidence" : ""}
                      </p>
                    </div>
                    <Ring className="w-12 h-12 shrink-0" value={pct} tone={pct < 50 ? "text-tertiary" : "text-secondary"}>
                      <span className="font-label-sm text-label-sm text-on-surface">{pct}</span>
                    </Ring>
                  </div>
                  <div className="flex items-center justify-between gap-space-md">
                    <span className={`px-space-sm py-space-2xs rounded font-label-sm text-label-sm uppercase tracking-wide ${tier.cls}`}>
                      {tier.label}
                    </span>
                    <Trend points={t.trend} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-space-md">
        <div className="flex items-baseline justify-between px-space-xs">
          <span className="font-label-sm text-label-sm uppercase tracking-widest text-on-surface-variant font-bold">
            Attempt history
          </span>
          <span className="font-label-md text-label-md text-on-surface-variant">{history.length} completed</span>
        </div>
        {history.length === 0 ? (
          <p className="font-body-md text-body-md text-on-surface-variant px-space-xs">No completed attempts yet.</p>
        ) : (
          <ul className="flex flex-col gap-space-sm">
            {history.map((a) => (
              <li key={a.attemptId}>
                <Link
                  to={`/attempts/${a.attemptId}/feedback`}
                  className="group flex items-center justify-between gap-space-md rounded-xl bg-surface-container-lowest shadow-sm hover:shadow-md transition-shadow p-space-lg"
                >
                  <div className="flex items-center gap-space-md min-w-0">
                    <span className="w-8 h-8 rounded-lg bg-surface-container-low flex items-center justify-center text-primary shrink-0">
                      <Icon name="fact_check" className="text-lg" />
                    </span>
                    <div className="min-w-0">
                      <div className="font-ui-title text-ui-title text-on-surface truncate">{a.testTitle}</div>
                      <div className="font-label-md text-label-md text-on-surface-variant">
                        {timeAgo(a.submittedAt)} · {a.questionsAnswered} {a.questionsAnswered === 1 ? "question" : "questions"}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-space-md shrink-0">
                    {a.marksPossible ? (
                      <span className="font-ui-title text-ui-title text-primary font-semibold">
                        {a.marksAwarded} / {a.marksPossible}
                      </span>
                    ) : null}
                    <span className="text-secondary font-label-md text-label-md font-semibold flex items-center gap-space-2xs group-hover:text-primary transition-colors">
                      Results
                      <Icon name="arrow_forward" className="text-sm" />
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
