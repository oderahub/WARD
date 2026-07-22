/**
 * Network registry. Ward targets Avalanche; Fuji is the default so a fresh
 * clone points at testnet rather than mainnet. Add additional NetworkConfig
 * records here when Ward deploys to new chains.
 */
import { isAddress } from "viem";

export const AVALANCHE_FUJI_CHAIN_ID = 43113;
export const AVALANCHE_CHAIN_ID = 43114;

/**
 * Stand-in for a not-yet-deployed contract. `policy-draft.ts` skips the zero
 * address when building RESERVED_TARGETS so an unconfigured network cannot
 * suppress the friendlier "replace the placeholder address" validation.
 */
export const UNSET_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export interface NetworkConfig {
  chainId: number;
  name: string;
  rpc: string;
  oracleAddress: `0x${string}`;
  queueAddress: `0x${string}`;
  /**
   * WardAgentRegistry deployment for this chain. Optional because not every
   * chain entry is guaranteed to have a registry deployed at the same time as
   * the oracle/queue. Consumed by `agents-catalog.ts` as the NETWORKS-first
   * fallback when `VITE_WARD_AGENT_REGISTRY` is unset on a fresh clone.
   */
  registryAddress?: `0x${string}`;
  explorer: string;
  nativeSymbol: string;
}

function envTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function envAddress(value: string | undefined): `0x${string}` | undefined {
  const trimmed = envTrimmed(value);
  return trimmed && isAddress(trimmed) ? (trimmed as `0x${string}`) : undefined;
}

/**
 * Ward has no canonical Avalanche deployment baked in yet, so oracle/queue come
 * from env. Until they are set the entry stays present — so the app still boots
 * and can explain itself — but points at UNSET_ADDRESS.
 */
const ORACLE_FROM_ENV = envAddress(import.meta.env.VITE_WARD_ORACLE);
const QUEUE_FROM_ENV = envAddress(import.meta.env.VITE_WARD_QUEUE);
const REGISTRY_FROM_ENV = envAddress(import.meta.env.VITE_WARD_AGENT_REGISTRY);

export const NETWORKS: Record<number, NetworkConfig> = {
  [AVALANCHE_FUJI_CHAIN_ID]: {
    chainId: AVALANCHE_FUJI_CHAIN_ID,
    name: "Avalanche Fuji",
    rpc: envTrimmed(import.meta.env.VITE_FUJI_RPC) ?? "https://api.avax-test.network/ext/bc/C/rpc",
    oracleAddress: ORACLE_FROM_ENV ?? UNSET_ADDRESS,
    queueAddress: QUEUE_FROM_ENV ?? UNSET_ADDRESS,
    registryAddress: REGISTRY_FROM_ENV,
    explorer: "https://testnet.snowtrace.io",
    nativeSymbol: "AVAX",
  },
  [AVALANCHE_CHAIN_ID]: {
    chainId: AVALANCHE_CHAIN_ID,
    name: "Avalanche",
    rpc: envTrimmed(import.meta.env.VITE_AVALANCHE_RPC) ?? "https://api.avax.network/ext/bc/C/rpc",
    oracleAddress: ORACLE_FROM_ENV ?? UNSET_ADDRESS,
    queueAddress: QUEUE_FROM_ENV ?? UNSET_ADDRESS,
    registryAddress: REGISTRY_FROM_ENV,
    explorer: "https://snowtrace.io",
    nativeSymbol: "AVAX",
  },
};

/**
 * Which chain the dashboard targets, from `VITE_WARD_CHAIN`. Defaults to Fuji
 * when unset or unrecognized so a misconfigured env lands on testnet rather
 * than mainnet.
 */
function resolveActiveChainId(): number {
  const requested = envTrimmed(import.meta.env.VITE_WARD_CHAIN)?.toLowerCase();
  const wantsMainnet =
    requested === "avalanche" ||
    requested === "mainnet" ||
    requested === "c-chain" ||
    requested === String(AVALANCHE_CHAIN_ID);
  return wantsMainnet ? AVALANCHE_CHAIN_ID : AVALANCHE_FUJI_CHAIN_ID;
}

export const ACTIVE_CHAIN_ID: number = resolveActiveChainId();

export function getNetwork(chainId: number): NetworkConfig | undefined {
  return NETWORKS[chainId];
}

export function getActiveNetwork(): NetworkConfig {
  return NETWORKS[ACTIVE_CHAIN_ID];
}

/** True when the active network has a deployed oracle configured. */
export function isActiveNetworkConfigured(): boolean {
  return getActiveNetwork().oracleAddress !== UNSET_ADDRESS;
}
