import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/AuthContext.jsx";
import Icon from "../components/Icon.jsx";
import Logo from "../components/Logo.jsx";

export default function SignIn() {
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mode === "login") await login(email, password);
      else await register(email, password);
      navigate("/");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const input =
    "w-full h-11 px-space-base rounded-lg bg-surface-container-low text-on-surface font-ui-body text-ui-body placeholder:text-on-surface-variant/50 shadow-sm focus:outline-none focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary/20 transition-all";

  return (
    <div className="min-h-screen bg-surface flex flex-col items-center justify-center px-gutter-canvas py-space-xl relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none overflow-hidden flex items-center justify-center opacity-40">
        <div className="w-[580px] h-[580px] rounded-full bg-secondary-fixed/40 blur-3xl -translate-y-12"></div>
        <div className="w-[420px] h-[420px] rounded-full bg-tertiary-fixed/30 blur-2xl translate-x-32 translate-y-24"></div>
      </div>

      <div className="w-full max-w-[440px] relative z-10 flex flex-col items-center">
        <div className="w-full bg-surface-container-lowest rounded-xl shadow-xl p-space-xl sm:p-space-2xl transition-all duration-300">
          <div className="flex flex-col items-center text-center">
            <div className="w-14 h-14 rounded-xl bg-surface-container-low flex items-center justify-center shadow-sm mb-space-md">
              <Logo size={36} />
            </div>
            <span className="font-label-md text-label-md uppercase tracking-wider text-secondary mb-space-2xs">
              Cognitive Synthesis Workspace
            </span>
            <h1 className="font-headline-md text-headline-md text-on-surface mb-space-xs tracking-tight">Mind Atlas</h1>
            <p className="font-body-md text-body-md text-on-surface-variant max-w-[320px] leading-relaxed italic text-balance">
              “Turn your own notes into tests that adapt to you.”
            </p>
          </div>

          <form className="mt-space-xl flex flex-col gap-space-md" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-space-2xs">
              <label className="font-label-md text-label-md text-on-surface-variant" htmlFor="study-email">
                Email
              </label>
              <div className="relative">
                <input
                  id="study-email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={input}
                  placeholder="you@school.edu"
                />
                <Icon
                  name="mail"
                  className="text-sm absolute right-space-base top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none"
                />
              </div>
            </div>

            <div className="flex flex-col gap-space-2xs">
              <label className="font-label-md text-label-md text-on-surface-variant" htmlFor="study-pass">
                Password
              </label>
              <div className="relative">
                <input
                  id="study-pass"
                  type={showPassword ? "text" : "password"}
                  required
                  minLength={8}
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={input}
                  placeholder="At least 8 characters"
                />
                <button
                  type="button"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-space-base top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface transition-colors p-1"
                >
                  <Icon name={showPassword ? "visibility_off" : "visibility"} className="text-sm block" />
                </button>
              </div>
            </div>

            {error && (
              <p role="alert" className="font-body-sm text-body-sm text-error">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full h-11 mt-space-xs rounded-lg bg-primary hover:opacity-90 text-on-primary font-ui-title text-ui-title tracking-tight shadow-md hover:shadow-lg transition-all duration-200 flex items-center justify-center gap-space-xs disabled:opacity-60"
            >
              <span>{busy ? "Please wait…" : mode === "login" ? "Enter your study space" : "Create your account"}</span>
              {!busy && <Icon name="arrow_forward" className="text-sm" />}
            </button>
          </form>

          <div className="mt-space-xl bg-surface-container-low rounded-lg p-space-md text-center flex flex-col items-center gap-space-2xs">
            <span className="font-body-sm text-body-sm text-on-surface-variant">
              {mode === "login" ? "New researcher on the platform?" : "Already have a library?"}
            </span>
            <button
              type="button"
              onClick={() => {
                setMode(mode === "login" ? "register" : "login");
                setError("");
              }}
              className="font-label-md text-label-md text-primary hover:text-on-surface-variant transition-colors flex items-center gap-space-2xs font-semibold"
            >
              <span>{mode === "login" ? "Create a personal library" : "Sign in instead"}</span>
              <Icon name={mode === "login" ? "auto_stories" : "login"} className="text-sm" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
