import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { getLastSubject, setLastAttempt } from "../lib/recent.js";
import Icon from "../components/Icon.jsx";

function clock(totalSeconds) {
  const s = Math.max(0, totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Focus mode. Delivery is adaptive: the server sends one question at a time
// (not a fixed array to page through) and picks the next one based on how the
// previous one went - see the staircase controller in
// server/src/services/adaptiveEngine.js. This component renders whatever
// question the server hands it and reports progress from {shown, target}.
// The test's time limit is enforced here: when the countdown reaches zero the
// attempt is submitted with whatever has been answered so far.
export default function TestAttempt() {
  const { testId } = useParams();
  const navigate = useNavigate();
  const [attempt, setAttempt] = useState(null);
  const [testInfo, setTestInfo] = useState(null);
  const [question, setQuestion] = useState(null);
  const [progress, setProgress] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(null);
  const [timeUp, setTimeUp] = useState(false);
  const [confirmExit, setConfirmExit] = useState(false);
  const questionStartedAt = useRef(Date.now());
  const started = useRef(false);
  const finishing = useRef(false);
  const deadline = useRef(null);
  const latest = useRef({});
  latest.current = { attempt, question, selected };

  const backTo = testInfo?.subjectId || getLastSubject();
  const exitPath = backTo ? `/subjects/${backTo}/tests` : "/";

  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice in dev; only start one attempt
    started.current = true;
    api
      .startAttempt(testId)
      .then((d) => {
        setAttempt(d.attempt);
        setTestInfo(d.test || null);
        setQuestion(d.question);
        setProgress(d.progress);
        setSelected(d.question?.type === "theory" ? "" : null);
        questionStartedAt.current = Date.now();
        if (d.test?.durationMinutes) {
          deadline.current = Date.now() + d.test.durationMinutes * 60 * 1000;
          setSecondsLeft(d.test.durationMinutes * 60);
        }
      })
      .catch((err) => setError(err.message));
  }, [testId]);

  const finish = useCallback(
    async (opts = {}) => {
      if (finishing.current) return;
      finishing.current = true;
      const { attempt: a, question: q, selected: ans } = latest.current;
      try {
        // Record the answer that was in progress when time ran out, if any.
        if (opts.timedOut && a && q) {
          const has = q.type === "theory" ? ans?.trim() : ans;
          if (has) {
            await api
              .submitResponse(a._id, { questionId: q._id, answer: ans, timeMs: Date.now() - questionStartedAt.current })
              .catch(() => {});
          }
        }
        await api.submitAttempt(a._id);
        setLastAttempt(a._id);
        navigate(`/attempts/${a._id}/feedback`, { replace: true });
      } catch (err) {
        finishing.current = false;
        setBusy(false);
        setError(err.message);
      }
    },
    [navigate]
  );

  // Countdown. Computed from a fixed deadline so a throttled background tab
  // doesn't drift.
  useEffect(() => {
    if (!deadline.current || !attempt) return undefined;
    const tick = () => {
      const left = Math.max(0, Math.round((deadline.current - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left === 0) {
        setTimeUp(true);
        finish({ timedOut: true });
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [attempt, finish]);

  const isTheory = question?.type === "theory";
  const canAdvance = isTheory ? selected?.trim() : selected;
  const isLast = progress && progress.shown >= progress.target;

  async function handleNext() {
    if (!canAdvance || finishing.current) return;
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
        finishing.current = true;
        await api.submitAttempt(attempt._id);
        setLastAttempt(attempt._id);
        navigate(`/attempts/${attempt._id}/feedback`, { replace: true });
      } else {
        setQuestion(nextQuestion);
        setProgress(nextProgress);
        setSelected(nextQuestion.type === "theory" ? "" : null);
        questionStartedAt.current = Date.now();
        setBusy(false);
      }
    } catch (err) {
      finishing.current = false;
      setError(err.message);
      setBusy(false);
    }
  }

  const shell = (children) => <div className="min-h-screen bg-surface flex flex-col">{children}</div>;

  if (error && !question) {
    return shell(
      <div className="flex-1 grid place-items-center px-gutter-canvas">
        <div className="max-w-md text-center flex flex-col items-center gap-space-md">
          <Icon name="error" className="text-error text-[40px]" />
          <p className="font-body-md text-body-md text-on-surface">{error}</p>
          <button
            onClick={() => navigate(exitPath)}
            className="h-10 px-space-lg rounded-lg bg-surface-container-high text-on-surface font-ui-body text-ui-body hover:bg-surface-container-highest"
          >
            Back
          </button>
        </div>
      </div>
    );
  }
  if (!question) {
    return shell(<div className="flex-1 grid place-items-center font-body-md text-on-surface-variant">Loading…</div>);
  }

  const answered = Math.max(0, progress.shown - 1);
  const urgent = secondsLeft !== null && secondsLeft <= 60;

  return shell(
    <>
      <header className="w-full bg-surface-container-lowest/80 backdrop-blur-md px-gutter-canvas py-space-md shadow-sm sticky top-0 z-20">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-space-md">
          <div className="flex items-center gap-space-sm min-w-0">
            <span className="flex items-center gap-space-xs font-label-sm text-label-sm text-on-surface-variant uppercase tracking-wider shrink-0">
              <span className="w-2 h-2 rounded-full bg-secondary inline-block"></span>Focus active
            </span>
            <span className="text-outline-variant">|</span>
            <span className="font-ui-title text-ui-title text-on-surface truncate">{testInfo?.title || "Test"}</span>
          </div>
          <div className="flex items-center gap-space-lg shrink-0">
            {secondsLeft !== null && (
              <div className="text-right">
                <p className="font-label-sm text-label-sm text-on-surface-variant uppercase tracking-wider">Time remaining</p>
                <p
                  data-testid="focus-timer"
                  className={`font-ui-title text-headline-sm tabular-nums ${urgent ? "text-error" : "text-on-surface"}`}
                >
                  {clock(secondsLeft)}
                </p>
              </div>
            )}
            {confirmExit ? (
              <div className="flex items-center gap-space-xs">
                <button
                  type="button"
                  onClick={() => navigate(exitPath)}
                  className="h-9 px-space-md rounded-lg bg-error-container text-on-error-container font-ui-body text-ui-body hover:opacity-90 transition-opacity"
                >
                  Leave without submitting
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmExit(false)}
                  className="h-9 px-space-md rounded-lg text-on-surface-variant font-ui-body text-ui-body hover:bg-surface-container-high transition-colors"
                >
                  Stay
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmExit(true)}
                className="h-9 px-space-lg rounded-lg bg-surface-container-lowest border border-outline-variant text-on-surface font-ui-body text-ui-body hover:bg-surface-container-high transition-colors"
              >
                Exit focus
              </button>
            )}
          </div>
        </div>
        <div className="max-w-5xl mx-auto mt-space-sm h-1 rounded-full bg-surface-container-high overflow-hidden">
          <div
            className="h-full bg-secondary rounded-full transition-all duration-500"
            style={{ width: `${(answered / Math.max(1, progress.target)) * 100}%` }}
          ></div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-gutter-canvas py-space-3xl">
          <div className="text-center">
            <p className="font-label-md text-label-md text-secondary uppercase tracking-wider mb-space-md">
              Question {progress.shown} of {progress.target}
              {question.topic ? <span className="text-on-surface-variant"> · {question.topic}</span> : null}
              {isTheory && (
                <span className="ml-space-sm px-space-xs py-space-2xs rounded bg-secondary-container text-on-secondary-container normal-case tracking-normal">
                  Theory
                </span>
              )}
            </p>
            <h1 className="font-headline-lg text-headline-lg text-on-surface mb-space-2xl" style={{ textWrap: "balance" }}>
              {question.prompt}
            </h1>
          </div>

          {timeUp && (
            <p role="status" className="mb-space-lg text-center font-ui-body text-ui-body text-error">
              Time&apos;s up — submitting your answers…
            </p>
          )}

          {isTheory ? (
            <>
              <textarea
                value={selected || ""}
                onChange={(e) => setSelected(e.target.value)}
                rows={6}
                disabled={timeUp}
                placeholder="Write your answer here… use the key terms from your notes."
                className="w-full rounded-xl bg-surface-container-lowest border border-outline-variant p-space-lg font-body-md text-body-md text-on-surface text-left focus:outline-none focus:border-primary shadow-sm"
              />
            </>
          ) : (
            <div className="flex flex-col gap-space-sm">
              {question.options.map((opt, i) => {
                const on = selected === opt;
                return (
                  <button
                    key={opt}
                    type="button"
                    disabled={timeUp}
                    onClick={() => setSelected(opt)}
                    className={`w-full text-left rounded-xl px-space-lg py-space-md font-body-md text-body-md transition-all flex items-center gap-space-md shadow-sm ${
                      on
                        ? "bg-primary-container text-on-primary-container ring-2 ring-primary font-semibold"
                        : "bg-surface-container-lowest text-on-surface hover:bg-surface-container-high"
                    }`}
                  >
                    <span
                      className={`w-7 h-7 shrink-0 rounded-full flex items-center justify-center font-label-md text-label-md ${
                        on ? "bg-primary text-on-primary" : "bg-surface-container-high text-on-surface-variant"
                      }`}
                    >
                      {String.fromCharCode(65 + i)}
                    </span>
                    <span>{opt}</span>
                  </button>
                );
              })}
            </div>
          )}

          {error && (
            <p role="alert" className="mt-space-md font-body-sm text-body-sm text-error text-center">
              {error}
            </p>
          )}

          <div className="flex items-center justify-between mt-space-2xl">
            <span className="font-label-sm text-label-sm text-on-surface-variant">
              Answers are final — the next question adapts to this one.
            </span>
            <button
              type="button"
              onClick={handleNext}
              disabled={!canAdvance || busy || timeUp}
              className="h-11 px-space-2xl rounded-lg bg-primary text-on-primary font-ui-title text-ui-title shadow-md hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {busy ? "Saving…" : isLast ? "Submit test" : "Next question"}
            </button>
          </div>
        </div>
      </div>

      <footer className="border-t border-outline-variant py-space-md">
        <div className="max-w-3xl mx-auto px-gutter-canvas flex items-center justify-center gap-space-2xl font-label-sm text-label-sm text-on-surface-variant uppercase tracking-wider flex-wrap">
          <span>
            <span className="text-secondary font-bold">{answered}</span> answered
          </span>
          <span>
            <span className="text-tertiary font-bold">{Math.max(0, progress.target - answered)}</span> to go
          </span>
          <span>Adaptive difficulty</span>
        </div>
      </footer>
    </>
  );
}
