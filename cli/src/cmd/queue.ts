import { readFileSync } from "node:fs";
import {
  LEGACY_WARD_QUEUE_ABI_V0,
  WARD_ORACLE_ABI,
  WARD_QUEUE_ABI,
  abiExposesDispatchQueued,
  buildQueueHandoffRecommendation,
  extractAbi,
} from "@ward/sdk";
import kleur from "kleur";
import { decodeFunctionResult, padHex, type Address, type Hex } from "viem";
import {
  loadEnv,
  publicClient,
  walletClient,
  requireWardOracle,
  requireWardQueue,
  requirePrivateKey,
} from "../lib/env.js";

const STATE_NAMES = ["None", "Pending", "Committed", "Vetoed", "Expired"] as const;
const TIER_NAMES: Record<number, string> = { 0: "IMMEDIATE", 1: "DELAYED", 2: "VETO_REQUIRED" };

export interface QueueHeaderRaw {
  policyId: Hex;
  policyVersion: bigint;
  asker: Address;
  enqueuedAt: bigint;
  earliestCommitAt: bigint;
  deadline: bigint;
  tier: number;
  state: number;
  target: Address;
  selector: Hex;
  value: bigint;
  requestId: bigint;
}

type QueueHeaderLegacyRaw = Omit<QueueHeaderRaw, "policyVersion">;

function queueHeaderPayloadBytes(err: unknown): string | undefined {
  const msg = err instanceof Error ? err.message : String(err);
  const bound = msg.match(/0\s*<\s*position\s*<\s*(\d+)/i)?.[1];
  if (bound) return bound;
  const hex = msg.match(/0x[0-9a-f]+/i)?.[0];
  return hex ? String((hex.length - 2) / 2) : undefined;
}

function isSupportedQueueHeaderDecodeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /is out of bounds/i.test(msg) || (/not in safe integer range/i.test(msg) && /getRecordHeader/i.test(msg));
}

function withLegacyPolicyVersion(raw: QueueHeaderLegacyRaw | QueueHeaderRaw): QueueHeaderRaw {
  if ("policyVersion" in raw) return raw;
  return { ...raw, policyVersion: 0n };
}

function normalizeLegacyQueueHeader(raw: unknown): QueueHeaderRaw {
  // decodeFunctionResult is best-effort here; the caller already classified the legacy path.
  const decoded =
    typeof raw === "string"
      ? decodeFunctionResult({
          abi: LEGACY_WARD_QUEUE_ABI_V0,
          functionName: "getRecordHeader",
          data: raw as Hex,
        } as unknown as Parameters<typeof decodeFunctionResult>[0])
      : raw;
  return withLegacyPolicyVersion(decoded as QueueHeaderLegacyRaw | QueueHeaderRaw);
}

function queueHeaderShapeError(queue: Address, canonicalErr: unknown, legacyErr: unknown): Error {
  const bytes = queueHeaderPayloadBytes(legacyErr) ?? queueHeaderPayloadBytes(canonicalErr) ?? "unknown";
  return new Error(
    `WardQueue at ${queue} returned an unexpected payload shape (${bytes} bytes); expected 384 or 352 bytes. The deployed contract may be on a newer or older RecordHeader version than the SDK supports.`,
  );
}

export async function readQueueHeader(client: ReturnType<typeof publicClient>, queue: Address, execId: bigint): Promise<QueueHeaderRaw> {
  let canonicalErr: unknown;
  try {
    return (await client.readContract({
      address: queue,
      abi: WARD_QUEUE_ABI as never,
      functionName: "getRecordHeader",
      args: [execId],
    })) as QueueHeaderRaw;
  } catch (err) {
    if (!isSupportedQueueHeaderDecodeError(err)) throw err;
    canonicalErr = err;
  }

  try {
    const legacy = await client.readContract({
      address: queue,
      abi: LEGACY_WARD_QUEUE_ABI_V0 as never,
      functionName: "getRecordHeader",
      args: [execId],
    });
    return normalizeLegacyQueueHeader(legacy);
  } catch (legacyErr) {
    throw queueHeaderShapeError(queue, canonicalErr, legacyErr);
  }
}

function loadAgentHasDispatchQueued(path?: string): boolean {
  if (!path) return false;
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  return abiExposesDispatchQueued(extractAbi(parsed));
}

export async function queueStatusCmd(execIdStr: string): Promise<void> {
  const env = loadEnv();
  const queue = requireWardQueue(env);
  const client = publicClient(env.rpc);
  const execId = BigInt(execIdStr);

  const h = await readQueueHeader(client, queue, execId);

  const now = BigInt(Math.floor(Date.now() / 1000));
  const remaining =
    h.state === 1 ? (h.earliestCommitAt > now ? `${h.earliestCommitAt - now}s until dispatchable` : `dispatchable; ${h.deadline - now}s left before expiry`) : "-";

  console.log(kleur.bold().cyan(`# queue record execId=${execId}`));
  console.log(`  state           ${kleur.bold(STATE_NAMES[h.state] ?? `Unknown(${h.state})`)}`);
  console.log(`  tier            ${TIER_NAMES[h.tier] ?? h.tier}`);
  console.log(`  policyId        ${h.policyId}`);
  console.log(`  asker           ${h.asker}`);
  console.log(`  target          ${h.target}`);
  console.log(`  selector        ${h.selector}`);
  console.log(`  value           ${h.value}`);
  console.log(`  requestId       ${h.requestId}`);
  console.log(`  enqueuedAt      ${h.enqueuedAt}`);
  console.log(`  earliestCommit  ${h.earliestCommitAt}`);
  console.log(`  deadline        ${h.deadline}`);
  console.log(`  timing          ${kleur.gray(remaining)}`);
}

export interface HandoffOptions {
  agent?: Address;
  abi?: string;
}

export async function queueHandoffCmd(execIdStr: string, opts: HandoffOptions = {}): Promise<void> {
  const env = loadEnv();
  const queue = requireWardQueue(env);
  const client = publicClient(env.rpc);
  const execId = BigInt(execIdStr);
  const h = await readQueueHeader(client, queue, execId);
  const agentHasDispatchQueued = Boolean(opts.agent && opts.abi && loadAgentHasDispatchQueued(opts.abi));

  let policyOwner: Address | undefined;
  if (h.tier === 2) {
    const oracle = requireWardOracle(env);
    policyOwner = (await client.readContract({
      address: oracle,
      abi: WARD_ORACLE_ABI as never,
      functionName: "policyOwner",
      args: [h.policyId],
    })) as Address;
  }

  const rec = buildQueueHandoffRecommendation({
    execId,
    queueAddress: queue,
    tier: h.tier,
    asker: h.asker,
    target: h.target,
    agentAddress: opts.agent,
    agentHasDispatchQueued,
    policyOwner,
  });

  console.log(kleur.bold().cyan(`# queue handoff execId=${execId}`));
  console.log(`  state           ${kleur.bold(STATE_NAMES[h.state] ?? `Unknown(${h.state})`)}`);
  console.log(`  tier            ${rec.tier}`);
  console.log(`  policyId        ${h.policyId}`);
  console.log(`  requester       ${h.asker}`);
  console.log(`  target          ${h.target}`);
  if (rec.policyOwner) console.log(`  policy owner    ${rec.policyOwner}`);
  if (opts.agent) console.log(`  agent           ${opts.agent}`);
  if (opts.abi) console.log(`  agent abi       ${agentHasDispatchQueued ? "dispatchQueued(uint256) found" : "dispatchQueued(uint256) not found"}`);
  console.log("");
  if (rec.warning) console.log(kleur.yellow(`warning: ${rec.warning}`));
  console.log(rec.summary);
  console.log(kleur.gray(rec.detail));
  if (rec.command) {
    console.log("");
    console.log("cast command:");
    console.log(rec.command);
  }
}

export interface DispatchOptions {
  /** Opt into the value-moving follow-up tx after `dispatch` commits. */
  execute?: boolean;
}

export async function queueDispatchCmd(
  execIdStr: string,
  opts: DispatchOptions = {},
): Promise<void> {
  const env = loadEnv();
  const pk = requirePrivateKey(env);
  const queue = requireWardQueue(env);
  const wallet = walletClient(pk, env.rpc);
  const client = publicClient(env.rpc);
  const execId = BigInt(execIdStr);

  // Simulate first to catch reverts and capture the Intent returned for --execute.
  let simulatedIntent!: {
    target: Address;
    data: Hex;
    value: bigint;
  };
  try {
    const sim = await client.simulateContract({
      address: queue,
      abi: WARD_QUEUE_ABI as never,
      functionName: "dispatch",
      args: [execId],
      account: wallet.account,
    });
    const result = (sim as { result: { target: Address; data: Hex; value: bigint } }).result;
    simulatedIntent = { target: result.target, data: result.data, value: result.value };
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new Error(`dispatch would revert: ${msg}`);
  }

  const hash = await wallet.writeContract({
    address: queue,
    abi: WARD_QUEUE_ABI as never,
    functionName: "dispatch",
    args: [execId],
  });
  console.log(kleur.yellow(`dispatch tx: ${hash}`));
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    console.log(kleur.red("dispatch reverted"));
    return;
  }

  if (!opts.execute) {
    console.log(
      kleur.green("dispatched OK — caller now executes the intent themselves"),
    );
    console.log(
      kleur.gray("(rerun with --execute to also send the intent's tx in this command)"),
    );
    return;
  }

  console.log(
    kleur.cyan(
      `executing intent → target=${simulatedIntent.target} value=${simulatedIntent.value} dataBytes=${(simulatedIntent.data.length - 2) / 2}`,
    ),
  );
  const execHash = await wallet.sendTransaction({
    to: simulatedIntent.target,
    data: simulatedIntent.data,
    value: simulatedIntent.value,
  });
  console.log(kleur.yellow(`execute tx: ${execHash}`));
  const execReceipt = await client.waitForTransactionReceipt({ hash: execHash });
  console.log(
    execReceipt.status === "success"
      ? kleur.green("intent executed OK")
      : kleur.red("intent execution reverted"),
  );
}

interface IntentJson {
  agentId: string;
  requestId: string;
  target: Address;
  selector: Hex;
  data: Hex;
  value: string;
  promptHash: Hex;
  taskClass: number;
}

export interface EnqueueOptions {
  /** spentToday in wei as a decimal string; defaults to "0". */
  spentToday?: string;
}

export async function queueEnqueueCmd(
  intentPath: string,
  policyIdStr: string,
  opts: EnqueueOptions = {},
): Promise<void> {
  const env = loadEnv();
  const pk = requirePrivateKey(env);
  const queue = requireWardQueue(env);
  const wallet = walletClient(pk, env.rpc);
  const client = publicClient(env.rpc);

  if (!/^0x[0-9a-fA-F]{64}$/.test(policyIdStr)) {
    throw new Error(`policyId "${policyIdStr}" must be a 32-byte hex string (0x + 64 hex chars)`);
  }
  const policyId = policyIdStr as Hex;

  const raw = JSON.parse(readFileSync(intentPath, "utf-8")) as IntentJson;
  const intent = {
    agentId: BigInt(raw.agentId),
    requestId: BigInt(raw.requestId),
    target: raw.target,
    selector: raw.selector,
    data: raw.data,
    value: BigInt(raw.value),
    promptHash: raw.promptHash,
    taskClass: raw.taskClass,
  };
  const spentToday = BigInt(opts.spentToday ?? "0");

  // Simulate first so oracle-side rejections surface before paying gas.
  try {
    await client.simulateContract({
      address: queue,
      abi: WARD_QUEUE_ABI as never,
      functionName: "enqueue",
      args: [policyId, intent as never, spentToday],
      account: wallet.account,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new Error(`enqueue would revert: ${msg}`);
  }

  const hash = await wallet.writeContract({
    address: queue,
    abi: WARD_QUEUE_ABI as never,
    functionName: "enqueue",
    args: [policyId, intent as never, spentToday],
  });
  console.log(kleur.yellow(`enqueue tx: ${hash}`));
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    console.log(kleur.red("enqueue reverted"));
    return;
  }
  console.log(kleur.green("enqueued OK"));
  console.log(
    kleur.gray(
      "(run `ward queue:status <execId>` once the Enqueued event is indexed; the execId is the indexed `nextExecId` at enqueue-time)",
    ),
  );
}

export async function queueVetoCmd(execIdStr: string, reasonText: string): Promise<void> {
  const env = loadEnv();
  const pk = requirePrivateKey(env);
  const queue = requireWardQueue(env);
  const wallet = walletClient(pk, env.rpc);
  const client = publicClient(env.rpc);

  const bytes = new TextEncoder().encode(reasonText);
  if (bytes.length > 32) throw new Error(`reason "${reasonText}" is ${bytes.length} bytes; must be ≤ 32 bytes`);
  const reasonHex = padHex(("0x" + Buffer.from(bytes).toString("hex")) as Hex, { size: 32, dir: "right" });

  const hash = await wallet.writeContract({
    address: queue,
    abi: WARD_QUEUE_ABI as never,
    functionName: "veto",
    args: [BigInt(execIdStr), reasonHex],
  });
  console.log(kleur.yellow(`veto tx: ${hash}`));
  const receipt = await client.waitForTransactionReceipt({ hash });
  console.log(
    receipt.status === "success"
      ? kleur.green(`vetoed OK · reason="${reasonText}"`)
      : kleur.red("veto reverted (likely: not policy owner, or already terminal)"),
  );
}

export async function queueExpireCmd(execIdStr: string): Promise<void> {
  const env = loadEnv();
  const pk = requirePrivateKey(env);
  const queue = requireWardQueue(env);
  const wallet = walletClient(pk, env.rpc);
  const client = publicClient(env.rpc);

  const hash = await wallet.writeContract({
    address: queue,
    abi: WARD_QUEUE_ABI as never,
    functionName: "expireIfStale",
    args: [BigInt(execIdStr)],
  });
  console.log(kleur.yellow(`expireIfStale tx: ${hash}`));
  const receipt = await client.waitForTransactionReceipt({ hash });
  console.log(
    receipt.status === "success"
      ? kleur.green("marked expired")
      : kleur.red("expireIfStale reverted (likely: still in window, or already terminal)"),
  );
}
