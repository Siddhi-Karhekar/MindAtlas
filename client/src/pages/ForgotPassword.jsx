import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";
import AuthCard, { authButton, authInput, authLink } from "../components/AuthCard.jsx";

// Ask for a link to choose a new password. The answer is the same whether or
// not the address has an account, so this page cannot be used to find out who
// uses the app.
export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState({ busy: false, error: "", sent: false });

  async function handleSubmit(e) {
    e.preventDefault();
    setState({ busy: true, error: "", sent: false });
    try {
      await api.forgotPassword(email.trim());
      setState({ busy: false, error: "", sent: true });
    } catch (err) {
      setState({ busy: false, error: err.message, sent: false });
    }
  }

  return (
    <AuthCard title="Reset your password">
      {state.sent ? (
        <p role="status" data-testid="forgot-sent" className="font-body-md text-body-md text-on-surface text-center">
          If there is an account for <strong>{email.trim()}</strong>, a link to choose a new password is on its way. It works for 30
          minutes. Check your spam folder too.
        </p>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-space-md">
          <p className="font-body-md text-body-md text-on-surface-variant text-center">
            Enter your account&apos;s email address and we&apos;ll send you a link to choose a new password.
          </p>
          <label className="flex flex-col gap-space-2xs font-label-md text-label-md text-on-surface-variant">
            Email
            <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={authInput} placeholder="you@school.edu" />
          </label>
          {state.error && (
            <p role="alert" className="font-body-sm text-body-sm text-error">
              {state.error}
            </p>
          )}
          <button type="submit" disabled={state.busy} className={authButton}>
            {state.busy ? "Please wait…" : "Send the link"}
          </button>
        </form>
      )}
      <Link to="/sign-in" className={`${authLink} text-center`}>
        Back to sign in
      </Link>
    </AuthCard>
  );
}
