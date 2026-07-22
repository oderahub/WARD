import { defineChain, createPublicClient, createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const avalancheFuji = defineChain({
  id: 43113,
  name: "Avalanche Fuji",
  nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
  rpcUrls: { default: { http: ["https://api.avax-test.network/ext/bc/C/rpc"] } },
  blockExplorers: {
    default: { name: "SnowTrace (Testnet)", url: "https://testnet.snowtrace.io" },
  },
  testnet: true,
});

export const avalanche = defineChain({
  id: 43114,
  name: "Avalanche",
  nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
  rpcUrls: { default: { http: ["https://api.avax.network/ext/bc/C/rpc"] } },
  blockExplorers: {
    default: { name: "SnowTrace", url: "https://snowtrace.io" },
  },
});

const CHAINS = { fuji: avalancheFuji, avalanche } as const;
export type ChainKey = keyof typeof CHAINS;

/// Selects the target chain from WARD_CHAIN. Defaults to Fuji when unset or
/// unrecognized, so a fresh clone targets testnet rather than mainnet.
export function activeChainKey(): ChainKey {
  const v = (process.env.WARD_CHAIN ?? "").trim().toLowerCase();
  if (v === "avalanche" || v === "mainnet" || v === "c-chain" || v === "43114") return "avalanche";
  return "fuji";
}

export function activeChain() {
  return CHAINS[activeChainKey()];
}

/// Default RPC for the active chain, honoring the chain-specific override env var.
export function activeRpc(): string {
  const chain = activeChain();
  const override = chain.id === avalanche.id ? process.env.AVALANCHE_RPC : process.env.FUJI_RPC;
  return override ?? chain.rpcUrls.default.http[0];
}

export interface EnvSettings {
  rpc: string;
  wardOracle?: Address;
  wardQueue?: Address;
  privateKey?: `0x${string}`;
}

export function loadEnv(): EnvSettings {
  return {
    rpc: activeRpc(),
    wardOracle: process.env.WARD_ORACLE as Address | undefined,
    wardQueue: process.env.WARD_QUEUE as Address | undefined,
    privateKey: process.env.PRIVATE_KEY as `0x${string}` | undefined,
  };
}

export function publicClient(rpc?: string) {
  return createPublicClient({
    chain: activeChain(),
    transport: http(rpc ?? activeRpc()),
  });
}

export function walletClient(privateKey: `0x${string}`, rpc?: string) {
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({
    account,
    chain: activeChain(),
    transport: http(rpc ?? activeRpc()),
  });
}

export function requireWardOracle(env: EnvSettings): Address {
  if (!env.wardOracle) {
    throw new Error("WARD_ORACLE env var required (the deployed oracle address)");
  }
  return env.wardOracle;
}

export function requireWardQueue(env: EnvSettings): Address {
  if (!env.wardQueue) {
    throw new Error("WARD_QUEUE env var required (the deployed queue address)");
  }
  return env.wardQueue;
}

export function requirePrivateKey(env: EnvSettings): `0x${string}` {
  if (!env.privateKey) {
    throw new Error("PRIVATE_KEY env var required");
  }
  return env.privateKey;
}
