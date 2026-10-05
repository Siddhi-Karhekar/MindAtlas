import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api.js";
import { clearUrlToken, useUrlToken } from "../lib/urlToken.js";
import { useAuth } from "../lib/AuthContext.jsx";
import AuthCard, { authButton, authInput, authLink } from "../components/AuthCard.jsx";

// The page a password-reset email links to: /reset-password#token=...
export default function ResetPassword() {
  const { adopt } = useAuth();
  const navigate = useNavigate();
  const token = useUrlToken(); // read once, and removed from the address bar (lib/urlToken.js)
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [state, setState] = useState({ busy: false, error: "" });

  async function handleSubmit(e) {
    e.preventDefault();
    if (password !== again) return setState({ busy: false, error: "The two passwords do not match." });
    setState({ busy: true, error: "" });
    try {
      const data = await api.resetPassword(token, password);
      clearUrlToken();
      await adopt(data.token); // the reset signs the student in
      navigate("/");
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }

  return (
    <AuthCard title="Choose a new password">
      {!token ? (
        <p role="alert" className="font-body-md text-body-md text-on-surface text-center">
          This link is incomplete. Open the link from the email again, or ask for a new one.
        </p>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-space-md" data-testid="reset-form">
          <label className="flex flex-col gap-space-2xs font-label-md text-label-md text-on-surface-variant">
            New password
            <input type="password" required minLength={10} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={authInput} />
          </label>
          <label className="flex flex-col gap-space-2xs font-label-md text-label-md text-on-surface-variant">
            New password again
            <input type="password" required minLength={10} autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} className={authInput} />
          </label>
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            At least 10 characters. Not a common password, not your email name, not only digits.
          </p>
          {state.error && (
            <p role="alert" className="font-body-sm text-body-sm text-error">
              {state.error}
            </p>
          )}
          <button type="submit" disabled={state.busy} className={authButton}>
            {state.busy ? "Please wait…" : "Save and sign in"}
          </button>
        </form>
      )}
      <Link to="/forgot-password" className={`${authLink} text-center`}>
        Ask for a new link
      </Link>
    </AuthCard>
  );
}
