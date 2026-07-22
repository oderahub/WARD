import { useEffect, useState } from "react";

import { useEventStore } from "../hooks/useEventStore";
import { useUrlState } from "../hooks/useUrlState";
import { ACTIVE_CHAIN_ID } from "../lib/networks";

const DASHBOARD_VERSION = "v0.10.1";

/**
 * Bottom status bar. Low-prominence; surfaces the four pieces of state most
 * useful when diagnosing "is the dashboard actually pointed at the right RPC
 * / contracts and seeing live events": cursor head, RPC URL, chain id, and
 * the build version.
 *
 * Lane B chrome: warm paper background with a single top hairline. Head /
 * RPC / chain are mono and left-aligned; version sits on the right.
 *
 * When the event-store is still backfilling, a thin 2px progress fill is
 * rendered along the top edge of the bar (merged from the old ProgressBar
 * component to remove a visually duplicated footer).
 */
export default function StatusBar() {
  const { store, snapshotKey, ready, progress } = useEventStore();
  const { rpc } = useUrlState();

  const [head, setHead] = useState<string>("—");
  const [eventCount, setEventCount] = useState<number>(0);

  useEffect(() => {
    if (!store) {
      setHead("—");
      setEventCount(0);
      return;
    }
    try {
      setHead(store.cursor().toString());
    } catch {
      setHead("—");
    }
    setEventCount(store.recentEvents(99999).length);
  }, [store, snapshotKey]);

  const showProgress = !ready && progress !== null;

  return (
    <div className="relative border-t border-rule bg-bg">
      {showProgress && <BackfillProgressFill progress={progress!} />}
      <div className="flex h-8 items-center gap-5 px-6 text-[11px]">
        <span className="font-mono">
          <span className="text-text-muted">head</span>{" "}
          <span className="tabular-nums text-text">{head}</span>
        </span>
        <span className="font-mono">
          <span className="text-text-muted">events</span>{" "}
          <span className="tabular-nums text-text">{eventCount}</span>
        </span>
        <span className="font-mono">
          <span className="text-text-muted">chain</span>{" "}
          <span className="tabular-nums text-text">{ACTIVE_CHAIN_ID}</span>
        </span>
        <span className="min-w-0 flex-1 truncate font-mono" title={rpc}>
          <span className="text-text-muted">rpc</span>{" "}
          <span className="text-text-muted">{rpc}</span>
        </span>
        <span className="font-mono text-text-muted">{DASHBOARD_VERSION}</span>
      </div>
    </div>
  );
}

/**
 * 2px backfill progress fill, pinned to the top edge of the StatusBar.
 * Preserves the a11y attributes from the old standalone ProgressBar so
 * screen-readers still announce progress.
 */
function BackfillProgressFill({
  progress,
}: {
  progress: NonNullable<ReturnType<typeof useEventStore>["progress"]>;
}) {
  const totalNum = Number(progress.total);
  const currentNum = Number(progress.current);
  const indeterminate = totalNum === 0;
  const percent =
    totalNum > 0
      ? Math.min(100, Math.max(0, Math.round((currentNum / totalNum) * 100)))
      : 0;

  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`Loading ${progress.phase} events`}
      className="absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-rule"
    >
      {indeterminate ? (
        <div className="h-full w-full animate-pulse bg-warn" />
      ) : (
        <div
          className="h-full bg-warn transition-all duration-150"
          style={{ width: `${percent}%` }}
        />
      )}
    </div>
  );
}
