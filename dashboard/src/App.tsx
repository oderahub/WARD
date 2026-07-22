import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { EventStoreProvider, useEventStore } from "./hooks/useEventStore";
import { useUrlState } from "./hooks/useUrlState";
import { Sidebar } from "./components/Sidebar";
import TopBar from "./components/TopBar";
import QueueTab from "./components/QueueTab";
import StatusBar from "./components/StatusBar";
import ExecDrawer from "./components/ExecDrawer";
import PolicyDrawer from "./components/PolicyDrawer";
import VisibilityBanner from "./components/VisibilityBanner";
import { PublishPage } from "./pages/PublishPage";
import { WatchedPage } from "./pages/WatchedPage";
import { WatchWizardPage } from "./pages/WatchWizardPage";
import { humanizeWeb3Error } from "./lib/humanizeError";
import { Toaster } from "./components/ui/sonner";
import { TooltipProvider } from "./components/ui/tooltip";

export default function App() {
  return (
    <EventStoreProvider>
      <TooltipProvider delayDuration={200}>
        <AppShell />
      </TooltipProvider>
    </EventStoreProvider>
  );
}

function truncateRpc(url: string, max = 48): string {
  if (url.length <= max) return url;
  return `${url.slice(0, max - 1)}…`;
}

function AppShell() {
  const { tab, drawer, rpc, setDrawer } = useUrlState();
  const { error, retry } = useEventStore();
  const humanized = error ? humanizeWeb3Error(error) : null;
  const reduced = useReducedMotion();

  return (
    <div className="flex min-h-screen bg-bg">
      <Sidebar />

      <div className="flex min-h-screen flex-1 flex-col overflow-hidden">
        <TopBar />

        {error && humanized && (
          <div
            role="alert"
            className="border-b border-danger bg-danger/20 px-4 py-2 text-sm text-danger"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <span>Ward could not connect to RPC, {humanized.headline}</span>
                <span className="ml-2 font-mono text-[11px] text-text-subtle">
                  {truncateRpc(rpc)}
                </span>
                <details className="mt-1">
                  <summary className="cursor-pointer text-text-subtle text-[11px]">
                    Show details
                  </summary>
                  <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] text-text-subtle">
                    {error.message}
                  </pre>
                </details>
              </div>
              <button
                type="button"
                onClick={retry}
                className="shrink-0 rounded-md border border-danger px-2 py-1 text-xs hover:bg-danger/30 active:scale-[0.98] transition-transform"
              >
                Retry
              </button>
            </div>
          </div>
        )}

        <main className="flex flex-1 flex-col overflow-hidden">
          {tab === "queue" && <VisibilityBanner />}
          <div className="flex-1 overflow-hidden">
            <AnimatePresence mode="wait">
              <motion.div
                key={tab}
                initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
                animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
                exit={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
                transition={reduced ? { duration: 0 } : { duration: 0.16, ease: [0.25, 1, 0.5, 1] }}
                className="h-full"
              >
                {tab === "publish" && <PublishPage />}
                {tab === "queue" && <QueueTab />}
                {tab === "watched" && <WatchedPage />}
                {tab === "watch-wizard" && <WatchWizardPage />}
              </motion.div>
            </AnimatePresence>
          </div>
        </main>

        <StatusBar />
      </div>

      <AnimatePresence>
        {drawer && (drawer.kind === "exec"
          ? tab === "queue" && <ExecDrawer key={"exec-" + drawer.execId.toString()} execId={drawer.execId} onClose={() => setDrawer(null)} />
          : <PolicyDrawer key={"policy-" + drawer.policyId} policyId={drawer.policyId} onClose={() => setDrawer(null)} />)}
      </AnimatePresence>

      <Toaster />
    </div>
  );
}
