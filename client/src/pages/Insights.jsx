import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { setLastAttempt } from "../lib/recent.js";
import Icon from "../components/Icon.jsx";
import Ring from "../components/Ring.jsx";
import TopicName from "../components/TopicName.jsx";
import { topicParts } from "../lib/notes.js";

const shortName = (t) => topicParts(t).name;

// Subtopic scores grouped under their document, weakest document first. The
// server stores this as feedback.documentScores; older reports without it are
// grouped here from topicScores so they render the same way.
function groupByDocument(topics) {
  const docs = new Map();
  for (const t of topics) {
    if (!t.parentTopicId) continue;
    const key = String(t.parentTopicId);
    if (!docs.has(key)) docs.set(key, { parentTopicId: key, parentTopic: t.parentTopic, subtopics: [] });
    docs.get(key).subtopics.push(t);
  }
  return [...docs.values()]
    .map((d) => {
      const n = d.subtopics.reduce((a, t) => a + t.questionsAnswered, 0);
      const accuracy = n ? d.subtopics.reduce((a, t) => a + t.accuracy * t.questionsAnswered, 0) / n : 0;
      return { ...d, accuracy, questionsAnswered: n, subtopics: [...d.subtopics].sort((a, b) => a.accuracy - b.accuracy) };
    })
    .sort((a, b) => a.accuracy - b.accuracy);
}

// The feedback text (template or LLM) may contain **bold** spans. Render
// those as <strong> instead of showing literal asterisks. Deliberately
// minimal - only **bold** is supported, and everything else stays plain
// text (React escapes it), so LLM output can never inject markup.
function renderInline(text) {
  return String(text || "")
    .split(/(\*\*[^*]+\*\*)/g)
    .map((part, i) =>
      part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : (
        part
      )
    );
}

function duration(startedAt, submittedAt) {
  const ms = new Date(submittedAt) - new Date(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} sec`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${String(s % 60).padStart(2, "0")} sec` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export default function Insights() {
  const { attemptId } = useParams();
  const [data, setData] = useState(null);
  const [subjectName, setSubjectName] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setLastAttempt(attemptId);
    api
      .getFeedback(attemptId)
      .then((d) => {
        setData(d);
        if (d.test?.subjectId) {
          api
            .listSubjects()
            .then((s) => setSubjectName(s.subjects.find((x) => String(x._id) === String(d.test.subjectId))?.name || ""))
            .catch(() => {});
        }
      })
      .catch((err) => setError(err.message));
  }, [attemptId]);

  const stats = useMemo(() => {
    if (!data) return null;
    const topics = data.feedback.topicScores || [];
    const answered = topics.reduce((n, t) => n + t.questionsAnswered, 0);
    const weightedAcc = answered ? topics.reduce((n, t) => n + t.accuracy * t.questionsAnswered, 0) / answered : 0;
    const marks = data.feedback;
    const mastery =
      typeof marks.marksPossible === "number" && marks.marksPossible > 0
        ? marks.marksAwarded / marks.marksPossible
        : weightedAcc;
    const totalMs = topics.reduce((n, t) => n + t.avgTimeMs * t.questionsAnswered, 0);
    const byAccuracy = [...topics].sort((a, b) => b.accuracy - a.accuracy || a.attentionScore - b.attentionScore);
    const bySpeed = [...topics].sort((a, b) => a.avgTimeMs - b.avgTimeMs);
    return {
      topics,
      answered,
      mastery: Math.round(mastery * 100),
      avgSeconds: answered ? Math.round(totalMs / answered / 1000) : 0,
      strongest: byAccuracy[0] || null,
      attention: topics[0] || null, // already ranked weakest-first by the server
      fastest: bySpeed[0] || null,
      slowest: bySpeed[bySpeed.length - 1] || null,
    };
  }, [data]);

  if (error) {
    return (
      <div className="max-w-md mx-auto text-center flex flex-col items-center gap-space-md py-space-3xl">
        <Icon name="lightbulb" className="text-tertiary text-[40px]" />
        <p className="font-body-md text-body-md text-on-surface">{error}</p>
        <Link to="/" className="text-secondary hover:underline font-ui-body text-ui-body">Back home</Link>
      </div>
    );
  }
  if (!data || !stats) return <p className="font-body-md text-on-surface-variant">Loading…</p>;

  const { feedback, attempt, test } = data;
  const maxAttention = Math.max(...stats.topics.map((t) => t.attentionScore), 0.01);
  const band = stats.mastery >= 80 ? "Strong recall" : stats.mastery >= 50 ? "Getting there" : "Needs more work";
  const took = attempt ? duration(attempt.startedAt, attempt.submittedAt) : null;
  const subjectId = test?.subjectId;
  const documents = groupByDocument(stats.topics);

  return (
    <div className="max-w-6xl mx-auto w-full flex flex-col gap-space-2xl pb-space-xl">
      <section className="relative bg-surface-container-lowest rounded-xl p-space-xl shadow-sm flex flex-col md:flex-row md:items-end justify-between gap-space-xl">
        <div className="flex flex-col gap-space-sm max-w-2xl">
          <div className="flex items-center gap-space-xs text-secondary font-label-md text-label-md">
            <Icon name="verified" className="text-base" />
            <span className="uppercase tracking-wider">Evaluation Digest</span>
          </div>
          <h1 className="font-headline-lg text-headline-lg text-primary tracking-tight">
            Your results{test?.title ? `: ${test.title}` : ""}
          </h1>
          <p className="font-body-md text-body-md text-on-surface-variant flex items-center gap-space-sm flex-wrap">
            {took && (
              <>
                <span>Completed in {took}</span>
                <span className="w-1 h-1 rounded-full bg-outline-variant"></span>
              </>
            )}
            <span>{stats.answered} {stats.answered === 1 ? "question" : "questions"} answered</span>
            {feedback.marksPossible > 0 && (
              <>
                <span className="w-1 h-1 rounded-full bg-outline-variant"></span>
                <span className="text-secondary font-semibold" data-testid="marks">
                  {feedback.marksAwarded} / {feedback.marksPossible} marks
                </span>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-space-lg bg-surface-container-low px-space-lg py-space-md rounded-lg self-start md:self-auto shadow-sm">
          <Ring className="w-16 h-16" value={stats.mastery} stroke={3.2} track="text-surface-container-highest">
            <span className="font-headline-sm text-headline-sm text-primary font-semibold">{stats.mastery}%</span>
          </Ring>
          <div className="flex flex-col">
            <span className="font-label-md text-label-md uppercase tracking-wider text-secondary">Score</span>
            <span className="font-headline-sm text-headline-sm text-primary leading-tight">{band}</span>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-12 gap-space-xl items-stretch">
        <div className="lg:col-span-8 bg-surface-container-low p-space-xl rounded-xl shadow-sm flex flex-col justify-between">
          <div className="flex flex-col gap-space-md">
            <div className="flex items-center justify-between pb-space-xs">
              <span className="font-label-md text-label-md uppercase tracking-widest text-on-surface-variant font-semibold">Synthesis Review</span>
              <span className="font-label-sm text-label-sm text-secondary bg-secondary-container/50 px-space-sm py-space-2xs rounded">
                Phrased via {feedback.generatedBy === "llm" ? "LLM" : "template"}
              </span>
            </div>
            <p className="font-body-lg text-body-lg text-on-surface leading-relaxed">{renderInline(feedback.feedbackText)}</p>
          </div>
          <div className="pt-space-lg flex items-center gap-space-md text-on-surface-variant font-label-md text-label-md flex-wrap">
            <span className="flex items-center gap-space-xs text-secondary font-semibold">
              <Icon name="rule" className="text-sm" />
              Deterministic ranking
            </span>
            <span>•</span>
            <span>Weakest topics first — correctness plus response time, not an LLM guess</span>
          </div>
        </div>

        <div className="lg:col-span-4 relative rounded-xl overflow-hidden shadow-sm flex flex-col justify-end min-h-[220px] bg-inverse-surface">
          <div className="absolute -right-10 -top-10 w-56 h-56 rounded-full bg-secondary/40 blur-3xl"></div>
          <div className="absolute -left-8 bottom-10 w-40 h-40 rounded-full bg-tertiary/30 blur-2xl"></div>
          <div className="relative p-space-lg text-inverse-on-surface flex flex-col gap-space-xs">
            <span className="font-label-sm text-label-sm tracking-widest uppercase text-tertiary font-semibold">Focus next</span>
            <h3 className="font-headline-sm text-headline-sm leading-snug">{stats.attention ? shortName(stats.attention) : "Nothing to review"}</h3>
            {stats.attention && topicParts(stats.attention).parent && (
              <span className="font-label-md text-label-md opacity-80">in {topicParts(stats.attention).parent}</span>
            )}
            {stats.attention && (
              <p className="font-body-sm text-body-sm opacity-80">
                {Math.round(stats.attention.accuracy * 100)}% correct across {stats.attention.questionsAnswered}{" "}
                {stats.attention.questionsAnswered === 1 ? "question" : "questions"} — the best place to spend your next study session.
              </p>
            )}
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-space-lg">
        <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm flex flex-col justify-between gap-space-base hover:-translate-y-0.5 transition-transform">
          <div className="flex flex-col gap-space-sm">
            <div className="flex items-center justify-between">
              <span className="font-label-md text-label-md uppercase tracking-wider text-secondary flex items-center gap-space-xs">
                <Icon name="verified" className="text-base" />
                Strongest topic
              </span>
              {stats.strongest && (
                <span className="font-label-md text-label-md font-semibold bg-secondary-container text-on-secondary-container px-space-xs py-space-2xs rounded">
                  {Math.round(stats.strongest.accuracy * 100)}%
                </span>
              )}
            </div>
            {stats.strongest ? (
              <TopicName topic={stats.strongest} as="h4" className="font-headline-sm text-headline-sm text-primary" />
            ) : (
              <h4 className="font-headline-sm text-headline-sm text-primary">—</h4>
            )}
            <p className="font-body-sm text-body-sm text-on-surface-variant">Highest share of correct answers in this attempt.</p>
          </div>
        </div>

        <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm flex flex-col justify-between gap-space-base hover:-translate-y-0.5 transition-transform">
          <div className="flex flex-col gap-space-sm">
            <div className="flex items-center justify-between">
              <span className="font-label-md text-label-md uppercase tracking-wider text-tertiary flex items-center gap-space-xs">
                <Icon name="flag" className="text-base" />
                Attention needed
              </span>
              {stats.attention && (
                <span className="font-label-md text-label-md font-semibold bg-tertiary-fixed text-on-tertiary-fixed px-space-xs py-space-2xs rounded">
                  Rank #1
                </span>
              )}
            </div>
            {stats.attention ? (
              <TopicName topic={stats.attention} as="h4" className="font-headline-sm text-headline-sm text-primary" />
            ) : (
              <h4 className="font-headline-sm text-headline-sm text-primary">—</h4>
            )}
            <p className="font-body-sm text-body-sm text-on-surface-variant">Highest attention score once accuracy and response time are combined.</p>
          </div>
        </div>

        <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm flex flex-col justify-between gap-space-base hover:-translate-y-0.5 transition-transform">
          <div className="flex flex-col gap-space-sm">
            <div className="flex items-center justify-between">
              <span className="font-label-md text-label-md uppercase tracking-wider text-primary font-semibold flex items-center gap-space-xs">
                <Icon name="speed" className="text-base" />
                Response pace
              </span>
              <span className="font-label-md text-label-md font-semibold bg-primary-container text-on-primary-container px-space-xs py-space-2xs rounded">
                {stats.avgSeconds}s avg
              </span>
            </div>
            <h4 className="font-headline-sm text-headline-sm text-primary">
              {stats.topics.length > 1 && stats.slowest ? `Slowest on ${shortName(stats.slowest)}` : "Steady pace"}
            </h4>
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              {stats.topics.length > 1 && stats.fastest && stats.slowest
                ? `${Math.round(stats.slowest.avgTimeMs / 1000)}s per question there, versus ${Math.round(stats.fastest.avgTimeMs / 1000)}s on ${shortName(stats.fastest)}.`
                : "Only one topic came up, so there is nothing to compare against."}
            </p>
          </div>
        </div>
      </section>

      {documents.length > 0 && (
        <section className="bg-surface-container-lowest rounded-xl p-space-xl shadow-sm flex flex-col gap-space-lg" data-testid="document-breakdown">
          <div className="flex flex-col">
            <span className="font-label-md text-label-md uppercase tracking-wider text-secondary">Subtopic breakdown</span>
            <h3 className="font-headline-sm text-headline-sm text-primary">Inside each document</h3>
          </div>
          {documents.map((d) => (
            <div key={d.parentTopicId} className="flex flex-col gap-space-sm">
              <div className="flex items-center justify-between gap-space-md">
                <Link
                  to={subjectId ? `/subjects/${subjectId}?note=${d.parentTopicId}` : "#"}
                  className="font-ui-title text-ui-title text-on-surface font-semibold hover:text-secondary flex items-center gap-space-xs min-w-0"
                >
                  <Icon name="description" className="text-base text-secondary shrink-0" />
                  <span className="truncate">{d.parentTopic}</span>
                </Link>
                <span className="font-label-md text-label-md text-on-surface-variant shrink-0">
                  {Math.round(d.accuracy * 100)}% overall · {d.subtopics.length} {d.subtopics.length === 1 ? "subtopic" : "subtopics"} tested
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-space-xs">
                {d.subtopics.map((t) => {
                  const pctv = Math.round(t.accuracy * 100);
                  return (
                    <Link
                      key={t.topicId}
                      to={subjectId ? `/subjects/${subjectId}?note=${t.topicId}` : "#"}
                      data-testid="subtopic-score"
                      className="flex items-center justify-between gap-space-sm px-space-md py-space-sm rounded-lg bg-surface-container-low hover:bg-surface-container transition-colors"
                    >
                      <span className="font-ui-body text-ui-body text-on-surface truncate">{shortName(t)}</span>
                      <span
                        className={`font-label-md text-label-md font-semibold px-space-xs py-space-2xs rounded shrink-0 ${
                          pctv < 50 ? "bg-tertiary-container text-on-tertiary-container" : "bg-secondary-container text-on-secondary-container"
                        }`}
                      >
                        {pctv}%
                      </span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
          <p className="font-label-sm text-label-sm text-on-surface-variant">
            Subtopics come from the document&apos;s own headings. Click one to re-read exactly that section.
          </p>
        </section>
      )}

      <section className="grid grid-cols-1 lg:grid-cols-12 gap-space-xl items-start">
        <div className="lg:col-span-7 bg-surface-container-low rounded-xl p-space-xl shadow-sm flex flex-col gap-space-md">
          <div className="flex flex-col">
            <span className="font-label-md text-label-md uppercase tracking-wider text-secondary">Topic ranking</span>
            <h3 className="font-headline-sm text-headline-sm text-primary">Where to spend your time</h3>
          </div>
          <div className="flex flex-col gap-space-sm">
            {stats.topics.map((t) => (
              <div key={t.topicId || t.topic} className="bg-surface-container-lowest rounded-lg p-space-md shadow-sm" data-testid="topic-rank">
                <div className="flex items-center justify-between gap-space-md mb-space-xs">
                  <span className="font-ui-title text-ui-title text-on-surface font-semibold flex items-baseline gap-space-xs min-w-0">
                    <span className="shrink-0">#{t.rank}</span>
                    <TopicName topic={t} />
                  </span>
                  <span className="font-label-md text-label-md text-on-surface-variant shrink-0">
                    {Math.round(t.accuracy * 100)}% correct · {Math.round(t.avgTimeMs / 1000)}s avg
                  </span>
                </div>
                <div className="h-2 rounded-full bg-surface-container-high overflow-hidden">
                  <div
                    className="h-full bg-tertiary rounded-full"
                    style={{ width: `${(t.attentionScore / maxAttention) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
          <p className="font-label-sm text-label-sm text-on-surface-variant">
            Bar length shows how much attention a topic needs relative to the others.
          </p>
        </div>

        <div className="lg:col-span-5 flex flex-col gap-space-md">
          <div className="flex flex-col">
            <span className="font-label-md text-label-md uppercase tracking-wider text-secondary">Next steps</span>
            <h3 className="font-headline-sm text-headline-sm text-primary">Keep the momentum</h3>
          </div>
          {[
            subjectId && {
              // topicId is the note id, so this opens exactly that subtopic
              to: stats.attention?.topicId ? `/subjects/${subjectId}?note=${stats.attention.topicId}` : `/subjects/${subjectId}`,
              icon: "auto_stories",
              title: stats.attention ? `Re-read your notes on ${shortName(stats.attention)}` : "Re-read your notes",
              body: topicParts(stats.attention).parent
                ? `Opens that section of ${topicParts(stats.attention).parent}.`
                : "Start with the topic that needs the most attention.",
            },
            subjectId && {
              to: `/subjects/${subjectId}/tests`,
              icon: "fact_check",
              title: "Build another test",
              body: "A fresh set of adaptive questions from the same notes.",
            },
            subjectId && {
              to: `/subjects/${subjectId}/graph`,
              icon: "hub",
              title: "See how your notes connect",
              body: "Open the knowledge graph for this subject.",
            },
          ]
            .filter(Boolean)
            .map((a) => (
              <Link
                key={a.to}
                to={a.to}
                className="group bg-surface-container-lowest p-space-lg rounded-xl shadow-sm hover:shadow-md transition-all flex items-center gap-space-md"
              >
                <span className="w-9 h-9 rounded-lg bg-surface-container-low flex items-center justify-center text-secondary shrink-0 group-hover:bg-secondary-container transition-colors">
                  <Icon name={a.icon} className="text-lg" />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="font-ui-title text-ui-title text-on-surface">{a.title}</div>
                  <div className="font-body-sm text-body-sm text-on-surface-variant">{a.body}</div>
                </div>
                <Icon name="arrow_forward" className="text-base text-outline-variant group-hover:text-primary transition-colors" />
              </Link>
            ))}
        </div>
      </section>

      {feedback.masteryDeltas?.length > 0 && (
        <section className="bg-surface-container-lowest rounded-xl p-space-xl shadow-sm flex flex-col gap-space-md">
          <div className="flex flex-col">
            <span className="font-label-md text-label-md uppercase tracking-wider text-secondary">Mastery movement</span>
            <h3 className="font-headline-sm text-headline-sm text-primary">What this attempt changed</h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-space-sm">
            {feedback.masteryDeltas.map((d) => {
              const before = Math.round(d.before * 100);
              const after = Math.round(d.after * 100);
              const diff = after - before;
              return (
                <div key={d.topicId} className="bg-surface-container-low rounded-lg p-space-md flex items-center justify-between gap-space-md">
                  <TopicName topic={d.topicLabel} className="font-ui-title text-ui-title text-on-surface" />
                  <span className="font-label-md text-label-md text-on-surface-variant shrink-0 flex items-center gap-space-xs">
                    {before}% <Icon name="arrow_forward" className="text-sm" /> <strong className="text-on-surface">{after}%</strong>
                    <span className={`px-space-xs py-space-2xs rounded font-semibold ${diff >= 0 ? "bg-secondary-container text-on-secondary-container" : "bg-tertiary-container text-on-tertiary-container"}`}>
                      {diff >= 0 ? "+" : ""}{diff}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="bg-surface-container-low p-space-lg rounded-xl shadow-sm flex flex-col sm:flex-row items-center justify-between gap-space-md">
        <div className="flex items-center gap-space-sm text-on-surface-variant font-ui-body text-ui-body">
          <Icon name="inventory_2" className="text-secondary" />
          <span>
            Attempt saved{subjectName ? <> to <strong>{subjectName}</strong></> : ""}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-space-sm">
          <Link to="/" className="h-9 px-space-lg rounded-lg text-on-surface-variant hover:bg-surface-container-high transition-colors font-ui-body text-ui-body flex items-center">
            Back home
          </Link>
          {subjectId && (
            <Link
              to={`/subjects/${subjectId}/tests`}
              className="h-9 px-space-lg rounded-lg bg-primary text-on-primary hover:opacity-90 transition-all font-ui-body text-ui-body shadow-sm flex items-center gap-space-xs"
            >
              <Icon name="fact_check" className="text-sm" />
              <span>Back to tests</span>
            </Link>
          )}
        </div>
      </section>
    </div>
  );
}
