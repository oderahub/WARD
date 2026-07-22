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

export interface EnvSettings {
  rpc: string;
  sentryOracle?: Address;
  sentryQueue?: Address;
  privateKey?: `0x${string}`;
}

export function loadEnv(): EnvSettings {
  return {
    rpc: process.env.SOMNIA_TESTNET_RPC ?? somniaTestnet.rpcUrls.default.http[0],
    sentryOracle: process.env.SENTRY_ORACLE as Address | undefined,
    sentryQueue: process.env.SENTRY_QUEUE as Address | undefined,
    privateKey: process.env.PRIVATE_KEY as `0x${string}` | undefined,
  };
}

export function publicClient(rpc?: string) {
  return createPublicClient({
    chain: somniaTestnet,
    transport: http(rpc ?? somniaTestnet.rpcUrls.default.http[0]),
  });
}

export function walletClient(privateKey: `0x${string}`, rpc?: string) {
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({
    account,
    chain: somniaTestnet,
    transport: http(rpc ?? somniaTestnet.rpcUrls.default.http[0]),
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
