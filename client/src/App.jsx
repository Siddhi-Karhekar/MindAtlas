import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/AuthContext.jsx";
import AppShell from "./components/AppShell.jsx";
import SignIn from "./pages/SignIn.jsx";
import Home from "./pages/Home.jsx";
import SubjectWorkspace from "./pages/SubjectWorkspace.jsx";
import KnowledgeGraph from "./pages/KnowledgeGraph.jsx";
import Tests from "./pages/Tests.jsx";
import TestAttempt from "./pages/TestAttempt.jsx";
import Insights from "./pages/Insights.jsx";

function RequireAuth({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="min-h-full grid place-items-center text-ink-soft">Loading…</div>;
  if (!user) return <Navigate to="/sign-in" replace />;
  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/sign-in" element={<SignIn />} />
          <Route
            element={
              <RequireAuth>
                <AppShell />
              </RequireAuth>
            }
          >
            <Route path="/" element={<Home />} />
            <Route path="/subjects/:subjectId" element={<SubjectWorkspace />} />
            <Route path="/subjects/:subjectId/graph" element={<KnowledgeGraph />} />
            <Route path="/subjects/:subjectId/tests" element={<Tests />} />
            <Route path="/tests/:testId/attempt" element={<TestAttempt />} />
            <Route path="/attempts/:attemptId/feedback" element={<Insights />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
