import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, hasMemoryToken, setMemoryToken, setSignedOutHandler, takeLegacyToken } from "./api.js";
import { clearRecent } from "./recent.js";

const AuthContext = createContext(null);

// After a sign-in the server has set the session cookie AND sent the token.
// If the cookie alone is enough to be recognised, the token is dropped and
// the session lives only in the cookie, out of reach of page scripts. If the
// browser refused the cookie (an API on another address, in some browsers),
// the token stays in memory for this page load. See lib/api.js.
async function settleSession(token) {
  setMemoryToken(token);
  try {
    const data = await api.me({ cookieOnly: true });
    setMemoryToken(null);
    return data;
  } catch {
    return token ? api.me() : null;
  }
}

// Who is signed in when the app opens. Done once per page load however many
// times React mounts the provider (development mode mounts it twice): a
// session from before the token left localStorage is moved into the cookie,
// so this upgrade does not sign anyone out, then the server is asked.
//
// The server can take half a minute to wake up, long enough for someone to
// sign in before this first question is answered. `actions` counts sign-ins
// and sign-outs: an answer that arrives after one of them is out of date and
// is dropped, instead of signing the student straight back out.
let opening = null;
let actions = 0;
function openSession() {
  opening ||= (async () => {
    const before = actions;
    const legacy = takeLegacyToken();
    if (legacy) {
      setMemoryToken(legacy);
      await api.adoptSession().catch(() => {});
    }
    const data = await settleSession(legacy).catch(() => null);
    if (actions !== before) return { stale: true };
    if (!data) setMemoryToken(null);
    return { data };
  })();
  return opening;
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  // true while this account still has to confirm its email address
  const [needsVerification, setNeedsVerification] = useState(false);
  const [loading, setLoading] = useState(true);

  const apply = useCallback((data) => {
    setUser(data?.user || null);
    setNeedsVerification(Boolean(data?.user && data.emailVerificationRequired));
  }, []);

  useEffect(() => {
    let cancelled = false;
    openSession().then(({ data, stale }) => {
      if (cancelled) return;
      if (!stale) apply(data);
      setLoading(false);
    });
    // any request answered "not signed in" brings the app back to the sign-in page
    setSignedOutHandler(() => {
      setMemoryToken(null);
      apply(null);
    });
    return () => {
      cancelled = true;
      setSignedOutHandler(() => {});
    };
  }, [apply]);

  async function login(email, password) {
    const data = await api.login(email, password);
    actions += 1;
    apply((await settleSession(data.token)) || data);
  }

  async function register(email, password, extra) {
    const data = await api.register(email, password, extra);
    actions += 1;
    apply((await settleSession(data.token)) || data);
  }

  // After the password changed, or a reset: the server issued a new session.
  async function adopt(token) {
    actions += 1;
    apply(await settleSession(token));
  }

  /** Ask the server again who is signed in (after confirming an email address). */
  async function refresh() {
    apply(await api.me().catch(() => null));
  }

  // Signing out has to reach the server: that is what clears the cookie and
  // retires the session. If it cannot (no connection), the student is told
  // and stays signed in, rather than being shown the sign-in page while the
  // next person at this computer would still get their account.
  async function logout() {
    try {
      await api.logout();
    } catch {
      throw new Error("Could not sign out - check your connection and try again.");
    }
    actions += 1;
    setMemoryToken(null);
    clearRecent();
    apply(null);
  }

  return (
    <AuthContext.Provider value={{ user, needsVerification, loading, login, register, adopt, refresh, logout, tokenInMemory: hasMemoryToken }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
