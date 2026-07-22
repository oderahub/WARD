import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
import {
  createEventStore,
  type BackfillProgress,
  type EventStore,
  type StoreEvent,
} from "@sentry-somnia/sdk";

import { somniaTestnet } from "../main";
import { useUrlState } from "./useUrlState";
import {
  loadOwnerIndexRich,
  loadSnapshot,
  reorgSafeStartBlock,
  saveOwnerIndexRich,
  saveSnapshot,
  type OwnerIndexEntry,
} from "../lib/persistence";
import {
  lookupPoliciesByOwner,
  lookupPolicyOnChain,
  type LookupPoliciesByOwnerProgress,
} from "../lib/onChainPolicyLookup";

/** Cap on per-call rehydrations of policyIds that already lived in the
 *  persisted ownerIndex but aren't in the in-memory EventStore (e.g. fresh
 *  reload, EventStore re-created after a network swap). Each rehydrate is
 *  ~3 RPC reads (policyOwner + policyHealth + event scan), so 50 caps the
 *  worst-case burst at ~150 reads. Anything beyond that is the next
 *  refresh's job. */
const OWNER_INDEX_REHYDRATE_CAP = 50;

/** Concurrency budget for the rehydrate burst. Shannon comfortably handles
 *  6 parallel reads; higher tends to trip rate-limits, lower needlessly
 *  serialises a cold reload. */
const OWNER_INDEX_REHYDRATE_CONCURRENCY = 6;

/**
 * Run `worker(item)` over `items` with a fixed concurrency window. Returns
 * after every worker has resolved (no fail-fast; individual rejections are
 * swallowed by the worker — callers should handle errors inside it). Pure
 * helper, exported only for tests.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;
  const runners: Array<Promise<void>> = [];
  for (let i = 0; i < limit; i += 1) {
    runners.push(
      (async () => {
        while (true) {
          const idx = cursor;
          cursor += 1;
          if (idx >= items.length) return;
          await worker(items[idx]);
        }
      })(),
    );
  }
  await Promise.all(runners);
}

/** Debounce window for the IndexedDB writer. Keeps disk traffic sane during
 *  bursty backfill emits without losing the trailing write. */
const SNAPSHOT_DEBOUNCE_MS = 500;

/**
 * Oracle was deployed at this block on Shannon. Passed to the SDK so the
 * deep policy backfill is bounded and complete.
 */
const ORACLE_DEPLOYMENT_BLOCK = 394474581n;

/** Approximate number of blocks in 30 days on Shannon (~0.5s block time). */
export const APPROX_30D_BLOCKS = 5_200_000n;

/**
 * Approximate number of blocks in 24 hours on Shannon (0.5s block time):
 * 24 × 3600 ÷ 0.5 = 172_800. Drives the "Skip — last 24 hours" cold-start
 * opt-out: small enough to fit comfortably inside Shannon's live history
 * (~57h at the time of writing) so `head - APPROX_24H_BLOCKS` lands
 * strictly above `ORACLE_DEPLOYMENT_BLOCK` and Skip actually shortens the
 * scan instead of collapsing back to a full walk.
 */
export const APPROX_24H_BLOCKS = 172_800n;

/**
 * Rolling window for the per-chunk ETA estimator. Ten samples balances
 * responsiveness (so a single slow chunk doesn't permanently inflate
 * ETA) against jitter (so a single fast chunk doesn't crash ETA to
 * zero). Exported for the pure-helper test below.
 */
const ETA_WINDOW = 10;

/**
 * Pure helper: given a rolling buffer of per-chunk wall-clock durations
 * (oldest-to-newest) and the remaining chunk count, return the estimated
 * remaining ms as `avg(buffer) * chunksRemaining`. Returns null when the
 * buffer is empty (no sample yet → no honest estimate to surface).
 *
 * Exported so the consuming UI can re-use the same logic in tests; not
 * exported as a public SDK contract — lives next to its single caller.
 */
export function estimateRemainingMs(
  timingsMs: readonly number[],
  chunksRemaining: number,
): number | null {
  if (timingsMs.length === 0) return null;
  if (chunksRemaining <= 0) return 0;
  let total = 0;
  for (const t of timingsMs) total += t;
  const avg = total / timingsMs.length;
  return Math.round(avg * chunksRemaining);
}

/**
 * Per-id failure record produced when the rehydrate path for a persisted
 * ownerIndex entry rejects. Surfaced in the UI so the user can see WHICH
 * policy didn't load and trigger a retry — replaces the prior swallow-and-
 * forget path that left orphaned ids absent from "My policies" with no
 * feedback.
 */
export interface RehydrateFailure {
  policyId: Hex;
  errorMessage: string;
  /** Epoch ms when this attempt failed (Date.now()). */
  lastAttemptAtMs: number;
  /** True while a retry for this id is in flight; the row shows a spinner. */
  inFlight?: boolean;
}

/**
 * Live progress payload mirrored into React state from the
 * `lookupPoliciesByOwner` per-chunk callback. Stays `null` while idle and
 * is reset at the start of every scan. Decoupled from the
 * `LookupPoliciesByOwnerProgress` shape only by the added rolling-average
 * ETA, which is computed on the React side from chunk completion
 * timestamps so the SDK helper stays pure.
 */
export interface OwnerIndexScanProgress {
  /** 1-based index of the chunk most recently completed. */
  chunkIdx: number;
  /** Total chunk count for the safe scan window. */
  totalChunks: number;
  /** Highest block of the chunk most recently attempted. */
  scannedToBlock: bigint;
  /** Upper bound of THIS scan's window — the reorg-safe `toBlock` that
   *  was selected when the scan kicked off (chain head minus the reorg
   *  trim). Stable for the lifetime of a single scan; the UI uses it as
   *  the denominator in the "block X of Y" copy so the user sees both
   *  the cursor AND the target it's converging on. */
  targetToBlock: bigint;
  /** Number of policies discovered so far in this scan. */
  foundCount: number;
  /** ETA in ms based on a rolling 10-chunk average of chunk duration.
   *  Null until at least one chunk has completed (so the first paint
   *  doesn't flash "0 min remaining"). */
  estRemainingMs: number | null;
}

export interface OwnerIndexRefreshState {
  status: "idle" | "scanning" | "done" | "error";
  scannedFromBlock: bigint | null;
  scannedToBlock: bigint | null;
  /** Count of new policyIds discovered on the most recent scan (delta). */
  discovered: number;
  error?: string;
  /** ms timestamp of the most recent successful scan completion. */
  lastSuccessAtMs: number | null;
  /** Per-id failures from the stale-rehydrate burst. Keyed by lowercased
   *  policyId so casing variants collapse to a single record. */
  rehydrateFailures: ReadonlyMap<string, RehydrateFailure>;
  /** Live per-chunk progress mirrored from the scan. Null while idle. */
  progress: OwnerIndexScanProgress | null;
}

/** Module-scope helper so tests / SSR shims can override Date.now in one
 *  place if they ever need to. Production callers can keep using Date.now()
 *  directly. */
const nowMs = (): number => globalThis.Date.now();

export interface EventStoreContextValue {
  store: EventStore | null;
  ready: boolean;
  progress: BackfillProgress | null;
  /** Bumped on every store event so subscribers can re-render via deps. */
  snapshotKey: number;
  /** Set when `store.init()` rejects; cleared on retry. */
  error: Error | null;
  /** Dispose the current store and re-create + re-init it. */
  retry: () => void;
  /** Manually bump snapshotKey so consumers re-render after a hydrate
   *  (hydrate methods don't emit through subscribe, so the standard
   *  re-render path is skipped). Used by PublishButton to surface the
   *  freshly-published policy immediately, before the next live tick. */
  bumpSnapshot: () => void;
  /**
   * Scan PolicyPublished(owner=...) from the persisted ownerIndex cursor up
   * to head, hydrate each discovered policy into the EventStore (with
   * persistence), then save the updated ownerIndex back to IDB. Safe to
   * call repeatedly; uses the cached checkpoint to avoid re-scanning
   * already-seen history.
   */
  refreshOwnerIndex: (owner: Address) => Promise<void>;
  /**
   * Shallow variant of `refreshOwnerIndex` for the first-time-user
   * cold-start UX. Aborts the in-flight scan (if any) and restarts with
   * a fresh `fromBlock` computed as `head - skipBlocks` (where `head` is
   * fetched at scan start so the offset is always relative to chain
   * head, NOT the current scan cursor — a cursor-relative computation
   * would underflow to the deployment block early in a cold scan and
   * defeat the optimization). `skipBlocks` is typically
   * `approxBlocksPer24Hours` for the "last 24 hours" UX. The resulting
   * `fromBlock` is clamped to `[ORACLE_DEPLOYMENT_BLOCK, head]` so an
   * absurd `skipBlocks` (e.g. greater than head) can't push the scan
   * past head or below deployment; additionally, when the clamp would
   * collapse `fromBlock` down to `ORACLE_DEPLOYMENT_BLOCK` (i.e. Shannon
   * is younger than `skipBlocks`), the shallow call no-ops so we don't
   * abort and restart an already-running full scan that would have
   * produced the same result.
   */
  refreshOwnerIndexShallow: (
    owner: Address,
    skipBlocks: bigint,
  ) => Promise<void>;
  /** Constant exposed to UI so the "Skip — last 24 hours" link can compute
   *  `head - APPROX_24H_BLOCKS` without redefining it. */
  approxBlocksPer24Hours: bigint;
  /** State of the most recent `refreshOwnerIndex` call. Reset to idle when
   *  the EventStore is re-created (RPC / oracle change). */
  ownerIndexState: OwnerIndexRefreshState;
  /** Retry the stale-rehydrate for a single policyId previously surfaced in
   *  `ownerIndexState.rehydrateFailures`. On success the failure is removed
   *  and a snapshot bump fires; on failure the record is updated with the
   *  fresh error + timestamp. */
  retryRehydrate: (policyId: Hex) => Promise<void>;
  /** Retry all currently-surfaced rehydrate failures, bounded by the same
   *  concurrency cap as the initial burst. */
  retryAllRehydrates: () => Promise<void>;
  /** Read the persisted ownerIndex (rich-shape) for `owner` straight from
   *  IDB. Exposed so MyPoliciesPanel can render an "ownerIndex ∪ in-memory"
   *  union row set — entries that exist on disk but haven't been
   *  rehydrated into the EventStore yet show up as loading rows instead of
   *  silently vanishing until the next refreshOwnerIndex completes. */
  loadOwnerIndexEntries: (owner: Address) => Promise<OwnerIndexEntry[]>;
  /** Kick off a single-id stale-rehydrate for `policyId` under `owner`,
   *  reusing the ownerIndex hint (publishedBlock) when available. Dedupes
   *  concurrent calls per id via an internal ref so a re-render storm
   *  cannot spawn duplicate lookups. On failure the per-id record lands in
   *  `ownerIndexState.rehydrateFailures` exactly as the bulk burst's
   *  failures do, so the existing RehydrateFailuresPanel renders it. */
  rehydrateMissing: (owner: Address, policyId: Hex) => Promise<void>;
}

const EventStoreContext = createContext<EventStoreContextValue | null>(null);

interface Props {
  children: ReactNode;
}

export function EventStoreProvider({ children }: Props) {
  const { rpc, oracle, queue } = useUrlState();

  const [store, setStore] = useState<EventStore | null>(null);
  const [ready, setReady] = useState(false);
  const [progress, setProgress] = useState<BackfillProgress | null>(null);
  const [snapshotKey, setSnapshotKey] = useState(0);
  const [error, setError] = useState<Error | null>(null);
  // Bumping this re-runs the effect below, disposing the old store and
  // creating a fresh one. The banner "Retry" button calls retry().
  const [retryKey, setRetryKey] = useState(0);
  const [ownerIndexState, setOwnerIndexState] = useState<OwnerIndexRefreshState>({
    status: "idle",
    scannedFromBlock: null,
    scannedToBlock: null,
    discovered: 0,
    lastSuccessAtMs: null,
    rehydrateFailures: new Map(),
    progress: null,
  });
  // Mutable per-id failure collector; flushed to state once at scan end.
  const rehydrateFailuresRef = useRef<Map<string, RehydrateFailure>>(new Map());
  // Hold the live publicClient so the standalone refreshOwnerIndex callback
  // can scan without rebuilding a client. Replaced each time the rpc/oracle
  // effect re-runs so a network swap doesn't leak the old client.
  const publicClientRef = useRef<PublicClient | null>(null);
  // Guards re-entry on the same (oracle, owner) — a second click during an
  // in-flight scan would otherwise double-scan and double-hydrate.
  const refreshInFlightRef = useRef<string | null>(null);
  // Per-scan abort; shallow-rescan path calls abort() before restarting.
  const abortScanRef = useRef<AbortController | null>(null);
  // Rolling buffer of per-chunk wall-clock durations for the most recent
  // scan, used to derive `estRemainingMs` in the React-side progress
  // payload. The SDK helper stays pure (no timing concerns); we measure
  // here so the rolling-window logic lives next to the consumer.
  const chunkTimingsMsRef = useRef<number[]>([]);
  const lastChunkAtRef = useRef<number | null>(null);
  // Per-id dedupe set for single-id rehydrates fired by MyPoliciesPanel
  // when it auto-loads the ownerIndex tail. Each render of the panel may
  // try to rehydrate the same id (the row stays "loading" until the
  // EventStore picks it up); the set lets us no-op concurrent / repeated
  // calls so a burst of re-renders doesn't fan out into a burst of
  // duplicate lookupPolicyOnChain RPC calls. Keyed lowercase to collapse
  // casing variants. Cleared on (rpc, oracle, queue) effect re-init below.
  const rehydrateInFlightIdsRef = useRef<Set<string>>(new Set());
  // FIFO concurrency limiter for `rehydrateMissing`, capped at
  // OWNER_INDEX_REHYDRATE_CONCURRENCY.
  const rehydrateQueueRef = useRef<Array<() => void>>([]);
  const rehydrateActiveCountRef = useRef<number>(0);

  // `progress` updates fire from inside the SDK during init; route them through
  // a ref so we can swap the live callback without rebuilding the store.
  const onProgressRef = useRef<((p: BackfillProgress) => void) | null>(null);
  useEffect(() => {
    onProgressRef.current = (p) => {
      setProgress(p);
      if (p.phase === "live") setReady(true);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setProgress(null);
    setSnapshotKey(0);
    setError(null);
    // The ownerIndex cache is keyed by (chainId, oracle, owner); a network /
    // oracle swap means the prior scan state is no longer relevant.
    rehydrateFailuresRef.current = new Map();
    setOwnerIndexState({
      status: "idle",
      scannedFromBlock: null,
      scannedToBlock: null,
      discovered: 0,
      lastSuccessAtMs: null,
      rehydrateFailures: new Map(),
      progress: null,
    });
    refreshInFlightRef.current = null;
    rehydrateInFlightIdsRef.current = new Set();
    rehydrateQueueRef.current = [];
    rehydrateActiveCountRef.current = 0;
    abortScanRef.current = null;

    const publicClient = createPublicClient({
      chain: somniaTestnet,
      transport: http(rpc),
    }) as PublicClient;
    publicClientRef.current = publicClient;

    // Capture per-effect handles so cleanup can flush the debounced writer
    // without leaking state across reconfigures.
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingWrite = false;
    let createdStore: EventStore | null = null;

    const writeNow = () => {
      if (!createdStore) return;
      pendingWrite = false;
      const snapshotPayload = {
        chainId: somniaTestnet.id,
        oracleAddress: oracle,
        queueAddress: queue,
        cursor: createdStore.cursor(),
        // We snapshot cursor only; head is fetched lazily on next load via the
        // publicClient. Persist cursor as the head-at-cursor too so the reorg
        // helper has a reasonable baseline if the next session can't reach RPC.
        headBlockAtCursor: createdStore.cursor(),
        policies: createdStore.listPolicies(),
        queueRecords: createdStore.listQueueRecords(),
        eventLog: createdStore.recentEvents(2000),
      };
      saveSnapshot(snapshotPayload).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn("snapshot save failed", err);
      });
    };

    const scheduleSave = () => {
      pendingWrite = true;
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        writeNow();
      }, SNAPSHOT_DEBOUNCE_MS);
    };

    let unsub: (() => void) | null = null;

    (async () => {
      // Resume from a persisted cursor when one exists, AND replay the
      // persisted policies map so getPolicy() works for policies published
      // before the cached cursor. Without this hydration, reloading would
      // skip the prior PolicyPublished events (because the new backfill
      // starts from cursor + reorg-safety, which is AFTER those events),
      // leaving `getPolicy` empty until a live PolicyUpdated arrives.
      // queueRecords + eventLog are replayed below so the Queue tab and the
      // live-events panel render cached state instantly on reload; the
      // background backfill then fills the cursor → head gap.
      let startBlock: bigint | undefined;
      let hydratedCursor: bigint | undefined;
      let hydratedPolicies: ReturnType<EventStore["listPolicies"]> = [];
      let hydratedQueueRecords: Array<{
        execId: bigint;
        record: ReturnType<EventStore["listQueueRecords"]>[number];
      }> = [];
      let hydratedEvents: StoreEvent[] = [];
      // Shared reviver: bigintReplacer writes plain decimal strings; we don't
      // auto-detect them here (no field name context), so per-record mappers
      // below cast known bigint fields explicitly. The trailing-'n' branch is
      // defensive in case a future replacer switches to that encoding.
      const reviver = (_k: string, v: unknown) =>
        typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v;
      try {
        const snapshot = await loadSnapshot({
          chainId: somniaTestnet.id,
          oracleAddress: oracle,
          queueAddress: queue,
        });
        if (snapshot && !cancelled) {
          const headBlock = await publicClient.getBlockNumber();
          startBlock = reorgSafeStartBlock(snapshot.cursor, headBlock);
          // Seed the displayed cursor from the persisted last-indexed block so
          // "Indexed through block N" survives a reload instead of flashing 0
          // until init() catches up. Backfill still starts from `startBlock`.
          hydratedCursor = snapshot.cursor;
          try {
            const parsed = JSON.parse(snapshot.policiesJSON, reviver);
            if (Array.isArray(parsed)) {
              hydratedPolicies = parsed.map((p: Record<string, unknown>) => ({
                policyId: p.policyId as `0x${string}`,
                owner: p.owner as `0x${string}`,
                label: p.label as `0x${string}` | undefined,
                // Pre-W3 snapshots have no `labelRecovered` field. The only
                // way `label` got populated in those was via a real
                // PolicyPublished log decode, so treat missing-as-`true` for
                // back-compat. New snapshots written by the no-label probe
                // path explicitly set this to `false`.
                labelRecovered:
                  typeof p.labelRecovered === "boolean" ? p.labelRecovered : true,
                pendingOwner: p.pendingOwner as `0x${string}` | undefined,
                publishedBlock:
                  p.publishedBlock !== undefined && p.publishedBlock !== null
                    ? BigInt(p.publishedBlock as string | number | bigint)
                    : undefined,
                lastUpdatedBlock: BigInt(p.lastUpdatedBlock as string | number | bigint),
              }));
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn("snapshot policies parse failed", err);
          }

          // queueRecords: each is its own try/catch so a corrupt blob in
          // this field doesn't poison the (separately-parsed) eventLog below.
          try {
            const parsed = JSON.parse(snapshot.queueRecordsJSON, reviver);
            if (Array.isArray(parsed)) {
              hydratedQueueRecords = parsed.flatMap((q: Record<string, unknown>) => {
                // Skip entries without a usable execId — the SDK keys the
                // queueRecords map externally, so we have nothing to insert
                // under without it.
                const rawExecId = q.execId;
                if (rawExecId === undefined || rawExecId === null) return [];
                let execId: bigint;
                try {
                  execId = BigInt(rawExecId as string | number | bigint);
                } catch {
                  return [];
                }
                return [
                  {
                    execId,
                    record: {
                      policyId: q.policyId as `0x${string}`,
                      policyVersion:
                        q.policyVersion !== undefined && q.policyVersion !== null
                          ? BigInt(q.policyVersion as string | number | bigint)
                          : 0n,
                      asker: q.asker as `0x${string}`,
                      enqueuedAt: BigInt(q.enqueuedAt as string | number | bigint),
                      earliestCommitAt: BigInt(q.earliestCommitAt as string | number | bigint),
                      deadline: BigInt(q.deadline as string | number | bigint),
                      tier: Number(q.tier),
                      state: q.state as ReturnType<EventStore["listQueueRecords"]>[number]["state"],
                      target: q.target as `0x${string}`,
                      selector: q.selector as `0x${string}`,
                      value: BigInt(q.value as string | number | bigint),
                      requestId: BigInt(q.requestId as string | number | bigint),
                    },
                  },
                ];
              });
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn("snapshot queueRecords parse failed", err);
          }

          // eventLog: must be chronological for hydrateEvent's ordered+capped
          // log. recentEvents() persists oldest-first, so parsed order is
          // already correct; we don't re-sort to avoid mis-handling ties.
          try {
            const parsed = JSON.parse(snapshot.eventLogJSON, reviver);
            if (Array.isArray(parsed)) {
              hydratedEvents = parsed.flatMap((e: Record<string, unknown>) => {
                if (typeof e.type !== "string") return [];
                if (e.blockNumber === undefined || e.blockNumber === null) return [];
                if (typeof e.logIndex !== "number") return [];
                let blockNumber: bigint;
                try {
                  blockNumber = BigInt(e.blockNumber as string | number | bigint);
                } catch {
                  return [];
                }
                const base = { ...e, blockNumber, logIndex: e.logIndex } as Record<
                  string,
                  unknown
                >;
                // Re-cast any other known bigint fields the bigintReplacer
                // flattened to decimal strings. Unknown extras pass through.
                for (const k of [
                  "execId",
                  "deadline",
                  "earliestCommitAt",
                ] as const) {
                  if (base[k] !== undefined && base[k] !== null && typeof base[k] !== "bigint") {
                    try {
                      base[k] = BigInt(base[k] as string | number);
                    } catch {
                      // leave as-is; the consumer will see the original value
                    }
                  }
                }
                return [base as unknown as StoreEvent];
              });
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn("snapshot eventLog parse failed", err);
          }
        }
      } catch (err) {
        // Persistence is best-effort; fall through to a cold backfill.
        // eslint-disable-next-line no-console
        console.warn("snapshot load failed", err);
      }
      if (cancelled) return;

      const nextStore = createEventStore({
        publicClient,
        chainId: somniaTestnet.id,
        oracleAddress: oracle,
        queueAddress: queue,
        oracleDeploymentBlock: ORACLE_DEPLOYMENT_BLOCK,
        startBlock,
        onProgress: (p) => onProgressRef.current?.(p),
      });
      createdStore = nextStore;

      // Inject hydrated policies + queueRecords + eventLog BEFORE wiring the
      // subscribe + init() so the maps are populated by the time the first
      // lookup happens. None of the hydrate methods emit through subscribe,
      // so we bump snapshotKey ONCE below (after all three loops) to drive
      // a single re-render instead of one per loop.
      for (const meta of hydratedPolicies) {
        nextStore.hydratePolicy(meta);
      }
      for (const { execId, record } of hydratedQueueRecords) {
        nextStore.hydrateQueueRecord(execId, record);
      }
      // eventLog is appended in array order; recentEvents() saves oldest
      // first, so iterating the parsed array preserves chronology.
      for (const event of hydratedEvents) {
        nextStore.hydrateEvent(event);
      }
      if (hydratedCursor !== undefined) {
        nextStore.hydrateCursor(hydratedCursor);
      }

      setStore(nextStore);
      unsub = nextStore.subscribe(() => {
        if (cancelled) return;
        setSnapshotKey((k) => k + 1);
        scheduleSave();
      });
      // Single bump after all hydration so consumers see the hydrated state
      // via their snapshotKey-dep effects, even though no SDK event fired
      // during hydration. Cheap; only happens once per (re)init.
      if (
        hydratedPolicies.length > 0 ||
        hydratedQueueRecords.length > 0 ||
        hydratedEvents.length > 0 ||
        hydratedCursor !== undefined
      ) {
        setSnapshotKey((k) => k + 1);
      }

      nextStore
        .init()
        .then(() => {
          if (cancelled) return;
          setReady(true);
          // init() set lastCursor=head internally but emitted no event, so
          // consumers still hold the hydrated (or 0) value. Nudge them to
          // re-read store.cursor() and persist the advanced cursor so the
          // next reload resumes from head rather than the older snapshot
          // (matters on quiet chains where no live event fires post-init).
          setSnapshotKey((k) => k + 1);
          scheduleSave();
        })
        .catch((err) => {
          if (cancelled) return;
          const e = err instanceof Error ? err : new Error(String(err));
          // Surface to console for diagnosis; the banner shows the message.
          // eslint-disable-next-line no-console
          console.error("event-store init failed", e);
          setError(e);
        });
    })();

    return () => {
      cancelled = true;
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      // Flush any pending debounced write so the latest cursor lands on disk.
      if (pendingWrite) writeNow();
      unsub?.();
      createdStore?.dispose();
      setStore(null);
      // Drop the publicClient ref so a stale refresh callback can't run
      // against a disposed network config.
      publicClientRef.current = null;
    };
  }, [rpc, oracle, queue, retryKey]);

  const retry = useMemo(() => () => setRetryKey((k) => k + 1), []);
  const bumpSnapshot = useMemo(() => () => setSnapshotKey((k) => k + 1), []);

  const runRefreshOwnerIndex = useCallback(
    async (owner: Address, fromBlockOverride?: bigint) => {
      const pc = publicClientRef.current;
      if (!store || !pc) return;
      const inflightKey = `${oracle.toLowerCase()}:${owner.toLowerCase()}`;
      if (refreshInFlightRef.current === inflightKey) return;
      refreshInFlightRef.current = inflightKey;
      // Per-scan abort controller; threaded into `lookupPoliciesByOwner`
      // so Skip stops issuing RPCs without draining the chunk queue.
      const abortController = new AbortController();
      abortScanRef.current = abortController;
      const abortToken = abortController.signal;
      // Reset rolling chunk-timing buffer for this scan so the ETA reflects
      // only this run's wall-clock latency, not the prior scan's.
      chunkTimingsMsRef.current = [];
      lastChunkAtRef.current = null;
      try {
        const existing = await loadOwnerIndexRich({
          chainId: somniaTestnet.id,
          oracleAddress: oracle,
          owner,
        });
        const head = await pc.getBlockNumber();
        // Resume from prior checkpoint when available, else from oracle
        // deployment. `fromBlockOverride` (shallow-rescan path) is clamped
        // to [ORACLE_DEPLOYMENT_BLOCK, head].
        const checkpointFrom = existing
          ? existing.lastSeenBlock + 1n > ORACLE_DEPLOYMENT_BLOCK
            ? existing.lastSeenBlock + 1n
            : ORACLE_DEPLOYMENT_BLOCK
          : ORACLE_DEPLOYMENT_BLOCK;
        let fromBlock = checkpointFrom;
        if (fromBlockOverride !== undefined) {
          const clamped =
            fromBlockOverride < ORACLE_DEPLOYMENT_BLOCK
              ? ORACLE_DEPLOYMENT_BLOCK
              : fromBlockOverride > head
                ? head
                : fromBlockOverride;
          fromBlock = clamped;
        }
        // Clear the prior collector so each scan reports failures fresh; an
        // id that succeeded last time but fails this time should appear, and
        // an id that failed last time but succeeded this time should drop.
        rehydrateFailuresRef.current = new Map();
        setOwnerIndexState({
          status: "scanning",
          scannedFromBlock: fromBlock,
          scannedToBlock: null,
          discovered: 0,
          lastSuccessAtMs: null,
          rehydrateFailures: new Map(),
          progress: null,
        });

        // Rehydrate the stale tail of the persisted ownerIndex so a cold
        // reload doesn't render empty until regular backfill catches up.
        // Rich entries carry a `publishedBlock` hint for the fast getLogs
        // path; sentinel 0n falls back to the legacy backward walk and is
        // upgraded by the saveOwnerIndexRich call below on success.
        const persistedEntries: OwnerIndexEntry[] = existing?.entries ?? [];
        const stale = persistedEntries
          .filter((entry) => !store.getPolicy(entry.policyId))
          .slice(0, OWNER_INDEX_REHYDRATE_CAP);
        // PublishBlocks recovered via stale-rehydrate. Used by the merge
        // below to upgrade sentinel (0n) entries whose publish predates
        // the tail-scan window. Keyed by lowercase policyId.
        const recoveredHints = new Map<
          string,
          { publishedBlock: bigint; lastUpdatedBlock?: bigint }
        >();
        if (stale.length > 0) {
          await runWithConcurrency(
            stale,
            OWNER_INDEX_REHYDRATE_CONCURRENCY,
            async (entry) => {
              try {
                const result = await lookupPolicyOnChain(pc, oracle, entry.policyId, {
                  publishedBlockHint:
                    entry.publishedBlock > 0n ? entry.publishedBlock : undefined,
                  lastUpdatedBlockHint: entry.lastUpdatedBlock,
                });
                // `not_found` / `rpc_error` → per-id failure; `found` → hydrate.
                if (result.kind === "not_found") {
                  rehydrateFailuresRef.current.set(entry.policyId.toLowerCase(), {
                    policyId: entry.policyId,
                    errorMessage:
                      "Could not recover policy from chain (chain returned no owner or scan window exhausted).",
                    lastAttemptAtMs: nowMs(),
                  });
                  return;
                }
                if (result.kind === "rpc_error") {
                  rehydrateFailuresRef.current.set(entry.policyId.toLowerCase(), {
                    policyId: entry.policyId,
                    errorMessage: result.error.message,
                    lastAttemptAtMs: nowMs(),
                  });
                  return;
                }
                const snap = result.policy;
                // Forward `labelRecovered` so a `found-no-label` rehydrate
                // doesn't suppress the "label not recoverable" badge.
                store.hydratePolicyAndPersist({
                  policyId: snap.policyId,
                  owner: snap.publisher,
                  label: snap.labelHex,
                  labelRecovered: snap.kind === "found-with-label",
                  publishedBlock: snap.publishBlock,
                  lastUpdatedBlock: snap.publishBlock ?? 0n,
                });
                // Record recovered publishBlock for the merge below;
                // leave sentinel intact when none was recovered.
                if (snap.publishBlock !== undefined && snap.publishBlock > 0n) {
                  recoveredHints.set(entry.policyId.toLowerCase(), {
                    publishedBlock: snap.publishBlock,
                  });
                }
              } catch (err) {
                // Record per-id failure so the UI can surface it with a retry
                // button. Writing into the ref (not state) avoids a setState
                // storm during a 50-id burst — the snapshot into state
                // happens once at the end of refreshOwnerIndex.
                rehydrateFailuresRef.current.set(entry.policyId.toLowerCase(), {
                  policyId: entry.policyId,
                  errorMessage: err instanceof Error ? err.message : String(err),
                  lastAttemptAtMs: nowMs(),
                });
              }
            },
          );
        }

        const result = await lookupPoliciesByOwner({
          publicClient: pc,
          oracleAddress: oracle,
          owner,
          fromBlock,
          toBlock: head,
          // Cooperative cancellation: the chunker polls this signal at
          // the top of every chunk and stops the walk when set. Without
          // this, Skip would only suppress UI updates while the prior
          // scan's chunk queue kept hammering RPC for another ~10 min.
          signal: abortController.signal,
          onProgress: (info: LookupPoliciesByOwnerProgress) => {
            // Drop progress updates from a scan the user has skipped.
            // The shallow-rescan path aborts the live controller; emitting
            // a stale progress payload would briefly flash old numbers
            // over the new scan's UI.
            if (abortToken.aborted) return;
            const tNow = nowMs();
            if (lastChunkAtRef.current !== null) {
              const dt = tNow - lastChunkAtRef.current;
              chunkTimingsMsRef.current.push(dt);
              if (chunkTimingsMsRef.current.length > ETA_WINDOW) {
                chunkTimingsMsRef.current.shift();
              }
            }
            lastChunkAtRef.current = tNow;
            const chunksRemaining = Math.max(0, info.totalChunks - info.chunkIdx);
            const estRemainingMs = estimateRemainingMs(
              chunkTimingsMsRef.current,
              chunksRemaining,
            );
            setOwnerIndexState((prev) => ({
              ...prev,
              progress: {
                chunkIdx: info.chunkIdx,
                totalChunks: info.totalChunks,
                scannedToBlock: info.scannedToBlock,
                // Forward chain `head` for the UI's "of Y" denominator
                // (more useful than the reorg-trimmed safe upper bound).
                targetToBlock: head,
                foundCount: info.foundCount,
                estRemainingMs,
              },
            }));
          },
        });
        // If a `refreshOwnerIndexShallow` call superseded this scan
        // mid-flight, drop the result on the floor: the new scan will
        // produce its own (more correct) result with the user-requested
        // fromBlock, and writing this stale result into the ownerIndex
        // would just race the new one.
        if (abortToken.aborted) return;

        // Hydrate every newly-discovered policy into the EventStore from the
        // already-decoded PolicyPublished log args. Zero extra RPC.
        const known = new Set(persistedEntries.map((e) => e.policyId.toLowerCase()));
        let newCount = 0;
        for (const meta of result.policies) {
          if (!known.has(meta.policyId.toLowerCase())) newCount += 1;
          // `labelRecovered: true` unconditionally: bytes came from the
          // decoded event, so all-zero is the REAL label.
          store.hydratePolicyAndPersist({
            policyId: meta.policyId,
            owner: meta.publisher,
            label: meta.labelHex,
            labelRecovered: true,
            publishedBlock: meta.publishBlock,
            // lastUpdatedBlock starts at publishBlock; live watcher advances it.
            lastUpdatedBlock: meta.publishBlock,
          });
        }

        // Merge rich entries in priority order: persistedEntries (seed) <
        // tail-scan results < stale-rehydrate recoveries. Sentinels
        // (publishedBlock === 0n) are upgradeable; real values stay put.
        const mergedEntries = new Map<string, OwnerIndexEntry>();
        for (const e of persistedEntries) {
          mergedEntries.set(e.policyId.toLowerCase(), e);
        }
        for (const meta of result.policies) {
          const k = meta.policyId.toLowerCase();
          const prior = mergedEntries.get(k);
          // Upgrade the sentinel (publishedBlock=0n) or insert fresh; if
          // we already have a real publishedBlock, leave it alone so a
          // re-decoded log with the same data is a no-op.
          if (!prior || prior.publishedBlock === 0n) {
            mergedEntries.set(k, {
              policyId: meta.policyId,
              publishedBlock: meta.publishBlock,
              lastUpdatedBlock: prior?.lastUpdatedBlock ?? meta.publishBlock,
            });
          }
        }
        // Apply hints last to upgrade sentinels the tail scan didn't reach.
        for (const [k, hint] of recoveredHints) {
          const prior = mergedEntries.get(k);
          if (!prior) continue;
          if (prior.publishedBlock === 0n) {
            mergedEntries.set(k, {
              policyId: prior.policyId,
              publishedBlock: hint.publishedBlock,
              lastUpdatedBlock:
                prior.lastUpdatedBlock ?? hint.lastUpdatedBlock ?? hint.publishedBlock,
            });
          }
        }
        await saveOwnerIndexRich({
          chainId: somniaTestnet.id,
          oracleAddress: oracle,
          owner,
          value: {
            entries: [...mergedEntries.values()],
            lastSeenBlock: result.scannedToBlock,
          },
        });

        setOwnerIndexState({
          status: "done",
          scannedFromBlock: fromBlock,
          scannedToBlock: result.scannedToBlock,
          discovered: newCount,
          lastSuccessAtMs: nowMs(),
          // Snapshot the collector into state ONCE so React renders the
          // failures section. New Map() copy so a later ref mutation can't
          // mutate the rendered state.
          rehydrateFailures: new Map(rehydrateFailuresRef.current),
          // Scan completed — clear the progress payload so the UI drops
          // back to the "done" branch without a stale chunk counter.
          progress: null,
        });
      } catch (err) {
        if (abortToken.aborted) return;
        setOwnerIndexState((prev) => ({
          status: "error",
          scannedFromBlock: prev.scannedFromBlock,
          scannedToBlock: prev.scannedToBlock,
          discovered: 0,
          lastSuccessAtMs: prev.lastSuccessAtMs,
          error: err instanceof Error ? err.message : String(err),
          // Even when the OUTER scan failed, per-id rehydrate failures that
          // occurred before the failure are still useful signal — surface
          // them so the user can retry the individual ids.
          rehydrateFailures: new Map(rehydrateFailuresRef.current),
          progress: null,
        }));
      } finally {
        if (refreshInFlightRef.current === inflightKey) {
          refreshInFlightRef.current = null;
        }
        if (abortScanRef.current === abortController) {
          abortScanRef.current = null;
        }
      }
    },
    [oracle, store],
  );

  const refreshOwnerIndex = useCallback(
    (owner: Address) => runRefreshOwnerIndex(owner),
    [runRefreshOwnerIndex],
  );

  const refreshOwnerIndexShallow = useCallback(
    async (owner: Address, skipBlocks: bigint) => {
      // Compute fromBlock = head - skipBlocks (anchored on chain head).
      const pc = publicClientRef.current;
      if (!pc) return;
      const head = await pc.getBlockNumber();
      const fromBlockOverride = head > skipBlocks ? head - skipBlocks : 0n;
      // When Shannon is younger than the skip window, `fromBlockOverride`
      // clamps back to `ORACLE_DEPLOYMENT_BLOCK` inside
      // `runRefreshOwnerIndex` and Skip would re-walk the entire chain —
      // exactly what the in-flight scan was already doing. Aborting +
      // restarting in that case would throw away progress for zero
      // benefit, so bail out and let the existing scan run to completion.
      if (fromBlockOverride <= ORACLE_DEPLOYMENT_BLOCK) {
        // eslint-disable-next-line no-console
        console.warn(
          "refreshOwnerIndexShallow: Skip would not shorten the scan (chain is younger than skip window); leaving existing scan running.",
        );
        return;
      }
      // Abort the in-flight scan (if any) and clear the inflight key so
      // the new scan can re-enter `runRefreshOwnerIndex` past the guard.
      const current = abortScanRef.current;
      if (current) current.abort();
      refreshInFlightRef.current = null;
      await runRefreshOwnerIndex(owner, fromBlockOverride);
    },
    [runRefreshOwnerIndex],
  );

  /**
   * Retry a single previously-failed stale rehydrate. Drives an in-place
   * update of `ownerIndexState.rehydrateFailures` so the row can show a
   * spinner, then either drops the entry (success) or refreshes it with
   * the latest error + timestamp (failure).
   */
  const retryRehydrate = useCallback(
    async (policyId: Hex) => {
      const pc = publicClientRef.current;
      if (!store || !pc) return;
      const key = policyId.toLowerCase();
      const existing = rehydrateFailuresRef.current.get(key);
      if (!existing) return;
      // Synchronous in-flight guard via the ref: catches click bursts
      // that fire before React re-renders the disabled button.
      if (existing.inFlight === true) return;
      // Mark in-flight in BOTH the ref (truth) and a snapshot into state
      // (drives the UI spinner).
      rehydrateFailuresRef.current.set(key, { ...existing, inFlight: true });
      setOwnerIndexState((prev) => ({
        ...prev,
        rehydrateFailures: new Map(rehydrateFailuresRef.current),
      }));
      try {
        // No publishedBlock hint available here (owner not in scope);
        // falls back to the legacy backward walk.
        const result = await lookupPolicyOnChain(pc, oracle, policyId);
        if (result.kind === "not_found") {
          // Non-retryable: drop the failure (ownerIndex entry is kept).
          rehydrateFailuresRef.current.delete(key);
        } else if (result.kind === "rpc_error") {
          // Refresh the failure record with the latest error + timestamp.
          rehydrateFailuresRef.current.set(key, {
            policyId,
            errorMessage: result.error.message,
            lastAttemptAtMs: nowMs(),
          });
        } else {
          const snap = result.policy;
          store.hydratePolicyAndPersist({
            policyId: snap.policyId,
            owner: snap.publisher,
            label: snap.labelHex,
            labelRecovered: snap.kind === "found-with-label",
            publishedBlock: snap.publishBlock,
            lastUpdatedBlock: snap.publishBlock ?? 0n,
          });
          rehydrateFailuresRef.current.delete(key);
        }
      } catch (err) {
        rehydrateFailuresRef.current.set(key, {
          policyId,
          errorMessage: err instanceof Error ? err.message : String(err),
          lastAttemptAtMs: nowMs(),
        });
      } finally {
        setOwnerIndexState((prev) => ({
          ...prev,
          rehydrateFailures: new Map(rehydrateFailuresRef.current),
        }));
      }
    },
    [oracle, store],
  );

  /**
   * Retry all currently-surfaced rehydrate failures, bounded by the same
   * concurrency cap as the initial burst so a "retry all" click can't
   * trip rate limits the single-shot burst already respects.
   */
  const retryAllRehydrates = useCallback(async () => {
    const ids = Array.from(rehydrateFailuresRef.current.values()).map(
      (f) => f.policyId,
    );
    if (ids.length === 0) return;
    await runWithConcurrency(ids, OWNER_INDEX_REHYDRATE_CONCURRENCY, (id) =>
      retryRehydrate(id),
    );
  }, [retryRehydrate]);

  /**
   * Thin wrapper around `loadOwnerIndexRich` that returns just the entries
   * array. MyPoliciesPanel calls this to compute the "ownerIndex ∪
   * in-memory" union of rows it renders. Empty array on miss (no
   * persisted index yet) so callers can treat the response uniformly.
   */
  const loadOwnerIndexEntries = useCallback(
    async (owner: Address): Promise<OwnerIndexEntry[]> => {
      const rich = await loadOwnerIndexRich({
        chainId: somniaTestnet.id,
        oracleAddress: oracle,
        owner,
      });
      return rich?.entries ?? [];
    },
    [oracle],
  );

  /** Single-id rehydrate for MyPoliciesPanel loading rows: per-id dedupe +
   *  global concurrency cap, failures land in rehydrateFailures. */
  const rehydrateMissing = useCallback(
    async (owner: Address, policyId: Hex): Promise<void> => {
      const pc = publicClientRef.current;
      if (!store || !pc) return;
      const key = policyId.toLowerCase();
      if (rehydrateInFlightIdsRef.current.has(key)) return;
      if (store.getPolicy(policyId)) return;
      rehydrateInFlightIdsRef.current.add(key);
      // Wait for a FIFO slot in the global concurrency window
      // (OWNER_INDEX_REHYDRATE_CONCURRENCY).
      await new Promise<void>((resolve) => {
        const start = () => {
          rehydrateActiveCountRef.current += 1;
          resolve();
        };
        if (rehydrateActiveCountRef.current < OWNER_INDEX_REHYDRATE_CONCURRENCY) {
          start();
        } else {
          rehydrateQueueRef.current.push(start);
        }
      });
      try {
        // Pull the cached publishBlock hint when present so the fast
        // path (single-block getLogs) wins over the legacy backward
        // walk. A sentinel (publishedBlock===0n) means the persisted
        // entry doesn't know the publish block; fall through with no
        // hint and let lookupPolicyOnChain take the slow path.
        let publishedBlockHint: bigint | undefined;
        let lastUpdatedBlockHint: bigint | undefined;
        try {
          const rich = await loadOwnerIndexRich({
            chainId: somniaTestnet.id,
            oracleAddress: oracle,
            owner,
          });
          const entry = rich?.entries.find(
            (e) => e.policyId.toLowerCase() === key,
          );
          if (entry) {
            if (entry.publishedBlock > 0n) publishedBlockHint = entry.publishedBlock;
            lastUpdatedBlockHint = entry.lastUpdatedBlock;
          }
        } catch {
          // Hint lookup is best-effort; fall through with no hint.
        }
        const result = await lookupPolicyOnChain(pc, oracle, policyId, {
          publishedBlockHint,
          lastUpdatedBlockHint,
        });
        if (result.kind === "not_found") {
          // Record a failure so the row gets a retry button instead of
          // staying "loading" forever.
          rehydrateFailuresRef.current.set(key, {
            policyId,
            errorMessage:
              "Could not recover policy from chain (chain returned no owner or scan window exhausted).",
            lastAttemptAtMs: nowMs(),
          });
          setOwnerIndexState((prev) => ({
            ...prev,
            rehydrateFailures: new Map(rehydrateFailuresRef.current),
          }));
          return;
        }
        if (result.kind === "rpc_error") {
          rehydrateFailuresRef.current.set(key, {
            policyId,
            errorMessage: result.error.message,
            lastAttemptAtMs: nowMs(),
          });
          setOwnerIndexState((prev) => ({
            ...prev,
            rehydrateFailures: new Map(rehydrateFailuresRef.current),
          }));
          return;
        }
        const snap = result.policy;
        store.hydratePolicyAndPersist({
          policyId: snap.policyId,
          owner: snap.publisher,
          label: snap.labelHex,
          labelRecovered: snap.kind === "found-with-label",
          publishedBlock: snap.publishBlock,
          lastUpdatedBlock: snap.publishBlock ?? 0n,
        });
        // Clear any prior failure for this id — we just recovered it.
        if (rehydrateFailuresRef.current.delete(key)) {
          setOwnerIndexState((prev) => ({
            ...prev,
            rehydrateFailures: new Map(rehydrateFailuresRef.current),
          }));
        }
      } catch (err) {
        rehydrateFailuresRef.current.set(key, {
          policyId,
          errorMessage: err instanceof Error ? err.message : String(err),
          lastAttemptAtMs: nowMs(),
        });
        setOwnerIndexState((prev) => ({
          ...prev,
          rehydrateFailures: new Map(rehydrateFailuresRef.current),
        }));
      } finally {
        rehydrateInFlightIdsRef.current.delete(key);
        // Release the concurrency slot and dispatch the next queued
        // worker (if any). Always decrement first so the next worker
        // sees an accurate `activeCount` when it checks the gate.
        rehydrateActiveCountRef.current -= 1;
        const next = rehydrateQueueRef.current.shift();
        if (next) next();
      }
    },
    [oracle, store],
  );

  const value = useMemo<EventStoreContextValue>(
    () => ({
      store,
      ready,
      progress,
      snapshotKey,
      error,
      retry,
      bumpSnapshot,
      refreshOwnerIndex,
      refreshOwnerIndexShallow,
      approxBlocksPer24Hours: APPROX_24H_BLOCKS,
      ownerIndexState,
      retryRehydrate,
      retryAllRehydrates,
      loadOwnerIndexEntries,
      rehydrateMissing,
    }),
    [
      store,
      ready,
      progress,
      snapshotKey,
      error,
      retry,
      bumpSnapshot,
      refreshOwnerIndex,
      refreshOwnerIndexShallow,
      ownerIndexState,
      retryRehydrate,
      retryAllRehydrates,
      loadOwnerIndexEntries,
      rehydrateMissing,
    ],
  );

  return <EventStoreContext.Provider value={value}>{children}</EventStoreContext.Provider>;
}

export function useEventStore(): EventStoreContextValue {
  const ctx = useContext(EventStoreContext);
  if (!ctx) throw new Error("useEventStore must be used inside <EventStoreProvider>");
  return ctx;
}
