import { type Address, type Hex, type PublicClient } from "viem";
import { WARD_ORACLE_ABI, WARD_QUEUE_ABI } from "./abi.js";
import { createOracleClient, type OracleClient } from "./oracle-client.js";
import { createQueueClient, type QueueClient, type QueueRecordHeader } from "./queue-client.js";

export interface PolicyMeta {
  policyId: Hex;
  owner: Address;
  /** Bytes32 label passed to `publishPolicy`; consult `labelRecovered` before decoding placeholders. */
  label?: Hex;
  /** False means `label` is a fallback placeholder, not a recoverable on-chain label. */
  labelRecovered?: boolean;
  /** Pending nominee from `PolicyOwnershipTransferStarted`, if any. */
  pendingOwner?: Address;
  publishedBlock?: bigint;
  lastUpdatedBlock: bigint;
}

export type StoreEventType =
  | "PolicyPublished"
  | "PolicyUpdated"
  | "OwnershipTransferStarted"
  | "OwnershipTransferred"
  | "OwnershipTransferCancelled"
  | "Enqueued"
  | "Dispatched"
  | "Vetoed"
  | "Expired";

/** Synthetic persistence signal emitted by `emitSnapshotUpdated()` and `*AndPersist` hydrators. */
export interface SnapshotUpdatedEvent {
  type: "snapshotUpdated";
}

export interface PolicyStoreEvent {
  type: "PolicyPublished" | "PolicyUpdated";
  policyId: Hex;
  owner: Address;
  /** Only present on PolicyPublished. */
  label?: Hex;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
}

export interface OwnershipTransferStartedEvent {
  type: "OwnershipTransferStarted";
  policyId: Hex;
  currentOwner: Address;
  pendingOwner: Address;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
}

export interface OwnershipTransferredEvent {
  type: "OwnershipTransferred";
  policyId: Hex;
  previousOwner: Address;
  newOwner: Address;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
}

export interface OwnershipTransferCancelledEvent {
  type: "OwnershipTransferCancelled";
  policyId: Hex;
  currentOwner: Address;
  cancelledNominee: Address;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
}

export type OwnershipStoreEvent =
  | OwnershipTransferStartedEvent
  | OwnershipTransferredEvent
  | OwnershipTransferCancelledEvent;

export interface QueueStoreEvent {
  type: "Enqueued" | "Dispatched" | "Vetoed" | "Expired";
  execId: bigint;
  policyId: Hex;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
  /** Enqueued only. */
  asker?: Address;
  tier?: number;
  earliestCommitAt?: bigint;
  deadline?: bigint;
  calldataHash?: Hex;
  /** Dispatched only. */
  dispatcher?: Address;
  intentHash?: Hex;
  /** Vetoed only. */
  reason?: Hex;
}

export type StoreEvent = PolicyStoreEvent | OwnershipStoreEvent | QueueStoreEvent;

export interface BackfillProgress {
  phase: "policy-events" | "queue-events" | "header-hydration" | "live";
  /** Blocks processed so far in THIS phase (relative; 0..total). */
  current: bigint;
  /** Total blocks this phase will scan (relative). */
  total: bigint;
  /** Absolute range for block-scanning phases. */
  fromBlock?: bigint;
  headBlock?: bigint;
  /** Optional human-readable hint. */
  message?: string;
}

export interface EventStoreConfig {
  publicClient: PublicClient;
  oracleAddress: Address;
  queueAddress: Address;
  /** Informational namespace for consumers; unused by the store. */
  chainId?: number;
  /** Deepest block to scan for policy events; pass the real deployment block for full policy history. */
  oracleDeploymentBlock?: bigint;
  /** How many blocks back to scan for queue events. Default: ~7 days at 1s blocks. */
  queueLookbackBlocks?: bigint;
  /** Chunk size for getLogs. Default 2000 (public RPCs often cap at 10k). */
  chunkSize?: bigint;
  /** Cap on retained chronological events. Default 2000. */
  eventLogCap?: number;
  /** Lower bound for resumed backfills; the SDK does not persist snapshots itself. */
  startBlock?: bigint;
  /** Optional progress callback for the backfill. */
  onProgress?: (p: BackfillProgress) => void;
}

export interface EventStore {
  readonly oracleClient: OracleClient;
  readonly queueClient: QueueClient;

  /** Returns when backfill completes; live watch continues running. */
  init(): Promise<void>;

  /** Stop live watch + free resources. Safe to call multiple times. */
  dispose(): void;

  /** Subscribe to chain events and `snapshotUpdated` synthetics; returns an unsubscribe function. */
  subscribe(handler: (event: StoreEvent) => void): () => void;

  /** Snapshot of all known policies, in publish-block order. */
  listPolicies(): PolicyMeta[];
  getPolicy(policyId: Hex): PolicyMeta | undefined;

  /** Filter `listPolicies()` by owner with a case-insensitive linear scan. */
  listPoliciesByOwner(owner: Address): PolicyMeta[];

  /**
   * Insert persisted policy state without emitting. Existing live-derived records win;
   * call `hydratePolicyAndPersist` or `emitSnapshotUpdated()` when subscribers should flush.
   */
  hydratePolicy(meta: PolicyMeta): void;

  /** Same as `hydratePolicy`, but emits `snapshotUpdated` for subscribe-driven persistence. */
  hydratePolicyAndPersist(meta: PolicyMeta): void;

  /** Snapshot of all known queue records (Pending + terminal), in execId order. */
  listQueueRecords(): QueueRecordHeader[];
  getQueueRecord(execId: bigint): QueueRecordHeader | undefined;

  /** Insert a persisted queue record without emitting; see `hydratePolicy`. */
  hydrateQueueRecord(execId: bigint, record: QueueRecordHeader): void;

  /** Same as `hydrateQueueRecord`, but emits `snapshotUpdated`. */
  hydrateQueueRecordAndPersist(execId: bigint, record: QueueRecordHeader): void;

  /** Pending records only. Convenience for "what's actionable right now". */
  listPending(): QueueRecordHeader[];

  /** Pending records paired with queue `execId`; `record.requestId` is not interchangeable. */
  listPendingWithExecIds(): Array<{ execId: bigint; record: QueueRecordHeader }>;

  /** Most recent N events in chronological order (oldest first). */
  recentEvents(limit?: number): StoreEvent[];

  /** Append one persisted event without emitting; caller supplies chronological order and handles dedup. */
  hydrateEvent(event: StoreEvent): void;

  /** Same as `hydrateEvent`, but emits `snapshotUpdated`. */
  hydrateEventAndPersist(event: StoreEvent): void;

  /** Emit one `snapshotUpdated` signal after a batch of no-emit hydrate calls. */
  emitSnapshotUpdated(): void;

  /** Current store cursor (last processed block; may lag head by up to one chunk). */
  cursor(): bigint;

  /**
   * Seed the cursor from a persisted snapshot on reload so `cursor()` reports
   * the last-known indexed block immediately instead of 0 until `init()` runs.
   * Monotonic: only advances, never rewinds (a stale snapshot must not pull a
   * live or already-initialized store backwards).
   */
  hydrateCursor(block: bigint): void;
}

// Fuji testnet RPC caps eth_getLogs at 1000 blocks. Empirically the call
// fails with "block range exceeds 1000" above that. Keep the default at 1000
// to work out of the box; consumers on an unrestricted RPC can pass a larger
// chunkSize via config.
const DEFAULT_CHUNK = 1000n;
const DEFAULT_QUEUE_LOOKBACK = 604800n; // ~7 days at 1s blocks
const DEFAULT_EVENT_LOG_CAP = 2000;

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function createEventStore(config: EventStoreConfig): EventStore {
  const {
    publicClient,
    oracleAddress,
    queueAddress,
    onProgress,
  } = config;
  const chunkSize = config.chunkSize ?? DEFAULT_CHUNK;
  const queueLookback = config.queueLookbackBlocks ?? DEFAULT_QUEUE_LOOKBACK;
  const eventLogCap = config.eventLogCap ?? DEFAULT_EVENT_LOG_CAP;

  const oracleClient = createOracleClient({ publicClient, oracleAddress });
  const queueClient = createQueueClient({ publicClient, queueAddress });

  const policies = new Map<Hex, PolicyMeta>();
  const queueRecords = new Map<bigint, QueueRecordHeader>();
  const eventLog: StoreEvent[] = [];
  const subscribers = new Set<(e: StoreEvent) => void>();
  let lastCursor = 0n;
  const unwatchFns: Array<() => void> = [];
  let disposed = false;

  function emit(event: StoreEvent) {
    eventLog.push(event);
    if (eventLog.length > eventLogCap) eventLog.shift();
    for (const handler of subscribers) {
      try {
        handler(event);
      } catch {
        // A buggy subscriber must not break the store.
      }
    }
  }

  // Synthetic persistence signals must not be appended to the chain event log.
  function emitSynthetic() {
    const ev: SnapshotUpdatedEvent = { type: "snapshotUpdated" };
    for (const handler of subscribers) {
      try {
        handler(ev as unknown as StoreEvent);
      } catch {
        // A buggy subscriber must not break the store.
      }
    }
  }

  function applyPolicyEvent(e: PolicyStoreEvent) {
    const existing = policies.get(e.policyId);
    if (e.type === "PolicyPublished") {
      policies.set(e.policyId, {
        policyId: e.policyId,
        owner: e.owner,
        label: e.label,
        // Even an empty bytes32 label is recoverable when decoded from the publish log.
        labelRecovered: true,
        pendingOwner: existing?.pendingOwner,
        publishedBlock: e.blockNumber,
        lastUpdatedBlock: e.blockNumber,
      });
    } else {
      policies.set(e.policyId, {
        policyId: e.policyId,
        owner: e.owner,
        label: existing?.label,
        labelRecovered: existing?.labelRecovered,
        pendingOwner: existing?.pendingOwner,
        publishedBlock: existing?.publishedBlock,
        lastUpdatedBlock: e.blockNumber,
      });
    }
    emit(e);
  }

  function applyOwnershipEvent(e: OwnershipStoreEvent) {
    const existing = policies.get(e.policyId);
    if (e.type === "OwnershipTransferStarted") {
      if (existing) {
        policies.set(e.policyId, {
          ...existing,
          pendingOwner: e.pendingOwner,
          lastUpdatedBlock: e.blockNumber,
        });
      } else {
        // Seed a minimal record when the publish event was outside the backfill window.
        policies.set(e.policyId, {
          policyId: e.policyId,
          owner: e.currentOwner,
          pendingOwner: e.pendingOwner,
          lastUpdatedBlock: e.blockNumber,
        });
      }
    } else if (e.type === "OwnershipTransferred") {
      if (existing) {
        policies.set(e.policyId, {
          ...existing,
          owner: e.newOwner,
          pendingOwner: undefined,
          lastUpdatedBlock: e.blockNumber,
        });
      } else {
        policies.set(e.policyId, {
          policyId: e.policyId,
          owner: e.newOwner,
          pendingOwner: undefined,
          lastUpdatedBlock: e.blockNumber,
        });
      }
    } else {
      if (existing) {
        policies.set(e.policyId, {
          ...existing,
          pendingOwner: undefined,
          lastUpdatedBlock: e.blockNumber,
        });
      } else {
        policies.set(e.policyId, {
          policyId: e.policyId,
          owner: e.currentOwner,
          pendingOwner: undefined,
          lastUpdatedBlock: e.blockNumber,
        });
      }
    }
    emit(e);
  }

  function decodeOwnershipLog(log: {
    eventName: string;
    args: Record<string, unknown>;
    blockNumber: bigint;
    logIndex: number;
    transactionHash: Hex;
  }): OwnershipStoreEvent | undefined {
    const base = {
      policyId: log.args.policyId as Hex,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      transactionHash: log.transactionHash,
    };
    switch (log.eventName) {
      case "PolicyOwnershipTransferStarted":
        return {
          ...base,
          type: "OwnershipTransferStarted",
          currentOwner: log.args.currentOwner as Address,
          pendingOwner: log.args.pendingOwner as Address,
        };
      case "PolicyOwnershipTransferred":
        return {
          ...base,
          type: "OwnershipTransferred",
          previousOwner: log.args.previousOwner as Address,
          newOwner: log.args.newOwner as Address,
        };
      case "PolicyOwnershipTransferCancelled":
        return {
          ...base,
          type: "OwnershipTransferCancelled",
          currentOwner: log.args.currentOwner as Address,
          cancelledNominee: log.args.cancelledPendingOwner as Address,
        };
      default:
        return undefined;
    }
  }

  function applyQueueEvent(e: QueueStoreEvent) {
    emit(e);
    // Fire-and-forget hydration keeps queue headers fresh without emitting synthetic chain events.
    hydrateRecord(e.execId).catch(() => {
      // RPC blip; skip silently. The next event will retry.
    });
  }

  async function hydrateRecord(execId: bigint): Promise<void> {
    if (disposed) return;
    try {
      const header = await queueClient.getRecordHeader(execId);
      // Avoid post-dispose writes after the RPC await.
      if (disposed) return;
      queueRecords.set(execId, header);
    } catch {
      // Record may not exist (None state); leave map untouched.
    }
  }

  async function backfillPolicyEvents(headBlock: bigint): Promise<void> {
    const defaultFrom = config.oracleDeploymentBlock ?? (headBlock > queueLookback ? headBlock - queueLookback : 0n);
    const fromBlock = max(defaultFrom, config.startBlock ?? 0n);
    const totalSpan = headBlock - fromBlock;
    let from = fromBlock;
    let processed = 0n;

    while (from <= headBlock) {
      if (disposed) return;
      const to = from + chunkSize - 1n > headBlock ? headBlock : from + chunkSize - 1n;
      const logs = await publicClient.getContractEvents({
        address: oracleAddress,
        abi: WARD_ORACLE_ABI as never,
        fromBlock: from,
        toBlock: to,
      });
      // Ownership events must apply chronologically or `pendingOwner` can become stale.
      const sortedLogs = (logs as unknown as Array<{
        eventName: string;
        args: Record<string, unknown>;
        blockNumber: bigint;
        logIndex: number;
        transactionHash: Hex;
      }>)
        .slice()
        .sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
      for (const log of sortedLogs) {
        if (log.eventName === "PolicyPublished" || log.eventName === "PolicyUpdated") {
          applyPolicyEvent({
            type: log.eventName,
            policyId: log.args.policyId as Hex,
            owner: log.args.owner as Address,
            label: log.args.label as Hex | undefined,
            blockNumber: log.blockNumber,
            logIndex: log.logIndex,
            transactionHash: log.transactionHash,
          });
        } else {
          const ownership = decodeOwnershipLog(log);
          if (ownership) applyOwnershipEvent(ownership);
        }
      }
      processed = to - fromBlock + 1n;
      onProgress?.({ phase: "policy-events", current: processed, total: totalSpan + 1n, fromBlock, headBlock });
      from = to + 1n;
    }
  }

  async function backfillQueueEvents(headBlock: bigint): Promise<bigint[]> {
    const defaultFrom = headBlock > queueLookback ? headBlock - queueLookback : 0n;
    const fromBlock = max(defaultFrom, config.startBlock ?? 0n);
    const totalSpan = headBlock - fromBlock;
    let from = fromBlock;
    let processed = 0n;
    const pendingHydrate: Set<bigint> = new Set();

    while (from <= headBlock) {
      if (disposed) return [];
      const to = from + chunkSize - 1n > headBlock ? headBlock : from + chunkSize - 1n;
      const logs = await publicClient.getContractEvents({
        address: queueAddress,
        abi: WARD_QUEUE_ABI as never,
        fromBlock: from,
        toBlock: to,
      });
      for (const log of logs as unknown as Array<{
        eventName: string;
        args: Record<string, unknown>;
        blockNumber: bigint;
        logIndex: number;
        transactionHash: Hex;
      }>) {
        const e = decodeQueueLog(log);
        if (!e) continue;
        // Backfill records events silently and batches header hydration at the end.
        eventLog.push(e);
        if (eventLog.length > eventLogCap) eventLog.shift();
        if (e.type === "Enqueued") pendingHydrate.add(e.execId);
        // Terminal events also need re-hydration because record state changed.
        if (e.type === "Dispatched" || e.type === "Vetoed" || e.type === "Expired") {
          pendingHydrate.add(e.execId);
        }
      }
      processed = to - fromBlock + 1n;
      onProgress?.({ phase: "queue-events", current: processed, total: totalSpan + 1n, fromBlock, headBlock });
      from = to + 1n;
    }
    return [...pendingHydrate].sort((a, b) => (a < b ? -1 : 1));
  }

  function decodeQueueLog(log: {
    eventName: string;
    args: Record<string, unknown>;
    blockNumber: bigint;
    logIndex: number;
    transactionHash: Hex;
  }): QueueStoreEvent | undefined {
    const base = {
      execId: log.args.execId as bigint,
      policyId: log.args.policyId as Hex,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      transactionHash: log.transactionHash,
    };
    switch (log.eventName) {
      case "Enqueued":
        return {
          ...base,
          type: "Enqueued",
          asker: log.args.asker as Address,
          tier: Number(log.args.tier),
          earliestCommitAt: log.args.earliestCommitAt as bigint,
          deadline: log.args.deadline as bigint,
          calldataHash: log.args.calldataHash as Hex,
        };
      case "Dispatched":
        return {
          ...base,
          type: "Dispatched",
          dispatcher: log.args.dispatcher as Address,
          intentHash: log.args.intentHash as Hex,
        };
      case "Vetoed":
        return {
          ...base,
          type: "Vetoed",
          reason: log.args.reason as Hex,
        };
      case "Expired":
        return { ...base, type: "Expired" };
      default:
        return undefined;
    }
  }

  async function hydrateAll(execIds: bigint[]): Promise<void> {
    let i = 0;
    for (const execId of execIds) {
      if (disposed) return;
      await hydrateRecord(execId);
      i += 1;
      onProgress?.({ phase: "header-hydration", current: BigInt(i), total: BigInt(execIds.length) });
    }
  }

  function startLiveWatch(fromBlock: bigint) {
    const unwatchOracle = publicClient.watchContractEvent({
      address: oracleAddress,
      abi: WARD_ORACLE_ABI as never,
      fromBlock,
      onLogs: (logs: unknown) => {
        for (const log of logs as Array<{
          eventName: string;
          args: Record<string, unknown>;
          blockNumber: bigint;
          logIndex: number;
          transactionHash: Hex;
        }>) {
          if (log.eventName === "PolicyPublished" || log.eventName === "PolicyUpdated") {
            applyPolicyEvent({
              type: log.eventName,
              policyId: log.args.policyId as Hex,
              owner: log.args.owner as Address,
              label: log.args.label as Hex | undefined,
              blockNumber: log.blockNumber,
              logIndex: log.logIndex,
              transactionHash: log.transactionHash,
            });
          } else {
            const ownership = decodeOwnershipLog(log);
            if (ownership) applyOwnershipEvent(ownership);
          }
          if (log.blockNumber > lastCursor) lastCursor = log.blockNumber;
        }
      },
    });
    const unwatchQueue = publicClient.watchContractEvent({
      address: queueAddress,
      abi: WARD_QUEUE_ABI as never,
      fromBlock,
      onLogs: (logs: unknown) => {
        for (const log of logs as Array<{
          eventName: string;
          args: Record<string, unknown>;
          blockNumber: bigint;
          logIndex: number;
          transactionHash: Hex;
        }>) {
          const e = decodeQueueLog(log);
          if (e) applyQueueEvent(e);
          if (log.blockNumber > lastCursor) lastCursor = log.blockNumber;
        }
      },
    });
    unwatchFns.push(unwatchOracle, unwatchQueue);
  }

  return {
    oracleClient,
    queueClient,

    async init() {
      if (disposed) throw new Error("event-store: disposed");
      const head = await publicClient.getBlockNumber();
      lastCursor = head;
      onProgress?.({ phase: "queue-events", current: 0n, total: 0n, message: "starting" });
      const toHydrate = await backfillQueueEvents(head);
      await hydrateAll(toHydrate);
      await backfillPolicyEvents(head);
      // Start after the backfilled head so the boundary block is not processed twice.
      startLiveWatch(head + 1n);
      onProgress?.({ phase: "live", current: 1n, total: 1n, message: "ready" });
    },

    dispose() {
      disposed = true;
      for (const u of unwatchFns) {
        try {
          u();
        } catch {
          // Ignore unwatch failures during cleanup.
        }
      }
      unwatchFns.length = 0;
      subscribers.clear();
    },

    subscribe(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },

    hydratePolicy(meta) {
      // Existing live-derived entries win over persisted snapshots.
      if (policies.has(meta.policyId)) return;
      policies.set(meta.policyId, { ...meta });
    },

    hydratePolicyAndPersist(meta) {
      const had = policies.has(meta.policyId);
      if (!had) policies.set(meta.policyId, { ...meta });
      // Emit even on no-op inserts so callers can flush batched side state.
      emitSynthetic();
    },

    hydrateQueueRecord(execId, record) {
      // Same first-write-wins policy as hydratePolicy.
      if (queueRecords.has(execId)) return;
      queueRecords.set(execId, { ...record });
    },

    hydrateQueueRecordAndPersist(execId, record) {
      const had = queueRecords.has(execId);
      if (!had) queueRecords.set(execId, { ...record });
      emitSynthetic();
    },

    hydrateEvent(event) {
      // Do not emit replayed events or move the live cursor.
      eventLog.push(event);
      if (eventLog.length > eventLogCap) eventLog.shift();
    },

    hydrateCursor(block) {
      if (block > lastCursor) lastCursor = block;
    },

    hydrateEventAndPersist(event) {
      eventLog.push(event);
      if (eventLog.length > eventLogCap) eventLog.shift();
      emitSynthetic();
    },

    emitSnapshotUpdated() {
      emitSynthetic();
    },

    listPolicies() {
      const out = [...policies.values()];
      out.sort((a, b) => {
        const ab = a.publishedBlock ?? a.lastUpdatedBlock;
        const bb = b.publishedBlock ?? b.lastUpdatedBlock;
        return ab < bb ? -1 : ab > bb ? 1 : 0;
      });
      return out;
    },
    getPolicy(policyId) {
      return policies.get(policyId);
    },

    listPoliciesByOwner(owner) {
      const lc = owner.toLowerCase();
      const out: PolicyMeta[] = [];
      for (const meta of policies.values()) {
        if (meta.owner.toLowerCase() === lc) out.push(meta);
      }
      out.sort((a, b) => {
        const ab = a.publishedBlock ?? a.lastUpdatedBlock;
        const bb = b.publishedBlock ?? b.lastUpdatedBlock;
        return ab < bb ? -1 : ab > bb ? 1 : 0;
      });
      return out;
    },

    listQueueRecords() {
      const out = [...queueRecords.values()];
      out.sort((a, b) => Number(a.enqueuedAt - b.enqueuedAt));
      return out;
    },
    getQueueRecord(execId) {
      return queueRecords.get(execId);
    },

    listPending() {
      return [...queueRecords.values()]
        .filter((r) => r.state === "Pending")
        .sort((a, b) => Number(a.deadline - b.deadline));
    },

    listPendingWithExecIds() {
      const out: Array<{ execId: bigint; record: QueueRecordHeader }> = [];
      for (const [execId, record] of queueRecords) {
        if (record.state === "Pending") out.push({ execId, record });
      }
      out.sort((a, b) => Number(a.record.deadline - b.record.deadline));
      return out;
    },

    recentEvents(limit = 100) {
      return eventLog.slice(Math.max(0, eventLog.length - limit));
    },

    cursor() {
      return lastCursor;
    },
  };
}
