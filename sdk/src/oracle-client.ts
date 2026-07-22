import {
  encodeAbiParameters,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { SENTRY_ORACLE_ABI } from "./abi.js";
import type { PolicyInput, Intent } from "./types.js";

export interface OracleClient {
  readonly address: Address;
  publishPolicy(label: Hex, input: PolicyInput): Promise<{ txHash: Hex; policyId: Hex }>;
  updatePolicy(policyId: Hex, input: PolicyInput): Promise<{ txHash: Hex }>;
  checkIntent(policyId: Hex, intent: Intent, spentToday: bigint): Promise<{ ok: boolean; reason: Hex }>;
  tierAndDelay(policyId: Hex, target: Address, selector: Hex): Promise<{ tier: number; delaySeconds: number }>;
}

export function policyIdFor(publisher: Address, label: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [publisher, label]));
}

export interface CreateOracleClientArgs {
  publicClient: PublicClient;
  walletClient?: WalletClient;
  oracleAddress: Address;
  /** Optional chain id to pin every write to; viem rejects mismatched wallets. */
  chainId?: number;
}

/** Thin viem wrapper around `SentryOracle`; reads are walletless, writes simulate before submitting. */
export function createOracleClient(args: CreateOracleClientArgs): OracleClient {
  const { publicClient, walletClient, oracleAddress, chainId } = args;

  function requireWallet(): WalletClient {
    if (!walletClient) throw new Error("oracle-client: walletClient required for write operations");
    if (!walletClient.account) throw new Error("oracle-client: walletClient has no account");
    return walletClient;
  }

  async function simulateAndWrite(opts: {
    functionName: string;
    args: readonly unknown[];
  }): Promise<Hex> {
    const wallet = requireWallet();
    await publicClient.simulateContract({
      address: oracleAddress,
      abi: SENTRY_ORACLE_ABI as never,
      functionName: opts.functionName,
      args: opts.args as never,
      account: wallet.account!,
    });
    return wallet.writeContract({
      address: oracleAddress,
      abi: SENTRY_ORACLE_ABI as never,
      functionName: opts.functionName,
      args: opts.args as never,
      account: wallet.account!,
      chain: wallet.chain ?? null,
      ...(chainId !== undefined ? { chainId } : {}),
    });
  }

  return {
    address: oracleAddress,

    async publishPolicy(label, input) {
      const wallet = requireWallet();
      const txHash = await simulateAndWrite({
        functionName: "publishPolicy",
        args: [label, input],
      });
      const policyId = policyIdFor(wallet.account!.address, label);
      return { txHash, policyId };
    },

    async updatePolicy(policyId, input) {
      const txHash = await simulateAndWrite({
        functionName: "updatePolicy",
        args: [policyId, input],
      });
      return { txHash };
    },

    async checkIntent(policyId, intent, spentToday) {
      const [ok, reason] = (await publicClient.readContract({
        address: oracleAddress,
        abi: SENTRY_ORACLE_ABI as never,
        functionName: "checkIntent",
        args: [policyId, intent as never, spentToday],
      })) as readonly [boolean, Hex];
      return { ok, reason };
    },

    async tierAndDelay(policyId, target, selector) {
      const [tier, delaySeconds] = (await publicClient.readContract({
        address: oracleAddress,
        abi: SENTRY_ORACLE_ABI as never,
        functionName: "tierAndDelay",
        args: [policyId, target, selector],
      })) as readonly [number, number];
      return { tier, delaySeconds };
    },
  };
}
