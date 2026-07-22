import { defineChain, createPublicClient, createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const somniaTestnet = defineChain({
  id: 50312,
  name: "Somnia Testnet",
  nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://dream-rpc.somnia.network"] } },
  blockExplorers: {
    default: { name: "Shannon", url: "https://shannon-explorer.somnia.network" },
  },
});

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

const CHAINS = { somnia: somniaTestnet, fuji: avalancheFuji } as const;
export type ChainKey = keyof typeof CHAINS;

/// Selects the target chain from SENTRY_CHAIN. Defaults to Somnia when unset or
/// unrecognized so existing single-chain workflows are unchanged.
export function activeChainKey(): ChainKey {
  const v = (process.env.SENTRY_CHAIN ?? "").trim().toLowerCase();
  if (v === "fuji" || v === "avalanche" || v === "avalanche-fuji" || v === "43113") return "fuji";
  return "somnia";
}

export function activeChain() {
  return CHAINS[activeChainKey()];
}

/// Default RPC for the active chain, honoring the chain-specific override env var.
export function activeRpc(): string {
  const chain = activeChain();
  const override = chain.id === avalancheFuji.id ? process.env.FUJI_RPC : process.env.SOMNIA_TESTNET_RPC;
  return override ?? chain.rpcUrls.default.http[0];
}

export interface EnvSettings {
  rpc: string;
  sentryOracle?: Address;
  sentryQueue?: Address;
  privateKey?: `0x${string}`;
}

export function loadEnv(): EnvSettings {
  return {
    rpc: activeRpc(),
    sentryOracle: process.env.SENTRY_ORACLE as Address | undefined,
    sentryQueue: process.env.SENTRY_QUEUE as Address | undefined,
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

export function requireSentryOracle(env: EnvSettings): Address {
  if (!env.sentryOracle) {
    throw new Error("SENTRY_ORACLE env var required (the deployed oracle address)");
  }
  return env.sentryOracle;
}

export function requireSentryQueue(env: EnvSettings): Address {
  if (!env.sentryQueue) {
    throw new Error("SENTRY_QUEUE env var required (the deployed queue address)");
  }
  return env.sentryQueue;
}

export function requirePrivateKey(env: EnvSettings): `0x${string}` {
  if (!env.privateKey) {
    throw new Error("PRIVATE_KEY env var required");
  }
  return env.privateKey;
}
