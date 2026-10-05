// Dev: the API runs separately on :4000. Production build: the API serves
// this client itself, so a same-origin relative path is all that's needed.
// Set VITE_API_BASE at build time only if the API lives on another domain.
const API_BASE =
  import.meta.env.VITE_API_BASE || (import.meta.env.DEV ? "http://localhost:4000/api" : "/api");

// THE SESSION. Signing in puts the session in a cookie the browser keeps and
// sends by itself, and that page scripts cannot read (HttpOnly) - so a script
// injected into the page cannot steal it. Nothing about the session is kept
// in localStorage.
//
// Some browsers refuse a cookie from an API on a different address than the
// page (the web client and the API hosted separately). There the token from
// the sign-in answer is used instead, held in this variable only: it lasts
// until the page is reloaded, and the student signs in again after that.
// lib/AuthContext.jsx decides which of the two is in use.
let memoryToken = null;
export const setMemoryToken = (token) => {
  memoryToken = token || null;
};
export const hasMemoryToken = () => Boolean(memoryToken);

// The token of a session started before this change, when it was kept in
// localStorage. Returned once and removed for good.
export function takeLegacyToken() {
  try {
    const token = localStorage.getItem("mindatlas_token");
    localStorage.removeItem("mindatlas_token");
    return token;
  } catch {
    return null;
  }
}

// Told when the server says the session is over (expired, password changed,
// account gone), so the app can go back to the sign-in page from wherever it is.
let onSignedOut = () => {};
export const setSignedOutHandler = (fn) => {
  onSignedOut = fn;
};

/** An error from the API: `status` is the HTTP status, `code` a short machine name when the server gave one. */
class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function authHeaders(cookieOnly) {
  return memoryToken && !cookieOnly ? { Authorization: `Bearer ${memoryToken}` } : {};
}

async function request(path, { method = "GET", body, isForm = false, cookieOnly = false, quiet = false } = {}) {
  const headers = authHeaders(cookieOnly);
  if (body && !isForm) headers["Content-Type"] = "application/json";

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    credentials: "include", // send the session cookie, also to an API on another address
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !quiet && !path.startsWith("/auth/")) onSignedOut();
    throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data.code);
  }
  return data;
}

// The name the server gave a download: the UTF-8 one if present, else the plain one.
function fileNameFrom(disposition) {
  const header = String(disposition || "");
  const utf8 = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch {
      // fall through to the plain name
    }
  }
  return header.match(/filename="([^"]+)"/i)?.[1] || "";
}

// A download: the answer is the file itself, not JSON. Returns { blob, fileName }.
async function download(path) {
  const res = await fetch(`${API_BASE}${path}`, { headers: authHeaders(false), credentials: "include" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) onSignedOut();
    throw new ApiError(data.error || `Download failed (${res.status})`, res.status, data.code);
  }
  return { blob: await res.blob(), fileName: fileNameFrom(res.headers.get("Content-Disposition")) };
}

// format ("pdf" | "docx") and the student's time zone, for the date on the first page
function exportQuery(format) {
  let tz = "";
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    // no time zone: the server uses UTC
  }
  return `format=${encodeURIComponent(format)}${tz ? `&tz=${encodeURIComponent(tz)}` : ""}`;
}

export const api = {
  // What the sign-in pages need first: a challenge for the sign-up form,
  // whether this server sends email, the password length rule.
  authConfig: () => request("/auth/config"),
  // `challenge` comes from authConfig; `website` is the hidden field people leave empty
  register: (email, password, { challenge, website = "" } = {}) =>
    request("/auth/register", { method: "POST", body: { email, password, challenge, website } }),
  login: (email, password) => request("/auth/login", { method: "POST", body: { email, password } }),
  logout: () => request("/auth/logout", { method: "POST" }),
  // `cookieOnly`: ask without the in-memory token, to learn whether the cookie alone signs us in
  me: ({ cookieOnly = false } = {}) => request("/auth/me", { cookieOnly, quiet: true }),
  // moves a session held as a token into the cookie
  adoptSession: () => request("/auth/session", { method: "POST" }),
  verifyEmail: (token) => request("/auth/verify-email", { method: "POST", body: { token } }),
  resendVerification: () => request("/auth/resend-verification", { method: "POST" }),
  forgotPassword: (email) => request("/auth/forgot", { method: "POST", body: { email } }),
  resetPassword: (token, password) => request("/auth/reset", { method: "POST", body: { token, password } }),
  changePassword: (currentPassword, newPassword) =>
    request("/auth/password", { method: "POST", body: { currentPassword, newPassword } }),
  // removes the account and everything in it; the password is asked for again
  deleteAccount: (password) => request("/auth/me", { method: "DELETE", body: { password } }),

  listSubjects: () => request("/subjects"),
  createSubject: (name) => request("/subjects", { method: "POST", body: { name } }),

  listNotes: (subjectId) => request(`/subjects/${subjectId}/notes`),
  createNote: (subjectId, { title, content }) =>
    request(`/subjects/${subjectId}/notes`, { method: "POST", body: { title, content } }),
  // Uploads any supported file (PDF, Word, PowerPoint, text, image). A long
  // document with subtopics is split into a parent note plus one child note
  // per subtopic unless `split` is false.
  uploadNoteImage: (subjectId, file, title, { split = true } = {}) => {
    const form = new FormData();
    form.append("file", file);
    if (title) form.append("title", title);
    form.append("split", split ? "true" : "false");
    return request(`/subjects/${subjectId}/notes`, { method: "POST", body: form, isForm: true });
  },
  // Reads a file and reports the subtopics it would be split into, saving nothing.
  previewUpload: (subjectId, file) => {
    const form = new FormData();
    form.append("file", file);
    return request(`/subjects/${subjectId}/notes/preview`, { method: "POST", body: form, isForm: true });
  },

  // One note. getNote also returns `editText`: the note as editable text.
  getNote: (noteId) => request(`/notes/${noteId}`),
  // `content` is the edited text; keywords and links are recomputed from it.
  updateNote: (noteId, { title, content }) => request(`/notes/${noteId}`, { method: "PATCH", body: { title, content } }),
  // A split document takes its subtopics with it.
  deleteNote: (noteId) => request(`/notes/${noteId}`, { method: "DELETE" }),

  // A formatted file to keep or print. For a document that was split into
  // subtopics, exportNote gives the whole document.
  exportNote: (noteId, format) => download(`/notes/${noteId}/export?${exportQuery(format)}`),
  exportSubject: (subjectId, format) => download(`/subjects/${subjectId}/export?${exportQuery(format)}`),

  getGraph: (subjectId) => request(`/subjects/${subjectId}/graph`),
  // action: "remove" (the student says this link is wrong) or "restore"
  correctEdge: (edgeId, action) => request(`/graph/edges/${edgeId}/correct`, { method: "POST", body: { action } }),
  getKeywordMap: (noteId) => request(`/graph/notes/${noteId}/keyword-map`),

  listTests: (subjectId) => request(`/subjects/${subjectId}/tests`),
  createTest: (subjectId, { title, noteIds, mcqCount, theoryCount, marksPerQuestion, durationMinutes }) =>
    request(`/subjects/${subjectId}/tests`, {
      method: "POST",
      body: { title, noteIds, mcqCount, theoryCount, marksPerQuestion, durationMinutes },
    }),

  startAttempt: (testId) => request(`/tests/${testId}/attempts`, { method: "POST" }),
  submitResponse: (attemptId, { questionId, answer, timeMs }) =>
    request(`/attempts/${attemptId}/responses`, { method: "POST", body: { questionId, answer, timeMs } }),
  submitAttempt: (attemptId) => request(`/attempts/${attemptId}/submit`, { method: "POST" }),
  getFeedback: (attemptId) => request(`/attempts/${attemptId}/feedback`),

  getProgress: (subjectId) => request(`/subjects/${subjectId}/progress`),
};
