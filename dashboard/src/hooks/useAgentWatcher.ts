import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChainId, usePublicClient } from "wagmi";
import {
  decodeFunctionData,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import {
  applyPolicyToObservedCall,
  WARD_ORACLE_ABI,
  utcDayBucket,
  type PolicyInput,
} from "@ward/sdk";

import { useUrlState } from "./useUrlState";
import {
  getCachedPolicyInput,
  listWatchedPolicies,
  updateLastCheckedBlock,
  type WatchedPolicy,
} from "../lib/watched-policies";
import {
  addSpendDaily,
  getSpendDaily,
} from "../lib/spend-store";
import {
  addViolation,
  computeKey as violationKey,
  listViolations,
  pruneViolations,
  type PersistedViolation,
} from "../lib/violation-store";
// Canonical chunker lives in lib/rpcChunk so other lib/ modules can use the
// same chunk size without dragging this 1500-LOC React-coupled module into
// their bundles. Re-export here so existing importers of
// `chunkOwnerScanRange` from this hook keep working.
export {
  chunkOwnerScanRange,
  RPC_LOGS_CHUNK_SIZE as RPC_LOGS_CHUNK_SIZE_PURE,
} from "../lib/rpcChunk";
import { chunkOwnerScanRange, RPC_LOGS_CHUNK_SIZE } from "../lib/rpcChunk";

/**
 * useAgentWatcher — drives watch-mode polling for every entry in the local
 * watched-policies registry.
 *
 * Per watched (policyId, agent) pair we run an independent 30s poller that:
 *   1. Pulls recent txs involving the agent via the explorer txlist API
 *      (paginated; first-load bounded to MAX_WATCH_BACK_BLOCKS).
 *   2. Filters to txs whose blockNumber > entry.lastCheckedBlock.
 *   3. For each new tx, decodes the call tree via debug_traceTransaction.
 *      If the RPC does not expose debug_trace, we cannot evaluate (no
 *      silent fallback): the entry's `debugTraceUnavailable` flag is set
 *      so the UI surfaces a banner.
 *   4. For each observation, runs applyPolicyToObservedCall against the
 *      cached PolicyInput (decoded at bind time; chain reconstruction
 *      only as refresh).
 *   5. Disallowed verdicts become Violation records (persisted, deduped,
 *      capped per entry). Successful value-carrying observations increment
 *      the per-(policy, agent, UTC day) observed spend tally so subsequent
 *      calls see the running spent-today total — across reloads, not just
 *      the session.
 *
 * The return value aggregates all violations across entries, newest first,
 * capped at MAX_VIOLATIONS in a ring buffer.
 */

export const POLL_INTERVAL_MS = 30_000;
const POLICY_CACHE_TTL_MS = 5 * 60_000;
const MAX_VIOLATIONS = 100;
// Bounded ring buffer for surfaced watcher warnings. Capped tight so the
// expandable in the page header stays a glanceable list — older entries
// FIFO-drop as new failures land.
const MAX_ERRORS = 10;
const SHANNON_EXPLORER = "https://shannon-explorer.somnia.network";
const PAGE_SIZE = 50;
const MAX_PAGES = 200;
// ~7 days at 1s blocks. Bounds first-load history scan so a fresh watch
// doesn't try to walk the entire chain.
const MAX_WATCH_BACK_BLOCKS = 604_800n;
// After this many consecutive trace failures on the same tx we give up on
// it and let the cursor advance past it — otherwise a permanently
// untraceable tx (e.g. pruned state on the RPC) would block the watcher
// forever.
const MAX_TRACE_RETRIES = 5;

export interface Violation {
  policyId: Hex;
  agentAddress: Address;
  txHash: Hex;
  blockNumber: bigint;
  target: Address;
  selector: Hex;
  valueWei: bigint;
  reason: string;
  observedAtMs: number;
  observationIndex: number;
}

/**
 * Categorised watcher warning. Four kinds cover every observable failure
 * path the poller can hit:
 *  - `rpc_logs_fetch`        — RPC-first getLogs path failed (network or
 *                              malformed range). When this fires the poller
 *                              falls through to the Blockscout fallback.
 *  - `explorer_fetch`        — txlist API / head-block / truncation issues
 *                              (Blockscout fallback path).
 *  - `policy_input_lookup`   — fallback PolicyInput reconstruction failed
 *                              (RPC error or "not in 7-day window").
 *  - `trace_exhausted`       — a single tx hit MAX_TRACE_RETRIES; cursor
 *                              advances past it. `targetTxHash` is set so
 *                              the UI can deep-link to the explorer.
 *
 * The hook returns the latest MAX_ERRORS entries (newest first); older
 * warnings FIFO-drop. Rendered by WatchedPage as a "<N> watcher warnings"
 * expandable next to the polling status pill — without this, every failure
 * silently degraded into "no violations yet" with no way for the user to
 * tell broken from quiet.
 */
export type WatcherErrorKind =
  | "rpc_logs_fetch"
  | "explorer_fetch"
  | "policy_input_lookup"
  | "trace_exhausted";

export interface WatcherError {
  at: number;
  kind: WatcherErrorKind;
  message: string;
  targetTxHash?: Hex;
}

export interface UseAgentWatcherResult {
  violations: Violation[];
  /**
   * Every watched-policy registry entry for the active (chainId, oracle).
   * Surfaced so the UI can render a section per watch even before any
   * violations have been observed — otherwise active clean watches are
   * invisible and users have no feedback that polling is happening.
   */
  watchedEntries: WatchedPolicy[];
  isPolling: boolean;
  lastPolledAt: number | null;
  errors: WatcherError[];
  debugTraceUnavailable: Record<string, boolean>;
  truncated: Record<string, boolean>;
  /**
   * Running tally of trace attempts vs successes since the current (chainId,
   * oracle) scope mounted. Drives the Coverage KPI tile. In-memory only:
   * resets when scope changes or the page reloads. `total === 0` means
   * "no signal yet — show '—'".
   */
  traceCoverage: { successful: number; total: number };
  manualPoll: () => Promise<void>;
}

interface ExplorerTx {
  hash: string;
  from: string;
  to: string | null;
  blockNumber: string;
  timeStamp?: string;
}

interface CallTraceFrame {
  type?: string;
  from?: string;
  to?: string;
  input?: string;
  value?: string;
  error?: string;
  calls?: CallTraceFrame[];
}

interface ObservedCallRaw {
  target: Address;
  selector: Hex;
  valueWei: bigint;
  failed: boolean;
  /** Ordinal of this CALL frame within walkTrace order for the tx. */
  observationIndex: number;
}

interface PolicyCacheEntry {
  policy: PolicyInput;
  fetchedAtMs: number;
}

// DELEGATECALL excluded — executes in caller context, not an external call
// under this policy model (the target's code runs but msg.sender stays the
// caller, so attributing the call to the agent as a separate target would
// double-count).
const CALL_OPCODES = new Set(["CALL", "CALLCODE", "STATICCALL"]);

function lower(h: string | null | undefined): string {
  return (h ?? "").toLowerCase();
}

function isHexAddress(s: string): s is Address {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

function selectorFromInput(input: string | undefined): Hex | null {
  if (!input || input.length < 10) return null;
  const sel = input.slice(0, 10).toLowerCase();
  if (!/^0x[0-9a-f]{8}$/.test(sel)) return null;
  return sel as Hex;
}

function valueFromHex(hex: string | undefined): bigint {
  if (!hex || hex === "0x") return 0n;
  try {
    return BigInt(hex);
  } catch {
    return 0n;
  }
}

function entryKey(
  chainId: number,
  oracleAddress: Address,
  policyId: Hex,
  agent: Address,
): string {
  return `${chainId}:${oracleAddress.toLowerCase()}:${policyId.toLowerCase()}:${agent.toLowerCase()}`;
}

/**
 * Cache key for `PolicyInput` lookups. Must include `chainId` and the oracle
 * address so that the same `policyId` derived against a different deployment
 * (different chain or different oracle contract) does not collide and return
 * the wrong PolicyInput when the user switches scope. Lower-casing both the
 * oracle and policyId hex strings makes the key case-insensitive while still
 * preserving uniqueness of distinct addresses/ids.
 *
 * Exported for unit tests so the key-construction contract is pinned —
 * accidentally dropping a component (e.g. oracle) would silently re-collide.
 */
export function policyCacheKey(
  chainId: number,
  oracleAddress: Address,
  policyId: Hex,
): string {
  return `${chainId}:${oracleAddress.toLowerCase()}:${policyId.toLowerCase()}`;
}

async function fetchTxListPage(
  agent: Address,
  page: number,
  signal: AbortSignal,
): Promise<ExplorerTx[]> {
  const url =
    `${SHANNON_EXPLORER}/api?module=account&action=txlist` +
    `&address=${agent}&page=${page}&offset=${PAGE_SIZE}&sort=desc`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`explorer HTTP ${res.status}`);
  const body = (await res.json()) as {
    status?: string;
    message?: string;
    result?: unknown;
  };
  if (body.status === "0") {
    const msg = (body.message ?? "").toLowerCase();
    if (msg.includes("no transactions")) return [];
    throw new Error(`explorer error: ${body.message ?? "unknown"}`);
  }
  if (!Array.isArray(body.result)) throw new Error("malformed txlist");
  return body.result as ExplorerTx[];
}

/**
 * Page through txlist desc-sorted, collecting all txs with blockNumber >
 * effectiveSince. effectiveSince = max(lastCheckedBlock, head - 7d) so a
 * fresh watch doesn't try to scan unbounded history. Truncates at MAX_PAGES
 * (10K txs) and returns truncated=true so the UI can warn.
 */
async function fetchAllNewTxs(
  agent: Address,
  lastCheckedBlock: bigint,
  currentHead: bigint,
  signal: AbortSignal,
): Promise<{ txs: ExplorerTx[]; truncated: boolean }> {
  const minBlock =
    currentHead > MAX_WATCH_BACK_BLOCKS
      ? currentHead - MAX_WATCH_BACK_BLOCKS
      : 0n;
  const effectiveSince =
    lastCheckedBlock > minBlock ? lastCheckedBlock : minBlock;
  const out: ExplorerTx[] = [];
  let truncated = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const txs = await fetchTxListPage(agent, page, signal);
    if (txs.length === 0) break;
    let allBeforeEffective = true;
    for (const tx of txs) {
      let block: bigint;
      try {
        block = BigInt(tx.blockNumber);
      } catch {
        continue;
      }
      if (block > effectiveSince) {
        out.push(tx);
        allBeforeEffective = false;
      }
    }
    if (allBeforeEffective || txs.length < PAGE_SIZE) break;
    if (page === MAX_PAGES) {
      truncated = true;
      break;
    }
  }
  return { txs: out, truncated };
}

/**
 * Walk a callTracer frame and collect every (target, selector, valueWei)
 * where the caller is `agent`, in pre-order. observationIndex is the
 * ordinal of the emitted observation (not the visited frame).
 */
function walkTrace(
  frame: CallTraceFrame,
  agent: string,
  out: ObservedCallRaw[],
): void {
  const callType = (frame.type ?? "").toUpperCase();
  if (
    CALL_OPCODES.has(callType) &&
    lower(frame.from) === agent &&
    frame.to &&
    isHexAddress(frame.to) &&
    lower(frame.to) !== agent
  ) {
    const sel = selectorFromInput(frame.input);
    if (sel) {
      out.push({
        target: lower(frame.to) as Address,
        selector: sel,
        valueWei: valueFromHex(frame.value),
        failed: Boolean(frame.error),
        observationIndex: out.length,
      });
    }
  }
  if (Array.isArray(frame.calls)) {
    for (const child of frame.calls) walkTrace(child, agent, out);
  }
}

async function decodeTxCalls(
  publicClient: PublicClient,
  txHash: Hex,
  agent: Address,
): Promise<{ calls: ObservedCallRaw[]; traceFailed: boolean }> {
  try {
    const trace = (await publicClient.request({
      method: "debug_traceTransaction" as never,
      params: [txHash, { tracer: "callTracer" }] as never,
    })) as CallTraceFrame;
    const calls: ObservedCallRaw[] = [];
    walkTrace(trace, agent.toLowerCase(), calls);
    return { calls, traceFailed: false };
  } catch {
    return { calls: [], traceFailed: true };
  }
}

// 7-day window matches the SDK event-store default. Policies older than this
// can't be reconstructed without a full deployment-block scan, which is too
// expensive per-poll.
const FETCH_POLICY_LOOKBACK_BLOCKS = 7n * 24n * 60n * 60n; // assume 1s blocks

/**
 * Comparator for ordering logs by chronological position within the chain:
 * (blockNumber, transactionIndex, logIndex) ascending. Used by the fallback
 * policy reconstruction so ties within a block are broken deterministically
 * — sorting on blockNumber alone leaves intra-block order to the JS engine
 * and can pick a stale policy when multiple events share a block.
 *
 * Exported for tests so the tie-break order is pinned.
 */
export function compareLogPosition(
  a: { blockNumber?: bigint | null; transactionIndex?: number | null; logIndex?: number | null },
  b: { blockNumber?: bigint | null; transactionIndex?: number | null; logIndex?: number | null },
): number {
  const ab = a.blockNumber ?? 0n;
  const bb = b.blockNumber ?? 0n;
  if (ab !== bb) return ab < bb ? -1 : 1;
  const ati = a.transactionIndex ?? 0;
  const bti = b.transactionIndex ?? 0;
  if (ati !== bti) return ati - bti;
  const ali = a.logIndex ?? 0;
  const bli = b.logIndex ?? 0;
  return ali - bli;
}

/**
 * Compute the next `lastCheckedBlock` value for an empty-batch poll cycle.
 *
 * When pollOne runs and finds zero relevant txs we still want to advance
 * the cursor past the just-scanned window — otherwise an idle agent would
 * have every poll re-scan the same (growing) range. But we can only do
 * that when the scan was actually complete: if either the RPC log fetch
 * OR the Blockscout fallback threw, we may be missing txs and must hold
 * the cursor where it was so the next poll retries.
 *
 * `rpcSucceeded`, `explorerAttempted`, `explorerSucceeded` mirror the
 * flags pollOne tracks across the two fetch paths. Returns the block to
 * write to lastChecked (or the unchanged `lastChecked` if neither path
 * gives us a safe advance).
 *
 * Exported for tests so the "advance vs hold" decision matrix is pinned
 * — getting it wrong silently corrupts the watch loop on Shannon, where
 * Blockscout lags the RPC by ~5 days.
 */
export function computeEmptyBatchCursor(args: {
  lastChecked: bigint;
  head: bigint;
  maxSeenBlock: bigint;
  rpcSucceeded: boolean;
  explorerAttempted: boolean;
  explorerSucceeded: boolean;
}): bigint {
  const { lastChecked, head, maxSeenBlock, rpcSucceeded, explorerAttempted, explorerSucceeded } = args;
  // Scan is "complete" when every path we actually invoked returned
  // without error. RPC-only success (no fallback needed because RPC
  // produced events) counts as complete; RPC-success + explorer-success
  // counts as complete; RPC-fail + explorer-success counts as complete
  // (explorer's view covered the range). Anything else means a path
  // threw, so we can't be sure the range was fully scanned.
  const scanComplete =
    (rpcSucceeded && !explorerAttempted) ||
    (rpcSucceeded && explorerSucceeded) ||
    (!rpcSucceeded && explorerSucceeded);
  const target = scanComplete && head > maxSeenBlock ? head : maxSeenBlock;
  return target > lastChecked ? target : lastChecked;
}

/**
 * Pull every log emitted BY `agent` between `fromBlock` and `toBlock`
 * inclusive, chunked into Shannon-safe windows (≤1000 blocks per
 * `eth_getLogs` call). Returns the union of logs across all chunks; order
 * is "chunks oldest-first, logs within chunk in node-returned order" —
 * callers that need strict positional order should re-sort with
 * `compareLogPosition`.
 *
 * RPC-first replacement for the Blockscout txlist endpoint, which has been
 * lagging the RPC node by ~5 days on Shannon and returns "no transactions"
 * for verified contracts with recent activity. Logs come straight from the
 * RPC node's index so there's no upstream explorer dependency.
 *
 * Exported for unit tests so the chunker shape is pinned (off-by-one would
 * silently corrupt the watch flow's "what did the agent just do" answer).
 */
export async function fetchAgentEventsViaRpc(
  publicClient: PublicClient,
  agent: Address,
  fromBlock: bigint,
  toBlock: bigint,
  signal: AbortSignal,
  chunkSize: bigint = RPC_LOGS_CHUNK_SIZE,
): Promise<Log[]> {
  if (toBlock < fromBlock) return [];
  const chunks = chunkOwnerScanRange(toBlock, fromBlock, chunkSize);
  const out: Log[] = [];
  // Walk oldest-first so synthesized tx ordering is chronological. The
  // chunker emits newest-first to satisfy the policy-recovery scan's
  // "first hit wins" semantics, so reverse for this consumer.
  for (let i = chunks.length - 1; i >= 0; i--) {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const { fromBlock: cf, toBlock: ct } = chunks[i]!;
    const logs = await publicClient.getLogs({
      address: agent,
      fromBlock: cf,
      toBlock: ct,
    });
    out.push(...logs);
  }
  return out;
}

/**
 * RPC-first replacement for `fetchAllNewTxs`. Derives the set of txs the
 * agent contract participated in by reading the agent's emitted logs from
 * the RPC node, then resolving each unique txHash to a tx object. Returns
 * `ExplorerTx`-shaped records so the rest of `pollOne` (agentKind filter,
 * trace decode, policy evaluation) is unchanged.
 *
 * Tradeoff: getLogs only surfaces txs where the agent EMITTED an event.
 * Pure-transfer txs or fire-and-forget calls that emit nothing slip
 * through. The Blockscout fallback in `pollOne` covers that case
 * defensively. After the v0.12.0 simplification, the canonical
 * CounterAgent does NOT emit from its own address — `Bumped` / `Reset`
 * come from the downstream `Counter` contract, so the Blockscout
 * fallback (not the RPC path) carries the watcher for the new shape.
 * Agents that emit their own state-change events stay on the RPC path.
 */
export async function fetchNewTxsViaRpc(
  publicClient: PublicClient,
  agent: Address,
  lastCheckedBlock: bigint,
  currentHead: bigint,
  txCache: Map<string, ExplorerTx>,
  signal: AbortSignal,
): Promise<ExplorerTx[]> {
  const minBlock =
    currentHead > MAX_WATCH_BACK_BLOCKS
      ? currentHead - MAX_WATCH_BACK_BLOCKS
      : 0n;
  const effectiveSince =
    lastCheckedBlock > minBlock ? lastCheckedBlock : minBlock;
  // getLogs is inclusive on both ends; we want "strictly greater than
  // lastCheckedBlock" semantics to match the Blockscout path, so start one
  // block past the cursor.
  const fromBlock = effectiveSince + 1n;
  if (fromBlock > currentHead) return [];

  const logs = await fetchAgentEventsViaRpc(
    publicClient,
    agent,
    fromBlock,
    currentHead,
    signal,
  );

  // Dedup by txHash — a single tx can emit many events. Preserve the
  // first-seen log per tx so we have its blockNumber without re-fetching.
  const txHashes: Hex[] = [];
  const seen = new Set<string>();
  const blockByHash = new Map<string, bigint>();
  for (const log of logs) {
    const h = (log.transactionHash ?? "").toLowerCase();
    if (!h || seen.has(h)) continue;
    seen.add(h);
    txHashes.push(log.transactionHash as Hex);
    if (log.blockNumber !== null && log.blockNumber !== undefined) {
      blockByHash.set(h, log.blockNumber);
    }
  }

  const out: ExplorerTx[] = [];
  for (const hash of txHashes) {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const cacheKey = hash.toLowerCase();
    const cached = txCache.get(cacheKey);
    if (cached) {
      out.push(cached);
      continue;
    }
    let tx: Awaited<ReturnType<typeof publicClient.getTransaction>> | null;
    try {
      tx = await publicClient.getTransaction({ hash });
    } catch {
      // A single tx fetch failure shouldn't sink the whole batch — skip
      // this one and let the next poll retry it (cursor stays behind).
      continue;
    }
    // viem's getTransaction returns null when a tx is pruned, the RPC has
    // racy state, or the hash is otherwise unknown. The throw path above
    // covers errors; this guards the null-return path so we don't deref
    // `tx.blockNumber` / `tx.hash` on a missing record.
    if (!tx) continue;
    // Skip pending txs — they have no blockNumber yet and would corrupt
    // the block-keyed cache / cursor math downstream.
    if (tx.blockNumber === null || tx.blockNumber === undefined) continue;
    const block = blockByHash.get(cacheKey) ?? tx.blockNumber ?? 0n;
    const synthesized: ExplorerTx = {
      hash: tx.hash,
      from: tx.from,
      to: tx.to ?? null,
      blockNumber: block.toString(),
    };
    txCache.set(cacheKey, synthesized);
    out.push(synthesized);
  }
  return out;
}

/**
 * Thrown when the 7-day chunked fallback scan completes without finding
 * either a PolicyPublished or PolicyUpdated event for `policyId`. The
 * caller surfaces this as a watcher error rather than silently hanging
 * on a too-wide `eth_getLogs` call.
 */
export class PolicyNotFoundInWindowError extends Error {
  readonly policyId: Hex;
  constructor(policyId: Hex) {
    super(`Policy ${policyId} not found in last 7 days of logs`);
    this.name = "PolicyNotFoundInWindowError";
    this.policyId = policyId;
  }
}

/**
 * Reconstruct the current PolicyInput by reading the most recent
 * PolicyPublished/PolicyUpdated event for `policyId` and decoding the
 * originating tx calldata. There is no on-chain getter for PolicyInput.
 *
 * Used only as a fallback when the watched entry has no cached
 * policyInputJSON (entries added before that field existed) — the
 * 7-day event window means we'd otherwise be unable to evaluate
 * older policies.
 *
 * Implementation: walks backward from head to `head - 7d` in 999-block
 * chunks (Shannon's `eth_getLogs` caps at 1000 blocks/call). Returns on
 * the first chunk with any hit, taking the highest block in that chunk
 * across both event types — that's the most recent state-touch, which is
 * what the decoder needs to reconstruct the *current* PolicyInput.
 */
export async function fetchPolicyInput(
  publicClient: PublicClient,
  oracleAddress: Address,
  policyId: Hex,
): Promise<PolicyInput | null> {
  const head = await publicClient.getBlockNumber();
  const floor =
    head > FETCH_POLICY_LOOKBACK_BLOCKS
      ? head - FETCH_POLICY_LOOKBACK_BLOCKS
      : 0n;

  const publishedEvent = WARD_ORACLE_ABI.find(
    (a) => a.type === "event" && a.name === "PolicyPublished",
  ) as never;
  const updatedEvent = WARD_ORACLE_ABI.find(
    (a) => a.type === "event" && a.name === "PolicyUpdated",
  ) as never;

  let latest: { txHash: Hex; blockNumber: bigint } | null = null;
  for (const { fromBlock, toBlock } of chunkOwnerScanRange(head, floor)) {
    let publishedLogs: Awaited<ReturnType<typeof publicClient.getLogs>>;
    let updatedLogs: Awaited<ReturnType<typeof publicClient.getLogs>>;
    try {
      [publishedLogs, updatedLogs] = await Promise.all([
        publicClient.getLogs({
          address: oracleAddress,
          event: publishedEvent,
          args: { policyId } as never,
          fromBlock,
          toBlock,
        }),
        publicClient.getLogs({
          address: oracleAddress,
          event: updatedEvent,
          args: { policyId } as never,
          fromBlock,
          toBlock,
        }),
      ]);
    } catch {
      // RPC quirk on this chunk — skip and walk back. Worst case the whole
      // 7-day window comes up empty and we throw PolicyNotFoundInWindowError.
      continue;
    }
    // Sort by (blockNumber, transactionIndex, logIndex) ascending so that
    // when multiple events share a block (and even a tx), the LAST element
    // is unambiguously the most recent state-touch. Sorting on blockNumber
    // alone is non-deterministic for intra-block ties and could decode a
    // stale policy.
    const candidates = [...publishedLogs, ...updatedLogs]
      .filter((l) => l.blockNumber !== null && l.blockNumber !== undefined)
      .sort(compareLogPosition);
    const newest = candidates[candidates.length - 1];
    if (newest) {
      latest = {
        txHash: newest.transactionHash as Hex,
        blockNumber: newest.blockNumber!,
      };
    }
    // First chunk with a hit wins — we're walking backward so the latest
    // state-touch (publish OR most recent update) lives here.
    if (latest) break;
  }

  if (!latest) {
    throw new PolicyNotFoundInWindowError(policyId);
  }

  let tx: Awaited<ReturnType<typeof publicClient.getTransaction>> | null;
  try {
    tx = await publicClient.getTransaction({ hash: latest.txHash });
  } catch {
    return null;
  }
  // viem's getTransaction can RESOLVE to null (separate from throwing) when
  // the hash is pruned/unknown on the RPC. `tx.input` can also be missing on
  // some non-standard tx types (system txs). Either way the calldata decode
  // below would crash — bail to null so the watcher falls back gracefully.
  if (!tx || tx.input == null) return null;
  try {
    const decoded = decodeFunctionData({
      abi: WARD_ORACLE_ABI,
      data: tx.input,
    });
    if (decoded.functionName === "publishPolicy") {
      return decoded.args[1] as PolicyInput;
    }
    if (decoded.functionName === "updatePolicy") {
      return decoded.args[1] as PolicyInput;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Read the timestamp of a block; the watcher needs `block.timestamp` to feed
 * applyPolicyToObservedCall (expiry + utcDayBucket). Returns now() in seconds
 * on RPC failure so the watcher keeps making progress.
 */
async function blockTimestampSec(
  publicClient: PublicClient,
  blockNumber: bigint,
): Promise<bigint> {
  try {
    const b = await publicClient.getBlock({ blockNumber });
    return b.timestamp;
  } catch {
    return BigInt(Math.floor(Date.now() / 1000));
  }
}

interface PollContext {
  publicClient: PublicClient;
  chainId: number;
  oracleAddress: Address;
  policyCache: Map<string, PolicyCacheEntry>;
  /**
   * Per-(entryKey, txHash) count of consecutive trace failures. Persists
   * across polls so we can give up after MAX_TRACE_RETRIES and stop the
   * cursor from being held back forever by an untraceable tx.
   */
  traceFailureCounts: Map<string, number>;
  /**
   * Cache of synthesized `ExplorerTx` records keyed by lowercase txHash.
   * Populated by the RPC-first fetch path so re-scans of the same window
   * don't re-call `getTransaction` for already-seen txs. Lifetime matches
   * the (chainId, oracle) scope.
   */
  txCache: Map<string, ExplorerTx>;
  signal: AbortSignal;
  onViolation: (v: Violation) => void;
  onError: (e: WatcherError) => void;
  onLastBlock: (entry: WatchedPolicy, block: bigint) => Promise<void>;
  onTraceUnavailable: (entry: WatchedPolicy, value: boolean) => void;
  onTruncated: (entry: WatchedPolicy, value: boolean) => void;
  /**
   * Trace-coverage counters. Incremented per tx attempt: `total++` for every
   * tx the poller tries to trace, `successful++` only when the trace returns
   * a decodable frame tree. Read by the Coverage KPI tile via the hook's
   * return.
   */
  traceCoverage: { successful: number; total: number };
}

async function pollOne(entry: WatchedPolicy, ctx: PollContext): Promise<void> {
  const agent = entry.watchedAgentAddress as Address;
  const lastChecked = (() => {
    try {
      return BigInt(entry.lastCheckedBlock);
    } catch {
      return 0n;
    }
  })();

  let head: bigint;
  try {
    head = await ctx.publicClient.getBlockNumber();
  } catch (e) {
    ctx.onError({
      at: Date.now(),
      kind: "explorer_fetch",
      message: `head block fetch failed: ${e instanceof Error ? e.message : String(e)}`,
    });
    return;
  }

  // RPC-first fetch. Shannon Blockscout has been lagging the RPC node by
  // ~5 days, so txlist returns "no transactions" for verified contracts
  // with recent activity. The RPC node's log index is realtime, so reading
  // events emitted BY the agent gives us a fresh and accurate "what did
  // this agent just do" set.
  //
  // Fallback to Blockscout only when RPC fails OR when RPC returns zero
  // events (defensive: agents that don't emit events would otherwise look
  // permanently inactive). The truncated flag is RPC-path N/A — we read
  // chunked logs end-to-end, no 10K cap.
  let txs: ExplorerTx[] = [];
  let truncated = false;
  let usedFallback = false;
  let rpcSucceeded = false;
  let explorerAttempted = false;
  let explorerSucceeded = false;
  try {
    txs = await fetchNewTxsViaRpc(
      ctx.publicClient,
      agent,
      lastChecked,
      head,
      ctx.txCache,
      ctx.signal,
    );
    rpcSucceeded = true;
  } catch (e) {
    if (ctx.signal.aborted) return;
    ctx.onError({
      at: Date.now(),
      kind: "rpc_logs_fetch",
      message: `rpc getLogs failed: ${e instanceof Error ? e.message : String(e)} — falling back to explorer`,
    });
  }

  if (!rpcSucceeded || txs.length === 0) {
    // Fall through to the Blockscout txlist. When RPC succeeded but
    // returned 0 events we still try the explorer once — agents that
    // never emit events would otherwise look permanently inactive. If
    // both come back empty we just move on (cursor stays put).
    explorerAttempted = true;
    try {
      const result = await fetchAllNewTxs(
        agent,
        lastChecked,
        head,
        ctx.signal,
      );
      if (result.txs.length > 0) {
        txs = result.txs;
        truncated = result.truncated;
        usedFallback = true;
      }
      explorerSucceeded = true;
    } catch (e) {
      if (ctx.signal.aborted) return;
      // Only surface the explorer error when RPC ALSO failed — otherwise
      // an RPC-success path shouldn't be noisy about an explorer that
      // happens to also be broken.
      if (!rpcSucceeded) {
        ctx.onError({
          at: Date.now(),
          kind: "explorer_fetch",
          message: e instanceof Error ? e.message : String(e),
        });
        return;
      }
    }
  }

  ctx.onTruncated(entry, truncated);
  if (truncated && usedFallback) {
    ctx.onError({
      at: Date.now(),
      kind: "explorer_fetch",
      message:
        "Truncated: more than 10,000 txs since lastCheckedBlock — older txs may have been missed.",
    });
  }

  // EOA agents originate txs; contract agents are called by users. Same
  // branching as agent-discovery so we evaluate the right tx set.
  let agentKind: "eoa" | "contract" = "eoa";
  try {
    const code = await ctx.publicClient.getCode({ address: agent });
    agentKind = code && code !== "0x" ? "contract" : "eoa";
  } catch {
    // default eoa
  }
  const agentLower = agent.toLowerCase();
  const newTxs = txs.filter((t) => {
    return agentKind === "eoa"
      ? lower(t.from) === agentLower
      : lower(t.to) === agentLower;
  });

  if (newTxs.length === 0) {
    // No work for this poll. Advance the cursor to `head` ONLY if every
    // attempted fetch path completed without error — see
    // `computeEmptyBatchCursor` for the decision matrix. On Shannon this
    // matters because Blockscout lags ~5d behind RPC, so an idle agent
    // would otherwise see every poll re-scan the same growing window.
    const maxSeenBlock = txs.reduce((m, t) => {
      const b = (() => {
        try {
          return BigInt(t.blockNumber);
        } catch {
          return 0n;
        }
      })();
      return b > m ? b : m;
    }, lastChecked);
    const target = computeEmptyBatchCursor({
      lastChecked,
      head,
      maxSeenBlock,
      rpcSucceeded,
      explorerAttempted,
      explorerSucceeded,
    });
    if (target > lastChecked) {
      await ctx.onLastBlock(entry, target);
    }
    return;
  }

  // Resolve the policy. Prefer the cached PolicyInput captured at bind
  // time — chain reconstruction is bounded by the 7-day event window, so
  // older policies would otherwise become unevaluable.
  let policy: PolicyInput | null = null;
  const cachedFromEntry = getCachedPolicyInput(entry) as PolicyInput | null;
  if (cachedFromEntry) {
    policy = cachedFromEntry;
  } else {
    const cacheKey = policyCacheKey(
      ctx.chainId,
      ctx.oracleAddress,
      entry.policyId,
    );
    const cached = ctx.policyCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAtMs < POLICY_CACHE_TTL_MS) {
      policy = cached.policy;
    } else {
      try {
        policy = await fetchPolicyInput(
          ctx.publicClient,
          entry.oracleAddress as Address,
          entry.policyId,
        );
      } catch (err) {
        // PolicyNotFoundInWindowError is the expected miss case after a
        // full 7-day chunked scan. Surface it as a watcher error and skip
        // this poll instead of letting it bubble up and tear down the loop.
        ctx.onError({
          at: Date.now(),
          kind: "policy_input_lookup",
          message:
            err instanceof PolicyNotFoundInWindowError
              ? err.message
              : `policy input lookup failed: ${(err as Error)?.message ?? String(err)}`,
        });
        return;
      }
      if (policy) {
        ctx.policyCache.set(cacheKey, {
          policy,
          fetchedAtMs: Date.now(),
        });
      }
    }
  }
  if (!policy) {
    ctx.onError({
      at: Date.now(),
      kind: "policy_input_lookup",
      message: "policy input not found on-chain (event window too short?)",
    });
    return;
  }

  // Sort oldest-first so spent-today accumulation matches chronological order.
  newTxs.sort((a, b) => {
    const ba = BigInt(a.blockNumber);
    const bb = BigInt(b.blockNumber);
    return ba < bb ? -1 : ba > bb ? 1 : 0;
  });

  // Collect per-tx classification so we can compute a safe cursor cap
  // AFTER the batch finishes. The cursor must never advance past a
  // retryable-failed block, because fetchAllNewTxs filters by
  // `block > lastCheckedBlock` next cycle — anything at-or-above a skipped
  // failed block would be dropped silently.
  const successfulBlocks: bigint[] = [];
  const retryableFailedBlocks: bigint[] = [];
  const exhaustedFailedBlocks: bigint[] = [];
  let anyTraceFailed = false;
  let anyTraceSucceeded = false;
  const watchKey = entryKey(ctx.chainId, ctx.oracleAddress, entry.policyId, agent);

  // Per-(utcDay) running spend, hydrated lazily from the persistent store
  // on first sighting of a day. Carries within this poll cycle so multiple
  // calls on the same day see the running total.
  const dailySpend = new Map<string, bigint>();
  const hydrate = async (utcDay: bigint): Promise<bigint> => {
    const dayKey = utcDay.toString();
    const cached = dailySpend.get(dayKey);
    if (cached !== undefined) return cached;
    const rec = await getSpendDaily({
      chainId: ctx.chainId,
      oracleAddress: ctx.oracleAddress,
      policyId: entry.policyId,
      agentAddress: agent,
      utcDay: dayKey,
    });
    const base = rec ? BigInt(rec.spentWei) : 0n;
    dailySpend.set(dayKey, base);
    return base;
  };

  for (const tx of newTxs) {
    if (ctx.signal.aborted) return;
    const txHash = tx.hash as Hex;
    const blockNumber = BigInt(tx.blockNumber);
    const failKey = `${watchKey}:${txHash.toLowerCase()}`;

    // Coverage tally: count every attempt so the KPI denominator reflects
    // actual workload, not just successes. Increment BEFORE the await so
    // an aborted poll still accounts for the tx in flight.
    ctx.traceCoverage.total += 1;

    const { calls, traceFailed } = await decodeTxCalls(
      ctx.publicClient,
      txHash,
      agent,
    );
    if (traceFailed) {
      anyTraceFailed = true;
      const prior = ctx.traceFailureCounts.get(failKey) ?? 0;
      const next = prior + 1;
      ctx.traceFailureCounts.set(failKey, next);
      if (next >= MAX_TRACE_RETRIES) {
        // Give up on this tx — record an error and let the cursor advance
        // past it so we don't loop forever on something untraceable.
        ctx.onError({
          at: Date.now(),
          kind: "trace_exhausted",
          message: `tx ${txHash} could not be traced after ${MAX_TRACE_RETRIES} attempts; advancing past it`,
          targetTxHash: txHash,
        });
        ctx.traceFailureCounts.delete(failKey);
        exhaustedFailedBlocks.push(blockNumber);
      } else {
        // Leave this tx behind the cursor so the next poll retries it.
        retryableFailedBlocks.push(blockNumber);
      }
      continue;
    }
    anyTraceSucceeded = true;
    ctx.traceCoverage.successful += 1;
    // Trace succeeded — clear any previous failure count and record this
    // block as a candidate for cursor advancement.
    ctx.traceFailureCounts.delete(failKey);
    successfulBlocks.push(blockNumber);
    if (calls.length === 0) continue;

    const tsSec = tx.timeStamp
      ? BigInt(tx.timeStamp)
      : await blockTimestampSec(ctx.publicClient, blockNumber);
    const utcDay = utcDayBucket(tsSec);
    const utcDayStr = utcDay.toString();

    for (const call of calls) {
      const spent = await hydrate(utcDay);
      const verdict = applyPolicyToObservedCall(
        policy,
        {
          target: call.target,
          selector: call.selector,
          valueWei: call.valueWei,
          asker: agent,
          timestampSec: tsSec,
        },
        spent,
      );
      if (call.valueWei > 0n && !call.failed) {
        try {
          const { applied } = await addSpendDaily(
            call.valueWei,
            blockNumber,
            {
              chainId: ctx.chainId,
              oracleAddress: ctx.oracleAddress,
              policyId: entry.policyId,
              agentAddress: agent,
              utcDay: utcDayStr,
            },
            {
              txHash,
              observationIndex: call.observationIndex,
            },
          );
          // Count successful observed native spend even when the policy
          // verdict is a violation, so later daily-cap checks see the real
          // on-chain spend baseline. Re-polls remain idempotent.
          if (applied) {
            dailySpend.set(utcDayStr, spent + call.valueWei);
          }
        } catch {
          // persistence failures don't block evaluation
        }
      }
      if (!verdict.allowed) {
        const persisted: PersistedViolation = {
          key: violationKey({
            chainId: ctx.chainId,
            oracleAddress: ctx.oracleAddress,
            policyId: entry.policyId,
            agentAddress: agent,
            txHash,
            observationIndex: call.observationIndex,
            target: call.target,
            selector: call.selector,
          }),
          chainId: ctx.chainId,
          oracleAddress: ctx.oracleAddress,
          policyId: entry.policyId,
          agentAddress: agent,
          txHash,
          observationIndex: call.observationIndex,
          blockNumber: blockNumber.toString(),
          target: call.target,
          selector: call.selector,
          valueWei: call.valueWei.toString(),
          reason: verdict.reason,
          observedAtMs: Date.now(),
        };
        try {
          await addViolation(persisted);
        } catch {
          // persistence failures don't block evaluation
        }
        ctx.onViolation({
          policyId: entry.policyId,
          agentAddress: agent,
          txHash,
          blockNumber,
          target: call.target,
          selector: call.selector,
          valueWei: call.valueWei,
          reason: verdict.reason,
          observedAtMs: persisted.observedAtMs,
          observationIndex: call.observationIndex,
        });
      }
    }
  }

  // Flag debugTraceUnavailable only when every trace attempt failed for
  // this poll cycle — a single transient failure shouldn't sticky-banner
  // the UI.
  if (anyTraceFailed && !anyTraceSucceeded) {
    ctx.onTraceUnavailable(entry, true);
  } else if (anyTraceSucceeded) {
    ctx.onTraceUnavailable(entry, false);
  }

  // Compute the cursor cap. If any retryable-failed tx exists in the batch,
  // the cursor must stay below the LOWEST such block — otherwise next poll's
  // `block > lastCheckedBlock` filter would silently drop that tx forever.
  // Successful and exhausted-failed blocks are both "done" from the cursor's
  // perspective.
  const maxBigint = (xs: bigint[]): bigint =>
    xs.reduce((a, b) => (a > b ? a : b));
  let advanceableMaxBlock: bigint | null = null;
  if (retryableFailedBlocks.length === 0) {
    const done = [...successfulBlocks, ...exhaustedFailedBlocks];
    if (done.length > 0) advanceableMaxBlock = maxBigint(done);
  } else {
    const minFailed = retryableFailedBlocks.reduce((a, b) => (a < b ? a : b));
    const safe = [...successfulBlocks, ...exhaustedFailedBlocks].filter(
      (b) => b < minFailed,
    );
    if (safe.length > 0) advanceableMaxBlock = maxBigint(safe);
  }

  if (advanceableMaxBlock !== null && advanceableMaxBlock > lastChecked) {
    await ctx.onLastBlock(entry, advanceableMaxBlock);
  }

  try {
    await pruneViolations({
      chainId: ctx.chainId,
      oracleAddress: ctx.oracleAddress,
      policyId: entry.policyId,
      agentAddress: agent,
    });
  } catch {
    // prune failure is non-fatal
  }
}

function persistedToLive(p: PersistedViolation): Violation {
  return {
    policyId: p.policyId as Hex,
    agentAddress: p.agentAddress as Address,
    txHash: p.txHash as Hex,
    blockNumber: BigInt(p.blockNumber),
    target: p.target as Address,
    selector: p.selector as Hex,
    valueWei: BigInt(p.valueWei),
    reason: p.reason,
    observedAtMs: p.observedAtMs,
    observationIndex: p.observationIndex,
  };
}

function liveViolationKey(v: Violation, chainId: number, oracle: Address): string {
  return violationKey({
    chainId,
    oracleAddress: oracle,
    policyId: v.policyId,
    agentAddress: v.agentAddress,
    txHash: v.txHash,
    observationIndex: v.observationIndex,
    target: v.target,
    selector: v.selector,
  });
}

export function useAgentWatcher(): UseAgentWatcherResult {
  const publicClient = usePublicClient();
  const chainIdFromWallet = useChainId();
  const { oracle } = useUrlState();

  const [violations, setViolations] = useState<Violation[]>([]);
  const [errors, setErrors] = useState<WatcherError[]>([]);
  const [isPolling, setIsPolling] = useState(false);
  const [lastPolledAt, setLastPolledAt] = useState<number | null>(null);
  const [entries, setEntries] = useState<WatchedPolicy[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [debugTraceUnavailable, setDebugTraceUnavailable] = useState<
    Record<string, boolean>
  >({});
  const [truncated, setTruncated] = useState<Record<string, boolean>>({});

  // Mutable refs so the interval callback always sees the live state.
  // policyCache is keyed by `${chainId}:${oracle}:${policyId}` (via
  // policyCacheKey) — keying by policyId alone would collide across
  // deployments and return the wrong PolicyInput on scope switch.
  const policyCacheRef = useRef<Map<string, PolicyCacheEntry>>(new Map());
  const traceFailureCountsRef = useRef<Map<string, number>>(new Map());
  // Cache of synthesized `ExplorerTx` records (RPC-first path). Per-scope
  // so a deployment switch starts clean — txHashes are globally unique,
  // but clearing avoids unbounded growth across scope changes.
  const txCacheRef = useRef<Map<string, ExplorerTx>>(new Map());
  const inFlightRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  // Trace coverage tally for the current (chainId, oracle) scope. Mutated
  // in-place by pollOne; snapshotted to React state at the end of each poll
  // cycle so the Coverage KPI re-renders on a stable per-cycle cadence
  // rather than re-rendering after every tx.
  const traceCoverageRef = useRef<{ successful: number; total: number }>({
    successful: 0,
    total: 0,
  });
  const [traceCoverage, setTraceCoverage] = useState<{
    successful: number;
    total: number;
  }>({ successful: 0, total: 0 });
  // Live cursor per entry. Mirrors lastCheckedBlock from IndexedDB but is
  // mutated in-place by bumpLastBlock so cursor advances don't change the
  // `entries` reference — that would re-run the poll effect, abort the
  // active Promise.all, and starve slower entries.
  const cursorsRef = useRef<Map<string, bigint>>(new Map());

  const effectiveChainId = chainIdFromWallet || 50312;

  // Load watched entries whenever (chainId, oracle) changes. We use the
  // wallet's chainId when available; otherwise the URL-state default.
  useEffect(() => {
    let cancelled = false;
    setHydrated(false);
    // Reset trace coverage when scope changes: counters from the prior
    // (chainId, oracle) describe a different fleet and shouldn't leak.
    traceCoverageRef.current = { successful: 0, total: 0 };
    setTraceCoverage({ successful: 0, total: 0 });
    // Reset watcher errors for the same reason: stale RPC/decode warnings
    // from the prior (chainId, oracle) don't describe the new scope. The
    // FIFO cap (MAX_ERRORS) continues to bound the array after reset via
    // appendError.
    setErrors([]);
    // Clear the policy cache: even though entries are now keyed by
    // (chainId, oracle, policyId), holding stale entries from a prior scope
    // would still serve memory-bounded garbage. Cheaper and clearer to drop
    // them whenever the user switches deployment.
    policyCacheRef.current.clear();
    // Same reasoning for the RPC tx cache — drop synthesized txs from the
    // prior (chainId, oracle).
    txCacheRef.current.clear();
    (async () => {
      let list: WatchedPolicy[] = [];
      try {
        list = await listWatchedPolicies(effectiveChainId, oracle);
      } catch {
        // ignore — empty registry is the right fallback
      }
      if (cancelled) return;

      // Hydrate violations from persistence BEFORE allowing polling, so the
      // UI doesn't flicker empty on reload.
      const hydratedViolations: Violation[] = [];
      const seen = new Set<string>();
      for (const entry of list) {
        try {
          const persisted = await listViolations({
            chainId: effectiveChainId,
            oracleAddress: oracle,
            policyId: entry.policyId,
            agentAddress: entry.watchedAgentAddress as Address,
          });
          for (const p of persisted) {
            if (seen.has(p.key)) continue;
            seen.add(p.key);
            hydratedViolations.push(persistedToLive(p));
          }
        } catch {
          // ignore individual entry hydration failures
        }
      }
      if (cancelled) return;
      hydratedViolations.sort((a, b) => b.observedAtMs - a.observedAtMs);
      if (hydratedViolations.length > MAX_VIOLATIONS) {
        hydratedViolations.length = MAX_VIOLATIONS;
      }
      // Rebuild the cursor ref from the freshly-loaded entries. (chainId,
      // oracle) changed → previous cursors belong to a different scope and
      // must not leak across.
      cursorsRef.current = new Map(
        list.map((e) => {
          let block: bigint;
          try {
            block = BigInt(e.lastCheckedBlock);
          } catch {
            block = 0n;
          }
          return [
            entryKey(
              e.chainId,
              e.oracleAddress as Address,
              e.policyId,
              e.watchedAgentAddress as Address,
            ),
            block,
          ];
        }),
      );
      setViolations(hydratedViolations);
      setEntries(list);
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [effectiveChainId, oracle]);

  const appendViolation = useCallback(
    (v: Violation) => {
      setViolations((prev) => {
        const key = liveViolationKey(v, effectiveChainId, oracle);
        if (
          prev.some(
            (existing) =>
              liveViolationKey(existing, effectiveChainId, oracle) === key,
          )
        ) {
          return prev;
        }
        const next = [v, ...prev];
        if (next.length > MAX_VIOLATIONS) next.length = MAX_VIOLATIONS;
        return next;
      });
    },
    [effectiveChainId, oracle],
  );

  const appendError = useCallback((e: WatcherError) => {
    setErrors((prev) => {
      const next = [e, ...prev];
      if (next.length > MAX_ERRORS) next.length = MAX_ERRORS;
      return next;
    });
  }, []);

  const setTraceUnavailableFor = useCallback(
    (entry: WatchedPolicy, value: boolean) => {
      const key = entryKey(
        entry.chainId,
        entry.oracleAddress as Address,
        entry.policyId,
        entry.watchedAgentAddress as Address,
      );
      setDebugTraceUnavailable((prev) => {
        if (prev[key] === value) return prev;
        return { ...prev, [key]: value };
      });
    },
    [],
  );

  const setTruncatedFor = useCallback(
    (entry: WatchedPolicy, value: boolean) => {
      const key = entryKey(
        entry.chainId,
        entry.oracleAddress as Address,
        entry.policyId,
        entry.watchedAgentAddress as Address,
      );
      setTruncated((prev) => {
        if (prev[key] === value) return prev;
        return { ...prev, [key]: value };
      });
    },
    [],
  );

  const bumpLastBlock = useCallback(
    async (entry: WatchedPolicy, block: bigint) => {
      // Update the in-memory cursor first so subsequent polls in the same
      // cycle see the advance, then persist. We intentionally do NOT call
      // setEntries here: that would change the `entries` reference, re-run
      // the poll effect, abort the in-flight Promise.all, and starve slower
      // entries.
      const key = entryKey(
        entry.chainId,
        entry.oracleAddress as Address,
        entry.policyId,
        entry.watchedAgentAddress as Address,
      );
      cursorsRef.current.set(key, block);
      try {
        await updateLastCheckedBlock(
          entry.chainId,
          entry.oracleAddress,
          entry.policyId,
          entry.watchedAgentAddress,
          block,
        );
      } catch {
        // persistence errors don't block evaluation
      }
    },
    [],
  );

  // Stable signature over the entry CONFIG fields only (no cursor). Cursor
  // updates flow through cursorsRef and must not invalidate this memo —
  // otherwise the poll effect re-runs, aborts in-flight work, and starves
  // slower entries.
  const entrySignature = useMemo(
    () =>
      JSON.stringify(
        entries.map((e) => [
          e.chainId,
          e.oracleAddress.toLowerCase(),
          e.policyId.toLowerCase(),
          e.watchedAgentAddress.toLowerCase(),
        ]),
      ),
    [entries],
  );
  // Reuse the most recent `entries` reference until the signature actually
  // changes. The dependency on `entrySignature` (a string) means this memo
  // returns the same array reference across cursor-only updates.
  const entryConfigs = useMemo(
    () => entries,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entrySignature],
  );

  const runOnce = useCallback(async () => {
    if (!publicClient) return;
    if (entryConfigs.length === 0) {
      setLastPolledAt(Date.now());
      return;
    }
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setIsPolling(true);

    const controller = new AbortController();
    abortRef.current = controller;
    const ctx: PollContext = {
      publicClient,
      chainId: effectiveChainId,
      oracleAddress: oracle,
      policyCache: policyCacheRef.current,
      traceFailureCounts: traceFailureCountsRef.current,
      txCache: txCacheRef.current,
      signal: controller.signal,
      onViolation: appendViolation,
      onError: appendError,
      onLastBlock: bumpLastBlock,
      onTraceUnavailable: setTraceUnavailableFor,
      onTruncated: setTruncatedFor,
      traceCoverage: traceCoverageRef.current,
    };
    try {
      // Snapshot the live cursor from cursorsRef at poll-launch time so
      // pollOne sees advances made by earlier polls within the same cycle.
      // We must NOT capture entry.lastCheckedBlock from the React-state copy,
      // which is stale by design (cursor updates skip setEntries).
      const liveEntries = entryConfigs.map((e) => {
        const key = entryKey(
          e.chainId,
          e.oracleAddress as Address,
          e.policyId,
          e.watchedAgentAddress as Address,
        );
        const cursor = cursorsRef.current.get(key);
        return cursor === undefined
          ? e
          : { ...e, lastCheckedBlock: cursor.toString() };
      });
      await Promise.all(liveEntries.map((e) => pollOne(e, ctx)));
    } finally {
      inFlightRef.current = false;
      setIsPolling(false);
      setLastPolledAt(Date.now());
      // Snapshot the live counters into React state once per poll cycle.
      // Doing it here (not per tx) keeps the Coverage KPI stable: it ticks
      // forward at the same cadence as `lastPolledAt`, never mid-poll.
      setTraceCoverage({
        successful: traceCoverageRef.current.successful,
        total: traceCoverageRef.current.total,
      });
    }
  }, [
    publicClient,
    entryConfigs,
    effectiveChainId,
    oracle,
    appendViolation,
    appendError,
    bumpLastBlock,
    setTraceUnavailableFor,
    setTruncatedFor,
  ]);

  // 30s poller. Independent of mount of any individual entry; we re-arm the
  // interval each time `entries` changes so adding a watch starts polling
  // immediately without waiting for the next tick. Gated on `hydrated` so
  // the first poll doesn't race the violation hydration.
  useEffect(() => {
    if (!publicClient || entryConfigs.length === 0 || !hydrated) return;
    // Fire once immediately on mount/entries-change so the UI isn't blank
    // for the first 30s.
    runOnce();
    const id = setInterval(() => {
      runOnce();
    }, POLL_INTERVAL_MS);
    return () => {
      clearInterval(id);
      abortRef.current?.abort();
    };
  }, [publicClient, entryConfigs, hydrated, runOnce]);

  const manualPoll = useCallback(async () => {
    await runOnce();
  }, [runOnce]);

  return {
    violations,
    watchedEntries: entries,
    isPolling,
    lastPolledAt,
    errors,
    debugTraceUnavailable,
    truncated,
    traceCoverage,
    manualPoll,
  };
}
