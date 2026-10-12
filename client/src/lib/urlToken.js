// The one-time token an emailed link carries (confirm an address, reset a
// password): https://app/reset-password#token=...
//
// It is after the "#", which browsers never send to the server hosting the
// page, so it stays out of that server's logs. It is read once per page load
// and taken out of the address bar straight away, so it is not left in the
// browser's history or carried along in a copied link. Reading happens here,
// outside React, because React may run a component's start-up code twice and
// the second run would find the address already cleaned.
import { useEffect, useState } from "react";

let taken = { path: null, token: "" };

/** The token the current page was opened with, or "". */
export function takeUrlToken() {
  const path = window.location.pathname;
  const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("token");
  // links sent before the token moved behind the "#" carried it as ?token=
  const fromQuery = new URLSearchParams(window.location.search).get("token");
  if (fromHash || fromQuery) {
    taken = { path, token: fromHash || fromQuery };
    window.history.replaceState(null, "", path);
  }
  // a token belongs to the page it arrived on: the reset page's is not the confirm page's
  return taken.path === path ? taken.token : "";
}

/** Forget the token once it has been used. */
export function clearUrlToken() {
  taken = { path: null, token: "" };
}

/**
 * The page's token, for a component. Also picks up a link pasted into a tab
 * that already shows the same page: only the part after "#" changes then, the
 * page is not loaded again, and the browser reports it as a "hashchange".
 */
export function useUrlToken() {
  const [token, setToken] = useState(takeUrlToken);
  useEffect(() => {
    const onChange = () => setToken(takeUrlToken());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return token;
}
