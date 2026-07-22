import {
  decodeFunctionData,
  parseAbiItem,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { WARD_ORACLE_ABI, type PolicyInput } from "@ward/sdk";

/**
 * Universal recovery of the most recent `PolicyInput` for a policy by decoding
 * the calldata of its most recent `publishPolicy` / `updatePolicy` transaction.
 *
 * Used when the original POLICY.md is not in publishedCache — e.g. the policy
 * was published from a different browser, a CLI session, or after the user
 * cleared site data. Because every active policy must have at least one
 * `publishPolicy` or `updatePolicy` tx, the calldata is the canonical
 * post-publish source of the full struct, recoverable client-side without
 * any contract changes.
 *
 * Strategy: chunked backward walk through the requested block range with the
 * Shannon RPC 1000-block cap. For each chunk, run two topic-filtered
 * `getLogs` calls (one for `PolicyPublished`, one for `PolicyUpdated`) scoped
 * by `policyId`. Short-circuit on the first chunk that returns at least one
 * log; the latest log in that chunk wins (largest blockNumber, then largest
 * logIndex). Then `getTransaction(hash)` and `decodeFunctionData` against the
 * matching ABI item to extract the `PolicyInput`.
 *
 * The search window can be large (millions of blocks on Shannon), so we
 * serialize chunks and never fan out — first-match-wins finishes fast in the
 * common case where the policy was published or last updated recently.
 *
 * When `publishedBlockHint` is supplied (e.g. from EventStore meta), we
 * collapse the worst case from "head → deployment block" to "head →
 * publishedBlock" because a policy cannot be updated before it was published.
 * We also try a single direct `getLogs({fromBlock: hint, toBlock: hint})`
 * fast-path first — if the publish event lives at the hinted block and no
 * later update exists, recovery resolves in two RPC calls (publish probe +
 * one chunked update scan) instead of a full backward walk.
 *
 * Returns `null` when no publish/update tx is found in the entire window.
 * Throws when a tx is found but decoding fails (e.g. an older PolicyInput
 * struct shape that no longer matches the current ABI) — callers should
 * catch and surface as "could not recover" rather than crash.
 */

const POLICY_PUBLISHED_EVENT = parseAbiItem(
  "event PolicyPublished(bytes32 indexed policyId, address indexed owner, bytes32 label)",
);
const POLICY_UPDATED_EVENT = parseAbiItem(
  "event PolicyUpdated(bytes32 indexed policyId, address indexed owner)",
);

// Shannon caps eth_getLogs at 1000 blocks per call. Match the same value used
// by onChainPolicyLookup so we stay safely under the cap.
const DEFAULT_CHUNK_SIZE = 999n;

export interface RecoveredPolicyInput {
  policyInput: PolicyInput;
  txHash: Hex;
  blockNumber: bigint;
  functionName: "publishPolicy" | "updatePolicy";
}

export interface RecoverPolicyInputOpts {
  publicClient: PublicClient;
  oracleAddress: Address;
  policyId: Hex;
  /** Oldest block to scan (inclusive). Typically the oracle's deployment
   *  block — the policy can't exist before its oracle did. */
  fromBlock: bigint;
  /** Newest block to scan (inclusive). Defaults to `getBlockNumber()`. */
  toBlock?: bigint;
  /** Chunk width. Defaults to 999 (Shannon RPC cap of 1000). */
  chunkSize?: bigint;
  /**
   * Known publishedBlock from the EventStore meta. When provided, the
   * chunked walk anchors at this block instead of crawling from head to
   * `fromBlock`: anything before it is impossible (a policy can't be
   * updated before it was published) so we cap the effective floor at
   * `max(publishedBlockHint, fromBlock)`. We also try a one-shot getLogs
   * at the hinted block first — if it returns the publish event and no
   * later update exists, we skip the backward walk entirely.
   *
   * When the hint turns out to be stale (the on-chain publish event is
   * NOT at the hinted block) we fall back to a full walk from `fromBlock`
   * rather than the anchored hint — anchoring on a wrong hint would let
   * the real (older) publish slip below the floor and recovery would
   * return null for a policy that does exist.
   */
  publishedBlockHint?: bigint;
  /**
   * Known lastUpdatedBlock from the EventStore meta. When equal to
   * `publishedBlockHint`, the policy has never been updated — the publish
   * tx is the canonical PolicyInput and the chunked forward update-scan
   * (which would otherwise crawl ~head-publish chunks on Shannon) is
   * unnecessary. When strictly greater, fetch the latest update at the
   * hinted block directly (one getLogs call, no chunked walk).
   *
   * Always validated against chain: if the on-chain event at the hinted
   * block is missing, fall back to the full deployment-floor walk (NOT
   * to the hint — see `publishedBlockHint` for the same stale-hint
   * fallback rule).
   */
  lastUpdatedBlockHint?: bigint;
}

interface MinimalLog {
  blockNumber: bigint | null;
  logIndex: number | null;
  transactionHash: Hex | null;
}

/**
 * Pick the most recent log out of a chunk's combined publish+update results.
 * "Most recent" = highest blockNumber, breaking ties on logIndex. Logs missing
 * either field are skipped (viem populates both on real chain hits — this is
 * defensive only).
 */
function pickLatest(logs: MinimalLog[]): MinimalLog | null {
  let best: MinimalLog | null = null;
  for (const log of logs) {
    if (log.blockNumber === null || log.logIndex === null) continue;
    if (
      !best ||
      best.blockNumber === null ||
      log.blockNumber > best.blockNumber ||
      (log.blockNumber === best.blockNumber &&
        (best.logIndex === null || log.logIndex > best.logIndex))
    ) {
      best = log;
    }
  }
  return best;
}

/** Resolve a hit log to a decoded `RecoveredPolicyInput`. Returns `null` when
 *  the tx targets a non-publish/update method (e.g. a multicall wrapper that
 *  re-emits the event from a different selector) so the caller can keep
 *  walking. Throws when the calldata is structurally broken — bubbled up to
 *  the original caller as "could not recover". */
async function decodeHit(
  publicClient: PublicClient,
  hit: MinimalLog,
): Promise<RecoveredPolicyInput | null> {
  if (!hit.transactionHash) return null;
  const txHash = hit.transactionHash;
  const tx = await publicClient.getTransaction({ hash: txHash });
  const decoded = decodeFunctionData({
    abi: WARD_ORACLE_ABI,
    data: tx.input,
  });
  if (
    decoded.functionName !== "publishPolicy" &&
    decoded.functionName !== "updatePolicy"
  ) {
    return null;
  }
  // Both signatures place the PolicyInput tuple at the LAST arg index:
  //   publishPolicy(bytes32 label, PolicyInput input)            -> args[1]
  //   updatePolicy(bytes32 policyId, PolicyInput input)          -> args[1]
  const policyInput = (decoded.args as readonly unknown[])[1] as PolicyInput;
  return {
    policyInput,
    txHash,
    blockNumber: hit.blockNumber ?? 0n,
    functionName: decoded.functionName,
  };
}

/** Scan `[fromBlock, toBlock]` backward in chunks looking for the most recent
 *  publish/update log. Returns the first hit (which, walking backward, is the
 *  most recent), `null` if nothing was found, or throws on decode failure.
 *
 *  A `Promise.all` over publish + update getLogs makes each chunk atomic — if
 *  EITHER side fails the whole chunk is treated as failed, preventing the
 *  partial-result bug where an Updated-side RPC blip would let an older
 *  Published log win and decode to stale PolicyInput. */
async function scanRange(
  publicClient: PublicClient,
  oracleAddress: Address,
  policyId: Hex,
  fromFloor: bigint,
  toHead: bigint,
  chunkSize: bigint,
): Promise<RecoveredPolicyInput | null> {
  if (toHead < fromFloor) return null;
  let toBlock = toHead;
  while (true) {
    const fromBlock =
      toBlock > fromFloor + chunkSize - 1n ? toBlock - chunkSize + 1n : fromFloor;

    let chunkOk = true;
    let publishedLogs: MinimalLog[] = [];
    let updatedLogs: MinimalLog[] = [];
    try {
      [publishedLogs, updatedLogs] = (await Promise.all([
        publicClient.getLogs({
          address: oracleAddress,
          event: POLICY_PUBLISHED_EVENT,
          args: { policyId },
          fromBlock,
          toBlock,
        }),
        publicClient.getLogs({
          address: oracleAddress,
          event: POLICY_UPDATED_EVENT,
          args: { policyId },
          fromBlock,
          toBlock,
        }),
      ])) as unknown as [MinimalLog[], MinimalLog[]];
    } catch {
      // Either getLogs failed — skip this chunk to avoid the stale-recovery
      // race where a publish-only result outlives an updated-side blip and
      // wins pickLatest. Continue walking back; a real "policy exists" will
      // be found in a healthier chunk on a subsequent iteration.
      chunkOk = false;
    }

    if (chunkOk) {
      const latest = pickLatest([...publishedLogs, ...updatedLogs]);
      if (latest) {
        const result = await decodeHit(publicClient, latest);
        if (result) return result;
        // Non-publish/update tx — keep walking past this chunk.
      }
    }

    if (fromBlock <= fromFloor) return null;
    toBlock = fromBlock - 1n;
  }
}

export async function recoverPolicyInputFromChain(
  opts: RecoverPolicyInputOpts,
): Promise<RecoveredPolicyInput | null> {
  const { publicClient, oracleAddress, policyId, publishedBlockHint, lastUpdatedBlockHint } = opts;
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const head = opts.toBlock ?? (await publicClient.getBlockNumber());
  if (head < opts.fromBlock) return null;

  // The EventStore meta tracks lastUpdatedBlock from the live watcher, so we
  // know the exact block of the most-recent state-defining tx. One getLogs
  // call at that block (publish if never updated, otherwise update) replaces
  // the chunked forward update-scan that would otherwise crawl up to ~1M
  // blocks between publish and head on Shannon. Recovery collapses to two
  // RPC calls (getLogs + getTransaction).
  //
  // Stale-hint rule: when the probe finds nothing at the hinted block, the
  // meta is wrong (reindex, manual IDB edit, etc.) — fall back to the FULL
  // walk anchored at opts.fromBlock, not at any hint. Anchoring on a wrong
  // hint would put the real event below the floor and return null.
  if (
    publishedBlockHint !== undefined &&
    lastUpdatedBlockHint !== undefined &&
    publishedBlockHint >= opts.fromBlock &&
    publishedBlockHint <= head &&
    lastUpdatedBlockHint >= publishedBlockHint &&
    lastUpdatedBlockHint <= head
  ) {
    if (lastUpdatedBlockHint === publishedBlockHint) {
      // Policy never updated since publish — the publish tx is canonical.
      let publishHit: MinimalLog | null = null;
      try {
        const publishLogs = (await publicClient.getLogs({
          address: oracleAddress,
          event: POLICY_PUBLISHED_EVENT,
          args: { policyId },
          fromBlock: publishedBlockHint,
          toBlock: publishedBlockHint,
        })) as unknown as MinimalLog[];
        publishHit = pickLatest(publishLogs);
      } catch {
        // Probe failed — drop through to the full walk.
      }
      if (publishHit) {
        const result = await decodeHit(publicClient, publishHit);
        if (result) return result;
        // Tx wasn't a direct publish (multicall-wrapped, etc.) — fall through.
      }
    } else {
      // Updates exist — the most recent one at lastUpdatedBlockHint is canonical.
      let updateHit: MinimalLog | null = null;
      try {
        const updateLogs = (await publicClient.getLogs({
          address: oracleAddress,
          event: POLICY_UPDATED_EVENT,
          args: { policyId },
          fromBlock: lastUpdatedBlockHint,
          toBlock: lastUpdatedBlockHint,
        })) as unknown as MinimalLog[];
        updateHit = pickLatest(updateLogs);
      } catch {
        // Probe failed — drop through to the full walk.
      }
      if (updateHit) {
        const result = await decodeHit(publicClient, updateHit);
        if (result) return result;
        // Tx wasn't a direct update — fall through.
      }
    }
    // Hint went stale or decoded non-publish/update — fall through to the
    // full backward walk from opts.fromBlock (NOT from the hint).
    return scanRange(publicClient, oracleAddress, policyId, opts.fromBlock, head, chunkSize);
  }

  // When we have publish but not last-updated, probe the publish block to
  // confirm it lives there. If so, anchor the forward update-scan at
  // publishedBlockHint+1 (much smaller than head → deployment) and return
  // the more recent of the two. Falls back to the full backward walk from
  // opts.fromBlock when the publish event is NOT at the hinted block —
  // anchoring at the stale hint would hide the real (older) event.
  if (publishedBlockHint !== undefined && publishedBlockHint <= head && publishedBlockHint >= opts.fromBlock) {
    let publishHit: MinimalLog | null = null;
    try {
      const publishLogs = (await publicClient.getLogs({
        address: oracleAddress,
        event: POLICY_PUBLISHED_EVENT,
        args: { policyId },
        fromBlock: publishedBlockHint,
        toBlock: publishedBlockHint,
      })) as unknown as MinimalLog[];
      publishHit = pickLatest(publishLogs);
    } catch {
      // Hint probe failed — drop through to the full walk.
    }
    if (publishHit) {
      // Check for updates strictly AFTER publish. If any update exists,
      // its decoded PolicyInput wins (it's the most recent). Otherwise
      // the publish tx is the canonical struct.
      if (publishedBlockHint < head) {
        const updateScan = await scanRange(
          publicClient,
          oracleAddress,
          policyId,
          publishedBlockHint + 1n,
          head,
          chunkSize,
        );
        if (updateScan) return updateScan;
      }
      const result = await decodeHit(publicClient, publishHit);
      if (result) return result;
      // Publish tx targets a non-publish method (shouldn't happen for a
      // direct publish, but defend against multicall-wrapped publishes).
      // Drop through to the full walk just in case.
    }
    // Hint stale or non-decodable — fall back to FULL walk from opts.fromBlock
    // (not anchored at the hint, which would hide the real publish below it).
    return scanRange(publicClient, oracleAddress, policyId, opts.fromBlock, head, chunkSize);
  }

  // Fallback: no hints at all — full chunked backward walk from head to
  // opts.fromBlock (typically the oracle's deployment block).
  return scanRange(publicClient, oracleAddress, policyId, opts.fromBlock, head, chunkSize);
}

// React StrictMode double-fires effects in dev and rapid drawer-row clicks
// can stack overlapping recovery scans for the same policy. Cleanup with a
// `cancelled` flag only suppresses setState; the underlying getLogs walk
// keeps running. A module-level inflight map collapses concurrent calls for
// the same (chainId, oracle, policyId) tuple into a single promise so the
// RPC walk only happens once. The entry is dropped on settle so subsequent
// re-opens (e.g. after a snapshotKey bump) start fresh.

const inflight = new Map<string, Promise<RecoveredPolicyInput | null>>();

function inflightKey(
  chainId: number,
  oracleAddress: Address,
  policyId: Hex,
): string {
  return `${chainId}:${oracleAddress.toLowerCase()}:${policyId.toLowerCase()}`;
}

export interface DedupedRecoverOpts extends RecoverPolicyInputOpts {
  /** Chain id used to namespace the inflight key alongside oracle+policyId.
   *  Required because the same oracle address could exist on multiple chains
   *  during local testing. */
  chainId: number;
}

/**
 * Same as `recoverPolicyInputFromChain` but shares one in-flight promise per
 * `(chainId, oracleAddress, policyId)` tuple. Two concurrent callers receive
 * the same promise and only one chain walk runs. Used by PolicyDrawer so
 * StrictMode double-fires and rapid drawer-row clicks don't stack scans.
 */
export function recoverPolicyInputFromChainDeduped(
  opts: DedupedRecoverOpts,
): Promise<RecoveredPolicyInput | null> {
  const key = inflightKey(opts.chainId, opts.oracleAddress, opts.policyId);
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = recoverPolicyInputFromChain(opts).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}
