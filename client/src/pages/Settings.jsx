import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/AuthContext.jsx";
import { api } from "../lib/api.js";
import { useTheme } from "../lib/theme.jsx";
import Icon from "../components/Icon.jsx";

const THEMES = [
  { key: "light", label: "Light mode", icon: "light_mode", swatch: "bg-surface-container-highest", iconClass: "text-primary" },
  { key: "dark", label: "Dark mode", icon: "dark_mode", swatch: "bg-[#1c1c18]", iconClass: "text-[#ece9dd]" },
  {
    key: "system",
    label: "System sync",
    icon: "desktop_windows",
    swatch: "bg-gradient-to-br from-surface-container-highest to-[#1c1c18]",
    iconClass: "text-on-surface-variant",
  },
];

export default function Settings() {
  const { user, logout, adopt } = useAuth();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const [tab, setTab] = useState("appearance");
  // where notes go, and who to write to (from the server's settings)
  const [config, setConfig] = useState(null);
  useEffect(() => {
    api.authConfig().then(setConfig).catch(() => setConfig(null));
  }, []);

  const [signOutError, setSignOutError] = useState("");
  async function handleSignOut() {
    setSignOutError("");
    try {
      await logout();
      navigate("/sign-in");
    } catch (err) {
      setSignOutError(err.message);
    }
  }

  // change password
  const [pw, setPw] = useState({ current: "", next: "", again: "" });
  const [pwState, setPwState] = useState({ busy: false, error: "", done: false });
  async function handlePassword(e) {
    e.preventDefault();
    if (pw.next !== pw.again) return setPwState({ busy: false, error: "The two new passwords do not match.", done: false });
    setPwState({ busy: true, error: "", done: false });
    try {
      const data = await api.changePassword(pw.current, pw.next);
      // every other session of the account has ended; this one carries on with a new one
      await adopt(data.token);
      setPw({ current: "", next: "", again: "" });
      setPwState({ busy: false, error: "", done: true });
    } catch (err) {
      setPwState({ busy: false, error: err.message, done: false });
    }
  }

  // delete account: opened deliberately, then confirmed with the password
  const [del, setDel] = useState({ open: false, password: "", busy: false, error: "" });
  async function handleDeleteAccount(e) {
    e.preventDefault();
    setDel((d) => ({ ...d, busy: true, error: "" }));
    try {
      await api.deleteAccount(del.password);
      await logout().catch(() => {}); // the account is gone; the server has already ended the session
      navigate("/sign-in");
    } catch (err) {
      setDel((d) => ({ ...d, busy: false, error: err.message }));
    }
  }

  const field =
    "w-full h-10 px-space-md rounded-lg bg-surface-container-lowest border border-outline-variant text-on-surface font-body-md text-body-md focus:outline-none focus:border-primary";

  const tabClass = (active) =>
    `text-left px-space-md py-space-sm rounded-lg font-ui-body text-ui-body whitespace-nowrap ${
      active
        ? "bg-surface-container-high text-on-surface font-semibold"
        : "text-on-surface-variant hover:bg-surface-container-high"
    }`;

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-start justify-between mb-space-xl">
        <div>
          <h1 className="font-headline-lg text-headline-lg text-on-surface">Settings</h1>
          <p className="font-label-sm text-label-sm text-on-surface-variant uppercase tracking-wider mt-space-2xs">
            Preferences &amp; account
          </p>
        </div>
      </div>

      {signOutError && (
        <p role="alert" className="mb-space-md font-body-sm text-body-sm text-error" data-testid="sign-out-error">
          {signOutError}
        </p>
      )}
      <div className="grid grid-cols-1 md:grid-cols-[180px_1fr] gap-space-2xl">
        <nav className="flex md:flex-col gap-space-2xs overflow-x-auto" aria-label="Settings sections">
          <button type="button" className={tabClass(tab === "appearance")} onClick={() => setTab("appearance")}>
            Appearance
          </button>
          <button type="button" className={tabClass(tab === "account")} onClick={() => setTab("account")}>
            Account
          </button>
          <div className="hidden md:block h-px bg-outline-variant my-space-sm"></div>
          <button
            type="button"
            onClick={handleSignOut}
            className="text-left px-space-md py-space-sm rounded-lg font-ui-body text-ui-body text-error hover:bg-error-container/40 whitespace-nowrap"
          >
            Sign out
          </button>
        </nav>

        <div>
          {tab === "appearance" && (
            <section>
              <h2 className="font-label-sm text-label-sm text-on-surface-variant uppercase tracking-wider mb-space-md">
                Theme interface
              </h2>
              <div className="grid grid-cols-3 gap-space-md max-w-xl" role="radiogroup" aria-label="Theme">
                {THEMES.map((t) => {
                  const on = theme === t.key;
                  return (
                    <button
                      key={t.key}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setTheme(t.key)}
                      className={`text-left rounded-xl border-2 p-space-xs transition-colors ${
                        on ? "border-primary" : "border-transparent hover:border-outline-variant"
                      }`}
                    >
                      <div className={`rounded-lg ${t.swatch} ring-1 ring-outline-variant/60 h-16 flex items-center justify-center mb-space-sm`}>
                        <Icon name={t.icon} className={t.iconClass} />
                      </div>
                      <span className="font-ui-body text-ui-body text-on-surface px-space-2xs">{t.label}</span>
                    </button>
                  );
                })}
              </div>
              <p className="font-body-sm text-body-sm text-on-surface-variant mt-space-md">
                Applied immediately and remembered in this browser.
              </p>
            </section>
          )}

          {tab === "account" && (
            <section>
              <h2 className="font-label-sm text-label-sm text-on-surface-variant uppercase tracking-wider mb-space-md">
                Signed in as
              </h2>
              <div className="bg-surface-container-lowest border border-outline-variant rounded-xl p-space-lg max-w-2xl flex items-center gap-space-md">
                <div className="w-14 h-14 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center font-headline-sm text-headline-sm shrink-0">
                  {(user?.email || "?").slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-ui-title text-ui-title text-on-surface truncate" data-testid="account-email">
                    {user?.email}
                  </p>
                  <p className="font-body-sm text-body-sm text-on-surface-variant">Your notes, graphs and tests belong to this account.</p>
                </div>
                <button
                  type="button"
                  onClick={handleSignOut}
                  className="h-9 px-space-md rounded-lg bg-surface-container-high text-on-surface font-ui-body text-ui-body hover:bg-surface-container-highest shrink-0"
                >
                  Sign out
                </button>
              </div>

              <h2 className="font-label-sm text-label-sm text-on-surface-variant uppercase tracking-wider mt-space-2xl mb-space-md">
                Change password
              </h2>
              <form onSubmit={handlePassword} className="bg-surface-container-lowest border border-outline-variant rounded-xl p-space-lg max-w-2xl flex flex-col gap-space-md" data-testid="password-form">
                <label className="flex flex-col gap-space-xs font-ui-body text-ui-body text-on-surface">
                  Current password
                  <input type="password" autoComplete="current-password" required value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} className={field} />
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-space-md">
                  <label className="flex flex-col gap-space-xs font-ui-body text-ui-body text-on-surface">
                    New password
                    <input type="password" autoComplete="new-password" required minLength={10} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} className={field} />
                  </label>
                  <label className="flex flex-col gap-space-xs font-ui-body text-ui-body text-on-surface">
                    New password again
                    <input type="password" autoComplete="new-password" required minLength={10} value={pw.again} onChange={(e) => setPw({ ...pw, again: e.target.value })} className={field} />
                  </label>
                </div>
                <div className="flex items-center justify-between gap-space-md flex-wrap">
                  <p className="font-body-sm text-body-sm text-on-surface-variant">
                    At least 10 characters. Not a common password, not your email name, not only digits. Changing it signs you out everywhere else.
                  </p>
                  <button type="submit" disabled={pwState.busy} className="h-9 px-space-lg rounded-lg bg-primary text-on-primary font-ui-body text-ui-body hover:opacity-90 disabled:opacity-60">
                    {pwState.busy ? "Saving…" : "Change password"}
                  </button>
                </div>
                {pwState.error && (
                  <p role="alert" className="font-body-sm text-body-sm text-error">
                    {pwState.error}
                  </p>
                )}
                {pwState.done && (
                  <p role="status" className="font-body-sm text-body-sm text-secondary" data-testid="password-changed">
                    Password changed. Other devices have been signed out; use the new password there.
                  </p>
                )}
              </form>

              <h2 className="font-label-sm text-label-sm text-on-surface-variant uppercase tracking-wider mt-space-2xl mb-space-md">
                Your data and help
              </h2>
              <div className="bg-surface-container-lowest border border-outline-variant rounded-xl p-space-lg max-w-2xl flex flex-col gap-space-sm font-body-sm text-body-sm text-on-surface" data-testid="data-and-help">
                <p>
                  <strong>What is kept:</strong> the text of your notes (never the files you upload), your tests, answers and
                  scores. Delete any note at any time, or the whole account below.
                </p>
                <p>
                  <strong>Where it goes:</strong>{" "}
                  {config?.ai?.enabled
                    ? `to write questions and mark written answers, the text of the notes you pick and your written answers are sent to ${config.ai.name}. ${
                        config.ai.trainsOnInputs === false
                          ? "Its terms say it does not use them to train its models."
                          : "What it may do with them is set by its own terms."
                      } Your email address is never sent.`
                    : "nowhere: this server writes questions and marks answers itself, without an outside AI service."}
                </p>
                <p>
                  <strong>Uploading:</strong> upload your own notes, or material you are allowed to use. Do not upload a
                  whole textbook or someone else&apos;s paid course material.
                </p>
                {config?.support?.email && (
                  <p>
                    <strong>Help, or a complaint:</strong>{" "}
                    <a className="text-secondary hover:underline" href={`mailto:${config.support.email}`} data-testid="support-email">
                      {config.support.email}
                    </a>
                  </p>
                )}
                <p className="text-on-surface-variant">
                  Account id: <span className="font-mono select-all" data-testid="account-id">{user?.id}</span>
                </p>
                {user?.isAdmin && (
                  <Link to="/admin" className="text-secondary hover:underline font-ui-body text-ui-body" data-testid="admin-link">
                    Open the admin page
                  </Link>
                )}
              </div>

              <h2 className="font-label-sm text-label-sm text-error uppercase tracking-wider mt-space-2xl mb-space-md">Delete account</h2>
              <div className="border border-error/40 rounded-xl p-space-lg max-w-2xl flex flex-col gap-space-md">
                <p className="font-body-md text-body-md text-on-surface">
                  This permanently deletes your account and everything in it: subjects, notes, the knowledge graph, tests,
                  attempts and progress. It cannot be undone.
                </p>
                {!del.open ? (
                  <button
                    type="button"
                    onClick={() => setDel({ ...del, open: true })}
                    data-testid="delete-account-open"
                    className="self-start h-9 px-space-lg rounded-lg border border-error/60 text-error font-ui-body text-ui-body hover:bg-error-container/40"
                  >
                    Delete my account…
                  </button>
                ) : (
                  <form onSubmit={handleDeleteAccount} className="flex flex-col gap-space-md" data-testid="delete-account-form">
                    <label className="flex flex-col gap-space-xs font-ui-body text-ui-body text-on-surface">
                      Enter your password to confirm
                      <input type="password" autoComplete="current-password" required value={del.password} onChange={(e) => setDel({ ...del, password: e.target.value })} className={field} />
                    </label>
                    <div className="flex items-center gap-space-sm">
                      <button type="button" onClick={() => setDel({ open: false, password: "", busy: false, error: "" })} disabled={del.busy} className="h-9 px-space-md rounded-lg text-on-surface hover:bg-surface-container-high font-ui-body text-ui-body">
                        Keep my account
                      </button>
                      <button type="submit" disabled={del.busy} className="h-9 px-space-lg rounded-lg bg-error text-on-error font-ui-body text-ui-body font-semibold hover:opacity-90 disabled:opacity-60">
                        {del.busy ? "Deleting…" : "Delete everything"}
                      </button>
                    </div>
                    {del.error && (
                      <p role="alert" className="font-body-sm text-body-sm text-error">
                        {del.error}
                      </p>
                    )}
                  </form>
                )}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
