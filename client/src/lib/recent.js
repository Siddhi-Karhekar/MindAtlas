// Tiny localStorage helpers that remember where the student last was, so the
// icon rail can send "Tests" / "Graph" / "Insights" somewhere useful from any
// page. Everything is best-effort: if storage is unavailable the app still works.

const SUBJECT = "mindatlas_last_subject";
const ATTEMPT = "mindatlas_last_attempt";
const VISITS = "mindatlas_subject_visits";

function get(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function set(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export const getLastSubject = () => get(SUBJECT);
export const getLastAttempt = () => get(ATTEMPT);
export const setLastAttempt = (id) => set(ATTEMPT, id);

export function setLastSubject(id) {
  set(SUBJECT, id);
  const visits = getSubjectVisits();
  visits[id] = Date.now();
  set(VISITS, JSON.stringify(visits));
}

export function getSubjectVisits() {
  try {
    return JSON.parse(get(VISITS) || "{}") || {};
  } catch {
    return {};
  }
}
