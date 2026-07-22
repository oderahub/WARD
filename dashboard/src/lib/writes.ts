/**
 * Pure write helpers for the Ward dashboard. No React, no hooks.
 *
 * Queue writes (veto/dispatch/expire) sign through a viem `WalletClient`
 * directly, since they were written before the publish flow moved to wagmi's
 * `useWriteContract`. Policy writes (pause/expiry/body/ownership) sign through
 * wagmi's `writeContractAsync` — same shape as `PublishButton.tsx` — so the
 * caller doesn't have to thread a separate WalletClient through hooks. Both
 * paths:
 *   1. simulate via the public client so revert reasons surface in the UI
 *      before the wallet popup opens;
 *   2. for wagmi-path writes, compute a Fuji-safe gas override via
 *      `fujiSafeGas` (Fuji's eth_estimateGas undershoots to ~0, which
 *      MetaMask rejects below the 21000 minimum — see `fujiGas.ts`);
 *   3. return the tx hash. The caller is responsible for waiting on the
 *      receipt if it needs post-mine state.
 *
 * The veto reason encoding mirrors the CLI exactly — see
 * `cli/src/cmd/queue.ts:91-94` and the comment in `./encoding.ts`.
 */
import {
  parseAbiItem,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import type { useWriteContract } from "wagmi";

import {
  WARD_AGENT_REGISTRY_ABI,
  WARD_ORACLE_ABI,
  WARD_QUEUE_ABI,
  type PolicyInput,
} from "@ward/sdk";

import { fujiSafeGas } from "./fujiGas";
import { encodeBytes32Label } from "./encoding";

/**
 * Simulate `publishPolicy` then submit it through wagmi's writeContractAsync.
 *
 * Mirrors the simulate-first pattern used by every other oracle write helper
 * in this file. `PublishButton.tsx` originally jumped straight to
 * writeContractAsync after compile; if the publish would revert on-chain
 * (e.g. policyId already taken, EIP-55 mismatch on a target, body validation),
 * the user paid gas to learn. Simulating first surfaces the revert reason
 * before the wallet popup opens.
 *
 * Returns the gas override alongside the tx hash so the caller can avoid a
 * second `fujiSafeGas` call — simulate has already vetted the args, so the
 * gas estimate happens here as part of the same code path.
 */
export async function simulateAndWritePublish(opts: {
  publicClient: PublicClient;
  writeContractAsync: WriteContractAsync;
  oracleAddress: Address;
  account: Address;
  labelHex: Hex;
  policyInput: PolicyInput;
  /** Optional chainId override — when set, wagmi aborts at the network boundary
   *  if the wallet is on the wrong chain. Pass ACTIVE_CHAIN_ID to enforce the
   *  testnet check at the SDK layer instead of only at the UI guard. */
  chainId?: number;
}): Promise<{ txHash: Hex }> {
  const { publicClient, writeContractAsync, oracleAddress, account, labelHex, policyInput, chainId } = opts;

  await publicClient.simulateContract({
    address: oracleAddress,
    abi: WARD_ORACLE_ABI,
    functionName: "publishPolicy",
    args: [labelHex, policyInput],
    account,
  });

  const gas = await fujiSafeGas(publicClient, {
    address: oracleAddress,
    abi: WARD_ORACLE_ABI,
    functionName: "publishPolicy",
    args: [labelHex, policyInput],
    account,
  });

  const txHash = await writeContractAsync({
    address: oracleAddress,
    abi: WARD_ORACLE_ABI,
    functionName: "publishPolicy",
    args: [labelHex, policyInput],
    gas,
    ...(chainId !== undefined ? { chainId } : {}),
  });

  return { txHash };
}

/**
 * Simulate `register(agent, oracle, policyId, name, metadataURI, tags)` on
 * WardAgentRegistry, then submit via wagmi's writeContractAsync. Mirrors
 * `simulateAndWritePublish` line-for-line — same simulate-first / fujiSafeGas
 * / chainId-pinned pattern — so the wizard's Step 3 register sub-card surfaces
 * NotRegistrar (or any other registry revert) before the wallet popup opens.
 *
 * The registry is non-funds-holding: `register` only writes the (agent →
 * (oracle, policyId, name, metadataURI, tags)) row. No value is transferred,
 * so the helper deliberately doesn't accept a `value:` field.
 */
export async function simulateAndWriteRegisterAgent(opts: {
  publicClient: PublicClient;
  writeContractAsync: WriteContractAsync;
  registryAddress: Address;
  account: Address;
  agent: Address;
  oracleAddress: Address;
  policyId: Hex;
  name: string;
  metadataURI: string;
  tags: readonly string[];
  /** See `simulateAndWritePublish.chainId`. */
  chainId?: number;
}): Promise<{ txHash: Hex }> {
  const {
    publicClient,
    writeContractAsync,
    registryAddress,
    account,
    agent,
    oracleAddress,
    policyId,
    name,
    metadataURI,
    tags,
    chainId,
  } = opts;

  const args = [agent, oracleAddress, policyId, name, metadataURI, tags] as const;

  await publicClient.simulateContract({
    address: registryAddress,
    abi: WARD_AGENT_REGISTRY_ABI,
    functionName: "register",
    args,
    account,
  });

  const gas = await fujiSafeGas(publicClient, {
    address: registryAddress,
    abi: WARD_AGENT_REGISTRY_ABI,
    functionName: "register",
    args,
    account,
  });

  const txHash = await writeContractAsync({
    address: registryAddress,
    abi: WARD_AGENT_REGISTRY_ABI,
    functionName: "register",
    args,
    gas,
    ...(chainId !== undefined ? { chainId } : {}),
  });

  return { txHash };
}

export interface VetoArgs {
  walletClient: WalletClient;
  publicClient: PublicClient;
  queueAddress: Address;
  execId: bigint;
  reasonText: string;
}

export interface DispatchArgs {
  walletClient: WalletClient;
  publicClient: PublicClient;
  queueAddress: Address;
  execId: bigint;
}

export interface ExpireArgs {
  walletClient: WalletClient;
  publicClient: PublicClient;
  queueAddress: Address;
  execId: bigint;
}

/**
 * Re-export wagmi's exact `writeContractAsync` type via `ReturnType` so the
 * alias stays version-portable: wagmi's narrow `WriteContractMutateAsync`
 * signature is not structurally assignable from a loose
 * `Record<string, unknown>` overload, which broke call sites passing the
 * actual wagmi value into our helpers. Deriving from `useWriteContract`
 * keeps us aligned no matter how wagmi reshapes its internal generics.
 */
export type WriteContractAsync = ReturnType<typeof useWriteContract>["writeContractAsync"];

function requireAccount(walletClient: WalletClient): Address {
  const account = walletClient.account;
  if (!account) throw new Error("wallet client has no account; connect a wallet first");
  return account.address;
}

/**
 * Veto a pending queue entry. The reason text must be ≤32 UTF-8 bytes; we
 * right-pad to bytes32 via the same encoding the CLI uses (`stringToHex`
 * with `size: 32` is byte-equivalent to `padHex(utf8(s), { dir: "right" })`
 * — verified against `cli/src/cmd/queue.ts:91-94`).
 */
export async function vetoIntent(args: VetoArgs): Promise<{ txHash: Hex }> {
  const { walletClient, publicClient, queueAddress, execId, reasonText } = args;
  const account = requireAccount(walletClient);
  const reasonHex = encodeBytes32Label(reasonText);

  const { request } = await publicClient.simulateContract({
    address: queueAddress,
    abi: WARD_QUEUE_ABI,
    functionName: "veto",
    args: [execId, reasonHex],
    account,
  });

  const txHash = await walletClient.writeContract(request);
  return { txHash };
}

/**
 * Dispatch a pending queue entry. Caller must be either the asker (for
 * TIER_DELAYED) or the policy owner (for TIER_VETO_REQUIRED) — the contract
 * enforces this; we simulate first so the user sees the precise revert.
 */
export async function dispatchIntent(args: DispatchArgs): Promise<{ txHash: Hex }> {
  const { walletClient, publicClient, queueAddress, execId } = args;
  const account = requireAccount(walletClient);

  const { request } = await publicClient.simulateContract({
    address: queueAddress,
    abi: WARD_QUEUE_ABI,
    functionName: "dispatch",
    args: [execId],
    account,
  });

  const txHash = await walletClient.writeContract(request);
  return { txHash };
}

/**
 * Garbage-collect a pending entry whose deadline has passed. Anyone can call
 * this; the caller pays gas with no refund. The UI surfaces that fact in the
 * confirm modal so volunteers aren't surprised.
 */
export async function expireIfStaleIntent(args: ExpireArgs): Promise<{ txHash: Hex }> {
  const { walletClient, publicClient, queueAddress, execId } = args;
  const account = requireAccount(walletClient);

  const { request } = await publicClient.simulateContract({
    address: queueAddress,
    abi: WARD_QUEUE_ABI,
    functionName: "expireIfStale",
    args: [execId],
    account,
  });

  const txHash = await walletClient.writeContract(request);
  return { txHash };
}

/* ------------------------------------------------------------------ */
/* Policy-management writes                                            */
/* ------------------------------------------------------------------ */

/** Oracle functions reachable through the policy-write helpers below. */
type PolicyFunctionName =
  | "updatePolicy"
  | "transferPolicyOwnership"
  | "acceptPolicyOwnership"
  | "cancelPolicyOwnershipTransfer";

/**
 * Thrown when the optimistic-concurrency probe fires immediately before
 * `writeContractAsync` and detects that another `updatePolicy` /
 * `PolicyPublished` mined for this policyId after the caller captured
 * `expectedLastUpdatedBlock`. Callers (modals) catch this specifically to
 * render a reconcile prompt instead of the generic web3 error path.
 */
export class ConcurrentEditError extends Error {
  readonly policyId: Hex;
  readonly expected: bigint;
  readonly actual: bigint;
  constructor(policyId: Hex, expected: bigint, actual: bigint) {
    super(
      `concurrent edit detected for policy ${policyId}: expected lastUpdatedBlock ${expected.toString()}, chain now reports ${actual.toString()}`,
    );
    this.name = "ConcurrentEditError";
    this.policyId = policyId;
    this.expected = expected;
    this.actual = actual;
  }
}

const POLICY_PUBLISHED_EVENT = parseAbiItem(
  "event PolicyPublished(bytes32 indexed policyId, address indexed owner, bytes32 label)",
);
const POLICY_UPDATED_EVENT = parseAbiItem(
  "event PolicyUpdated(bytes32 indexed policyId, address indexed owner)",
);

// Fuji RPC caps eth_getLogs at 1000 blocks per call. Walk backwards from
// `latest` and early-return on the first hit. MAX_BACK_BLOCKS bounds the scan
// so a probe for a long-dormant policy doesn't spin the RPC indefinitely.
const PROBE_CHUNK_SIZE = 999n;
const PROBE_MAX_BACK_BLOCKS = 5_000_000n;
/**
 * Cap on the FORWARD probe range when an `expectedLastUpdatedBlock` is
 * supplied. The probe's job is detecting CONCURRENT edits during the modal's
 * open window (seconds-to-minutes of wall-clock), NOT backfilling chain
 * history. On Fuji (~0.5s blocks) 10_000 blocks ≈ 1.4 hours, which
 * comfortably exceeds any realistic modal lifetime. If the modal sat open
 * longer than that, the user has bigger problems than a concurrency race
 * (their wallet is probably disconnected, etc.) and the simulate above
 * already vetted the args against current chain state.
 *
 * Without this cap, an `expectedLastUpdatedBlock` from a long-dormant policy
 * (e.g., trading-v1 published days/weeks ago) forces the probe to walk every
 * intervening chunk before declaring "no concurrent edit found" — a 5+ min
 * hang for a confirmation the wallet popup is waiting on.
 */
const PROBE_FORWARD_MAX_BLOCKS = 10_000n;

/**
 * Topic-filtered `eth_getLogs` for the most recent `PolicyUpdated` OR
 * `PolicyPublished` for `policyId`. Walks backwards from head in chunks of
 * `PROBE_CHUNK_SIZE` and returns the highest block seen across both event
 * types. Returns `null` if neither event is found within
 * `PROBE_MAX_BACK_BLOCKS` (caller treats null as "policy never touched on
 * chain" — falls back to permitting the write so first-publish flows still
 * work without a special case).
 *
 * Cross-browser authoritative: this hits the RPC directly so a concurrent
 * update from a different browser (which our local EventStore can't see) is
 * picked up. The trade-off is ~200-500ms of latency immediately before the
 * `writeContractAsync` call.
 */
async function probeLatestPolicyBlock(
  publicClient: PublicClient,
  oracleAddress: Address,
  policyId: Hex,
  expectedLastUpdatedBlock?: bigint,
): Promise<bigint | null> {
  const head = await publicClient.getBlockNumber();
  // When a caller-supplied expectedLastUpdatedBlock exists, cap the backward
  // floor at max(expected + 1, head - PROBE_FORWARD_MAX_BLOCKS). The probe
  // only needs to detect events AFTER the expected block; anything ≤ expected
  // is already known. The PROBE_FORWARD_MAX_BLOCKS clamp bounds the worst
  // case (long-dormant policy) to ~1.4 hours of chain at 999-block chunks =
  // ~10 sequential RPC calls instead of ~1000+ for trading-v1.
  const floor =
    expectedLastUpdatedBlock !== undefined
      ? head > PROBE_FORWARD_MAX_BLOCKS
        ? head - PROBE_FORWARD_MAX_BLOCKS > expectedLastUpdatedBlock
          ? head - PROBE_FORWARD_MAX_BLOCKS
          : expectedLastUpdatedBlock + 1n
        : 0n
      : 0n;
  let toBlock = head;
  while (true) {
    const fromBlock =
      toBlock > PROBE_CHUNK_SIZE && toBlock - PROBE_CHUNK_SIZE > floor
        ? toBlock - PROBE_CHUNK_SIZE + 1n
        : floor;
    try {
      // Query both events in parallel for this chunk. Either can be the most
      // recent state-touch (publish OR subsequent update), so we take the max.
      const [publishedLogs, updatedLogs] = await Promise.all([
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
      ]);
      let best: bigint | null = null;
      for (const log of [...publishedLogs, ...updatedLogs]) {
        const b = log.blockNumber;
        if (b !== null && b !== undefined && (best === null || b > best)) best = b;
      }
      if (best !== null) return best;
    } catch {
      // RPC quirk on this chunk — skip and walk back. If the whole walk
      // returns null, the caller fails open (treats as first-publish).
    }
    if (fromBlock <= floor) return null;
    if (head - fromBlock >= PROBE_MAX_BACK_BLOCKS) return null;
    toBlock = fromBlock - 1n;
  }
}

interface PolicyWriteCommon {
  publicClient: PublicClient;
  writeContractAsync: WriteContractAsync;
  oracleAddress: Address;
  policyId: Hex;
  /** Connected wallet address — required for simulate + gas estimate.
   *  Callers in React get this from wagmi's `useAccount().address`; the
   *  actual write reuses the wagmi-connected signer, so we only need it
   *  for the pre-flight calls. */
  account: Address;
  /** Optional chainId override — when set, wagmi aborts at the network
   *  boundary if the wallet is on the wrong chain. The modals pass the
   *  expected Avalanche chainId here so a wrong-network submission is rejected
   *  at the SDK layer (in addition to the UI guard from `useWrongNetwork`). */
  chainId?: number;
}

/**
 * Shared simulate-then-write path for the oracle policy-management functions.
 * Simulates first so reverts surface before the wallet popup opens, then
 * computes a Fuji-safe gas override (see `fujiGas.ts`) and submits
 * through wagmi's `writeContractAsync`. The ABI is widened to `unknown` at
 * the simulate/estimate boundary so this helper can dispatch all four policy
 * functions through a single code path without duplicating per-function
 * overloads — the public helpers below restore narrow typing on inputs.
 *
 * `buildArgs` (when supplied) runs IMMEDIATELY before simulate so any
 * chain-merge read (e.g. `readChainHealth` in `setPolicyPaused`/
 * `setPolicyExpiry`) lives inside the same async flow as simulate+write. This
 * shrinks the TOCTOU window between the chain read and the tx-submit to the
 * cost of one simulate + one gas estimate (sub-second on Fuji). It does
 * NOT eliminate the race: another browser's `updatePolicy` can still mine
 * between our simulate and our write. See the JSDoc on
 * `setPolicyPaused`/`setPolicyExpiry` for the residual risk.
 *
 * `concurrencyCheck` (when supplied) fires AFTER simulate + gas-estimate and
 * IMMEDIATELY before `writeContractAsync`. The wallet popup typically blocks
 * for seconds-to-minutes while the user clicks confirm; this probe closes that
 * window by re-reading the latest `PolicyPublished`/`PolicyUpdated` block for
 * the policy and throwing `ConcurrentEditError` if it has advanced past the
 * caller's `expectedLastUpdatedBlock`. The remaining race is the sub-second
 * gap between this probe and the tx broadcast — see the residual-race notes
 * on `setPolicyPaused`/`setPolicyExpiry` below.
 */
async function simulateAndWritePolicy(opts: {
  publicClient: PublicClient;
  writeContractAsync: WriteContractAsync;
  oracleAddress: Address;
  account: Address;
  functionName: PolicyFunctionName;
  /** Static args used directly when no `buildArgs` is supplied. */
  args?: readonly unknown[];
  /** Lazy args, evaluated right before simulate. Use this when args depend on
   *  a live chain read so the read happens as late as possible. */
  buildArgs?: () => Promise<readonly unknown[]>;
  /** Optimistic-concurrency probe. When set, the helper re-reads the latest
   *  PolicyPublished/PolicyUpdated block for `policyId` immediately before
   *  `writeContractAsync` and throws `ConcurrentEditError` if it differs
   *  from `expectedLastUpdatedBlock`. */
  concurrencyCheck?: { policyId: Hex; expectedLastUpdatedBlock: bigint };
  /** See `PolicyWriteCommon.chainId`. */
  chainId?: number;
}): Promise<{ txHash: Hex }> {
  const { publicClient, writeContractAsync, oracleAddress, account, functionName, concurrencyCheck, chainId } = opts;

  // Evaluate args as late as possible — for chain-merge helpers this is where
  // the `policyHealth` read fires, shrinking the read→write window.
  const args = opts.buildArgs ? await opts.buildArgs() : (opts.args ?? []);

  await publicClient.simulateContract({
    address: oracleAddress,
    abi: WARD_ORACLE_ABI,
    functionName,
    // viem derives a per-function tuple type for `args` from the ABI literal;
    // our helper accepts an opaque `readonly unknown[]` because the four
    // call sites use different argument shapes. The public wrappers below
    // construct the tuple correctly, so the runtime shape always matches.
    args: args as readonly unknown[] as never,
    account,
  });

  const gas = await fujiSafeGas(publicClient, {
    address: oracleAddress,
    abi: WARD_ORACLE_ABI,
    functionName,
    args,
    account,
  });

  // Optimistic-concurrency probe — see helper JSDoc above. Fires AFTER
  // simulate+gas so the wallet-popup window (which sits between simulate and
  // the actual tx broadcast) is bounded by this single probe + the broadcast
  // latency (~50-200ms). A `null` probe result means the policy has no
  // PolicyPublished/PolicyUpdated within the scan window — fall open and let
  // the write proceed; the caller's expected block was presumably 0 (first
  // publish) and the simulate above already vetted the args.
  if (concurrencyCheck) {
    const actual = await probeLatestPolicyBlock(
      publicClient,
      oracleAddress,
      concurrencyCheck.policyId,
      concurrencyCheck.expectedLastUpdatedBlock,
    );
    if (actual !== null && actual !== concurrencyCheck.expectedLastUpdatedBlock) {
      throw new ConcurrentEditError(
        concurrencyCheck.policyId,
        concurrencyCheck.expectedLastUpdatedBlock,
        actual,
      );
    }
  }

  const txHash = await writeContractAsync({
    address: oracleAddress,
    abi: WARD_ORACLE_ABI,
    functionName,
    // Same widening rationale as the simulate call above — wagmi derives a
    // per-function tuple for `args` from the ABI literal, but this helper
    // dispatches all four policy functions through one path. The public
    // wrappers below construct the correct tuple at runtime.
    args: args as readonly unknown[] as never,
    gas,
    ...(chainId !== undefined ? { chainId } : {}),
  });

  return { txHash };
}

/**
 * Read the on-chain `pendingPolicyOwner(policyId)` view. Used by the
 * accept/cancel modals as a last-second probe immediately before submit so a
 * pending transfer that was cancelled (or already accepted) from another
 * browser surfaces as a humanized error instead of a contract revert that
 * costs gas. Returns the zero address when no transfer is pending.
 */
export async function readPendingPolicyOwner(
  publicClient: PublicClient,
  oracleAddress: Address,
  policyId: Hex,
): Promise<Address> {
  return (await publicClient.readContract({
    address: oracleAddress,
    abi: WARD_ORACLE_ABI,
    functionName: "pendingPolicyOwner",
    args: [policyId],
  })) as Address;
}

/**
 * Read the on-chain `policyHealth(policyId)` view and return the live
 * `paused` + `expiresAt` fields. Used by the single-field write helpers
 * below to merge chain-current state into the full `updatePolicy` payload
 * so a stale-cache submit doesn't roll back a recent change to the OTHER
 * field made from another browser/session.
 */
export async function readChainHealth(
  publicClient: PublicClient,
  oracleAddress: Address,
  policyId: Hex,
): Promise<{ paused: boolean; expiresAt: bigint }> {
  const [paused, expiresAt] = (await publicClient.readContract({
    address: oracleAddress,
    abi: WARD_ORACLE_ABI,
    functionName: "policyHealth",
    args: [policyId],
  })) as readonly [boolean, bigint];
  return { paused, expiresAt };
}

/**
 * Pause or unpause a policy by re-submitting its full PolicyInput with the
 * `paused` flag toggled.
 *
 * `updatePolicy` is a FULL replacement on-chain — there is no partial-update
 * path — so the caller must supply the current PolicyInput from the published
 * cache. The dashboard's publishedCache stores bodies after publish/update so
 * the operator doesn't have to re-import YAML to toggle a flag.
 *
 * Chain-merge: just before submit, we re-read `expiresAt` from chain via
 * `buildArgs` (which fires inside `simulateAndWritePolicy`, immediately before
 * the simulate call) and use THAT instead of the cache. This protects against
 * a stale-cache window where another browser extended the expiry between cache
 * hydration and this submit — without the merge, this pause would silently
 * roll the expiry back to the cached value. The body fields (targets/
 * selectors/caps) still come from the cache; that's the highest-blast-radius
 * path and is gated by EditPolicyModal's chain-mismatch warning instead.
 *
 * Optimistic concurrency: when `expectedLastUpdatedBlock` is supplied (modal
 * captures it at mount via `EventStore.getPolicy(policyId)?.lastUpdatedBlock`),
 * `simulateAndWritePolicy` probes the latest `PolicyPublished`/`PolicyUpdated`
 * block for this policyId immediately before `writeContractAsync` and throws
 * `ConcurrentEditError` if it diverges. This closes the wallet-popup window
 * (seconds-to-minutes while the user clicks confirm) against cross-browser
 * concurrent edits.
 *
 * KNOWN LIMITATION: optimistic concurrency via lastUpdatedBlock closes the
 * wallet-popup window; the sub-second tx-broadcast → tx-mining window (~1-3s
 * on Fuji) remains as the residual race — another tx can land in the same
 * block range and our `updatePolicy` still overwrites it because there's no
 * on-chain compare-and-swap. Dedicated contract entry points
 * (`pausePolicy(bool)` / `setExpiry(uint64)` plus per-policy nonce) would
 * eliminate the residual race entirely.
 */
export async function setPolicyPaused(opts: PolicyWriteCommon & {
  currentInput: PolicyInput;
  paused: boolean;
  /** Optional optimistic-concurrency token. When set, the helper probes chain
   *  for the latest PolicyPublished/PolicyUpdated block right before submit
   *  and throws `ConcurrentEditError` on divergence. Modals pass the value
   *  they captured at mount time. */
  expectedLastUpdatedBlock?: bigint;
}): Promise<{ txHash: Hex }> {
  const { policyId, currentInput, paused, publicClient, oracleAddress, expectedLastUpdatedBlock, chainId, ...rest } = opts;
  return simulateAndWritePolicy({
    ...rest,
    publicClient,
    oracleAddress,
    chainId,
    functionName: "updatePolicy",
    buildArgs: async () => {
      const chain = await readChainHealth(publicClient, oracleAddress, policyId);
      const nextInput: PolicyInput = {
        ...currentInput,
        expiresAt: chain.expiresAt,
        paused,
      };
      return [policyId, nextInput];
    },
    concurrencyCheck:
      expectedLastUpdatedBlock !== undefined
        ? { policyId, expectedLastUpdatedBlock }
        : undefined,
  });
}

/**
 * Update only the `expiresAt` field of a policy by re-submitting its full
 * PolicyInput. Past values are allowed — the on-chain contract decides whether
 * to reject them, and the simulate path surfaces the revert if it does.
 *
 * Chain-merge: see `setPolicyPaused` — the live `paused` flag is re-read from
 * chain inside `buildArgs` so an extend-expiry from a stale cache doesn't
 * silently unpause a policy that was paused from another browser since cache
 * hydration.
 *
 * Optimistic concurrency: see `setPolicyPaused` for the wallet-popup-window
 * rationale. When `expectedLastUpdatedBlock` is supplied, the helper throws
 * `ConcurrentEditError` if chain has advanced past it by submit time.
 *
 * KNOWN LIMITATION: optimistic concurrency via lastUpdatedBlock closes the
 * wallet-popup window; the sub-second tx-broadcast → tx-mining window remains
 * as the residual race. Dedicated contract entry points (`pausePolicy(bool)` /
 * `setExpiry(uint64)`) would eliminate it entirely.
 */
export async function setPolicyExpiry(opts: PolicyWriteCommon & {
  currentInput: PolicyInput;
  expiresAt: bigint;
  /** See `setPolicyPaused.expectedLastUpdatedBlock`. */
  expectedLastUpdatedBlock?: bigint;
}): Promise<{ txHash: Hex }> {
  const { policyId, currentInput, expiresAt, publicClient, oracleAddress, expectedLastUpdatedBlock, chainId, ...rest } = opts;
  return simulateAndWritePolicy({
    ...rest,
    publicClient,
    oracleAddress,
    chainId,
    functionName: "updatePolicy",
    buildArgs: async () => {
      const chain = await readChainHealth(publicClient, oracleAddress, policyId);
      const nextInput: PolicyInput = {
        ...currentInput,
        paused: chain.paused,
        expiresAt,
      };
      return [policyId, nextInput];
    },
    concurrencyCheck:
      expectedLastUpdatedBlock !== undefined
        ? { policyId, expectedLastUpdatedBlock }
        : undefined,
  });
}

/**
 * Full-replacement policy update. The convenience helpers above (`setPolicyPaused`,
 * `setPolicyExpiry`) are thin wrappers over this — use them when only one
 * field changes so the caller doesn't have to spread `currentInput` itself.
 *
 * Optimistic concurrency: see `setPolicyPaused`. When supplied, the helper
 * throws `ConcurrentEditError` if chain advanced past `expectedLastUpdatedBlock`
 * between modal-mount and submit.
 */
export async function updatePolicyBody(opts: PolicyWriteCommon & {
  nextInput: PolicyInput;
  /** See `setPolicyPaused.expectedLastUpdatedBlock`. */
  expectedLastUpdatedBlock?: bigint;
}): Promise<{ txHash: Hex }> {
  const { policyId, nextInput, expectedLastUpdatedBlock, chainId, ...rest } = opts;
  return simulateAndWritePolicy({
    ...rest,
    chainId,
    functionName: "updatePolicy",
    args: [policyId, nextInput],
    concurrencyCheck:
      expectedLastUpdatedBlock !== undefined
        ? { policyId, expectedLastUpdatedBlock }
        : undefined,
  });
}

/**
 * Start a two-step ownership transfer. The new owner must subsequently call
 * `acceptPolicyOwnership` for the transfer to complete; until they do, the
 * pending transfer can be revoked via `cancelPolicyOwnershipTransfer`.
 */
export async function transferPolicyOwnership(opts: PolicyWriteCommon & {
  newOwner: Address;
}): Promise<{ txHash: Hex }> {
  const { policyId, newOwner, chainId, ...rest } = opts;
  return simulateAndWritePolicy({
    ...rest,
    chainId,
    functionName: "transferPolicyOwnership",
    args: [policyId, newOwner],
  });
}

/**
 * Accept a pending ownership transfer. Caller must be the pending owner
 * recorded on-chain by a prior `transferPolicyOwnership`.
 */
export async function acceptPolicyOwnership(opts: PolicyWriteCommon): Promise<{ txHash: Hex }> {
  const { policyId, chainId, ...rest } = opts;
  return simulateAndWritePolicy({
    ...rest,
    chainId,
    functionName: "acceptPolicyOwnership",
    args: [policyId],
  });
}

/**
 * Revoke a pending ownership transfer. Caller must be the current owner.
 * No-op (reverts) if there is no pending transfer.
 */
export async function cancelPolicyOwnershipTransfer(opts: PolicyWriteCommon): Promise<{ txHash: Hex }> {
  const { policyId, chainId, ...rest } = opts;
  return simulateAndWritePolicy({
    ...rest,
    chainId,
    functionName: "cancelPolicyOwnershipTransfer",
    args: [policyId],
  });
}
