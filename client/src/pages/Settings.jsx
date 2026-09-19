import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/AuthContext.jsx";
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
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const [tab, setTab] = useState("appearance");

  function handleSignOut() {
    logout();
    navigate("/sign-in");
  }

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
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
