import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/AuthContext.jsx";

const NAV = [
  { to: "/", label: "Home", end: true },
];

export default function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate("/sign-in");
  }

  return (
    <div className="min-h-full flex flex-col">
      <header className="flex items-center justify-between px-6 py-4 border-b border-black/10 bg-surface">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-md bg-primary text-white grid place-items-center text-sm font-bold">
            M
          </div>
          <span className="font-semibold tracking-tight">Mind Atlas</span>
        </div>
        <nav className="flex items-center gap-4 text-sm">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                isActive ? "text-primary font-semibold" : "text-ink-soft hover:text-ink"
              }
            >
              {item.label}
            </NavLink>
          ))}
          {user && (
            <>
              <span className="text-ink-soft">{user.email}</span>
              <button
                onClick={handleLogout}
                className="px-3 py-1.5 rounded-md border border-black/10 hover:bg-page text-ink-soft"
              >
                Sign out
              </button>
            </>
          )}
        </nav>
      </header>
      <main className="flex-1 px-6 py-8 max-w-5xl w-full mx-auto">
        <Outlet />
      </main>
    </div>
  );
}
