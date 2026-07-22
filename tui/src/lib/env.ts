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

export const avalancheFuji = defineChain({
  id: 43113,
  name: "Avalanche Fuji",
  nativeCurrency: { name: "Avalanche Test Token", symbol: "AVAX", decimals: 18 },
  rpcUrls: { default: { http: ["https://api.avax-test.network/ext/bc/C/rpc"] } },
  blockExplorers: {
    default: { name: "Fuji", url: "https://testnet.snowtrace.io" },
  },
});

export interface ResolvedEnv {
  rpc: string;
  oracleAddress: Address;
  queueAddress: Address;
  privateKey?: `0x${string}`;
}

/**
 * Ward has no canonical Avalanche deployment yet, so there is no address to
 * default to. The zero address makes an unconfigured run fail visibly rather
 * than silently reading a contract that isn't there. Set WARD_ORACLE /
 * WARD_QUEUE from contracts/deployments/43113.json.
 */
const UNSET_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

export function resolveEnv(overrides: Partial<ResolvedEnv> = {}): ResolvedEnv {
  return {
    rpc: overrides.rpc ?? process.env.FUJI_RPC ?? avalancheFuji.rpcUrls.default.http[0],
    oracleAddress: overrides.oracleAddress ?? (process.env.WARD_ORACLE as Address | undefined) ?? UNSET_ADDRESS,
    queueAddress: overrides.queueAddress ?? (process.env.WARD_QUEUE as Address | undefined) ?? UNSET_ADDRESS,
    privateKey: overrides.privateKey ?? (process.env.PRIVATE_KEY as `0x${string}` | undefined),
  };
}

export function makePublicClient(rpc: string) {
  return createPublicClient({ chain: avalancheFuji, transport: http(rpc) });
}

export function makeWalletClient(privateKey: `0x${string}`, rpc: string) {
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({ account, chain: avalancheFuji, transport: http(rpc) });
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
