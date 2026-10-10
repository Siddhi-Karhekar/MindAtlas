import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { getLastSubject, setLastAttempt } from "../lib/recent.js";
import Icon from "../components/Icon.jsx";
import ReportQuestion from "../components/ReportQuestion.jsx";

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
// The test's time limit is kept by the server (it refuses late answers); the
// countdown here shows the server's deadline, and at zero the attempt is
// submitted with whatever has been answered so far.
// The question as a paper would set it.
// A fill-in-the-blank arrives as: Fill in the blank: "... _____ ..." - shown as
// the instruction, then the sentence with each blank drawn as a ruled gap. A
// theory question may carry `guidance` ("Answer in two or three sentences."),
// shown under it the way a paper prints the instruction beside the question.
function QuestionText({ question }) {
  const cloze = String(question.prompt || "").match(/^Fill in the blank:\s*["\u201c]([\s\S]*)["\u201d]\s*$/);
  const heading = "font-headline-lg text-headline-lg text-on-surface";
  if (cloze) {
    const parts = cloze[1].split("_____");
    return (
      <div className="mb-space-2xl" data-testid="question-cloze">
        <p className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider mb-space-sm">Fill in the blank</p>
        <h1 className={heading} style={{ textWrap: "balance" }}>
          {parts.map((part, i) => (
            <span key={i}>
              {part}
              {i < parts.length - 1 && (
                <span className="inline-block align-baseline w-24 mx-space-xs border-b-2 border-primary" aria-label="blank">
                  &nbsp;
                </span>
              )}
            </span>
          ))}
        </h1>
      </div>
    );
  }
  return (
    <div className="mb-space-2xl">
      <h1 className={heading} style={{ textWrap: "balance" }}>
        {question.prompt}
      </h1>
      {question.guidance && (
        <p className="mt-space-md font-body-md text-body-md text-on-surface-variant" data-testid="question-guidance">
          {question.guidance}
        </p>
      )}
    </div>
  );
}

// A theory answer being written is kept in this browser until it is sent, so
// a refresh or a dropped connection does not lose it. Per attempt and
// question; removed once the answer is saved on the server.
const draftKey = (attemptId, questionId) => `mindatlas_draft_${attemptId}_${questionId}`;
function readDraft(attemptId, questionId) {
  try {
    return localStorage.getItem(draftKey(attemptId, questionId)) || "";
  } catch {
    return "";
  }
}
function writeDraft(attemptId, questionId, text) {
  try {
    if (text) localStorage.setItem(draftKey(attemptId, questionId), text);
    else localStorage.removeItem(draftKey(attemptId, questionId));
  } catch {
    /* storage unavailable: the draft just isn't kept */
  }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
// No answer from the server at all (offline, a dropped connection), as
// opposed to the server answering with an error.
const isNetworkError = (err) => err && err.status === undefined;

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
  const [resumed, setResumed] = useState(false);
  const [expired, setExpired] = useState(null);
  const started = useRef(false);
  const finishing = useRef(false);
  const timeoutFired = useRef(false);
  const deadline = useRef(null);
  const latest = useRef({});
  latest.current = { attempt, question, selected };

  const backTo = testInfo?.subjectId || getLastSubject();
  const exitPath = backTo ? `/subjects/${backTo}/tests` : "/";

  // The clock is the server's: the deadline it sent, moved by the difference
  // between its clock and this device's, so a wrong clock here cannot give
  // more (or less) time.
  const setClock = useCallback((d) => {
    if (!d.deadlineAt) return;
    const skew = d.serverNow ? Date.parse(d.serverNow) - Date.now() : 0;
    deadline.current = Date.parse(d.deadlineAt) - skew;
    setSecondsLeft(Math.max(0, Math.round((deadline.current - Date.now()) / 1000)));
  }, []);

  const showQuestion = useCallback((a, q) => {
    setQuestion(q);
    setSelected(q?.type === "theory" ? readDraft(a._id, q._id) : null);
  }, []);

  const finish = useCallback(
    async (opts = {}) => {
      if (finishing.current) return;
      finishing.current = true;
      const { attempt: a, question: q, selected: ans } = latest.current;
      const toResults = () => {
        if (q) writeDraft(a._id, q._id, "");
        setLastAttempt(a._id);
        navigate(`/attempts/${a._id}/feedback`, { replace: true });
      };
      // Record the answer that was in progress when time ran out, if any.
      // The server allows a short grace for exactly this.
      if (opts.timedOut && a && q) {
        const has = q.type === "theory" ? ans?.trim() : ans;
        if (has) await api.submitResponse(a._id, { questionId: q._id, answer: ans }).catch(() => {});
      }
      // A dropped connection is tried again, waiting longer each time (2, 4,
      // 8 s); "already submitted / being marked" (409) means the results page
      // is the place to be.
      for (let tries = 0; ; tries++) {
        try {
          await api.submitAttempt(a._id, { timedOut: Boolean(opts.timedOut) });
          toResults();
          return;
        } catch (err) {
          if (err.status === 409) {
            toResults();
            return;
          }
          if (isNetworkError(err) && tries < 3) {
            await pause(2000 * 2 ** tries);
            continue;
          }
          finishing.current = false;
          setBusy(false);
          setError(isNetworkError(err) ? "No connection - your answers are saved. Press Submit test to try again." : err.message);
          return;
        }
      }
    },
    [navigate]
  );

  // Open the test: a new attempt, or the one already open (after a refresh,
  // another tab, or coming back later) - the server decides.
  const open = useCallback(
    (opts = {}) =>
      api.startAttempt(testId, { startOver: opts.startOver }).then((d) => {
        if (d.expired) {
          setTestInfo(d.test || null);
          setExpired(d.expired);
          return;
        }
        setExpired(null);
        setAttempt(d.attempt);
        setTestInfo(d.test || null);
        setProgress(d.progress);
        if (!opts.quiet) setResumed(Boolean(d.resumed));
        setClock(d);
        latest.current = { ...latest.current, attempt: d.attempt };
        if (d.readyToSubmit) {
          // every question was answered before the page closed
          finish();
          return;
        }
        showQuestion(d.attempt, d.question);
      }),
    [testId, setClock, showQuestion, finish]
  );

  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice in dev; only open once
    started.current = true;
    open().catch((err) => {
      // the last attempt is still being marked: its results page waits for it
      if (err.code === "closing" && err.data?.attemptId) navigate(`/attempts/${err.data.attemptId}/feedback`, { replace: true });
      else setError(err.message);
    });
  }, [open, navigate]);

  // Countdown, from the fixed deadline so a throttled background tab doesn't
  // drift. At zero the attempt is submitted with what has been answered.
  useEffect(() => {
    if (!deadline.current || !attempt) return undefined;
    const tick = () => {
      const left = Math.max(0, Math.round((deadline.current - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left === 0 && !timeoutFired.current) {
        // once: finish() retries by itself, and shows a button if it gives up
        timeoutFired.current = true;
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

  function choose(value) {
    setSelected(value);
    if (isTheory && attempt && question) writeDraft(attempt._id, question._id, value);
  }

  // `blank`: leave an MCQ unanswered on purpose (only offered with negative
  // marking, where a blank costs nothing and a wrong answer costs marks)
  async function handleNext({ blank = false } = {}) {
    if ((!canAdvance && !blank) || finishing.current) return;
    setBusy(true);
    setError("");
    const send = () => api.submitResponse(attempt._id, { questionId: question._id, answer: blank ? "" : selected });
    try {
      let out;
      // a dropped connection is tried again twice before giving up; the
      // answer stays on screen either way
      for (let tries = 0; ; tries++) {
        try {
          out = await send();
          break;
        } catch (err) {
          if (!isNetworkError(err) || tries >= 2) throw err;
          await pause(1000 * (tries + 1));
        }
      }
      writeDraft(attempt._id, question._id, "");
      const { nextQuestion, progress: nextProgress } = out;
      if (out.deadlineAt) setClock(out);
      if (!nextQuestion) {
        await finish();
      } else {
        showQuestion(attempt, nextQuestion);
        setProgress(nextProgress);
        setBusy(false);
      }
    } catch (caught) {
      let err = caught;
      if (err.code === "time_up") {
        setTimeUp(true);
        await finish();
        return;
      }
      if (err.code === "already_answered" || err.code === "not_current") {
        // the answer reached the server on an earlier try: carry on from
        // where the server says the attempt is
        try {
          writeDraft(attempt._id, question._id, "");
          await open({ quiet: true });
          setBusy(false);
          return;
        } catch (again) {
          err = again;
        }
      }
      setError(
        isNetworkError(err) ? "No connection - your answer is still here. Check your connection and press the button again." : err.message
      );
      setBusy(false);
    }
  }

  const shell = (children) => <div className="min-h-screen bg-surface flex flex-col">{children}</div>;

  if (expired) {
    return shell(
      <div className="flex-1 grid place-items-center px-gutter-canvas">
        <div className="max-w-md text-center flex flex-col items-center gap-space-md" data-testid="attempt-expired">
          <Icon name="timer_off" className="text-tertiary text-[40px]" />
          <p className="font-ui-title text-ui-title text-on-surface">
            {expired.reason === "time" ? "Time ran out on your last attempt at this test." : "Your last attempt at this test has been marked."}
          </p>
          <p className="font-body-md text-body-md text-on-surface-variant">It was submitted with the answers you had given.</p>
          <div className="flex flex-wrap justify-center gap-space-sm">
            <button
              onClick={() => navigate(`/attempts/${expired.attemptId}/feedback`)}
              className="h-10 px-space-lg rounded-lg bg-primary text-on-primary font-ui-body text-ui-body hover:opacity-90"
            >
              See the results
            </button>
            <button
              onClick={() => open({ startOver: true }).catch((err) => setError(err.message))}
              className="h-10 px-space-lg rounded-lg bg-surface-container-high text-on-surface font-ui-body text-ui-body hover:bg-surface-container-highest"
            >
              Start the test again
            </button>
          </div>
        </div>
      </div>
    );
  }
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
                  title="Your answers are saved. Open the test again to carry on - the clock keeps running."
                  className="h-9 px-space-md rounded-lg bg-error-container text-on-error-container font-ui-body text-ui-body hover:opacity-90 transition-opacity"
                >
                  Leave for now
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
              {testInfo?.sectioned ? (isTheory ? "Section B · " : "Section A · ") : ""}
              Question {progress.shown} of {progress.target}
              {question.topic ? <span className="text-on-surface-variant"> · {question.topic}</span> : null}
              {isTheory && (
                <span className="ml-space-sm px-space-xs py-space-2xs rounded bg-secondary-container text-on-secondary-container normal-case tracking-normal">
                  Theory
                </span>
              )}
              {question.marks ? (
                <span className="ml-space-sm normal-case tracking-normal text-on-surface-variant" data-testid="question-marks">
                  [{question.marks} {Number(question.marks) === 1 ? "mark" : "marks"}]
                </span>
              ) : null}
            </p>
            <QuestionText question={question} />
          </div>

          {resumed && (
            <p role="status" className="mb-space-lg text-center font-ui-body text-ui-body text-secondary" data-testid="attempt-resumed">
              Picked up where you left off - your earlier answers are saved and the clock kept running.
            </p>
          )}

          {timeUp && (
            <p role="status" className="mb-space-lg text-center font-ui-body text-ui-body text-error">
              Time&apos;s up — submitting your answers…
            </p>
          )}

          {isTheory ? (
            <>
              <textarea
                value={selected || ""}
                onChange={(e) => choose(e.target.value)}
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
                    onClick={() => choose(opt)}
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

          <div className="mt-space-lg flex justify-center">
            <ReportQuestion key={question._id} questionId={question._id} attemptId={attempt?._id} during />
          </div>

          <div className="flex items-center justify-between mt-space-2xl">
            <span className="font-label-sm text-label-sm text-on-surface-variant">
              Answers are final — the next question adapts to this one.
              {!isTheory && testInfo?.negativeMarks > 0 && (
                <span className="block text-tertiary" data-testid="negative-note">
                  A wrong answer loses {testInfo.negativeMarks} {testInfo.negativeMarks === 1 ? "mark" : "marks"}; leaving it blank loses nothing.
                </span>
              )}
            </span>
            {!isTheory && testInfo?.negativeMarks > 0 && !timeUp && (
              <button
                type="button"
                onClick={() => handleNext({ blank: true })}
                disabled={busy}
                data-testid="leave-blank"
                className="h-11 px-space-lg rounded-lg text-on-surface-variant font-ui-body text-ui-body hover:bg-surface-container-high disabled:opacity-50"
              >
                Leave blank
              </button>
            )}
            <button
              type="button"
              onClick={timeUp ? () => finish() : handleNext}
              disabled={busy || (timeUp ? !error : !canAdvance)}
              className="h-11 px-space-2xl rounded-lg bg-primary text-on-primary font-ui-title text-ui-title shadow-md hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {busy ? "Saving…" : isLast || timeUp ? "Submit test" : "Next question"}
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
