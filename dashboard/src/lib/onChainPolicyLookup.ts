import {
  decodeFunctionData,
  hexToString,
  parseAbiItem,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { SENTRY_ORACLE_ABI } from "@sentry-somnia/sdk";

const POLICY_PUBLISHED_EVENT = parseAbiItem(
  "event PolicyPublished(bytes32 indexed policyId, address indexed owner, bytes32 label)",
);
const POLICY_UPDATED_EVENT = parseAbiItem(
  "event PolicyUpdated(bytes32 indexed policyId, address indexed owner)",
);

/**
 * Direct on-chain lookup of a policy, used by the publish-reveal panel
 * when the EventStore + localStorage cache both miss the policy.
 *
 * Returns `publisher` (from `policyOwner`), `paused` + `expiresAt` (from
 * `policyHealth`), and `label` + `publishBlock` + `txHash` (from a
 * topic-filtered `eth_getLogs` for `PolicyPublished`). The event does NOT
 * carry the full `PolicyInput` (targets/selectors/caps), so per-target
 * details are not recoverable from chain alone.
 */

export interface OnChainPolicySnapshot {
  /** Discriminant — `"found-with-label"` when the event scan recovered the
   *  publish log (so `label` + `labelHex` + `publishBlock` + `txHash` are
   *  populated), `"found-no-label"` when only the read-method branch
   *  succeeded. Both indicate "found on chain"; callers should not re-probe
   *  just because `label` is undefined. Absent / RPC-failure states live on
   *  `LookupPolicyOnChainResult`. */
  kind: "found-with-label" | "found-no-label";
  /** True iff the publish log was recovered; mirror of kind === 'found-with-label'. */
  labelRecovered: boolean;
  policyId: Hex;
  publisher: Address;
  paused: boolean;
  expiresAt: bigint;
  /** Decoded UTF-8 label; undefined unless labelRecovered. */
  label?: string;
  /** Raw bytes32 label; undefined unless labelRecovered. */
  labelHex?: Hex;
  publishBlock?: bigint;
  txHash?: Hex;
}

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;

// Shannon RPC caps eth_getLogs at 1000 blocks per call. Scan recent history
// in chunks of CHUNK_SIZE walking backwards from `latest`. STOP after either:
//   - finding the event (single hit by policyId topic)
//   - hitting MAX_BACK_BLOCKS without a hit (the policy is older than this
//     window and the user should bookmark from their original publish session)
const CHUNK_SIZE = 999n; // stay under the 1000 hard cap
const MAX_BACK_BLOCKS = 5_000_000n; // ~58 days at 1s blocks — far enough to catch any recent publish

async function findPublishedEvent(
  client: PublicClient,
  oracleAddress: Address,
  policyId: Hex,
): Promise<{ block: bigint; txHash: Hex; label: Hex; owner: Address } | null> {
  const head = await client.getBlockNumber();
  let toBlock = head;
  // Walk backwards, chunk by chunk. Early-return on first hit.
  while (true) {
    const fromBlock = toBlock > CHUNK_SIZE ? toBlock - CHUNK_SIZE : 0n;
    try {
      const logs = await client.getLogs({
        address: oracleAddress,
        event: POLICY_PUBLISHED_EVENT,
        args: { policyId },
        fromBlock,
        toBlock,
      });
      for (const log of logs) {
        if (!log.args || log.args.policyId?.toLowerCase() !== policyId.toLowerCase()) continue;
        return {
          block: log.blockNumber ?? 0n,
          txHash: log.transactionHash ?? ("0x" as Hex),
          label: log.args.label ?? ("0x" as Hex),
          owner: (log.args.owner ?? ("0x0000000000000000000000000000000000000000" as Address)) as Address,
        };
      }
    } catch {
      // RPC quirk on this chunk — skip and walk back. Worst case we miss
      // the event entirely; the caller renders the partial snapshot
      // without label/tx fields.
    }
    if (fromBlock === 0n) return null;
    if (head - fromBlock >= MAX_BACK_BLOCKS) return null;
    toBlock = fromBlock - 1n;
  }
}

// Block depth trimmed from `toBlock` so we never persist a checkpoint inside
// the reorg-unsafe tail. Mirrors persistence.ts REORG_DEPTH (12n on Shannon);
// duplicated to keep this file dependency-free of the persistence module.
const REORG_DEPTH_BLOCKS = 12n;

/** Per-chunk progress payload fired by `lookupPoliciesByOwner` after each
 *  chunked getContractEvents call. `totalChunks` is stable across firings;
 *  `scannedToBlock` is the chunk's inclusive `toBlock` (distinct from the
 *  contiguous-success cursor in the result). */
export interface LookupPoliciesByOwnerProgress {
  chunkIdx: number;
  totalChunks: number;
  scannedToBlock: bigint;
  foundCount: number;
}

export interface LookupPoliciesByOwnerArgs {
  publicClient: PublicClient;
  oracleAddress: Address;
  owner: Address;
  /** Inclusive lower bound. Use the persisted checkpoint when resuming a
   *  prior scan; pass 0n for a cold scan from genesis. */
  fromBlock: bigint;
  /** Inclusive upper bound. Typically `await publicClient.getBlockNumber()`. */
  toBlock: bigint;
  /** Chunk width passed to getContractEvents. Defaults to 1000 (Shannon cap). */
  chunkSize?: bigint;
  /** Fired after every chunk attempt (success OR failure). Errors thrown by
   *  the callback are swallowed so a buggy subscriber can't abort the scan. */
  onProgress?: (info: LookupPoliciesByOwnerProgress) => void;
  /** Cooperative cancellation token. Checked BEFORE issuing each chunk's RPC.
   *  On abort, the chunker returns what it has collected with `scannedToBlock`
   *  reflecting the highest contiguous-success cursor reached so far. */
  signal?: AbortSignal;
}

/**
 * Per-policy metadata extracted directly from the decoded PolicyPublished log.
 * Carries the policyId topic, the non-indexed bytes32 label, the publish
 * block, and the publisher (indexed `owner` topic). Forwarding all fields
 * lets the owner-scan caller hydrate PolicyMeta without extra RPC round-trips.
 */
export interface OwnerScanPolicy {
  policyId: Hex;
  /** Raw bytes32 label as it appeared on chain. An all-zero value is a
   *  legitimate empty label — NOT a missing-label sentinel. */
  labelHex: Hex;
  publishBlock: bigint;
  /** Indexed `owner` topic from the log. Equals the `owner` arg passed to
   *  `lookupPoliciesByOwner`. */
  publisher: Address;
}

export interface LookupPoliciesByOwnerResult {
  /** Discovered policies in chain order (de-duped by policyId, first-seen
   *  metadata wins). Only contains hits from the reorg-safe window
   *  `[fromBlock, toBlock-12]`. */
  policies: OwnerScanPolicy[];
  /** Highest block verified in a contiguous run of successful chunks
   *  starting at `fromBlock`. The first chunk failure caps it at the end
   *  of the prior successful chunk (or `fromBlock - 1` if the first chunk
   *  itself failed) so the persisted cursor never skips past unverified
   *  blocks. Returns `fromBlock - 1` (clamped to 0n) when there's nothing
   *  safe to scan yet. */
  scannedToBlock: bigint;
}

/**
 * Owner-keyed scan of PolicyPublished. Topic-filtered eth_getLogs across the
 * reorg-safe window `[fromBlock, toBlock - REORG_DEPTH_BLOCKS]` in chunks
 * of `chunkSize` (default 1000, matching Shannon's RPC cap), returning the
 * discovered policyIds plus a reorg-safe checkpoint for the next resume.
 * The unsafe tail is never scanned so a reorg there can't leave a phantom
 * entry in the caller's owner index.
 *
 * Chunks that throw do NOT advance `scannedToBlock`: the watermark tracks
 * the highest contiguous-success run starting at `fromBlock`, so the first
 * failure caps the cursor and the next scan retries the gap. Discovered
 * policyIds from chunks after the gap are still returned (caller dedupes).
 */
export async function lookupPoliciesByOwner(
  args: LookupPoliciesByOwnerArgs,
): Promise<LookupPoliciesByOwnerResult> {
  const { publicClient, oracleAddress, owner, fromBlock, toBlock, onProgress, signal } = args;
  const chunkSize = args.chunkSize ?? CHUNK_SIZE + 1n; // CHUNK_SIZE is 999; +1 so the default span is 1000

  // Inverted range short-circuit (fromBlock > toBlock). Returns the caller's
  // prior cursor (= fromBlock - 1, assuming `fromBlock = lastSeenBlock + 1`)
  // so an empty/backwards window — e.g. rapid block-time jitter or a
  // reorg-aware caller that pre-rewound its cursor past head — is treated
  // as "nothing new to scan" and the persisted lastSeenBlock stays put.
  // Critically, this does NOT fall through to the `safeToBlock < fromBlock`
  // branch below, which would clamp to the reorg-trimmed safeToBlock and
  // could REWIND a cursor that's already further along than head.
  if (fromBlock > toBlock) {
    return {
      policies: [],
      scannedToBlock: fromBlock > 0n ? fromBlock - 1n : 0n,
    };
  }

  // Trim the upper bound to the reorg-safe block before chunking so the
  // discovered policyIds only come from finalized blocks.
  const safeToBlock = toBlock > REORG_DEPTH_BLOCKS ? toBlock - REORG_DEPTH_BLOCKS : 0n;

  // Nothing safe to scan yet; same cursor-preservation rule as above.
  if (safeToBlock < fromBlock) {
    return {
      policies: [],
      scannedToBlock: fromBlock > 0n ? fromBlock - 1n : 0n,
    };
  }

  // Total chunk count for the safe window — static denominator for the
  // progress payload only; chunker control flow drives off `from <= safeToBlock`.
  // ceil(span / chunkSize) computed without floats to keep bigint arithmetic exact.
  const spanBlocks = safeToBlock - fromBlock + 1n;
  const totalChunksBig = (spanBlocks + chunkSize - 1n) / chunkSize;
  const totalChunks = Number(totalChunksBig);
  let chunkIdx = 0;
  // Dedupe by lowercase policyId hex; preserve first-seen metadata. Defensive
  // against the same chunk being retried (oracle reverts duplicate publishes).
  const seen = new Map<string, OwnerScanPolicy>();
  // `nextContiguousStart`: the block a successful chunk must start at to
  // extend the contiguous-success run. Any failure leaves it behind the
  // current chunk's `from`, permanently blocking further watermark advances.
  let nextContiguousStart = fromBlock;
  // Highest verified block in the contiguous-success prefix. Starts one below
  // `fromBlock` so "all chunks failed" doesn't advance past the prior cursor.
  let highestContiguousSuccess = fromBlock > 0n ? fromBlock - 1n : 0n;
  let from = fromBlock;
  while (from <= safeToBlock) {
    // Cooperative cancellation checked before issuing the chunk's RPC.
    if (signal?.aborted) break;
    const to = from + chunkSize - 1n > safeToBlock ? safeToBlock : from + chunkSize - 1n;
    try {
      const logs = await publicClient.getContractEvents({
        address: oracleAddress,
        abi: SENTRY_ORACLE_ABI as never,
        eventName: "PolicyPublished",
        args: { owner } as never,
        fromBlock: from,
        toBlock: to,
      });
      for (const log of logs as unknown as Array<{
        args?: { policyId?: Hex; owner?: Address; label?: Hex };
        blockNumber?: bigint;
      }>) {
        const pid = log.args?.policyId;
        if (!pid) continue;
        const k = pid.toLowerCase();
        if (seen.has(k)) continue;
        // Forward every decoded field. All-zero `label` is a legitimate
        // empty label, not a missing sentinel. `blockNumber` falls back to
        // the chunk's `from` only if viem dropped it (shouldn't happen).
        seen.set(k, {
          policyId: pid,
          labelHex: (log.args?.label ?? ("0x" as Hex)) as Hex,
          publishBlock: log.blockNumber ?? from,
          publisher: (log.args?.owner ?? owner) as Address,
        });
      }
      // Only extend the watermark when this chunk butts up against the
      // prior successful run; any earlier failure permanently caps it.
      if (from === nextContiguousStart) {
        highestContiguousSuccess = to;
        nextContiguousStart = to + 1n;
      }
    } catch (err) {
      // RPC blip — log and skip. Watermark stays capped; next scan retries.
      // eslint-disable-next-line no-console
      console.warn(
        "[lookupPoliciesByOwner] chunk failed, will retry next scan",
        { from, to },
        err,
      );
    }
    // Fire progress after success/failure so a failed chunk still advances
    // the UI counter. `scannedToBlock` here is the wall-clock cursor, not
    // the contiguous-success watermark returned to the caller.
    chunkIdx += 1;
    if (onProgress) {
      try {
        onProgress({
          chunkIdx,
          totalChunks,
          scannedToBlock: to,
          foundCount: seen.size,
        });
      } catch {
        // ignore
      }
    }
    if (to >= safeToBlock) break;
    from = to + 1n;
  }

  return {
    policies: [...seen.values()],
    scannedToBlock: highestContiguousSuccess,
  };
}

export interface LookupPolicyOnChainOpts {
  /** Optional block hint for single-block getLogs fast-path; falls back to backward walk on miss. */
  publishedBlockHint?: bigint;
  /** Optional block hint for single-block getLogs fast-path; falls back to backward walk on miss. */
  lastUpdatedBlockHint?: bigint;
}

/** Single-block PolicyPublished probe; returns null on miss or RPC blip. */
async function findPublishedEventAtBlock(
  client: PublicClient,
  oracleAddress: Address,
  policyId: Hex,
  block: bigint,
): Promise<{ block: bigint; txHash: Hex; label: Hex; owner: Address } | null> {
  try {
    const logs = await client.getLogs({
      address: oracleAddress,
      event: POLICY_PUBLISHED_EVENT,
      args: { policyId },
      fromBlock: block,
      toBlock: block,
    });
    for (const log of logs) {
      if (!log.args || log.args.policyId?.toLowerCase() !== policyId.toLowerCase()) continue;
      return {
        block: log.blockNumber ?? block,
        txHash: log.transactionHash ?? ("0x" as Hex),
        label: log.args.label ?? ("0x" as Hex),
        owner: (log.args.owner ?? ("0x0000000000000000000000000000000000000000" as Address)) as Address,
      };
    }
  } catch {
    // Single-block RPC failure — fall through to the slow path.
  }
  return null;
}

/** Single-block PolicyUpdated probe; returns null on miss or RPC blip. */
async function findUpdatedEventAtBlock(
  client: PublicClient,
  oracleAddress: Address,
  policyId: Hex,
  block: bigint,
): Promise<{ block: bigint; txHash: Hex; owner: Address } | null> {
  try {
    const logs = await client.getLogs({
      address: oracleAddress,
      event: POLICY_UPDATED_EVENT,
      args: { policyId },
      fromBlock: block,
      toBlock: block,
    });
    for (const log of logs) {
      if (!log.args || log.args.policyId?.toLowerCase() !== policyId.toLowerCase()) continue;
      return {
        block: log.blockNumber ?? block,
        txHash: log.transactionHash ?? ("0x" as Hex),
        owner: (log.args.owner ?? ("0x0000000000000000000000000000000000000000" as Address)) as Address,
      };
    }
  } catch {
    // Single-block RPC failure — fall through to the publish probe.
  }
  return null;
}

/**
 * Decode an `updatePolicy(policyId, input)` tx's calldata. Used after a
 * `findUpdatedEventAtBlock` hit so the snapshot can carry the latest
 * `paused` / `expiresAt` from the update's `PolicyInput` even when the
 * `policyHealth` view read raced an in-flight reorg. Returns `null` on any
 * decode failure (non-update selector, malformed calldata, RPC blip) — the
 * caller falls back to the `policyHealth` values already populated upstream.
 */
async function decodeUpdatePolicyTx(
  client: PublicClient,
  txHash: Hex,
): Promise<{ paused: boolean; expiresAt: bigint } | null> {
  try {
    const tx = await client.getTransaction({ hash: txHash });
    const decoded = decodeFunctionData({
      abi: SENTRY_ORACLE_ABI,
      data: tx.input,
    });
    if (decoded.functionName !== "updatePolicy") return null;
    // updatePolicy(bytes32 policyId, PolicyInput input) — PolicyInput is
    // the LAST arg and carries `paused` + `expiresAt` as fields.
    const input = (decoded.args as readonly unknown[])[1] as {
      paused?: boolean;
      expiresAt?: bigint;
    };
    return {
      paused: input.paused ?? false,
      expiresAt: input.expiresAt ?? 0n,
    };
  } catch {
    return null;
  }
}

/**
 * Three-way outcome of `lookupPolicyOnChain`:
 *
 *   - `found`     — policy exists; `snapshot` carries publisher +
 *                   paused/expiresAt + (optionally) label/tx.
 *   - `not_found` — `policyOwner(policyId)` returned the zero address.
 *                   The id is genuinely absent on this oracle.
 *   - `rpc_error` — `policyOwner` THREW. The chain may or may not know
 *                   the policy; callers must NOT render "not found" for
 *                   this branch — render "cannot reach chain" with retry.
 */
export type LookupPolicyOnChainResult =
  | { kind: "found"; policy: OnChainPolicySnapshot }
  | { kind: "not_found" }
  | { kind: "rpc_error"; error: Error };

export async function lookupPolicyOnChain(
  client: PublicClient,
  oracleAddress: Address,
  policyId: Hex,
  opts: LookupPolicyOnChainOpts = {},
): Promise<LookupPolicyOnChainResult> {
  // 1) Confirm the policy exists. `policyOwner` returns zero-address for
  //    unknown policyIds. A THROW is an RPC-layer failure; propagate as
  //    `rpc_error` so the caller can distinguish "no such policy" from
  //    "couldn't reach chain".
  let publisher: Address;
  try {
    publisher = (await client.readContract({
      address: oracleAddress,
      abi: SENTRY_ORACLE_ABI,
      functionName: "policyOwner",
      args: [policyId],
    })) as Address;
  } catch (err) {
    return {
      kind: "rpc_error",
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
  if (!publisher || publisher === ZERO_ADDR) return { kind: "not_found" };

  // 2) Pull the lightweight health view (paused + expiresAt). One round-trip.
  let paused = false;
  let expiresAt = 0n;
  try {
    const [pausedRes, expiresAtRes] = (await client.readContract({
      address: oracleAddress,
      abi: SENTRY_ORACLE_ABI,
      functionName: "policyHealth",
      args: [policyId],
    })) as readonly [boolean, bigint];
    paused = pausedRes;
    expiresAt = expiresAtRes;
  } catch {
    // policyHealth shouldn't revert for an existing policy; if it does, fall
    // through to a partial snapshot rather than abort the whole lookup.
  }

  // 3) Recover label + publish tx via topic-filtered event scan. Fast-path:
  //    when `lastUpdatedBlockHint > publishedBlockHint`, probe PolicyUpdated
  //    at the update block (decoding its tx for fresh paused/expiresAt),
  //    then probe PolicyPublished at the publish hint for the label.
  //    Otherwise probe PolicyPublished at the publish hint. Any miss falls
  //    through to a backward walk from head capped at MAX_BACK_BLOCKS.
  let label: string | undefined;
  let labelHex: Hex | undefined;
  let publishBlock: bigint | undefined;
  let txHash: Hex | undefined;
  try {
    let hit: { block: bigint; txHash: Hex; label: Hex; owner: Address } | null = null;
    const hasPublishHint =
      opts.publishedBlockHint !== undefined && opts.publishedBlockHint > 0n;
    const hasUpdateHint =
      hasPublishHint &&
      opts.lastUpdatedBlockHint !== undefined &&
      opts.lastUpdatedBlockHint > (opts.publishedBlockHint as bigint);

    if (hasUpdateHint) {
      // PolicyUpdated probe at the update block. On hit, also probe the
      // publish event for the label (PolicyUpdated does not carry label).
      const updateHit = await findUpdatedEventAtBlock(
        client,
        oracleAddress,
        policyId,
        opts.lastUpdatedBlockHint as bigint,
      );
      if (updateHit) {
        // Decode the update tx so the snapshot's paused/expiresAt reflect
        // the most-recently-applied PolicyInput. Best-effort: a decode
        // failure leaves the policyHealth view values from step 2 intact.
        const decoded = await decodeUpdatePolicyTx(client, updateHit.txHash);
        if (decoded) {
          paused = decoded.paused;
          expiresAt = decoded.expiresAt;
        }
        // Probe the original publish for the label.
        hit = await findPublishedEventAtBlock(
          client,
          oracleAddress,
          policyId,
          opts.publishedBlockHint as bigint,
        );
      }
    }
    if (!hit && hasPublishHint) {
      // No update-hint path or update-hint missed — probe the publish at
      // its known block. This is the primary fast-path for the common case
      // (entry has only publishedBlockHint, no later update).
      hit = await findPublishedEventAtBlock(
        client,
        oracleAddress,
        policyId,
        opts.publishedBlockHint as bigint,
      );
    }
    if (!hit) {
      hit = await findPublishedEvent(client, oracleAddress, policyId);
    }
    if (hit) {
      labelHex = hit.label;
      try {
        label = hexToString(labelHex, { size: 32 }).replace(/\0+$/, "");
      } catch {
        label = labelHex;
      }
      publishBlock = hit.block;
      txHash = hit.txHash;
    }
  } catch {
    // ignore — partial snapshot is still useful
  }

  const recovered = labelHex !== undefined;
  return {
    kind: "found",
    policy: {
      kind: recovered ? "found-with-label" : "found-no-label",
      labelRecovered: recovered,
      policyId,
      publisher,
      paused,
      expiresAt,
      label,
      labelHex,
      publishBlock,
      txHash,
    },
  };
}
