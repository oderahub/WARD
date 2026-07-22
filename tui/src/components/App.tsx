import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import {
  createEventStore,
  WARD_QUEUE_ABI,
  type EventStore,
  type StoreEvent,
  type QueueRecordHeader,
} from "@ward/sdk";
import { type Hex } from "viem";
import {
  resolveEnv,
  makePublicClient,
  makeWalletClient,
  WARD_ORACLE_DEPLOY_BLOCK,
  WARD_QUEUE_LOOKBACK_BLOCKS,
} from "../lib/env.js";
import { ExpirablePane } from "./ExpirablePane.js";
import { AgingPane } from "./AgingPane.js";
import { LiveEventsPane, type EventFilter } from "./LiveEventsPane.js";
import { OverviewPane } from "./OverviewPane.js";
import { RasterHeader } from "./RasterHeader.js";

interface PendingTx {
  execId: bigint;
  hash?: Hex;
  status: "submitting" | "sent" | "ok" | "revert";
  message?: string;
}

/**
 * Single-screen operator dashboard:
 *   1) ExpirablePane — focused-row + sweep target
 *   2) AgingPane — one-line bucket summary
 *   3) LiveEventsPane — chronological tail
 *
 * Keys (from architect spec):
 *   ↑/↓        move focused row in Expirable pane
 *   x          expireIfStale on focused row
 *   s          sweep-all (tx-per-row loop with per-row revert reporting)
 *   c          force a cursor catch-up (soft snapshot bump — re-derive visible lists)
 *   a/e/d/v    filter live events (all/enqueued/dispatched/vetoed)
 *   q          quit
 */
export function App() {
  const env = resolveEnv();
  const { stdout } = useStdout();
  const columns = stdout.columns ?? 110;
  const rows = stdout.rows ?? 34;
  const wide = columns >= 116;
  const publicClient = useMemo(() => makePublicClient(env.rpc), [env.rpc]);
  const wallet = useMemo(
    () => (env.privateKey ? makeWalletClient(env.privateKey, env.rpc) : undefined),
    [env.privateKey, env.rpc],
  );

  const storeRef = useRef<EventStore | null>(null);
  const [snapshotKey, bumpSnapshot] = useReducer((n: number) => n + 1, 0);
  const [now, setNow] = useState<bigint>(BigInt(Math.floor(Date.now() / 1000)));
  const [progress, setProgress] = useState<string>("starting…");
  const [ready, setReady] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [filter, setFilter] = useState<EventFilter>("all");
  const [pendingTxs, setPendingTxs] = useState<PendingTx[]>([]);
  const [sweepRunning, setSweepRunning] = useState(false);
  const inFlightRef = useRef<Set<string>>(new Set());
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const { exit } = useApp();

  // ---- bootstrap the event store ----
  useEffect(() => {
    let cancelled = false;
    const store = createEventStore({
      publicClient,
      oracleAddress: env.oracleAddress,
      queueAddress: env.queueAddress,
      ...(WARD_ORACLE_DEPLOY_BLOCK !== undefined
        ? { oracleDeploymentBlock: WARD_ORACLE_DEPLOY_BLOCK }
        : {}),
      queueLookbackBlocks: WARD_QUEUE_LOOKBACK_BLOCKS,
      onProgress: ({ phase, current, total }) => {
        if (cancelled) return;
        const pct = total > 0n ? ((Number(current) / Number(total)) * 100).toFixed(0) : "—";
        setProgress(`${phase} ${current}/${total} (${pct}%)`);
      },
    });
    storeRef.current = store;
    store.subscribe(() => bumpSnapshot());
    void store
      .init()
      .then(() => {
        if (cancelled) return;
        setReady(true);
        setProgress("live");
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setErrorMsg(`init failed: ${e.message}`);
      });
    return () => {
      cancelled = true;
      store.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 1s ticker drives countdown re-eval ----
  useEffect(() => {
    const t = setInterval(() => setNow(BigInt(Math.floor(Date.now() / 1000))), 1000);
    return () => clearInterval(t);
  }, []);

  // ---- derive lists from store + now ----
  // Pending rows are paired with their execId — the queue's primary key for
  // dispatch/veto/expireIfStale. `QueueRecordHeader.requestId` is the
  // app-level intent ID and is NOT a substitute for execId.
  const pending: Array<{ execId: bigint; record: QueueRecordHeader }> = useMemo(() => {
    const s = storeRef.current;
    if (!s) return [];
    return s.listPendingWithExecIds();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotKey, ready]);

  const expirable: Array<{ execId: bigint; record: QueueRecordHeader }> = useMemo(
    () => pending.filter(({ record }) => now > record.deadline),
    [pending, now],
  );

  const events: StoreEvent[] = useMemo(() => {
    const s = storeRef.current;
    return s ? s.recentEvents(200) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotKey, ready]);

  // ---- keep selectedIdx in range when the list shrinks ----
  useEffect(() => {
    if (selectedIdx >= expirable.length && expirable.length > 0) {
      setSelectedIdx(expirable.length - 1);
    } else if (expirable.length === 0 && selectedIdx !== 0) {
      setSelectedIdx(0);
    }
  }, [expirable.length, selectedIdx]);

  // ---- write helpers ----
  async function expireOne(execId: bigint) {
    if (!wallet) {
      setErrorMsg("expireIfStale needs PRIVATE_KEY set in env; readonly mode.");
      return;
    }
    // Per-execId in-flight guard: prevents a fast operator (or a sweep) from
    // submitting a second expireIfStale before the first lands, which would
    // burn gas + produce duplicate revert spam in the pending-tx log.
    const key = execId.toString();
    if (inFlightRef.current.has(key)) return;
    inFlightRef.current.add(key);
    setPendingTxs((p) => [...p, { execId, status: "submitting" }]);
    try {
      const hash = await wallet.writeContract({
        address: env.queueAddress,
        abi: WARD_QUEUE_ABI as never,
        functionName: "expireIfStale",
        args: [execId],
        account: wallet.account,
        chain: wallet.chain ?? null,
      });
      setPendingTxs((p) =>
        p.map((t) => (t.execId === execId ? { ...t, hash, status: "sent" } : t)),
      );
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      setPendingTxs((p) =>
        p.map((t) =>
          t.execId === execId
            ? { ...t, status: receipt.status === "success" ? "ok" : "revert", message: receipt.status }
            : t,
        ),
      );
    } catch (e) {
      setPendingTxs((p) =>
        p.map((t) =>
          t.execId === execId ? { ...t, status: "revert", message: (e as Error).message.slice(0, 80) } : t,
        ),
      );
    } finally {
      inFlightRef.current.delete(key);
    }
  }

  async function sweepAll() {
    if (sweepRunning) return;
    setSweepRunning(true);
    try {
      for (const { execId } of expirable) {
        await expireOne(execId);
      }
    } finally {
      setSweepRunning(false);
    }
  }

  // ---- key handling ----
  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }
    if (key.upArrow) setSelectedIdx((i) => Math.max(0, i - 1));
    if (key.downArrow) setSelectedIdx((i) => Math.min(Math.max(0, expirable.length - 1), i + 1));
    if (input === "x" && expirable[selectedIdx]) {
      void expireOne(expirable[selectedIdx].execId);
    }
    if (input === "s") void sweepAll();
    if (input === "c") {
      // Soft catch-up: the cursor is already read live from the store;
      // bump snapshot so the UI re-derives lists in case the visible cap
      // dropped something during the previous render.
      bumpSnapshot();
    }
    if (input === "a") setFilter("all");
    if (input === "e") setFilter("enqueued");
    if (input === "d") setFilter("dispatched");
    if (input === "v") setFilter("vetoed");
    if (input === "r") setFilter("expired");
  });

  const cursor = storeRef.current?.cursor() ?? 0n;
  const walletInfo = wallet ? wallet.account?.address.slice(0, 10) + "…" : "(read-only — set PRIVATE_KEY to enable writes)";
  const oracleInfo = `${env.oracleAddress.slice(0, 8)}…${env.oracleAddress.slice(-4)}`;
  const queueInfo = `${env.queueAddress.slice(0, 8)}…${env.queueAddress.slice(-4)}`;
  const rpcHost = env.rpc.replace(/^https?:\/\//, "");
  const expirableRows = Math.max(3, Math.min(wide ? 8 : 6, rows - 27));
  const eventRows = Math.max(5, Math.min(wide ? 12 : 8, rows - 26));
  const leftWidth = wide ? Math.max(54, Math.min(78, Math.floor(columns * 0.48))) : undefined;

  return (
    <Box flexDirection="column" minHeight={rows}>
      <RasterHeader
        columns={columns}
        ready={ready}
        progress={progress}
        cursor={cursor}
        walletInfo={walletInfo}
        oracleInfo={oracleInfo}
        queueInfo={queueInfo}
        rpcHost={rpcHost}
        pendingCount={pending.length}
        expirableCount={expirable.length}
        eventCount={events.length}
        compact={!wide}
        errorMsg={errorMsg}
      />
      {!ready && (
        <Box paddingX={1}>
          <Text color="yellow">⟳ backfilling… {progress}</Text>
        </Box>
      )}
      {errorMsg && (
        <Box paddingX={1}>
          <Text color="red">{errorMsg}</Text>
        </Box>
      )}

      <OverviewPane
        pending={pending.map((p) => p.record)}
        expirableCount={expirable.length}
        events={events}
        now={now}
        ready={ready}
        progress={progress}
        compact={!wide}
      />

      {wide ? (
        <Box paddingX={1}>
          <Box flexDirection="column" width={leftWidth}>
            <ExpirablePane
              rows={expirable}
              selectedIndex={selectedIdx}
              now={now}
              sweepRunning={sweepRunning}
              maxRows={expirableRows}
            />
            <AgingPane pending={pending.map((p) => p.record)} now={now} />
          </Box>
          <Box flexGrow={1}>
            <LiveEventsPane events={events} filter={filter} maxRows={eventRows} />
          </Box>
        </Box>
      ) : (
        <>
          <ExpirablePane
            rows={expirable}
            selectedIndex={selectedIdx}
            now={now}
            sweepRunning={sweepRunning}
            maxRows={expirableRows}
          />
          <AgingPane pending={pending.map((p) => p.record)} now={now} />
          <LiveEventsPane events={events} filter={filter} maxRows={eventRows} />
        </>
      )}

      {/* pending tx log */}
      {pendingTxs.length > 0 && (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text bold color="yellow">RECENT TX</Text>
          {pendingTxs.slice(-5).map((t, i) => (
            <Text key={i} color={t.status === "ok" ? "green" : t.status === "revert" ? "red" : "yellow"}>
              exec #{String(t.execId)} {t.status} {t.hash ? t.hash.slice(0, 12) + "…" : ""}
              {t.message ? ` (${t.message})` : ""}
            </Text>
          ))}
        </Box>
      )}

      {/* footer */}
      {wide ? (
        <Box justifyContent="space-between" paddingX={1}>
          <Text dimColor>[↑↓] move · [x] expire · [s] sweep · [c] catch-up · [a/e/d/v/r] filter · [q] quit</Text>
          <Text dimColor>v0.9.0</Text>
        </Box>
      ) : (
        <Box flexDirection="column" paddingX={1}>
          <Text dimColor>[↑↓] move · [x] expire · [s] sweep</Text>
          <Text dimColor>[c] catch-up · [a/e/d/v/r] filter · [q] quit</Text>
          <Text dimColor>v0.9.0</Text>
        </Box>
      )}
    </Box>
  );
}
