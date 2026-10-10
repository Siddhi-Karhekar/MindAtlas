import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";
import { useAuth } from "../lib/AuthContext.jsx";
import Icon from "../components/Icon.jsx";

const REASON = {
  "wrong-answer": "Marked answer is wrong",
  unclear: "Unclear",
  "not-in-notes": "Not from the notes",
  repeated: "Asked before",
  other: "Other",
};

function Stat({ label, value, sub }) {
  return (
    <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm flex flex-col gap-space-2xs">
      <span className="font-label-md text-label-md uppercase tracking-wider text-on-surface-variant">{label}</span>
      <span className="font-headline-md text-headline-md text-primary">{value}</span>
      {sub && <span className="font-body-sm text-body-sm text-on-surface-variant">{sub}</span>}
    </div>
  );
}

// For the team running MindAtlas: reported questions, suspending an account,
// and whether new students get going. Only accounts named in the server's
// ADMIN_USER_IDS setting can load anything here.
export default function Admin() {
  const { user } = useAuth();
  const [overview, setOverview] = useState(null);
  const [reports, setReports] = useState(null);
  const [error, setError] = useState("");
  const [lookup, setLookup] = useState({ email: "", found: null, reason: "", busy: false, message: "" });

  useEffect(() => {
    if (!user?.isAdmin) return;
    api.adminOverview().then(setOverview).catch((e) => setError(e.message));
    api.adminReports().then(setReports).catch((e) => setError(e.message));
  }, [user?.isAdmin]);

  if (!user?.isAdmin) {
    return (
      <div className="max-w-md mx-auto text-center py-space-3xl">
        <p className="font-body-md text-body-md text-on-surface">This page is for the people running MindAtlas.</p>
        <Link to="/" className="text-secondary hover:underline">Back home</Link>
      </div>
    );
  }

  async function find(e) {
    e.preventDefault();
    setLookup((l) => ({ ...l, busy: true, message: "", found: null }));
    try {
      const d = await api.adminFindUser(lookup.email.trim());
      setLookup((l) => ({ ...l, busy: false, found: d.user }));
    } catch (err) {
      setLookup((l) => ({ ...l, busy: false, message: err.message }));
    }
  }

  async function suspend(suspended) {
    setLookup((l) => ({ ...l, busy: true, message: "" }));
    try {
      const d = await api.adminSuspend(lookup.found.id, suspended, lookup.reason.trim());
      setLookup((l) => ({ ...l, busy: false, found: { ...l.found, suspended: d.user.suspended }, message: d.user.suspended ? "Suspended." : "Restored." }));
    } catch (err) {
      setLookup((l) => ({ ...l, busy: false, message: err.message }));
    }
  }

  const w = overview?.last90Days;
  const pct = (x) => (x?.percent === null || x?.percent === undefined ? "—" : `${x.percent}%`);

  return (
    <div className="max-w-6xl mx-auto w-full flex flex-col gap-space-2xl pb-space-xl" data-testid="admin-page">
      <div>
        <h1 className="font-headline-lg text-headline-lg text-primary">Admin</h1>
        <p className="font-body-md text-body-md text-on-surface-variant">Reported questions are shown with the passage of notes they came from; no student&apos;s identity, notes or answers are.</p>
      </div>
      {error && <p role="alert" className="text-error font-body-sm">{error}</p>}

      <section className="flex flex-col gap-space-md">
        <h2 className="font-label-md text-label-md uppercase tracking-wider text-secondary">New students, last 90 days</h2>
        {w ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-space-md">
            <Stat label="Signed up" value={w.signedUp} sub={`${overview.accounts} ${overview.accounts === 1 ? "account" : "accounts"} in all`} />
            <Stat label="Got started" value={pct(w.startedInWeek1)} sub={`${w.startedInWeek1.count} added a note in week 1`} />
            <Stat label="Took a test" value={pct(w.testedInWeek1)} sub={`${w.testedInWeek1.count} finished one in week 1`} />
            <Stat label="Came back" value={pct(w.returnedInWeek2)} sub={`${w.returnedInWeek2.count} of ${w.returnedInWeek2.of} used it in week 2`} />
          </div>
        ) : (
          <p className="text-on-surface-variant">Loading…</p>
        )}
      </section>

      <section className="flex flex-col gap-space-md">
        <h2 className="font-label-md text-label-md uppercase tracking-wider text-secondary">
          Reported questions {reports ? `(${reports.total} reports)` : ""}
        </h2>
        {!reports ? (
          <p className="text-on-surface-variant">Loading…</p>
        ) : reports.questions.length === 0 ? (
          <p className="text-on-surface-variant">Nothing reported.</p>
        ) : (
          reports.questions.map((r) => (
            <article key={r.questionId} className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm flex flex-col gap-space-sm" data-testid="admin-report">
              <div className="flex items-start justify-between gap-space-md">
                <p className="font-ui-title text-ui-title text-on-surface">{r.question?.prompt || "(question deleted)"}</p>
                <span className="font-label-md text-label-md px-space-xs py-space-2xs rounded bg-tertiary-container text-on-tertiary-container shrink-0">
                  {r.reports.length} {r.reports.length === 1 ? "report" : "reports"}
                </span>
              </div>
              {r.question && (
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  Answer key: <strong className="text-on-surface">{r.question.answerKey}</strong> · {r.question.topic} · made by{" "}
                  {r.question.generatedBy === "llm" ? `${r.question.model} (${r.question.promptVersion})` : "the rules"}
                </p>
              )}
              {r.question?.source && <blockquote className="border-l-4 border-secondary pl-space-md font-body-sm text-body-sm text-on-surface-variant">“{r.question.source}”</blockquote>}
              <ul className="flex flex-col gap-space-2xs font-body-sm text-body-sm text-on-surface">
                {r.reports.map((x, i) => (
                  <li key={i}>
                    <strong>{REASON[x.reason] || x.reason}</strong>
                    {x.comment ? ` — ${x.comment}` : ""}
                  </li>
                ))}
              </ul>
            </article>
          ))
        )}
      </section>

      <section className="flex flex-col gap-space-md max-w-2xl">
        <h2 className="font-label-md text-label-md uppercase tracking-wider text-secondary">Suspend an account</h2>
        <form onSubmit={find} className="flex gap-space-sm">
          <input
            type="email"
            required
            value={lookup.email}
            onChange={(e) => setLookup((l) => ({ ...l, email: e.target.value }))}
            placeholder="student@example.com"
            aria-label="Email address of the account"
            className="flex-1 h-10 px-space-md rounded-lg bg-surface-container-lowest border border-outline-variant text-on-surface"
          />
          <button disabled={lookup.busy} className="h-10 px-space-lg rounded-lg bg-surface-container-high text-on-surface">
            Find
          </button>
        </form>
        {lookup.found && (
          <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm flex flex-col gap-space-sm">
            <p className="font-body-sm text-body-sm text-on-surface">
              Account {lookup.found.id} · joined {new Date(lookup.found.createdAt).toLocaleDateString()} ·{" "}
              {lookup.found.suspended ? <strong className="text-error">suspended</strong> : "active"}
            </p>
            <input
              value={lookup.reason}
              onChange={(e) => setLookup((l) => ({ ...l, reason: e.target.value }))}
              maxLength={500}
              placeholder="Reason (kept in the admin log)"
              aria-label="Reason"
              className="h-10 px-space-md rounded-lg bg-surface-container-low text-on-surface"
            />
            <div className="flex gap-space-sm">
              {lookup.found.suspended ? (
                <button type="button" disabled={lookup.busy || !lookup.reason.trim()} onClick={() => suspend(false)} className="h-9 px-space-lg rounded-lg bg-primary text-on-primary disabled:opacity-50">
                  Restore
                </button>
              ) : (
                <button type="button" disabled={lookup.busy || !lookup.reason.trim()} onClick={() => suspend(true)} className="h-9 px-space-lg rounded-lg bg-error-container text-on-error-container disabled:opacity-50">
                  <Icon name="block" className="text-sm" /> Suspend
                </button>
              )}
            </div>
          </div>
        )}
        {lookup.message && <p className="font-body-sm text-body-sm text-on-surface">{lookup.message}</p>}
      </section>
    </div>
  );
}
