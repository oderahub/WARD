import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineChain, createPublicClient, createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Load cwd .env before other modules read process.env; shell values win.
(function loadDotenv() {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
})();

export const somniaTestnet = defineChain({
  id: 50312,
  name: "Somnia Testnet",
  nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://dream-rpc.somnia.network"] } },
  blockExplorers: {
    default: { name: "Shannon", url: "https://shannon-explorer.somnia.network" },
  },
});

export interface ResolvedEnv {
  rpc: string;
  oracleAddress: Address;
  queueAddress: Address;
  privateKey?: `0x${string}`;
}

const DEFAULT_ORACLE: Address = "0x3C7bF90f243d670a01f512221d9546e09fEaCC9c";
const DEFAULT_QUEUE: Address = "0xFB715A37951Fc8dcc920120768e91f7C8bbA54c4";

export function resolveEnv(overrides: Partial<ResolvedEnv> = {}): ResolvedEnv {
  return {
    rpc: overrides.rpc ?? process.env.SOMNIA_TESTNET_RPC ?? somniaTestnet.rpcUrls.default.http[0],
    oracleAddress: overrides.oracleAddress ?? (process.env.WARD_ORACLE as Address | undefined) ?? DEFAULT_ORACLE,
    queueAddress: overrides.queueAddress ?? (process.env.WARD_QUEUE as Address | undefined) ?? DEFAULT_QUEUE,
    privateKey: overrides.privateKey ?? (process.env.PRIVATE_KEY as `0x${string}` | undefined),
  };
}

export function makePublicClient(rpc: string) {
  return createPublicClient({ chain: somniaTestnet, transport: http(rpc) });
}

export function makeWalletClient(privateKey: `0x${string}`, rpc: string) {
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({ account, chain: somniaTestnet, transport: http(rpc) });
}

function envBigInt(name: string): bigint | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  try {
    return BigInt(raw);
  } catch {
    return undefined;
  }
}

const DEFAULT_TUI_LOOKBACK_BLOCKS = 50_000n;

function truthy(name: string): boolean {
  const raw = process.env[name]?.toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

// Leave undefined by default so policy backfill uses the same bounded window as queue events.
export const WARD_ORACLE_DEPLOY_BLOCK: bigint | undefined =
  envBigInt("WARD_TUI_ORACLE_DEPLOY_BLOCK") ??
  (truthy("WARD_TUI_DEEP_BACKFILL") ? envBigInt("WARD_ORACLE_DEPLOY_BLOCK") : undefined);

// Operators can widen this for older pending queue records.
export const WARD_QUEUE_LOOKBACK_BLOCKS: bigint = envBigInt("WARD_QUEUE_LOOKBACK_BLOCKS") ?? DEFAULT_TUI_LOOKBACK_BLOCKS;
