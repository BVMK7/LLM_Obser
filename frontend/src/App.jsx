import { BrowserRouter, Routes, Route } from "react-router-dom";
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
import Models from "./pages/Models";
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
              <Route path="/models" element={<Models />} />
              <Route path="/prompt-library" element={<PromptLibrary />} />
              <Route path="/alerts" element={<Alerts />} />
              <Route path="/review" element={<Review />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </main>
        </div>
      </div>
    </BrowserRouter>
  );
}
