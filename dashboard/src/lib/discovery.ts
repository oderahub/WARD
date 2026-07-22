/**
 * Discovery — single-address structural probe used by the Watch Wizard
 * recommender.
 *
 * Given an arbitrary 0x address on Avalanche Fuji (chainId 43113), produces a
 * `DiscoveryReport` that classifies the account (EOA / ERC-20 / ERC-721 /
 * generic contract), surfaces a token fingerprint when applicable, and
 * answers two Ward-specific questions:
 *
 *   1. **Is this agent Ward-aware?** — proven by either a WardAgentRegistry
 *      `AgentRegistered` log OR a WardQueue `Enqueued` log naming the
 *      address. A `true` here means real-time gating via WardOracle is
 *      end-to-end achievable; `false` means the wizard must drop to
 *      observation-only Slack alerts per the project scope-honesty constraint.
 *
 *   2. **Is it already registered in this oracle's registry?** — read
 *      authoritatively from `WardAgentRegistry.getAgent(address)` so the
 *      wizard can flip to its update-path UI without a second round-trip.
 *      Crucially, this is checked even when the event probe missed (the
 *      agent may have been registered before our 5_000-block lookback
 *      window).
 *
 * Pure read-only. NEVER throws on RPC failure; every error is captured in
 * `report.errors[]` so the recommender can downgrade confidence rather than
 * present a stub as a fact. Throws only on programmer error (wrong-chain
 * client, malformed address) so the caller's wrong-network guard catches it.
 *
 * RPC budget (Fuji, no Multicall3):
 *
 *   - Happy path with registry hit:
 *       3 (head/code/nonce) + 4 (balance + 3 fingerprint reads)
 *       + 1 (registry getLogs chunk) + 1 (getAgent canonical row)
 *       + N (queue getLogs chunks — at most ⌈5000/999⌉ = 6, runs in parallel
 *         with registry) ≈ 9-15 calls.
 *   - Empty registry, empty queue (most common new agent):
 *       3 + 4 + 6 (registry chunks) + 6 (queue chunks) + 1 (getAgent fallback) ≈ 20 calls.
 *
 * `RPC_LOGS_CHUNK_SIZE = 999n` means ⌈5000/999⌉ = 6 chunks per event probe.
 * This matches the rest of the dashboard and keeps all chunks under Fuji's
 * 1000-block `eth_getLogs` cap with a 1-block safety buffer.
 *
 * Hard constraints honoured:
 *   - Network pinned to 43113 (throws if `publicClient.chain.id` differs).
 *   - No `debug_traceTransaction` — call-surface enumeration is out of scope
 *     here; the recommender only needs class signals + ward-aware signal.
 *   - No `client.multicall` — Fuji has no Multicall3 deployment (see
 *     `dashboard/src/main.tsx` chain definition, no `contracts.multicall3`).
 *   - No HTTP / no external indexer — every signal comes from the pinned RPC.
 */

import {
  getAddress,
  isAddress,
  parseAbiItem,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  ERC20_ABI,
  WARD_AGENT_REGISTRY_ABI,
  type RegistryAgent,
  type SelectorRule,
  type TargetRule,
} from "@ward/sdk";

// `recoverPolicyInputFromChain` (dashboard/src/lib/policyRecovery.ts) would
// be the hook for resolvedTargets. We deliberately do NOT call it here:
// it requires a chunked PolicyPublished+PolicyUpdated scan plus a `getTransaction` plus
// `decodeFunctionData`, which is a 5-10× budget regression on every
// discovery. The recommender's rule-5/6 needs at most the agent's declared
// (oracle, policyId) to bind the new watch subscription to the existing
// entry.policyId — `resolvedTargets` is therefore exposed as an optional
// field on the registry evidence so a future wizard step can populate it
// out-of-band (after the operator has committed to the agent) without
// blocking discovery's hot path.

import { getNetwork, ACTIVE_CHAIN_ID } from "./networks";

/**
 * Coarse classification used by the recommender to pick rule branches. Token
 * kinds let the wizard surface the matching ERC-20 / ERC-721 selectors as
 * defaults without a debug_traceTransaction walk.
 */
export type AgentKind =
  | "eoa"
  | "contract"
  | "erc20"
  | "erc721"
  | "unknown-contract";

/**
 * Concrete proof that the address participates in Ward's call-time gating.
 *
 *   - `kind: 'registry'` — the address has an active row in WardAgentRegistry.
 *     We forward the full canonical entry (from `getAgent`, which returns the
 *     post-update Agent struct including `tags` — the public mapping
 *     `agents(addr)` omits the dynamic `tags` array because Solidity can't
 *     auto-getter them).
 *
 *     `resolvedTargets` carries the (target, selectors[]) tuple from the live
 *     registry-bound PolicyInput so the deterministic policy recommender's
 *     rules 5 & 6 can emit byte-identical output instead of a `0x00000000`
 *     stub. Resolution is deliberately best-effort and bounded: a recovery
 *     failure leaves the field `undefined` and surfaces an error in
 *     `report.errors[]`. The recommender MUST treat `undefined` as "downgrade
 *     to observation-only recommendation".
 *
 *   - `kind: 'queue'` — the address has routed a VETO_REQUIRED / DELAYED
 *     intent through WardQueue. Doesn't prove registry membership, but
 *     proves the agent at minimum reads checkIntent's tier-routing path.
 */
export type WardAwareEvidence =
  | {
      kind: "registry";
      policyId: Hex;
      oracle: Address;
      registrar: Address;
      name: string;
      metadataURI: string;
      tags: readonly string[];
      updatedAt: bigint;
      active: boolean;
      /** Optional resolution of the registry-bound policy's targets[]. See type docs. */
      resolvedTargets?: readonly TargetRule[];
    }
  | {
      kind: "queue";
      execId: bigint;
      policyId: Hex;
      tier: number;
      blockNumber: bigint;
    };

/**
 * Per-probe error trail surfaced to the recommender. Each entry names the
 * probe (so the recommender / wizard can map it back to the failing UI
 * affordance) and carries the underlying error message — we never throw the
 * raw `Error` instance across the React boundary.
 */
export interface DiscoveryProbeError {
  probe:
    | "head"
    | "code"
    | "nonce"
    | "balance"
    | "supportsInterface(0x80ac58cd)"
    | "symbol()"
    | "decimals()"
    | "registry-getLogs"
    | "queue-getLogs"
    | "registry-getAgent";
  message: string;
  /** Optional context — e.g. the block range that failed. */
  detail?: string;
}

export interface DiscoveryReport {
  agent: Address;
  chainId: typeof ACTIVE_CHAIN_ID;
  kind: AgentKind;
  hasCode: boolean;
  /** Runtime bytecode size in bytes (0 for EOA). */
  codeSize: number;
  /** Originating-tx nonce. Contracts always report 1 (CREATE-bumped). */
  nonce: number;
  balanceWei: bigint;
  tokenFingerprint: {
    name?: string;
    symbol?: string;
    decimals?: number;
    supports721: boolean;
  } | null;
  wardAware:
    | { wardAware: true; evidence: WardAwareEvidence }
    | {
        wardAware: false;
        reason:
          | "no-registry-no-queue"
          | "registry-check-failed"
          | "queue-check-failed";
      };
  alreadyRegistered:
    | { registered: true; entry: RegistryAgent }
    | { registered: false };
  /**
   * Late-binding probe — present when the agent exposes a public `POLICY_ID()`
   * view (see §6.5 of SKILL.md). `policyId` is whatever the slot currently
   * holds: `0x00…00` means the agent is UNGATED (no policy bound, `_gate`
   * runs as a no-op); a non-zero value is the currently bound policy. When
   * the probe call reverts, the agent doesn't expose POLICY_ID — surfaces
   * as `null` so the UI hides the row entirely.
   */
  lateBinding:
    | { exposed: true; policyId: Hex }
    | null;
  scannedAtMs: number;
  rpcCallsUsed: number;
  /** Free-text warnings — superset of `errors[]` rendered for the user. */
  warnings: string[];
  /**
   * Per-probe structured error trail so the recommender can downgrade
   * confidence per probe.
   */
  errors: DiscoveryProbeError[];
}

export interface DiscoverAgentOpts {
  publicClient: PublicClient;
  address: Address;
  signal?: AbortSignal;
}

/**
 * Ward-aware lookback window in blocks. ~5000 blocks at Fuji's ~1s
 * block time ≈ 80 minutes. Wide enough to catch any registration that the
 * operator just kicked off in a sibling tab, narrow enough to keep the whole
 * probe under ~2s. The authoritative `alreadyRegistered` answer comes from
 * `getAgent(address)` regardless (one extra cheap readContract), so this
 * window only affects how fast we discover the FRESHEST evidence — older
 * registrations still resolve via the canonical read.
 */
export const WARD_AWARE_LOOKBACK_BLOCKS = 5_000n;

/**
 * Fuji caps `eth_getLogs` at 1000 blocks per call. Matches the rest of
 * the codebase (agent-discovery.ts:33 / onChainPolicyLookup.ts:53 /
 * policyRecovery.ts:56) — value held at 999 (one-block buffer) so a single
 * off-by-one in the chunker never triggers the RPC's `block range too large`
 * error path.
 */
export const RPC_LOGS_CHUNK_SIZE = 999n;

/**
 * Parsed event items hand-rolled here rather than pulled out of the SDK ABI
 * so viem's `getLogs({ event, args })` topic encoding is unambiguous — viem
 * needs the event-item form, not the full ABI array.
 */
const AGENT_REGISTERED_EVENT = parseAbiItem(
  "event AgentRegistered(address indexed agent, address indexed registrar, address indexed oracle, bytes32 policyId, string name, string metadataURI, string[] tags)",
);

const QUEUE_ENQUEUED_EVENT = parseAbiItem(
  "event Enqueued(uint256 indexed execId, bytes32 indexed policyId, address indexed asker, uint8 tier, uint64 earliestCommitAt, uint64 deadline, bytes32 calldataHash)",
);

/**
 * ERC-165 interface id for ERC-721. Probed via `supportsInterface` so we
 * disambiguate ERC-20 vs ERC-721 — `transferFrom` / `approve` selectors
 * collide between the two standards, so the only safe classifier is
 * ERC-165.
 */
const ERC721_INTERFACE_ID = "0x80ac58cd" as Hex;

/**
 * Tiny ABI for ERC-165 — kept inline so we don't depend on a fragment that
 * may not be present in the SDK abi.ts. Output explicitly typed bool.
 */
const ERC165_SUPPORTS_INTERFACE_ABI = [
  {
    type: "function",
    name: "supportsInterface",
    stateMutability: "view",
    inputs: [{ name: "interfaceId", type: "bytes4" }],
    outputs: [{ type: "bool" }],
  },
] as const;

/**
 * Inclusive ascending block-range chunker. Mirrors `chunkBlockRangeAsc` in
 * agent-discovery.ts but kept local so this module stays self-contained.
 * Returns at most ⌈(toBlock - fromBlock + 1) / chunkSize⌉ chunks; each chunk
 * spans ≤ chunkSize blocks (RPC cap minus the one-block buffer in
 * `RPC_LOGS_CHUNK_SIZE`).
 */
function chunkBlockRangeDesc(
  floor: bigint,
  head: bigint,
  chunkSize: bigint,
): Array<{ fromBlock: bigint; toBlock: bigint }> {
  if (chunkSize <= 0n) throw new Error("chunkSize must be positive");
  if (head < floor) return [];
  const out: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  let toBlock = head;
  while (true) {
    const fromBlock =
      toBlock > floor + chunkSize - 1n ? toBlock - chunkSize + 1n : floor;
    out.push({ fromBlock, toBlock });
    if (fromBlock === floor) return out;
    toBlock = fromBlock - 1n;
  }
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000" as const satisfies Address;

interface HeadCodeNonceResult {
  head?: bigint;
  code?: Hex;
  nonce?: number;
  rpcCallsUsed: number;
  errors: DiscoveryProbeError[];
}

async function probeHeadCodeNonce(
  client: PublicClient,
  address: Address,
  signal: AbortSignal | undefined,
): Promise<HeadCodeNonceResult> {
  checkAborted(signal);
  // Three independent calls — fire as one Promise.allSettled so a single
  // probe failure doesn't cancel the others.
  const [headRes, codeRes, nonceRes] = await Promise.allSettled([
    client.getBlockNumber(),
    client.getCode({ address }),
    client.getTransactionCount({ address }),
  ]);

  const errors: DiscoveryProbeError[] = [];
  const out: HeadCodeNonceResult = { rpcCallsUsed: 3, errors };

  if (headRes.status === "fulfilled") out.head = headRes.value;
  else errors.push({ probe: "head", message: errMessage(headRes.reason) });

  if (codeRes.status === "fulfilled") out.code = codeRes.value as Hex | undefined;
  else errors.push({ probe: "code", message: errMessage(codeRes.reason) });

  if (nonceRes.status === "fulfilled") out.nonce = nonceRes.value;
  else errors.push({ probe: "nonce", message: errMessage(nonceRes.reason) });

  return out;
}

interface FingerprintResult {
  balanceWei?: bigint;
  symbol?: string;
  decimals?: number;
  supports721: boolean;
  rpcCallsUsed: number;
  errors: DiscoveryProbeError[];
}

/**
 * One Promise.allSettled batch:
 *   - balance (always)
 *   - supportsInterface(ERC721) (only if hasCode)
 *   - symbol() (only if hasCode)
 *   - decimals() (only if hasCode)
 *
 * Token reads are independently try/caught via Promise.allSettled — a revert
 * just means "not that standard", not "discovery failed". An ERC-20 reverts
 * `supportsInterface` (no ERC-165) and resolves `symbol`/`decimals`; an
 * ERC-721 resolves all three; a generic contract reverts all three. Fuji
 * has no Multicall3 deployment, so these stay as direct reads.
 */
async function probeBalanceAndFingerprint(
  client: PublicClient,
  address: Address,
  hasCode: boolean,
  signal: AbortSignal | undefined,
): Promise<FingerprintResult> {
  checkAborted(signal);
  const errors: DiscoveryProbeError[] = [];
  let rpcCallsUsed = 1; // balance always
  if (hasCode) rpcCallsUsed += 3;

  // Tuple type lines up positions to indices used in the destructuring below.
  type Probes = [
    Promise<bigint>,
    Promise<boolean>,
    Promise<string>,
    Promise<number>,
  ];
  const probes: Probes = [
    client.getBalance({ address }),
    hasCode
      ? (client.readContract({
          address,
          abi: ERC165_SUPPORTS_INTERFACE_ABI,
          functionName: "supportsInterface",
          args: [ERC721_INTERFACE_ID],
        }) as Promise<boolean>)
      : Promise.reject(new Error("no-code")),
    hasCode
      ? (client.readContract({
          address,
          abi: ERC20_ABI,
          functionName: "symbol",
        }) as Promise<string>)
      : Promise.reject(new Error("no-code")),
    hasCode
      ? (client.readContract({
          address,
          abi: ERC20_ABI,
          functionName: "decimals",
        }) as Promise<number>)
      : Promise.reject(new Error("no-code")),
  ];

  const [balanceRes, supports721Res, symbolRes, decimalsRes] =
    await Promise.allSettled(probes);

  let balanceWei: bigint | undefined;
  if (balanceRes.status === "fulfilled") balanceWei = balanceRes.value;
  else errors.push({ probe: "balance", message: errMessage(balanceRes.reason) });

  let supports721 = false;
  if (supports721Res.status === "fulfilled") {
    supports721 = supports721Res.value === true;
  } else if (hasCode) {
    // Only treat as a probe error when we ACTUALLY tried the call. The
    // synthetic "no-code" rejection is structural, not a probe failure.
    const msg = errMessage(supports721Res.reason);
    if (msg !== "no-code") {
      errors.push({
        probe: "supportsInterface(0x80ac58cd)",
        message: msg,
      });
    }
  }

  let symbol: string | undefined;
  if (symbolRes.status === "fulfilled") {
    symbol = symbolRes.value;
  } else if (hasCode) {
    const msg = errMessage(symbolRes.reason);
    if (msg !== "no-code") {
      errors.push({ probe: "symbol()", message: msg });
    }
  }

  let decimals: number | undefined;
  if (decimalsRes.status === "fulfilled") {
    decimals = Number(decimalsRes.value);
  } else if (hasCode) {
    const msg = errMessage(decimalsRes.reason);
    if (msg !== "no-code") {
      errors.push({ probe: "decimals()", message: msg });
    }
  }

  return {
    balanceWei,
    symbol,
    decimals,
    supports721,
    rpcCallsUsed,
    errors,
  };
}

interface RegistryLogHit {
  policyId: Hex;
  oracle: Address;
  registrar: Address;
  name: string;
  metadataURI: string;
  tags: readonly string[];
  blockNumber: bigint;
}

interface QueueLogHit {
  execId: bigint;
  policyId: Hex;
  tier: number;
  blockNumber: bigint;
}

interface RegistryProbeResult {
  hit: RegistryLogHit | null;
  /** True iff EVERY chunk threw. Drives `reason: 'registry-check-failed'`. */
  allChunksFailed: boolean;
  /** Per-chunk failures captured for the report errors[] trail. */
  errors: DiscoveryProbeError[];
  rpcCallsUsed: number;
}

interface QueueProbeResult {
  hit: QueueLogHit | null;
  allChunksFailed: boolean;
  errors: DiscoveryProbeError[];
  rpcCallsUsed: number;
}

/**
 * Walk PolicyRegistry's `AgentRegistered` event for our address, newest-first,
 * breaking on the first chunk that yields a hit. Returns the most recent
 * matching log within that chunk (max blockNumber). Chunked at
 * `RPC_LOGS_CHUNK_SIZE` to honour Fuji's 1000-block getLogs cap.
 *
 * NOTE: this only catches registrations within the lookback window. The
 * canonical "is this agent in the registry at all?" answer comes from the
 * `getAgent` readContract in step 4 below — that read uses the agent address
 * as the mapping key, so it sees ALL prior registrations regardless of how
 * many blocks ago they happened.
 */
async function probeRegistry(
  client: PublicClient,
  registryAddress: Address,
  agent: Address,
  head: bigint,
  signal: AbortSignal | undefined,
): Promise<RegistryProbeResult> {
  const floor =
    head > WARD_AWARE_LOOKBACK_BLOCKS ? head - WARD_AWARE_LOOKBACK_BLOCKS : 0n;
  const chunks = chunkBlockRangeDesc(floor, head, RPC_LOGS_CHUNK_SIZE);
  const errors: DiscoveryProbeError[] = [];
  let failedChunks = 0;
  let attemptedChunks = 0;
  let rpcCallsUsed = 0;

  for (const { fromBlock, toBlock } of chunks) {
    checkAborted(signal);
    attemptedChunks += 1;
    rpcCallsUsed += 1;
    try {
      const logs = (await client.getLogs({
        address: registryAddress,
        event: AGENT_REGISTERED_EVENT,
        args: { agent },
        fromBlock,
        toBlock,
      })) as unknown as Array<{
        args: {
          agent: Address;
          registrar: Address;
          oracle: Address;
          policyId: Hex;
          name: string;
          metadataURI: string;
          tags: readonly string[];
        };
        blockNumber: bigint;
      }>;
      if (logs.length === 0) continue;
      // Most recent within this chunk wins. Logs from viem arrive in
      // chunk-ascending order; iterate to find the max blockNumber rather
      // than rely on the position.
      let best = logs[0]!;
      for (const log of logs) {
        if (log.blockNumber > best.blockNumber) best = log;
      }
      return {
        hit: {
          policyId: best.args.policyId,
          oracle: best.args.oracle,
          registrar: best.args.registrar,
          name: best.args.name,
          metadataURI: best.args.metadataURI,
          tags: best.args.tags,
          blockNumber: best.blockNumber,
        },
        allChunksFailed: false,
        errors,
        rpcCallsUsed,
      };
    } catch (e) {
      failedChunks += 1;
      errors.push({
        probe: "registry-getLogs",
        message: errMessage(e),
        detail: `[${fromBlock}, ${toBlock}]`,
      });
      // Continue walking — a single bad chunk shouldn't sink the probe.
    }
  }

  return {
    hit: null,
    // attemptedChunks === 0 happens only when head < 0 (impossible) — defensive.
    allChunksFailed: attemptedChunks > 0 && failedChunks === attemptedChunks,
    errors,
    rpcCallsUsed,
  };
}

/**
 * Walk WardQueue's `Enqueued` event filtered on `asker` (the third indexed
 * arg, per WARD_QUEUE_ABI). Same chunking discipline as registry probe.
 *
 * An Enqueued event proves the agent's calls routed through Ward's
 * tier-gating queue (VETO_REQUIRED or DELAYED) — which only happens for
 * Ward-aware caller code paths.
 */
async function probeQueue(
  client: PublicClient,
  queueAddress: Address,
  asker: Address,
  head: bigint,
  signal: AbortSignal | undefined,
): Promise<QueueProbeResult> {
  const floor =
    head > WARD_AWARE_LOOKBACK_BLOCKS ? head - WARD_AWARE_LOOKBACK_BLOCKS : 0n;
  const chunks = chunkBlockRangeDesc(floor, head, RPC_LOGS_CHUNK_SIZE);
  const errors: DiscoveryProbeError[] = [];
  let failedChunks = 0;
  let attemptedChunks = 0;
  let rpcCallsUsed = 0;

  for (const { fromBlock, toBlock } of chunks) {
    checkAborted(signal);
    attemptedChunks += 1;
    rpcCallsUsed += 1;
    try {
      const logs = (await client.getLogs({
        address: queueAddress,
        event: QUEUE_ENQUEUED_EVENT,
        args: { asker },
        fromBlock,
        toBlock,
      })) as unknown as Array<{
        args: {
          execId: bigint;
          policyId: Hex;
          asker: Address;
          tier: number;
          earliestCommitAt: bigint;
          deadline: bigint;
          calldataHash: Hex;
        };
        blockNumber: bigint;
      }>;
      if (logs.length === 0) continue;
      let best = logs[0]!;
      for (const log of logs) {
        if (log.blockNumber > best.blockNumber) best = log;
      }
      return {
        hit: {
          execId: best.args.execId,
          policyId: best.args.policyId,
          tier: Number(best.args.tier),
          blockNumber: best.blockNumber,
        },
        allChunksFailed: false,
        errors,
        rpcCallsUsed,
      };
    } catch (e) {
      failedChunks += 1;
      errors.push({
        probe: "queue-getLogs",
        message: errMessage(e),
        detail: `[${fromBlock}, ${toBlock}]`,
      });
    }
  }

  return {
    hit: null,
    allChunksFailed: attemptedChunks > 0 && failedChunks === attemptedChunks,
    errors,
    rpcCallsUsed,
  };
}

interface RegistryRowResult {
  entry: RegistryAgent | null;
  errors: DiscoveryProbeError[];
  rpcCallsUsed: number;
}

/**
 * `getAgent(address)` returns the full Agent struct including the dynamic
 * `tags` array (the `agents(address)` mapping accessor omits `tags` because
 * Solidity can't auto-getter dynamic types from a public mapping). A
 * registered agent's `registrar` field is non-zero; an unregistered agent
 * returns the zero-valued struct.
 *
 * This is the authoritative "is this agent in the registry now?" answer.
 */
async function fetchRegistryRow(
  client: PublicClient,
  registryAddress: Address,
  agent: Address,
  signal: AbortSignal | undefined,
): Promise<RegistryRowResult> {
  checkAborted(signal);
  const errors: DiscoveryProbeError[] = [];
  try {
    // viem decodes named-output structs positionally into an object with
    // the field names. `tags` is `readonly string[]` because viem returns
    // immutable arrays from readContract.
    const row = (await client.readContract({
      address: registryAddress,
      abi: WARD_AGENT_REGISTRY_ABI as never,
      functionName: "getAgent",
      args: [agent],
    })) as RegistryAgent;

    // Unregistered: getAgent returns the zero-valued struct (zero-address
    // registrar). Treat zero `registrar` as "not registered" — the registry's
    // `register` function reverts if registrar is the zero address, so any
    // legitimate row has non-zero.
    if (
      !row ||
      !row.registrar ||
      row.registrar.toLowerCase() === ZERO_ADDRESS
    ) {
      return { entry: null, errors, rpcCallsUsed: 1 };
    }
    return { entry: row, errors, rpcCallsUsed: 1 };
  } catch (e) {
    // Capture the failure so the wizard can show "could not confirm registry status".
    errors.push({
      probe: "registry-getAgent",
      message: errMessage(e),
    });
    return { entry: null, errors, rpcCallsUsed: 1 };
  }
}

/**
 * Minimal ABI for the public `POLICY_ID()` view exposed by late-binding
 * agents (see SKILL.md §6.5 + examples/ward-counter/src/CounterAgent.sol).
 * Read returns `bytes32(0)` when the agent is intentionally unbound — that
 * is NOT a probe failure, it's the documented "ungated" state.
 */
const POLICY_ID_VIEW_ABI = [
  {
    type: "function",
    name: "POLICY_ID",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
] as const;

interface LateBindingProbeResult {
  lateBinding: DiscoveryReport["lateBinding"];
  rpcCallsUsed: number;
}

/**
 * Defensive probe — wrapped in try/catch so a revert (agent doesn't expose
 * POLICY_ID — not a late-binding agent) never throws past the discovery
 * loop. Only the happy path mutates `lateBinding`; everything else returns
 * `null` and the UI hides the row.
 */
async function probeLateBinding(
  client: PublicClient,
  address: Address,
  hasCode: boolean,
  signal: AbortSignal | undefined,
): Promise<LateBindingProbeResult> {
  if (!hasCode) return { lateBinding: null, rpcCallsUsed: 0 };
  checkAborted(signal);
  try {
    const policyId = (await client.readContract({
      address,
      abi: POLICY_ID_VIEW_ABI,
      functionName: "POLICY_ID",
    })) as Hex;
    return {
      lateBinding: { exposed: true, policyId },
      rpcCallsUsed: 1,
    };
  } catch {
    // Revert = no such function. Not a probe failure; agents that don't use
    // the late-binding pattern are the common case.
    return { lateBinding: null, rpcCallsUsed: 1 };
  }
}

export async function discoverAgent(
  opts: DiscoverAgentOpts,
): Promise<DiscoveryReport> {
  const { publicClient, address, signal } = opts;

  if (!publicClient) {
    throw new Error("discoverAgent: publicClient required");
  }
  if (publicClient.chain?.id !== ACTIVE_CHAIN_ID) {
    throw new Error(
      `discoverAgent: chain mismatch — got ${publicClient.chain?.id ?? "undefined"}, expected ${ACTIVE_CHAIN_ID}`,
    );
  }
  if (!address || !isAddress(address)) {
    throw new Error("discoverAgent: address is not a 40-hex address");
  }

  // Network must have registry + queue + oracle pinned for Ward-aware
  // probes to mean anything. Refusal here is a programmer-config error
  // (missing networks.ts entry), not a runtime failure.
  const network = getNetwork(ACTIVE_CHAIN_ID);
  if (!network) {
    throw new Error(`discoverAgent: no NETWORKS entry for ${ACTIVE_CHAIN_ID}`);
  }
  if (!network.registryAddress) {
    throw new Error("discoverAgent: NETWORKS entry missing registryAddress");
  }
  const { registryAddress, queueAddress } = network;

  // Preserve the checksummed form for display; lowercase the comparison form
  // is only needed at log-arg encoding time (viem accepts either case).
  const checksummed = getAddress(address);

  const allErrors: DiscoveryProbeError[] = [];
  const warnings: string[] = [];
  let rpcCallsUsed = 0;
  const scannedAtMs = Date.now();

  const step1 = await probeHeadCodeNonce(publicClient, checksummed, signal);
  rpcCallsUsed += step1.rpcCallsUsed;
  allErrors.push(...step1.errors);
  for (const e of step1.errors) {
    warnings.push(`${e.probe}: ${e.message}`);
  }

  // `hasCode` derivation. viem returns `undefined` for "no code"; some RPCs
  // return "0x". Treat both as EOA. codeSize is bytes — strip "0x" and divide
  // by two; an `undefined` falls through as 0.
  const code = step1.code;
  const hasCode = !!code && code !== "0x";
  const codeSize = hasCode ? (code!.length - 2) / 2 : 0;

  checkAborted(signal);
  const step2 = await probeBalanceAndFingerprint(
    publicClient,
    checksummed,
    hasCode,
    signal,
  );
  rpcCallsUsed += step2.rpcCallsUsed;
  allErrors.push(...step2.errors);
  for (const e of step2.errors) {
    warnings.push(`${e.probe}: ${e.message}`);
  }

  // Classification: ERC-165 ERC-721 wins; failing that, presence of decimals
  // alone is the ERC-20 signal (token revert for the others). Any contract
  // that exposes neither gets the `unknown-contract` bucket so the
  // recommender can still emit observation rules without misclassifying.
  let kind: AgentKind;
  if (!hasCode) {
    kind = "eoa";
  } else if (step2.supports721) {
    kind = "erc721";
  } else if (step2.decimals !== undefined) {
    kind = "erc20";
  } else {
    kind = "unknown-contract";
  }

  const tokenFingerprint =
    hasCode && (step2.symbol !== undefined || step2.decimals !== undefined || step2.supports721)
      ? {
          symbol: step2.symbol,
          decimals: step2.decimals,
          supports721: step2.supports721,
        }
      : null;

  // Only run when we know `head`; if step 1 lost it, we can't define a
  // floor block and the registry/queue probes are skipped. The canonical
  // `getAgent` read in step 4 still runs (it doesn't need a block number)
  // so `alreadyRegistered` stays authoritative.
  let registryProbe: RegistryProbeResult | null = null;
  let queueProbe: QueueProbeResult | null = null;

  if (step1.head !== undefined) {
    checkAborted(signal);
    const [registryRes, queueRes] = await Promise.allSettled([
      probeRegistry(
        publicClient,
        registryAddress,
        checksummed,
        step1.head,
        signal,
      ),
      probeQueue(publicClient, queueAddress, checksummed, step1.head, signal),
    ]);

    if (registryRes.status === "fulfilled") {
      registryProbe = registryRes.value;
      rpcCallsUsed += registryRes.value.rpcCallsUsed;
      allErrors.push(...registryRes.value.errors);
      for (const e of registryRes.value.errors) {
        warnings.push(`${e.probe}: ${e.message}`);
      }
    } else {
      // Shouldn't fire: probeRegistry catches its own getLogs failures. This
      // path runs only if probeRegistry threw on an AbortError; re-throw so
      // the caller's abort handling fires.
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const msg = errMessage(registryRes.reason);
      allErrors.push({ probe: "registry-getLogs", message: msg });
      warnings.push(`registry-getLogs: ${msg}`);
    }

    if (queueRes.status === "fulfilled") {
      queueProbe = queueRes.value;
      rpcCallsUsed += queueRes.value.rpcCallsUsed;
      allErrors.push(...queueRes.value.errors);
      for (const e of queueRes.value.errors) {
        warnings.push(`${e.probe}: ${e.message}`);
      }
    } else {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const msg = errMessage(queueRes.reason);
      allErrors.push({ probe: "queue-getLogs", message: msg });
      warnings.push(`queue-getLogs: ${msg}`);
    }
  } else {
    warnings.push(
      "Skipped Ward-aware event probes — head block fetch failed.",
    );
  }

  // Always runs, regardless of step 3 outcome — this is the only path that
  // catches pre-lookback registrations and is required to make the wizard's
  // Step 2 gate reliable.
  const rowResult = await fetchRegistryRow(
    publicClient,
    registryAddress,
    checksummed,
    signal,
  );
  rpcCallsUsed += rowResult.rpcCallsUsed;
  allErrors.push(...rowResult.errors);
  for (const e of rowResult.errors) {
    warnings.push(`${e.probe}: ${e.message}`);
  }

  const lateBindingResult = await probeLateBinding(
    publicClient,
    checksummed,
    hasCode,
    signal,
  );
  rpcCallsUsed += lateBindingResult.rpcCallsUsed;

  // Priority: registry hit > queue hit > canonical row > negative reason.
  //
  // When the recent-log probes both miss but the canonical row exists, the
  // agent IS Ward-aware (it's just an older registration) — surface that
  // via a synthesized 'registry' evidence carrying the canonical row, so
  // the recommender doesn't drop to observation-only just because the agent
  // hasn't been touched in the lookback window.
  let wardAware: DiscoveryReport["wardAware"];
  if (registryProbe?.hit) {
    const hit = registryProbe.hit;
    wardAware = {
      wardAware: true,
      evidence: {
        kind: "registry",
        policyId: hit.policyId,
        oracle: hit.oracle,
        registrar: hit.registrar,
        name: hit.name,
        metadataURI: hit.metadataURI,
        tags: hit.tags,
        // The log doesn't carry updatedAt/active — pull from the canonical row
        // when present, otherwise default to "active now" (the log itself is
        // the proof of activation; a subsequent setActive(false) would have
        // been picked up by the canonical row). updatedAt falls back to the
        // log's block number cast through 1 because we don't have the timestamp
        // here — design contract says we ship the bigint and let the UI render.
        updatedAt: rowResult.entry?.updatedAt ?? 0n,
        active: rowResult.entry?.active ?? true,
        // `resolvedTargets` deliberately left undefined here — see the
        // _recoverPolicyInputFromChainHook note at the top of the file for
        // the budget rationale. The wizard recommender's rule-5/6 treats
        // undefined as "use entry.policyId for the watchSubscription binding
        // and surface observation-only".
        resolvedTargets: undefined,
      },
    };
  } else if (queueProbe?.hit) {
    wardAware = {
      wardAware: true,
      evidence: {
        kind: "queue",
        execId: queueProbe.hit.execId,
        policyId: queueProbe.hit.policyId,
        tier: queueProbe.hit.tier,
        blockNumber: queueProbe.hit.blockNumber,
      },
    };
  } else if (rowResult.entry) {
    // Registered, but no recent activity within the lookback window.
    wardAware = {
      wardAware: true,
      evidence: {
        kind: "registry",
        policyId: rowResult.entry.policyId,
        oracle: rowResult.entry.oracle,
        registrar: rowResult.entry.registrar,
        name: rowResult.entry.name,
        metadataURI: rowResult.entry.metadataURI,
        tags: rowResult.entry.tags,
        updatedAt: rowResult.entry.updatedAt,
        active: rowResult.entry.active,
        resolvedTargets: undefined,
      },
    };
  } else {
    // Pick the most specific failure reason — both checks failed > one check
    // failed > nothing found.
    let reason:
      | "no-registry-no-queue"
      | "registry-check-failed"
      | "queue-check-failed" = "no-registry-no-queue";
    const registryFailed = registryProbe?.allChunksFailed ?? false;
    const queueFailed = queueProbe?.allChunksFailed ?? false;
    if (registryFailed && !queueFailed) reason = "registry-check-failed";
    else if (queueFailed && !registryFailed) reason = "queue-check-failed";
    else if (registryFailed && queueFailed) {
      // Both probes blew up — prefer "registry-check-failed" (the
      // primary signal) so the UI surfaces the more user-actionable
      // affordance.
      reason = "registry-check-failed";
    }
    wardAware = { wardAware: false, reason };
  }

  const alreadyRegistered: DiscoveryReport["alreadyRegistered"] = rowResult.entry
    ? { registered: true, entry: rowResult.entry }
    : { registered: false };

  return {
    agent: checksummed,
    chainId: ACTIVE_CHAIN_ID,
    kind,
    hasCode,
    codeSize,
    nonce: step1.nonce ?? (hasCode ? 1 : 0),
    balanceWei: step2.balanceWei ?? 0n,
    tokenFingerprint,
    wardAware,
    alreadyRegistered,
    lateBinding: lateBindingResult.lateBinding,
    scannedAtMs,
    rpcCallsUsed,
    warnings,
    errors: allErrors,
  };
}

/**
 * Re-export for the type the recommender consumes. Kept here so a caller
 * importing only from `./discovery` doesn't need a second import line.
 */
export type { RegistryAgent, SelectorRule, TargetRule };
