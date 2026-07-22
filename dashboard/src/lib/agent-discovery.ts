import { loaders } from "@shazow/whatsabi";
import type { Hex, Log, PublicClient, TransactionReceipt } from "viem";

/**
 * Agent-side discovery: given an agent (EOA or contract) address, find the
 * (target, selector) pairs the agent has historically called so the policy
 * form can be pre-filled.
 *
 * Data source: debug_traceTransaction with callTracer. Walks the full call
 * tree and records every CALL/CALLCODE/STATICCALL where the agent is the
 * `from` (direct or nested). Selectors are real 4-byte function selectors
 * from input data. If the RPC does not expose debug_traceTransaction we
 * skip the tx and surface `traceFailed` so the UI can show a banner — we
 * deliberately do NOT fall back to receipt logs because log.topics[0] is
 * an event-sig hash, not a function selector, and treating it as one
 * mis-tiers every observation downstream.
 *
 * **Contract-vs-EOA branching**: we eth_getCode the agent address first.
 *   - EOA (code == "0x"): the agent ORIGINATES txs, so we scan txs where
 *     `from == agent` — those are the user-signed intents that hit targets.
 *   - Contract (code present): users invoke the agent contract, so we scan
 *     txs where `to == agent` — the contract is the destination and its
 *     internal calls are what we want to surface.
 * Without this branching, pasting an EOA-agent would yield zero results
 * (EOAs are never `to`), and pasting a token like USDC would yield garbage
 * (every incoming Transfer would be treated as an agent invocation).
 */

const SNOWTRACE_EXPLORER = "https://testnet.snowtrace.io";
const DEFAULT_MAX_TXS = 50;
// Fuji's RPC caps eth_getLogs at 1000 blocks per call (see
// useAgentWatcher.ts FETCH_POLICY_CHUNK_SIZE for the matching constant).
const RPC_LOGS_CHUNK_SIZE = 999n;
// Small RPC-first window for fresh agents. If no recent logs are found we fall
// back to the explorer txlist endpoint below; this keeps the UI responsive for
// quiet or older agents instead of making users wait through a multi-minute
// log scan before seeing anything.
const RPC_LOOKBACK_BLOCKS = 50_000n;

export interface DiscoveredFunction {
  selector: Hex;
  signature?: string;
  callCount: number;
}

export interface CallTarget {
  target: Hex;
  /**
   * Alias of `target`. The publish-flow component reads `.address`; keeping
   * both keeps the two call-sites honest without forcing one to alias the
   * other on every read.
   */
  address: Hex;
  functions: DiscoveredFunction[];
  firstSeenBlock: bigint;
  lastSeenBlock: bigint;
}

/** Back-compat alias for the publish-flow component. */
export type DiscoveredTarget = CallTarget;
export type DiscoverySource = "trace";

export type DiscoverResult =
  | {
      ok: true;
      agentAddress: Hex;
      agentKind: "contract" | "eoa";
      targets: CallTarget[];
      source: "trace";
      txsScanned: number;
      /**
       * True when debug_traceTransaction failed for at least one tx (or
       * every tx). The UI uses this to render a banner explaining that
       * discovery requires trace support.
       */
      traceFailed: boolean;
      warnings: string[];
    }
  | { ok: false; error: string };

export interface DiscoverOpts {
  publicClient: PublicClient;
  explorerUrl?: string;
  maxTxs?: number;
  signal?: AbortSignal;
}

interface ExplorerTx {
  hash: string;
  to: string | null;
  from: string;
  blockNumber: string;
}

interface CallTraceFrame {
  type?: string;
  from?: string;
  to?: string;
  input?: string;
  calls?: CallTraceFrame[];
}

// DELEGATECALL excluded — executes in caller context, not an external call
// under this policy model (the target's code runs but msg.sender stays the
// caller, so attributing the call to the agent as a separate target would
// double-count).
const CALL_OPCODES = new Set(["CALL", "CALLCODE", "STATICCALL"]);

function lower(h: string | null | undefined): string {
  return (h ?? "").toLowerCase();
}

function isHexAddress(s: string): s is Hex {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

function selectorFromInput(input: string | undefined): Hex | null {
  if (!input || typeof input !== "string") return null;
  // Need at least "0x" + 8 hex chars to have a selector.
  if (input.length < 10) return null;
  const sel = input.slice(0, 10).toLowerCase();
  if (!/^0x[0-9a-f]{8}$/.test(sel)) return null;
  return sel as Hex;
}

/**
 * Fetch recent transactions touching `agent` from the Blockscout-style
 * txlist endpoint. We ask for `desc` order so the most recent activity is
 * at the top — useful when maxTxs < total history.
 */
async function fetchTxList(
  agent: Hex,
  explorerUrl: string,
  maxTxs: number,
  signal?: AbortSignal,
): Promise<{ ok: true; txs: ExplorerTx[] } | { ok: false; error: string }> {
  const url =
    `${explorerUrl}/api?module=account&action=txlist` +
    `&address=${agent}&page=1&offset=${maxTxs}&sort=desc`;
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `explorer fetch failed: ${msg}` };
  }
  if (!res.ok) {
    return { ok: false, error: `explorer returned HTTP ${res.status}` };
  }
  let body: { status?: string; message?: string; result?: unknown };
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: "explorer returned non-JSON body" };
  }
  // Blockscout etherscan-compat: status "0" with "No transactions found" is
  // an empty result, not an error. Any other status:"0" is a real failure
  // (rate-limit, bad address, etc).
  if (body.status === "0") {
    const msg = (body.message ?? "").toLowerCase();
    if (msg.includes("no transactions")) return { ok: true, txs: [] };
    return { ok: false, error: `explorer error: ${body.message ?? "unknown"}` };
  }
  if (!Array.isArray(body.result)) {
    return { ok: false, error: "explorer returned malformed result" };
  }
  return { ok: true, txs: body.result as ExplorerTx[] };
}

/**
 * Pure helper: produce [fromBlock, toBlock] inclusive windows walking
 * forwards from `floor` to `head` in `chunkSize`-block chunks. Mirrors
 * `chunkOwnerScanRange` in useAgentWatcher but iterates ascending so the
 * RPC-first discovery path returns txs in chronological order. Each chunk
 * covers at most `chunkSize + 1` blocks, so callers passing the Fuji
 * cap of 999 stay strictly under the 1000-block RPC limit.
 */
function chunkBlockRangeAsc(
  floor: bigint,
  head: bigint,
  chunkSize: bigint = RPC_LOGS_CHUNK_SIZE,
): Array<{ fromBlock: bigint; toBlock: bigint }> {
  if (chunkSize <= 0n) throw new Error("chunkSize must be positive");
  if (head < floor) return [];
  const out: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  let fromBlock = floor;
  while (true) {
    const candidate = fromBlock + chunkSize;
    const toBlock = candidate < head ? candidate : head;
    out.push({ fromBlock, toBlock });
    if (toBlock === head) return out;
    fromBlock = toBlock + 1n;
  }
}

/**
 * Pull every log emitted BY `agent` between `fromBlock` and `toBlock`
 * inclusive, chunked into Fuji-safe windows. RPC-first replacement for
 * the Blockscout txlist endpoint, which has been lagging the RPC node by
 * ~5 days on Fuji (so verified contracts with recent activity return
 * "no transactions"). Logs come straight from the RPC node's index so
 * there's no upstream explorer dependency.
 *
 * Exported for unit tests so the chunker shape is pinned.
 */
export async function fetchAgentEventsViaRpc(
  publicClient: PublicClient,
  agent: Hex,
  fromBlock: bigint,
  toBlock: bigint,
  signal?: AbortSignal,
  chunkSize: bigint = RPC_LOGS_CHUNK_SIZE,
): Promise<Log[]> {
  if (toBlock < fromBlock) return [];
  const chunks = chunkBlockRangeAsc(fromBlock, toBlock, chunkSize);
  const out: Log[] = [];
  for (const { fromBlock: cf, toBlock: ct } of chunks) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
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
 * RPC-first replacement for `fetchTxList`. Reads the agent's emitted logs
 * from the RPC node (chunked, last 7 days), dedups by txHash, then
 * resolves each unique txHash to an `ExplorerTx` via `getTransaction`.
 * Caps the resulting txs at `maxTxs` (newest-first) to match the
 * Blockscout pagination semantics.
 *
 * Tradeoff: getLogs only surfaces txs where the agent EMITTED an event.
 * Agents that don't emit (or EOA agents) yield 0 results here — the
 * Blockscout fallback in `discoverAgentCallSurface` covers that case.
 */
async function fetchTxListViaRpc(
  publicClient: PublicClient,
  agent: Hex,
  maxTxs: number,
  signal?: AbortSignal,
): Promise<{ ok: true; txs: ExplorerTx[] } | { ok: false; error: string }> {
  let head: bigint;
  try {
    head = await publicClient.getBlockNumber();
  } catch (e) {
    return {
      ok: false,
      error: `rpc head block fetch failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const floor = head > RPC_LOOKBACK_BLOCKS ? head - RPC_LOOKBACK_BLOCKS : 0n;
  let logs: Log[];
  try {
    logs = await fetchAgentEventsViaRpc(publicClient, agent, floor, head, signal);
  } catch (e) {
    if (signal?.aborted) return { ok: false, error: "aborted" };
    return {
      ok: false,
      error: `rpc getLogs failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Dedup by txHash. Preserve newest-first ordering to match Blockscout's
  // sort=desc — iterate logs from the end and emit each unique txHash on
  // first sighting.
  const seen = new Set<string>();
  const orderedHashes: Hex[] = [];
  const blockByHash = new Map<string, bigint>();
  for (let i = logs.length - 1; i >= 0; i--) {
    const log = logs[i]!;
    const h = (log.transactionHash ?? "").toLowerCase();
    if (!h || seen.has(h)) continue;
    seen.add(h);
    orderedHashes.push(log.transactionHash as Hex);
    if (log.blockNumber !== null && log.blockNumber !== undefined) {
      blockByHash.set(h, log.blockNumber);
    }
    if (orderedHashes.length >= maxTxs) break;
  }

  const txs: ExplorerTx[] = [];
  for (const hash of orderedHashes) {
    if (signal?.aborted) return { ok: false, error: "aborted" };
    let tx: Awaited<ReturnType<typeof publicClient.getTransaction>> | null;
    try {
      tx = await publicClient.getTransaction({ hash });
    } catch {
      // A single tx fetch failure shouldn't sink the whole batch — skip it
      // and the discovery path can fall back to Blockscout if needed.
      continue;
    }
    // viem's getTransaction returns null when a tx is pruned or the RPC
    // doesn't know the hash. The throw path above covers errors; this
    // guards the null-return path so we don't deref `tx.hash/from/to`.
    if (!tx) continue;
    // Skip pending txs — no blockNumber to anchor the synthesized record.
    if (tx.blockNumber === null || tx.blockNumber === undefined) continue;
    const block = blockByHash.get(hash.toLowerCase()) ?? tx.blockNumber ?? 0n;
    txs.push({
      hash: tx.hash,
      from: tx.from,
      to: tx.to ?? null,
      blockNumber: block.toString(),
    });
  }
  return { ok: true, txs };
}

/**
 * Walk the callTracer tree and collect every (target, selector) where the
 * caller is `agent`. Direct and nested calls both count: if the agent is a
 * contract that delegates to a router which then calls a target, that
 * target IS still part of the agent's effective call surface.
 */
function walkTrace(
  frame: CallTraceFrame,
  agent: string,
  out: Array<{ target: Hex; selector: Hex }>,
): void {
  const callType = (frame.type ?? "").toUpperCase();
  if (
    CALL_OPCODES.has(callType) &&
    lower(frame.from) === agent &&
    frame.to &&
    isHexAddress(frame.to) &&
    // Skip recursive self-calls — the agent calling itself isn't a target
    // on its call surface.
    lower(frame.to) !== agent
  ) {
    const sel = selectorFromInput(frame.input);
    if (sel) {
      out.push({ target: lower(frame.to) as Hex, selector: sel });
    }
  }
  if (Array.isArray(frame.calls)) {
    for (const child of frame.calls) walkTrace(child, agent, out);
  }
}

interface PairBucket {
  signature?: string;
  callCount: number;
}

interface TargetBucket {
  pairs: Map<string, PairBucket>; // selector -> bucket
  firstSeenBlock: bigint;
  lastSeenBlock: bigint;
}

function recordPair(
  buckets: Map<string, TargetBucket>,
  target: Hex,
  selector: Hex,
  block: bigint,
): void {
  const tKey = target.toLowerCase();
  let bucket = buckets.get(tKey);
  if (!bucket) {
    bucket = { pairs: new Map(), firstSeenBlock: block, lastSeenBlock: block };
    buckets.set(tKey, bucket);
  } else {
    if (block < bucket.firstSeenBlock) bucket.firstSeenBlock = block;
    if (block > bucket.lastSeenBlock) bucket.lastSeenBlock = block;
  }
  const pair = bucket.pairs.get(selector);
  if (pair) {
    pair.callCount += 1;
  } else {
    bucket.pairs.set(selector, { callCount: 1 });
  }
}

/**
 * Run `fn` over `items` in parallel chunks of `chunkSize`. Each chunk
 * awaits as a Promise.all before the next chunk starts — bounded
 * concurrency, so we hammer the RPC without flooding it.
 */
async function batchParallel<T, U>(
  items: T[],
  chunkSize: number,
  fn: (item: T) => Promise<U>,
): Promise<U[]> {
  const out: U[] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const results = await Promise.all(chunk.map(fn));
    out.push(...results);
  }
  return out;
}

/**
 * Best-effort openchain signature resolution. Selectors that fail to resolve
 * (network error, no candidates) just stay nameless — we never let the
 * lookup break discovery. Only 4-byte function selectors are resolved;
 * event-sig hashes (32-byte topic0 from the logs path) are skipped because
 * openchain's function endpoint doesn't index them.
 */
async function resolveSignatures(
  buckets: Map<string, TargetBucket>,
  signal?: AbortSignal,
): Promise<void> {
  const lookup = new loaders.OpenChainSignatureLookup();
  const allSelectors: string[] = [];
  const seen = new Set<string>();
  for (const bucket of buckets.values()) {
    for (const sel of bucket.pairs.keys()) {
      if (/^0x[0-9a-f]{8}$/.test(sel) && !seen.has(sel)) {
        seen.add(sel);
        allSelectors.push(sel);
      }
    }
  }
  const resolved = new Map<string, string>();
  const lookups = await batchParallel(allSelectors, 10, async (sel) => {
    if (signal?.aborted) return null;
    try {
      const sigs = await lookup.loadFunctions(sel);
      if (sigs && sigs.length > 0) return { sel, sig: sigs[0] };
    } catch {
      // swallow — naming is best-effort
    }
    return null;
  });
  for (const entry of lookups) {
    if (entry) resolved.set(entry.sel, entry.sig);
  }
  for (const bucket of buckets.values()) {
    for (const [sel, pair] of bucket.pairs) {
      const sig = resolved.get(sel);
      if (sig) pair.signature = sig;
    }
  }
}

// ERC-20 / ERC-721 Transfer(address,address,uint256) topic — used to detect
// when the pasted address is a token contract (which produces useless,
// noisy discovery results).
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export async function discoverAgentCallSurface(
  agentAddress: string,
  opts: DiscoverOpts,
): Promise<DiscoverResult> {
  if (!isHexAddress(agentAddress)) {
    return { ok: false, error: "agentAddress is not a 40-hex address" };
  }
  const agent = agentAddress.toLowerCase() as Hex;
  const explorerUrl = opts.explorerUrl ?? SNOWTRACE_EXPLORER;
  const maxTxs = opts.maxTxs ?? DEFAULT_MAX_TXS;

  // Branch on the agent's account kind. EOAs originate txs (filter
  // from==agent); contracts are invoked by users (filter to==agent). Without
  // this, an EOA-agent yields zero results and a token address yields garbage.
  let agentKind: "contract" | "eoa";
  try {
    const code = await opts.publicClient.getCode({ address: agent });
    agentKind = code && code !== "0x" ? "contract" : "eoa";
  } catch {
    // If we can't classify, assume contract — the original behaviour. We
    // surface no warning here; the empty-results case below is informative
    // enough on its own.
    agentKind = "contract";
  }

  // RPC-first tx discovery. Fuji Blockscout lags the RPC node by ~5
  // days, so for active contracts txlist returns "no transactions" while
  // the RPC log index is realtime. For contract agents we read the agent's
  // emitted logs and resolve their txs. For EOAs, getLogs returns nothing
  // (EOAs can't emit), so we skip straight to Blockscout.
  //
  // The Blockscout fallback also runs when the RPC path returns zero
  // events — covers contract agents that don't emit on every entry point.
  let list: { ok: true; txs: ExplorerTx[] } | { ok: false; error: string };
  if (agentKind === "contract") {
    const rpc = await fetchTxListViaRpc(
      opts.publicClient,
      agent,
      maxTxs,
      opts.signal,
    );
    if (rpc.ok && rpc.txs.length > 0) {
      list = rpc;
    } else {
      // RPC failed OR returned no events — fall through to Blockscout.
      list = await fetchTxList(agent, explorerUrl, maxTxs, opts.signal);
    }
  } else {
    list = await fetchTxList(agent, explorerUrl, maxTxs, opts.signal);
  }
  if (!list.ok) return list;

  // EOAs: the agent IS the sender of user-signed intents.
  // Contracts: users send txs TO the agent contract, which then dispatches.
  const invocations =
    agentKind === "eoa"
      ? list.txs.filter((t) => lower(t.from) === agent)
      : list.txs.filter((t) => lower(t.to) === agent);
  if (invocations.length === 0) {
    return {
      ok: true,
      agentAddress: agent,
      agentKind,
      targets: [],
      source: "trace",
      txsScanned: 0,
      traceFailed: false,
      warnings: [],
    };
  }

  const warnings: string[] = [];
  const buckets = new Map<string, TargetBucket>();
  let traceFailed = false;
  let txsScanned = 0;
  // Track whether ANY scanned receipt emitted a Transfer event from the
  // agent address itself — the smoking gun that we're looking at a token,
  // not an agent contract.
  let agentEmittedTransfer = false;

  // Fetch receipts in parallel chunks rather than serially. Each invocation
  // is independent; we just need bounded concurrency to be polite to the
  // RPC. The trace path runs serially inside the per-tx loop because
  // `traceUnsupported` is a sticky decision that affects subsequent calls.
  const receipts = await batchParallel(invocations, 10, async (tx) => {
    if (opts.signal?.aborted) return { tx, receipt: null as TransactionReceipt | null };
    try {
      const r = await opts.publicClient.getTransactionReceipt({ hash: tx.hash as Hex });
      return { tx, receipt: r };
    } catch {
      return { tx, receipt: null };
    }
  });

  for (const { tx, receipt } of receipts) {
    if (opts.signal?.aborted) return { ok: false, error: "aborted" };
    const hash = tx.hash as Hex;
    if (!receipt) {
      warnings.push(`receipt missing for ${hash}; skipped`);
      continue;
    }
    const block = receipt.blockNumber;

    // Detect token-like behaviour: any log from the agent address itself
    // with the Transfer topic. We only check on contract agents because an
    // EOA can't emit events.
    if (agentKind === "contract" && !agentEmittedTransfer) {
      for (const log of receipt.logs) {
        if (
          lower(log.address) === agent &&
          lower(log.topics[0] ?? "") === TRANSFER_TOPIC
        ) {
          agentEmittedTransfer = true;
          break;
        }
      }
    }

    const pairs: Array<{ target: Hex; selector: Hex }> = [];

    // Trace is the only supported data source. If the RPC rejects
    // debug_traceTransaction we skip the tx and flag traceFailed so the UI
    // can render a banner — we never fall back to receipt logs because
    // log.topics[0] is an event-sig hash, not a 4-byte selector.
    try {
      const trace = (await opts.publicClient.request({
        // viem types the public request method narrowly; debug_* isn't in
        // its known method union, so cast at the boundary.
        method: "debug_traceTransaction" as never,
        params: [hash, { tracer: "callTracer" }] as never,
      })) as CallTraceFrame;
      walkTrace(trace, agent, pairs);
    } catch {
      traceFailed = true;
      continue;
    }

    for (const { target, selector } of pairs) {
      recordPair(buckets, target, selector, block);
    }
    txsScanned += 1;
  }

  if (traceFailed && txsScanned === 0) {
    warnings.unshift(
      "Discovery requires debug_traceTransaction. Your RPC does not support it. No call surface could be extracted from these txs.",
    );
  } else if (traceFailed) {
    warnings.unshift(
      "Some txs could not be traced (debug_traceTransaction rejected); results may be incomplete.",
    );
  }

  // Token-warning heuristic: a contract that maxed out the txlist AND
  // emitted a Transfer event is almost certainly a token, not an agent.
  // We hoist this to the front of `warnings` so the UI shows it first.
  if (
    agentKind === "contract" &&
    list.txs.length === maxTxs &&
    agentEmittedTransfer
  ) {
    warnings.unshift(
      "This address looks like a token, not an agent. Discovery will return noisy results. Use a contract you wrote/own as the agent.",
    );
  }

  await resolveSignatures(buckets, opts.signal);

  const targetTotals: Array<{ target: CallTarget; total: number }> = [];
  for (const [target, bucket] of buckets) {
    const functions = Array.from(bucket.pairs.entries())
      .map(([selector, pair]) => ({
        selector: selector as Hex,
        ...(pair.signature ? { signature: pair.signature } : {}),
        callCount: pair.callCount,
      }))
      .sort((a, b) => b.callCount - a.callCount);
    const totalCalls = functions.reduce((s, f) => s + f.callCount, 0);
    targetTotals.push({
      target: {
        target: target as Hex,
        address: target as Hex,
        functions,
        firstSeenBlock: bucket.firstSeenBlock,
        lastSeenBlock: bucket.lastSeenBlock,
      },
      total: totalCalls,
    });
  }
  targetTotals.sort((a, b) => b.total - a.total);
  const targets: CallTarget[] = targetTotals.map((t) => t.target);

  return {
    ok: true,
    agentAddress: agent,
    agentKind,
    targets,
    source: "trace",
    txsScanned,
    traceFailed,
    warnings,
  };
}
