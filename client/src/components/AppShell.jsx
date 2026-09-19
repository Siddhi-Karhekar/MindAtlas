import { NavLink, Outlet, useLocation, useMatch } from "react-router-dom";
import Icon from "./Icon.jsx";
import Logo from "./Logo.jsx";
import { getLastAttempt, getLastSubject, setLastSubject } from "../lib/recent.js";
import { useEffect } from "react";

// The icon rail. Tests / Graph / Insights are per-subject (or per-attempt) pages,
// so their targets come from the current route when there is one, and otherwise
// from the last subject / attempt the student touched. With nothing to go to yet
// they fall back to Home, where a subject can be picked or created.
export default function AppShell() {
  const location = useLocation();
  const subjectMatch = useMatch("/subjects/:subjectId/*");
  const routeSubject = subjectMatch?.params.subjectId;

  useEffect(() => {
    if (routeSubject) setLastSubject(routeSubject);
  }, [routeSubject]);

  const subjectId = routeSubject || getLastSubject();
  const attemptId = getLastAttempt();
  const path = location.pathname;

  const items = [
    { key: "home", label: "Home", icon: "home", to: "/", active: path === "/" },
    {
      key: "subjects",
      label: "Notes",
      icon: "auto_stories",
      to: subjectId ? `/subjects/${subjectId}` : "/",
      active: /^\/subjects\/[^/]+(\/new)?$/.test(path),
    },
    {
      key: "tests",
      label: "Tests",
      icon: "fact_check",
      to: subjectId ? `/subjects/${subjectId}/tests` : "/",
      active: path.endsWith("/tests"),
    },
    {
      key: "graph",
      label: "Knowledge graph",
      icon: "show_chart",
      to: subjectId ? `/subjects/${subjectId}/graph` : "/",
      active: path.endsWith("/graph"),
    },
    {
      key: "insights",
      label: "Insights",
      icon: "lightbulb",
      to: subjectId ? `/subjects/${subjectId}/progress` : attemptId ? `/attempts/${attemptId}/feedback` : "/",
      active: path.startsWith("/attempts/") || path.endsWith("/progress"),
    },
  ];

  const rail = (active) =>
    `flex items-center justify-center w-11 h-11 rounded-xl transition-colors ${
      active
        ? "bg-surface-container text-on-surface"
        : "text-on-surface-variant hover:bg-surface-container hover:text-on-surface"
    }`;

  return (
    <>
      <aside className="fixed left-0 top-0 h-full w-sidebar-width bg-surface-container-lowest border-r border-outline-variant z-50 flex flex-col items-center justify-between py-space-lg">
        <div className="flex flex-col items-center gap-space-2xl w-full">
          <NavLink to="/" title="Mind Atlas" className="flex items-center justify-center">
            <Logo />
          </NavLink>
          <nav className="flex flex-col items-center gap-space-xs">
            {items.map((it) => (
              <NavLink key={it.key} to={it.to} title={it.label} aria-label={it.label} className={rail(it.active)}>
                <Icon name={it.icon} className="text-[22px]" />
              </NavLink>
            ))}
          </nav>
        </div>
        <NavLink
          to="/settings"
          title="Settings"
          aria-label="Settings"
          className={rail(path === "/settings")}
        >
          <Icon name="settings" className="text-[22px]" />
        </NavLink>
      </aside>
      <div className="pl-sidebar-width h-screen flex flex-col overflow-hidden">
        <main className="w-full px-gutter-canvas py-space-xl flex-1 bg-surface overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </>
  );
}
