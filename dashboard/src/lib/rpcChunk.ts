/**
 * Pure helpers for chunking RPC log-scan ranges on Avalanche Fuji.
 *
 * Fuji's RPC caps `eth_getLogs` at 1000 blocks per call (the node returns
 * a "block range too large" error past that). Every dashboard module that
 * walks getLogs (useAgentWatcher, discovery, onChainPolicyLookup,
 * policyRecovery) must respect that cap. Keeping the chunk size and the
 * chunker pure and in `lib/` lets every layer import from the same source —
 * historically `chunkOwnerScanRange` lived inside `hooks/useAgentWatcher.ts`,
 * which forced a layering reversal (lib/ depending on hooks/) the moment a
 * second caller in `lib/` needed it. useAgentWatcher.ts re-exports
 * `chunkOwnerScanRange` from here so existing import sites stay intact.
 *
 * `RPC_LOGS_CHUNK_SIZE` is 999, not 1000: we hold a one-block safety buffer
 * so an off-by-one in any caller never trips the Fuji cap. Every other
 * lib/ chunker in this repo uses the same value (discovery.ts:242,
 * onChainPolicyLookup.ts:53, policyRecovery.ts:56).
 *
 * Pure module — no React, no viem (only the bigint primitives). Safe to
 * import from any layer.
 */

/**
 * Fuji's eth_getLogs hard cap is 1000 blocks. We chunk at 999 to keep a
 * one-block buffer against off-by-one errors in callers; matches the value
 * used by discovery.ts / onChainPolicyLookup.ts / policyRecovery.ts and the
 * SDK's event-store DEFAULT_CHUNK.
 */
export const RPC_LOGS_CHUNK_SIZE = 999n;

/**
 * Produce inclusive [fromBlock, toBlock] windows walking BACKWARDS from
 * `head` to `floor` in `chunkSize`-block chunks. Each window spans at most
 * `chunkSize + 1` blocks (chunkSize is the gap between fromBlock and
 * toBlock), so callers passing the Fuji cap of 999 stay strictly under
 * the 1000-block RPC limit.
 *
 * Backwards walk is the canonical shape for "find newest evidence first";
 * callers that need an ascending pass should reverse the returned array.
 *
 * Edge cases:
 *   - `chunkSize <= 0`: throws (programmer error).
 *   - `head < floor`: returns `[]` (nothing to scan).
 *   - `head === floor`: returns a single 1-block window `[floor, floor]`.
 */
export function chunkOwnerScanRange(
  head: bigint,
  floor: bigint,
  chunkSize: bigint = RPC_LOGS_CHUNK_SIZE,
): Array<{ fromBlock: bigint; toBlock: bigint }> {
  if (chunkSize <= 0n) throw new Error("chunkSize must be positive");
  if (head < floor) return [];
  const out: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  let toBlock = head;
  while (true) {
    const candidate = toBlock > chunkSize ? toBlock - chunkSize : 0n;
    const fromBlock = candidate > floor ? candidate : floor;
    out.push({ fromBlock, toBlock });
    if (fromBlock === floor) return out;
    toBlock = fromBlock - 1n;
  }
}
