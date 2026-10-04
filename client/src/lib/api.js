// Dev: the API runs separately on :4000. Production build: the API serves
// this client itself, so a same-origin relative path is all that's needed.
// Set VITE_API_BASE at build time only if the API lives on another domain.
const API_BASE =
  import.meta.env.VITE_API_BASE || (import.meta.env.DEV ? "http://localhost:4000/api" : "/api");

function getToken() {
  return localStorage.getItem("mindatlas_token");
}

export function setToken(token) {
  if (token) localStorage.setItem("mindatlas_token", token);
  else localStorage.removeItem("mindatlas_token");
}

async function request(path, { method = "GET", body, isForm = false } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body && !isForm) headers["Content-Type"] = "application/json";

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
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
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { headers });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Download failed (${res.status})`);
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
  register: (email, password) => request("/auth/register", { method: "POST", body: { email, password } }),
  login: (email, password) => request("/auth/login", { method: "POST", body: { email, password } }),
  me: () => request("/auth/me"),
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
