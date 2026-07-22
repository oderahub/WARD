import { type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { LEGACY_SENTRY_QUEUE_ABI_V0, SENTRY_QUEUE_ABI } from "./abi.js";
import type { Intent } from "./types.js";

export type QueueState = "None" | "Pending" | "Committed" | "Vetoed" | "Expired";

// The first Shannon SentryQueue returns an 11-word `RecordHeader`; synthesize `policyVersion: 0n`.
function isQueueHeaderShapeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /is out of bounds/i.test(msg) ||
    (/not in safe integer range/i.test(msg) && /getRecordHeader/i.test(msg))
  );
}

const QUEUE_STATE_NAMES: readonly QueueState[] = ["None", "Pending", "Committed", "Vetoed", "Expired"];

export interface QueueRecord {
  policyId: Hex;
  policyVersion: bigint;
  intent: Intent;
  asker: Address;
  enqueuedAt: bigint;
  earliestCommitAt: bigint;
  deadline: bigint;
  tier: number;
  state: QueueState;
}

export interface QueueRecordHeader {
  policyId: Hex;
  policyVersion: bigint;
  asker: Address;
  enqueuedAt: bigint;
  earliestCommitAt: bigint;
  deadline: bigint;
  tier: number;
  state: QueueState;
  target: Address;
  selector: Hex;
  value: bigint;
  requestId: bigint;
}

export interface QueueClient {
  readonly address: Address;
  enqueue(policyId: Hex, intent: Intent, spentToday: bigint): Promise<{ txHash: Hex }>;
  dispatch(execId: bigint): Promise<{ txHash: Hex }>;
  veto(execId: bigint, reason: Hex): Promise<{ txHash: Hex }>;
  expireIfStale(execId: bigint): Promise<{ txHash: Hex }>;
  getRecord(execId: bigint): Promise<QueueRecord>;
  getRecordHeader(execId: bigint): Promise<QueueRecordHeader>;
  nextExecId(): Promise<bigint>;
}

export interface CreateQueueClientArgs {
  publicClient: PublicClient;
  walletClient?: WalletClient;
  queueAddress: Address;
}

/** Thin viem wrapper around `SentryQueue`; reads are walletless, writes require `walletClient`. */
export function createQueueClient(args: CreateQueueClientArgs): QueueClient {
  const { publicClient, walletClient, queueAddress } = args;

  function requireWallet(): WalletClient {
    if (!walletClient) throw new Error("queue-client: walletClient required for write operations");
    if (!walletClient.account) throw new Error("queue-client: walletClient has no account");
    return walletClient;
  }

  return {
    address: queueAddress,

    async enqueue(policyId, intent, spentToday) {
      const wallet = requireWallet();
      const txHash = await wallet.writeContract({
        address: queueAddress,
        abi: SENTRY_QUEUE_ABI as never,
        functionName: "enqueue",
        args: [policyId, intent as never, spentToday],
        account: wallet.account!,
        chain: wallet.chain ?? null,
      });
      return { txHash };
    },

    async dispatch(execId) {
      const wallet = requireWallet();
      const txHash = await wallet.writeContract({
        address: queueAddress,
        abi: SENTRY_QUEUE_ABI as never,
        functionName: "dispatch",
        args: [execId],
        account: wallet.account!,
        chain: wallet.chain ?? null,
      });
      return { txHash };
    },

    async veto(execId, reason) {
      const wallet = requireWallet();
      const txHash = await wallet.writeContract({
        address: queueAddress,
        abi: SENTRY_QUEUE_ABI as never,
        functionName: "veto",
        args: [execId, reason],
        account: wallet.account!,
        chain: wallet.chain ?? null,
      });
      return { txHash };
    },

    async expireIfStale(execId) {
      const wallet = requireWallet();
      const txHash = await wallet.writeContract({
        address: queueAddress,
        abi: SENTRY_QUEUE_ABI as never,
        functionName: "expireIfStale",
        args: [execId],
        account: wallet.account!,
        chain: wallet.chain ?? null,
      });
      return { txHash };
    },

    async getRecord(execId) {
      const raw = (await publicClient.readContract({
        address: queueAddress,
        abi: SENTRY_QUEUE_ABI as never,
        functionName: "getRecord",
        args: [execId],
      })) as {
        policyId: Hex;
        policyVersion: bigint;
        intent: Intent;
        asker: Address;
        enqueuedAt: bigint;
        earliestCommitAt: bigint;
        deadline: bigint;
        tier: number;
        state: number;
      };
      return { ...raw, state: QUEUE_STATE_NAMES[raw.state] };
    },

    async getRecordHeader(execId) {
      type CanonicalRaw = {
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
      };
      type LegacyRaw = Omit<CanonicalRaw, "policyVersion">;

      let canonicalErr: unknown;
      try {
        const raw = (await publicClient.readContract({
          address: queueAddress,
          abi: SENTRY_QUEUE_ABI as never,
          functionName: "getRecordHeader",
          args: [execId],
        })) as CanonicalRaw;
        return { ...raw, state: QUEUE_STATE_NAMES[raw.state] };
      } catch (err) {
        if (!isQueueHeaderShapeError(err)) throw err;
        canonicalErr = err;
      }

      try {
        const legacy = (await publicClient.readContract({
          address: queueAddress,
          abi: LEGACY_SENTRY_QUEUE_ABI_V0 as never,
          functionName: "getRecordHeader",
          args: [execId],
        })) as LegacyRaw;
        return { ...legacy, policyVersion: 0n, state: QUEUE_STATE_NAMES[legacy.state] };
      } catch (legacyErr) {
        const legacyMsg = legacyErr instanceof Error ? legacyErr.message : String(legacyErr);
        const canonicalMsg = canonicalErr instanceof Error ? canonicalErr.message : String(canonicalErr);
        throw new Error(
          `SentryQueue at ${queueAddress} returned an unexpected payload shape ` +
            `for getRecordHeader(${execId}); expected 384 (canonical) or 352 (legacy) bytes. ` +
            `canonical decode: ${canonicalMsg} | legacy decode: ${legacyMsg}`,
        );
      }
    },

    async nextExecId() {
      return (await publicClient.readContract({
        address: queueAddress,
        abi: SENTRY_QUEUE_ABI as never,
        functionName: "nextExecId",
        args: [],
      })) as bigint;
    },
  };
}
