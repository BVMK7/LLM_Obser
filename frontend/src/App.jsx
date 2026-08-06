import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./AuthContext";
import RequireAuth from "./components/RequireAuth";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import AcceptInvite from "./pages/AcceptInvite";
import ProjectSettings from "./pages/ProjectSettings";
import Sidebar from "./components/Sidebar";
import Topbar from "./components/Topbar";
import Overview from "./pages/Overview";
import Traces from "./pages/Traces";
import TraceDetails from "./pages/TraceDetails";
import Performance from "./pages/Performance";
import CostUsage from "./pages/CostUsage";
import Providers from "./pages/Providers";
import Playground from "./pages/Playground";
import Evaluation from "./pages/Evaluation";
import Datasets from "./pages/Datasets";
import PromptLibrary from "./pages/PromptLibrary";
import Scorers from "./pages/Scorers";
import Experiments from "./pages/Experiments";
import ExperimentDetail from "./pages/ExperimentDetail";
import Alerts from "./pages/Alerts";
import Review from "./pages/Review";
import Settings from "./pages/Settings";

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/invites/accept" element={<AcceptInvite />} />
          <Route
            path="*"
            element={
              <RequireAuth>
                <div className="flex flex-col h-screen app-shell">
                  <Topbar />
                  <div className="flex flex-1 overflow-hidden">
                    <Sidebar />
                    <main className="flex-1 overflow-y-auto p-6">
                      <Routes>
                        <Route path="/" element={<Overview />} />
                        <Route path="/traces" element={<Traces />} />
                        <Route path="/traces/:id" element={<TraceDetails />} />
                        <Route path="/performance" element={<Performance />} />
                        <Route path="/cost-usage" element={<CostUsage />} />
                        <Route path="/providers" element={<Providers />} />
                        <Route path="/playground" element={<Playground />} />
                        <Route path="/evaluation" element={<Evaluation />} />
                        <Route path="/datasets" element={<Datasets />} />
                        <Route path="/scorers" element={<Scorers />} />
                        <Route path="/experiments" element={<Experiments />} />
                        <Route path="/experiments/:id" element={<ExperimentDetail />} />
                        <Route path="/models" element={<Navigate to="/providers" replace />} />
                        <Route path="/prompt-library" element={<PromptLibrary />} />
                        <Route path="/alerts" element={<Alerts />} />
                        <Route path="/review" element={<Review />} />
                        <Route path="/settings" element={<Settings />} />
                        <Route path="/projects/:id/settings" element={<ProjectSettings />} />
                      </Routes>
                    </main>
                  </div>
                </div>
              </RequireAuth>
            }
          />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
