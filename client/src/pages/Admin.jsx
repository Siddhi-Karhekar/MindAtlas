import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { useAuth } from "../lib/AuthContext.jsx";
import { formatDate, timeAgo } from "../lib/format.js";
import Icon from "../components/Icon.jsx";

// For the team running MindAtlas: is the server healthy, how is the app used,
// what did students report (and what was done about it), which accounts
// exist, and what admins changed. Only accounts named in the server's
// ADMIN_USER_IDS setting can load anything here. No student's email, notes or
// answers are listed; a reported question is shown with the passage it came
// from, never who reported it.

const REASON = {
  "wrong-answer": "Marked answer is wrong",
  unclear: "Unclear",
  "not-in-notes": "Not from the notes",
  invalid: "Marked invalid",
  repeated: "Asked before",
  other: "Other",
};

const ACTION = {
  suspend: "Suspended an account",
  restore: "Restored an account",
  "retire-question": "Retired a question for everyone",
  "unretire-question": "Brought a question back",
  "report-resolved": "Marked a report resolved",
  "report-dismissed": "Dismissed a report",
  "report-open": "Reopened a report",
};

const TABS = [
  { id: "overview", label: "Overview", icon: "monitoring" },
  { id: "reports", label: "Reports", icon: "flag" },
  { id: "accounts", label: "Accounts", icon: "group" },
  { id: "log", label: "Activity log", icon: "history" },
];

const MB = 1024 * 1024;
function mb(bytes) {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes >= 1024 * MB) return `${(bytes / 1024 / MB).toFixed(1)} GB`;
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${Math.round(bytes / MB)} MB`;
}
const DB_KIND = {
  mongodb: "MongoDB Atlas. When it is full, nothing new can be saved.",
  "local-file": "Local file database (development).",
  memory: "In-memory database - wiped on every restart.",
};
const shortId = (id) => `…${String(id).slice(-6)}`;

function uptime(seconds) {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} days`;
}

// good / warning / critical, always shown with an icon and a word, never colour alone
function level(fraction) {
  if (fraction === null) return null;
  if (fraction >= 0.85) return { name: "Critical", icon: "error", bar: "bg-error", text: "text-error" };
  if (fraction >= 0.7) return { name: "Getting full", icon: "warning", bar: "bg-tertiary", text: "text-tertiary" };
  return { name: "Healthy", icon: "check_circle", bar: "bg-secondary", text: "text-secondary" };
}

const card = "bg-surface-container-lowest rounded-xl p-space-lg shadow-sm";
const sectionTitle = "font-label-md text-label-md uppercase tracking-wider text-secondary";
const button = "h-9 px-space-md rounded-lg font-ui-body text-ui-body inline-flex items-center gap-space-2xs disabled:opacity-50";

function Meter({ title, used, limit, peak, note }) {
  const fraction = used !== null && limit ? Math.min(1, used / limit) : null;
  const peakFraction = peak && limit ? Math.min(1, peak / limit) : null;
  const lv = level(peakFraction ?? fraction);
  return (
    <div className={`${card} flex flex-col gap-space-sm`} data-testid="admin-meter">
      <div className="flex items-center justify-between gap-space-sm">
        <span className="font-label-md text-label-md uppercase tracking-wider text-on-surface-variant">{title}</span>
        {lv && (
          <span className={`inline-flex items-center gap-space-2xs font-label-md text-label-md ${lv.text}`}>
            <Icon name={lv.icon} className="text-sm" />
            {lv.name}
          </span>
        )}
      </div>
      <div className="flex items-baseline gap-space-xs">
        <span className="font-headline-md text-headline-md text-on-surface">{mb(used)}</span>
        <span className="font-body-sm text-body-sm text-on-surface-variant">{limit ? `of ${mb(limit)}` : "no limit known"}</span>
      </div>
      {limit ? (
        <div className="relative h-2 rounded-full bg-surface-container-high overflow-hidden" role="img" aria-label={`${mb(used)} of ${mb(limit)}`}>
          <div className={`h-full rounded-full ${lv.bar}`} style={{ width: `${Math.max(2, fraction * 100)}%` }} />
          {peakFraction !== null && peakFraction > fraction && (
            <div className="absolute top-0 h-full w-0.5 bg-on-surface" style={{ left: `${peakFraction * 100}%` }} title={`Peak ${mb(peak)}`} />
          )}
        </div>
      ) : null}
      {note && <p className="font-body-sm text-body-sm text-on-surface-variant">{note}</p>}
    </div>
  );
}

function Tile({ label, value, sub }) {
  return (
    <div className={`${card} flex flex-col gap-space-2xs`}>
      <span className="font-label-md text-label-md uppercase tracking-wider text-on-surface-variant">{label}</span>
      <span className="font-headline-md text-headline-md text-on-surface">{value}</span>
      {sub && <span className="font-body-sm text-body-sm text-on-surface-variant">{sub}</span>}
    </div>
  );
}

function ServiceRow({ name, on, detail }) {
  return (
    <li className="flex items-start justify-between gap-space-sm py-space-sm">
      <span className="flex flex-col min-w-0">
        <span className="font-ui-body text-ui-body text-on-surface">{name}</span>
        {detail && <span className="font-body-sm text-body-sm text-on-surface-variant break-words">{detail}</span>}
      </span>
      <span
        className={`shrink-0 inline-flex items-center gap-space-2xs px-space-xs py-space-2xs rounded font-label-md text-label-md ${
          on ? "bg-secondary-container text-on-secondary-container" : "bg-surface-container-high text-on-surface-variant"
        }`}
      >
        <Icon name={on ? "check_circle" : "do_not_disturb_on"} className="text-sm" />
        {on ? "On" : "Off"}
      </span>
    </li>
  );
}

// Sign-ups per week: one series, so no legend - the heading names it. Each
// bar has its own tooltip; a hidden table gives the same numbers to screen readers.
function SignupChart({ weeks }) {
  const [hover, setHover] = useState(null);
  const max = Math.max(1, ...weeks.map((w) => w.signups));
  const W = 600;
  const H = 110;
  const gap = 6;
  const barW = (W - gap * (weeks.length - 1)) / weeks.length;
  const label = (w) => new Date(w.weekStart).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (
    <div className={`${card} flex flex-col gap-space-sm`}>
      <span className="font-label-md text-label-md uppercase tracking-wider text-on-surface-variant">Sign-ups per week, last 12 weeks</span>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H + 22}`} className="w-full h-auto" role="img" aria-label="Sign-ups per week for the last 12 weeks">
          <line x1="0" x2={W} y1={H} y2={H} className="stroke-outline-variant" strokeWidth="1" />
          {weeks.map((w, i) => {
            const h = w.signups ? Math.max(4, (w.signups / max) * (H - 18)) : 0;
            const x = i * (barW + gap);
            return (
              <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <rect x={x} y="0" width={barW} height={H} fill="transparent" />
                {h > 0 && <path d={`M${x},${H} V${H - h + 4} q0,-4 4,-4 h${barW - 8} q4,0 4,4 V${H} Z`} className={hover === i ? "fill-primary" : "fill-secondary"} />}
                {w.signups === max && w.signups > 0 && (
                  <text x={x + barW / 2} y={H - h - 5} textAnchor="middle" className="fill-on-surface" fontSize="12">
                    {w.signups}
                  </text>
                )}
                {(i % 3 === 2 || i === weeks.length - 1) && (
                  <text x={x + barW / 2} y={H + 16} textAnchor="middle" className="fill-on-surface-variant" fontSize="11">
                    {label(w)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {hover !== null && (
          <div
            className="absolute top-0 -translate-x-1/2 px-space-sm py-space-2xs rounded-lg bg-surface-container-highest text-on-surface font-body-sm text-body-sm shadow-md pointer-events-none whitespace-nowrap"
            style={{ left: `${((hover * (barW + gap) + barW / 2) / W) * 100}%` }}
          >
            Week of {label(weeks[hover])}: <strong>{weeks[hover].signups}</strong>
          </div>
        )}
      </div>
      <table className="sr-only">
        <tbody>
          {weeks.map((w, i) => (
            <tr key={i}>
              <th>{label(w)}</th>
              <td>{w.signups}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Overview({ health, usage, overview }) {
  if (!health || !usage || !overview) return <p className="text-on-surface-variant">Loading…</p>;
  const { server, database, ai, email, semantic } = health;
  const w = overview.last90Days;
  const pct = (x) => (x?.percent === null || x?.percent === undefined ? "—" : `${x.percent}%`);
  return (
    <div className="flex flex-col gap-space-2xl">
      <section className="flex flex-col gap-space-md">
        <h2 className={sectionTitle}>System health</h2>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-space-md">
          <Meter
            title="Server memory"
            used={server.rssBytes}
            limit={server.memoryLimitBytes}
            peak={server.peakRssBytes}
            note={`Peak since start ${mb(server.peakRssBytes)} (the line on the bar). Over the limit, the host restarts the server mid-request.`}
          />
          <Meter
            title="Database storage"
            used={database.usedBytes}
            limit={database.quotaBytes}
            note={DB_KIND[database.kind] || database.kind}
          />
          <div className={`${card} flex flex-col gap-space-xs`}>
            <span className="font-label-md text-label-md uppercase tracking-wider text-on-surface-variant">Services</span>
            <ul className="divide-y divide-outline-variant">
              <ServiceRow name="AI questions & marking" on={ai.enabled} detail={ai.enabled ? `${ai.provider} · ${ai.model}` : "rule-based fallback"} />
              <ServiceRow name="Reading handwriting" on={ai.vision} detail={ai.vision ? null : "OCR, flagged for review"} />
              <ServiceRow name="Email" on={email.enabled} detail={email.enabled ? null : "no confirmation or password reset"} />
              <ServiceRow name="Links by meaning" on={semantic.active} detail={semantic.active ? semantic.model : "off to save memory - run a relink"} />
            </ul>
          </div>
        </div>
        <p className="font-body-sm text-body-sm text-on-surface-variant" data-testid="admin-server-info">
          Up {uptime(server.uptimeSeconds)} · started {timeAgo(server.startedAt)} · Node {server.node}
          {server.commit ? ` · version ${server.commit}` : ""}
        </p>
      </section>

      <section className="flex flex-col gap-space-md">
        <h2 className={sectionTitle}>Usage</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-space-md">
          <Tile label="Accounts" value={usage.accounts} sub={usage.suspended ? `${usage.suspended} suspended` : "none suspended"} />
          <Tile label="Active, 7 days" value={usage.active7} sub={`${usage.active30} in 30 days`} />
          <Tile label="Notes" value={usage.totals.notes} sub={`in ${usage.totals.subjects} ${usage.totals.subjects === 1 ? "subject" : "subjects"}`} />
          <Tile label="Tests" value={usage.totals.tests} sub={`${usage.totals.finishedAttempts} of ${usage.totals.attempts} attempts finished`} />
          <Tile label="Questions" value={usage.totals.questions} sub="accepted into tests" />
          <Tile label="Answer photos" value={usage.totals.answerImages} sub={`${overview.answersFlaggedForReview} answers flagged for review`} />
          <Tile label="Reports" value={usage.totals.reports} sub="from students" />
          <Tile label="New, 90 days" value={w.signedUp} sub={`${pct(w.startedInWeek1)} added a note in week 1`} />
        </div>
        <SignupChart weeks={usage.signupsByWeek} />
      </section>

      <section className="flex flex-col gap-space-md">
        <h2 className={sectionTitle}>Do new students get going? (joined in the last 90 days)</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-space-md">
          <Tile label="Added a note in week 1" value={pct(w.startedInWeek1)} sub={`${w.startedInWeek1.count} of ${w.signedUp}`} />
          <Tile label="Finished a test in week 1" value={pct(w.testedInWeek1)} sub={`${w.testedInWeek1.count} of ${w.signedUp}`} />
          <Tile label="Came back in week 2" value={pct(w.returnedInWeek2)} sub={`${w.returnedInWeek2.count} of ${w.returnedInWeek2.of} who joined 14+ days ago`} />
        </div>
      </section>

      {database.collections.length > 0 && (
        <section className="flex flex-col gap-space-md">
          <h2 className={sectionTitle}>What takes up the database</h2>
          <div className={`${card} overflow-x-auto`}>
            <table className="w-full font-body-sm text-body-sm">
              <thead>
                <tr className="text-left text-on-surface-variant">
                  <th className="py-space-xs font-medium">Collection</th>
                  <th className="py-space-xs font-medium text-right">Records</th>
                  <th className="py-space-xs font-medium text-right">Size</th>
                </tr>
              </thead>
              <tbody>
                {database.collections.slice(0, 8).map((c) => (
                  <tr key={c.name} className="border-t border-outline-variant text-on-surface">
                    <td className="py-space-xs font-mono">{c.name}</td>
                    <td className="py-space-xs text-right">{c.count.toLocaleString()}</td>
                    <td className="py-space-xs text-right">{c.bytes < MB ? `${Math.max(1, Math.round(c.bytes / 1024))} KB` : mb(c.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

const STATUS_STYLE = {
  open: "bg-tertiary-container text-on-tertiary-container",
  resolved: "bg-secondary-container text-on-secondary-container",
  dismissed: "bg-surface-container-high text-on-surface-variant",
};

function ReportCard({ r, onChanged }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmRetire, setConfirmRetire] = useState(false);
  const [error, setError] = useState("");
  const q = r.question;
  const reasons = Object.entries(r.reports.reduce((acc, x) => ({ ...acc, [x.reason]: (acc[x.reason] || 0) + 1 }), {}));
  const comments = r.reports.filter((x) => x.comment);

  async function run(fn) {
    setBusy(true);
    setError("");
    try {
      await fn();
      setNote("");
      setConfirmRetire(false);
      await onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  const review = (status) => run(() => api.adminReviewQuestion(r.questionId, status, note.trim()));
  const retire = (retired) => run(() => api.adminRetireQuestion(r.questionId, retired, note.trim()));

  return (
    <article className={`${card} flex flex-col gap-space-md`} data-testid="admin-report">
      <div className="flex flex-wrap items-start justify-between gap-space-sm">
        <p className="font-ui-title text-ui-title text-on-surface flex-1 min-w-[16rem]">{q?.prompt || "(question deleted)"}</p>
        <div className="flex flex-wrap gap-space-xs shrink-0">
          {r.retired && (
            <span className="inline-flex items-center gap-space-2xs font-label-md text-label-md px-space-xs py-space-2xs rounded bg-error-container text-on-error-container">
              <Icon name="block" className="text-sm" /> Retired
            </span>
          )}
          <span className={`font-label-md text-label-md px-space-xs py-space-2xs rounded capitalize ${STATUS_STYLE[r.status]}`} data-testid="report-status">
            {r.status}
          </span>
          <span className="font-label-md text-label-md px-space-xs py-space-2xs rounded bg-surface-container-high text-on-surface">
            {r.reports.length} {r.reports.length === 1 ? "report" : "reports"}
          </span>
        </div>
      </div>

      {q?.options?.length > 0 && (
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-space-xs">
          {q.options.map((o, i) => {
            const correct = String(o) === String(q.answerKey);
            return (
              <li key={i} className={`px-space-sm py-space-xs rounded-lg font-body-sm text-body-sm flex items-center gap-space-xs ${correct ? "bg-secondary-container text-on-secondary-container" : "bg-surface-container-low text-on-surface"}`}>
                {correct && <Icon name="check" className="text-sm" />}
                {o}
              </li>
            );
          })}
        </ul>
      )}
      {q && (
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          {!q.options?.length && (
            <>
              Answer key: <strong className="text-on-surface">{q.answerKey}</strong> ·{" "}
            </>
          )}
          {q.topic} · made by {q.generatedBy === "llm" ? `${q.model} (${q.promptVersion})` : "the rules"}
        </p>
      )}
      {q?.source && <blockquote className="border-l-4 border-secondary pl-space-md font-body-sm text-body-sm text-on-surface-variant">“{q.source}”</blockquote>}

      <div className="flex flex-col gap-space-xs">
        <div className="flex flex-wrap gap-space-xs">
          {reasons.map(([reason, n]) => (
            <span key={reason} className="font-label-md text-label-md px-space-sm py-space-2xs rounded-full bg-surface-container-high text-on-surface">
              {REASON[reason] || reason}
              {n > 1 ? ` × ${n}` : ""}
            </span>
          ))}
        </div>
        {comments.map((x, i) => (
          <p key={i} className="font-body-sm text-body-sm text-on-surface">
            “{x.comment}” <span className="text-on-surface-variant">— {timeAgo(x.at)}</span>
          </p>
        ))}
        {r.reviewNote && (
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            Team note: {r.reviewNote}
            {r.reviewedAt ? ` (${timeAgo(r.reviewedAt)})` : ""}
          </p>
        )}
      </div>

      {q && (
        <div className="flex flex-col gap-space-sm border-t border-outline-variant pt-space-md">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder="Note for the team (optional) - kept in the activity log"
            aria-label="Note for the team"
            className="h-9 px-space-md rounded-lg bg-surface-container-low text-on-surface font-body-sm text-body-sm"
          />
          <div className="flex flex-wrap gap-space-xs">
            {r.status !== "resolved" && (
              <button type="button" disabled={busy} onClick={() => review("resolved")} className={`${button} bg-primary text-on-primary`}>
                <Icon name="task_alt" className="text-sm" /> Resolved
              </button>
            )}
            {r.status !== "dismissed" && (
              <button type="button" disabled={busy} onClick={() => review("dismissed")} className={`${button} bg-surface-container-high text-on-surface`}>
                <Icon name="close" className="text-sm" /> Dismiss
              </button>
            )}
            {r.status !== "open" && (
              <button type="button" disabled={busy} onClick={() => review("open")} className={`${button} bg-surface-container-high text-on-surface`}>
                <Icon name="undo" className="text-sm" /> Reopen
              </button>
            )}
            <span className="flex-1" />
            {r.retired ? (
              <button type="button" disabled={busy} onClick={() => retire(false)} className={`${button} bg-surface-container-high text-on-surface`}>
                <Icon name="restore" className="text-sm" /> Bring back
              </button>
            ) : confirmRetire ? (
              <>
                <span className="self-center font-body-sm text-body-sm text-on-surface">No student will get this question again.</span>
                <button type="button" disabled={busy} onClick={() => retire(true)} className={`${button} bg-error text-on-error`}>
                  Retire it
                </button>
                <button type="button" disabled={busy} onClick={() => setConfirmRetire(false)} className={`${button} bg-surface-container-high text-on-surface`}>
                  Cancel
                </button>
              </>
            ) : (
              <button type="button" disabled={busy} onClick={() => setConfirmRetire(true)} className={`${button} bg-error-container text-on-error-container`}>
                <Icon name="block" className="text-sm" /> Retire for everyone
              </button>
            )}
          </div>
          {error && <p role="alert" className="font-body-sm text-body-sm text-error">{error}</p>}
        </div>
      )}
    </article>
  );
}

function Reports({ reports, reload }) {
  const [filter, setFilter] = useState("open");
  if (!reports) return <p className="text-on-surface-variant">Loading…</p>;
  const counts = reports.questions.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {});
  const shown = reports.questions.filter((r) => filter === "all" || r.status === filter);
  const chip = (id, label, n) => (
    <button
      key={id}
      type="button"
      onClick={() => setFilter(id)}
      className={`h-8 px-space-md rounded-full font-label-md text-label-md ${filter === id ? "bg-primary text-on-primary" : "bg-surface-container-high text-on-surface"}`}
    >
      {label} {n !== undefined ? `(${n})` : ""}
    </button>
  );
  return (
    <div className="flex flex-col gap-space-md">
      <p className="font-body-sm text-body-sm text-on-surface-variant max-w-3xl">
        A student&apos;s report already hides the question from that student. <strong className="text-on-surface">Retire for everyone</strong> takes it out of every
        future attempt; <strong className="text-on-surface">Resolved</strong> and <strong className="text-on-surface">Dismiss</strong> record what the team decided.
      </p>
      <div className="flex flex-wrap gap-space-xs" role="tablist" aria-label="Filter reports">
        {chip("open", "Open", counts.open || 0)}
        {chip("resolved", "Resolved", counts.resolved || 0)}
        {chip("dismissed", "Dismissed", counts.dismissed || 0)}
        {chip("all", "All", reports.questions.length)}
      </div>
      {shown.length === 0 ? (
        <div className={`${card} text-center text-on-surface-variant`}>
          {reports.questions.length === 0 ? "No student has reported a question." : `No ${filter} reports.`}
        </div>
      ) : (
        shown.map((r) => <ReportCard key={r.questionId} r={r} onChanged={reload} />)
      )}
    </div>
  );
}

function AccountRow({ u, highlight, onChanged }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function toggle() {
    setBusy(true);
    setError("");
    try {
      await api.adminSuspend(u.id, !u.suspended, reason.trim());
      setOpen(false);
      setReason("");
      await onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <tr className={`border-t border-outline-variant text-on-surface ${highlight ? "bg-secondary-container/40" : ""}`} data-testid="admin-account">
        <td className="py-space-sm pr-space-md whitespace-nowrap">
          <span className="font-mono">{shortId(u.id)}</span>
          {u.you && <span className="ml-space-xs font-label-sm text-label-sm px-space-xs rounded bg-primary-container text-on-primary-container">you</span>}
          {u.admin && !u.you && <span className="ml-space-xs font-label-sm text-label-sm px-space-xs rounded bg-primary-container text-on-primary-container">admin</span>}
          {u.suspended && <span className="ml-space-xs font-label-sm text-label-sm px-space-xs rounded bg-error-container text-on-error-container">suspended</span>}
        </td>
        <td className="py-space-sm pr-space-md whitespace-nowrap">{formatDate(u.createdAt)}</td>
        <td className="py-space-sm pr-space-md whitespace-nowrap">{u.lastActiveAt ? timeAgo(u.lastActiveAt) : "never"}</td>
        <td className="py-space-sm pr-space-md text-right">{u.notes}</td>
        <td className="py-space-sm pr-space-md text-right">{u.tests}</td>
        <td className="py-space-sm pr-space-md text-right">{u.attempts}</td>
        <td className="py-space-sm text-right">
          {!u.you && (
            <button type="button" onClick={() => setOpen((v) => !v)} className="text-secondary hover:underline font-ui-body text-ui-body">
              {u.suspended ? "Restore" : "Suspend"}
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7} className="pb-space-md">
            <div className="flex flex-wrap gap-space-sm items-center bg-surface-container-low rounded-lg p-space-sm">
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                autoFocus
                placeholder="Reason (required, kept in the activity log)"
                aria-label="Reason"
                className="flex-1 min-w-[14rem] h-9 px-space-md rounded-lg bg-surface-container-lowest text-on-surface"
              />
              <button
                type="button"
                disabled={busy || !reason.trim()}
                onClick={toggle}
                className={`${button} ${u.suspended ? "bg-primary text-on-primary" : "bg-error text-on-error"}`}
              >
                {u.suspended ? "Restore account" : "Suspend account"}
              </button>
              <button type="button" onClick={() => setOpen(false)} className={`${button} bg-surface-container-high text-on-surface`}>
                Cancel
              </button>
              {error && <p role="alert" className="w-full font-body-sm text-body-sm text-error">{error}</p>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Accounts({ users, reload }) {
  const [lookup, setLookup] = useState({ email: "", busy: false, message: "", foundId: null });
  if (!users) return <p className="text-on-surface-variant">Loading…</p>;

  async function find(e) {
    e.preventDefault();
    setLookup((l) => ({ ...l, busy: true, message: "", foundId: null }));
    try {
      const d = await api.adminFindUser(lookup.email.trim());
      setLookup((l) => ({ ...l, busy: false, foundId: d.user.id, message: `That address is account ${shortId(d.user.id)} - highlighted below.` }));
    } catch (err) {
      setLookup((l) => ({ ...l, busy: false, message: err.message }));
    }
  }

  const rows = lookup.foundId ? [...users.users].sort((a, b) => (b.id === lookup.foundId) - (a.id === lookup.foundId)) : users.users;
  return (
    <div className="flex flex-col gap-space-md">
      <form onSubmit={find} className="flex flex-wrap gap-space-sm max-w-2xl">
        <input
          type="email"
          required
          value={lookup.email}
          onChange={(e) => setLookup((l) => ({ ...l, email: e.target.value }))}
          placeholder="Find a student by email"
          aria-label="Email address of the account"
          className="flex-1 min-w-[14rem] h-10 px-space-md rounded-lg bg-surface-container-lowest border border-outline-variant text-on-surface"
        />
        <button disabled={lookup.busy} className={`${button} h-10 bg-surface-container-high text-on-surface`}>
          <Icon name="search" className="text-sm" /> Find
        </button>
      </form>
      {lookup.message && <p className="font-body-sm text-body-sm text-on-surface">{lookup.message}</p>}
      <p className="font-body-sm text-body-sm text-on-surface-variant">
        {users.total} {users.total === 1 ? "account" : "accounts"}, most recently active first. Email addresses are not listed; search for one above.
      </p>
      <div className={`${card} overflow-x-auto`}>
        <table className="w-full font-body-sm text-body-sm">
          <thead>
            <tr className="text-left text-on-surface-variant">
              <th className="py-space-xs pr-space-md font-medium">Account</th>
              <th className="py-space-xs pr-space-md font-medium">Joined</th>
              <th className="py-space-xs pr-space-md font-medium">Last active</th>
              <th className="py-space-xs pr-space-md font-medium text-right">Notes</th>
              <th className="py-space-xs pr-space-md font-medium text-right">Tests</th>
              <th className="py-space-xs pr-space-md font-medium text-right">Attempts</th>
              <th className="py-space-xs font-medium" />
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <AccountRow key={u.id} u={u} highlight={u.id === lookup.foundId} onChanged={reload} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Log({ log }) {
  if (!log) return <p className="text-on-surface-variant">Loading…</p>;
  if (!log.entries.length) return <div className={`${card} text-center text-on-surface-variant`}>No admin actions yet.</div>;
  return (
    <ol className={`${card} flex flex-col`}>
      {log.entries.map((e, i) => (
        <li key={i} className="flex flex-wrap items-baseline gap-x-space-md gap-y-space-2xs py-space-sm border-b border-outline-variant last:border-0">
          <span className="font-body-sm text-body-sm text-on-surface-variant w-28 shrink-0" title={new Date(e.at).toLocaleString()}>
            {timeAgo(e.at)}
          </span>
          <span className="font-ui-body text-ui-body text-on-surface">{ACTION[e.action] || e.action}</span>
          <span className="font-body-sm text-body-sm text-on-surface-variant">
            {e.targetUserId ? `account ${shortId(e.targetUserId)}` : e.targetQuestionId ? `question ${shortId(e.targetQuestionId)}` : ""} · by {e.by}
          </span>
          {e.reason && <span className="w-full sm:w-auto font-body-sm text-body-sm text-on-surface">“{e.reason}”</span>}
        </li>
      ))}
    </ol>
  );
}

export default function Admin() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.id === params.get("tab")) ? params.get("tab") : "overview";
  const [data, setData] = useState({});
  const [error, setError] = useState("");
  const [loadedAt, setLoadedAt] = useState(null);

  const load = useCallback(async () => {
    const get = (key, fn) =>
      fn()
        .then((v) => setData((d) => ({ ...d, [key]: v })))
        .catch((e) => setError(e.message));
    await Promise.all([
      get("health", api.adminHealth),
      get("usage", api.adminUsage),
      get("overview", api.adminOverview),
      get("reports", api.adminReports),
      get("users", api.adminUsers),
      get("log", api.adminLog),
    ]);
    setLoadedAt(new Date());
  }, []);

  useEffect(() => {
    if (user?.isAdmin) load();
  }, [user?.isAdmin, load]);

  const openReports = useMemo(() => data.reports?.questions.filter((r) => r.status === "open").length ?? 0, [data.reports]);

  if (!user?.isAdmin) {
    return (
      <div className="max-w-md mx-auto text-center py-space-3xl">
        <p className="font-body-md text-body-md text-on-surface">This page is for the people running MindAtlas.</p>
        <Link to="/" className="text-secondary hover:underline">
          Back home
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto w-full flex flex-col gap-space-xl pb-space-xl" data-testid="admin-page">
      <div className="flex flex-wrap items-end justify-between gap-space-md">
        <div>
          <h1 className="font-headline-lg text-headline-lg text-primary">Admin</h1>
          <p className="font-body-md text-body-md text-on-surface-variant">Health, usage, reports and accounts. No student&apos;s email, notes or answers are shown here.</p>
        </div>
        <div className="flex items-center gap-space-sm">
          {loadedAt && <span className="font-body-sm text-body-sm text-on-surface-variant">Updated {loadedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}
          <button
            type="button"
            onClick={() => {
              setError("");
              load();
            }}
            className={`${button} bg-surface-container-high text-on-surface`}
          >
            <Icon name="refresh" className="text-sm" /> Refresh
          </button>
        </div>
      </div>

      <nav className="flex gap-space-xs overflow-x-auto border-b border-outline-variant" role="tablist" aria-label="Admin sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setParams(t.id === "overview" ? {} : { tab: t.id })}
            className={`inline-flex items-center gap-space-xs px-space-md py-space-sm -mb-px border-b-2 whitespace-nowrap font-ui-body text-ui-body ${
              tab === t.id ? "border-primary text-on-surface font-semibold" : "border-transparent text-on-surface-variant hover:text-on-surface"
            }`}
          >
            <Icon name={t.icon} className="text-base" />
            {t.label}
            {t.id === "reports" && openReports > 0 && (
              <span className="font-label-sm text-label-sm px-space-xs rounded-full bg-tertiary-container text-on-tertiary-container">{openReports}</span>
            )}
          </button>
        ))}
      </nav>

      {error && (
        <p role="alert" className="text-error font-body-sm text-body-sm">
          {error}
        </p>
      )}

      {tab === "overview" && <Overview health={data.health} usage={data.usage} overview={data.overview} />}
      {tab === "reports" && <Reports reports={data.reports} reload={load} />}
      {tab === "accounts" && <Accounts users={data.users} reload={load} />}
      {tab === "log" && <Log log={data.log} />}
    </div>
  );
}
