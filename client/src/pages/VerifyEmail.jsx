import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { api } from "../lib/api.js";
import { clearUrlToken, useUrlToken } from "../lib/urlToken.js";
import { useAuth } from "../lib/AuthContext.jsx";
import AuthCard, { authButton, authLink } from "../components/AuthCard.jsx";

// Two jobs, one address:
//   /verify-email#token=...  the link in the confirmation email: confirm it
//   /verify-email            where a signed-in student waits until they have
export default function VerifyEmail() {
  const { user, needsVerification, loading, refresh, logout } = useAuth();
  const navigate = useNavigate();
  const token = useUrlToken(); // read once, and removed from the address bar (lib/urlToken.js)
  // with a token: "ready" -> "checking" -> "done" | "failed"
  const [progress, setResult] = useState("");
  const result = progress || (token ? "ready" : "");
  const [message, setMessage] = useState({ text: "", error: false });
  const [busy, setBusy] = useState(false);

  // Confirming takes a click. Opening the link is not enough: mail programs
  // and virus scanners open links by themselves, and an address must only
  // count as confirmed when its owner said so.
  async function confirm() {
    setResult("checking");
    try {
      await api.verifyEmail(token);
      clearUrlToken();
      await refresh();
      setResult("done");
    } catch (err) {
      setResult("failed");
      setMessage({ text: err.message, error: true });
    }
  }

  async function resend() {
    setBusy(true);
    setMessage({ text: "", error: false });
    try {
      const r = await api.resendVerification();
      if (r.alreadyVerified) {
        await refresh();
        navigate("/");
        return;
      }
      setMessage({ text: "Sent. Check your inbox, and your spam folder.", error: false });
    } catch (err) {
      setMessage({ text: err.message, error: true });
    } finally {
      setBusy(false);
    }
  }

  async function check() {
    setBusy(true);
    await refresh();
    setBusy(false);
    setMessage({ text: "Not confirmed yet - open the link in the email first.", error: true });
  }

  if (loading) return <AuthCard title="Confirm your email" />;

  if (result === "ready" || result === "checking") {
    return (
      <AuthCard title="Confirm your email">
        <p className="font-body-md text-body-md text-on-surface text-center">
          Confirm that this email address is yours and that you created a Mind Atlas account with it.
        </p>
        <button type="button" onClick={confirm} disabled={result === "checking"} className={authButton} data-testid="verify-confirm">
          {result === "checking" ? "Confirming…" : "Yes, confirm my email"}
        </button>
        <p className="font-body-sm text-body-sm text-on-surface-variant text-center">
          Not you? Close this page - nothing happens unless you press the button.
        </p>
      </AuthCard>
    );
  }
  if (result === "done") {
    return (
      <AuthCard title="Email confirmed">
        <p role="status" data-testid="verify-done" className="font-body-md text-body-md text-on-surface text-center">
          Thank you - your address is confirmed.
        </p>
        <Link to={user ? "/" : "/sign-in"} className={authButton}>
          {user ? "Continue to your notes" : "Sign in"}
        </Link>
      </AuthCard>
    );
  }

  // no token, or a link that did not work
  if (!user) {
    if (result === "failed") {
      return (
        <AuthCard title="Confirm your email">
          <p role="alert" className="font-body-md text-body-md text-on-surface text-center">
            {message.text}
          </p>
          <Link to="/sign-in" className={authButton}>
            Sign in
          </Link>
        </AuthCard>
      );
    }
    return <Navigate to="/sign-in" replace />;
  }
  if (!needsVerification) return <Navigate to="/" replace />;

  return (
    <AuthCard title="Confirm your email">
      <p className="font-body-md text-body-md text-on-surface text-center" data-testid="verify-pending">
        We sent a link to <strong>{user.email}</strong>. Open it to confirm that the address is yours, then come back here.
      </p>
      {message.text && (
        <p role={message.error ? "alert" : "status"} className={`font-body-sm text-body-sm text-center ${message.error ? "text-error" : "text-secondary"}`}>
          {message.text}
        </p>
      )}
      <button type="button" onClick={check} disabled={busy} className={authButton}>
        I&apos;ve confirmed it
      </button>
      <div className="flex items-center justify-between gap-space-md">
        <button type="button" onClick={resend} disabled={busy} className={authLink} data-testid="verify-resend">
          Send the link again
        </button>
        <button type="button" onClick={() => logout().catch((err) => setMessage({ text: err.message, error: true }))} className={authLink}>
          Sign out
        </button>
      </div>
    </AuthCard>
  );
}
