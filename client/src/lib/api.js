const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:4000/api";

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

export const api = {
  register: (email, password) => request("/auth/register", { method: "POST", body: { email, password } }),
  login: (email, password) => request("/auth/login", { method: "POST", body: { email, password } }),
  me: () => request("/auth/me"),

  listSubjects: () => request("/subjects"),
  createSubject: (name) => request("/subjects", { method: "POST", body: { name } }),

  listNotes: (subjectId) => request(`/subjects/${subjectId}/notes`),
  createNote: (subjectId, { title, content }) =>
    request(`/subjects/${subjectId}/notes`, { method: "POST", body: { title, content } }),
  uploadNoteImage: (subjectId, file, title) => {
    const form = new FormData();
    form.append("file", file);
    if (title) form.append("title", title);
    return request(`/subjects/${subjectId}/notes`, { method: "POST", body: form, isForm: true });
  },

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
