/**
 * Network registry. Somnia Shannon is the canonical, always-present entry;
 * Avalanche Fuji registers itself only once its deployment addresses are
 * supplied via env (see below). Add additional NetworkConfig records here when
 * Ward deploys to new chains.
 */
import { isAddress } from "viem";

export const SOMNIA_TESTNET_CHAIN_ID = 50312;
export const AVALANCHE_FUJI_CHAIN_ID = 43113;

export interface NetworkConfig {
  chainId: number;
  name: string;
  rpc: string;
  oracleAddress: `0x${string}`;
  queueAddress: `0x${string}`;
  /**
   * WardAgentRegistry deployment for this chain. Optional because not every
   * future chain entry is guaranteed to have a registry deployed at the same
   * time as the oracle/queue. Consumed by `agents-catalog.ts` as the
   * NETWORKS-first fallback when `VITE_WARD_AGENT_REGISTRY` is unset on a
   * fresh clone.
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
 * Fuji oracle/queue come from env because, unlike Shannon, there is no
 * canonical deployment baked in yet. The entry is omitted entirely until BOTH
 * are supplied — deliberately, not defensively: `policy-draft.ts` folds every
 * network's oracle+queue into RESERVED_TARGETS, and seeding that set with a
 * zero-address placeholder would suppress the friendlier "replace the
 * placeholder address" validation message.
 */
const FUJI_ORACLE = envAddress(import.meta.env.VITE_WARD_ORACLE);
const FUJI_QUEUE = envAddress(import.meta.env.VITE_WARD_QUEUE);

const FUJI_NETWORK: NetworkConfig | undefined =
  FUJI_ORACLE && FUJI_QUEUE
    ? {
        chainId: AVALANCHE_FUJI_CHAIN_ID,
        name: "Avalanche Fuji",
        rpc: envTrimmed(import.meta.env.VITE_FUJI_RPC) ?? "https://api.avax-test.network/ext/bc/C/rpc",
        oracleAddress: FUJI_ORACLE,
        queueAddress: FUJI_QUEUE,
        registryAddress: envAddress(import.meta.env.VITE_WARD_AGENT_REGISTRY),
        explorer: "https://testnet.snowtrace.io",
        nativeSymbol: "AVAX",
      }
    : undefined;

export const NETWORKS: Record<number, NetworkConfig> = {
  [SOMNIA_TESTNET_CHAIN_ID]: {
    chainId: SOMNIA_TESTNET_CHAIN_ID,
    name: "Somnia Shannon Testnet",
    rpc: "https://dream-rpc.somnia.network",
    oracleAddress: "0x3C7bF90f243d670a01f512221d9546e09fEaCC9c",
    queueAddress: "0xFB715A37951Fc8dcc920120768e91f7C8bbA54c4",
    registryAddress: "0x97F743A9AAa5AcAA73075C1B8F1921274755CF70",
    explorer: "https://shannon-explorer.somnia.network",
    nativeSymbol: "STT",
  },
};

// Assigned rather than spread: a conditional spread of a computed key widens
// the property to optional, which `Record<number, NetworkConfig>` rejects.
if (FUJI_NETWORK) {
  NETWORKS[AVALANCHE_FUJI_CHAIN_ID] = FUJI_NETWORK;
}

/**
 * Which chain the dashboard targets, from `VITE_WARD_CHAIN`. Falls back to
 * Shannon when unset, unrecognized, or when Fuji is requested but has no
 * configured deployment — so a misconfigured env degrades to the working
 * default instead of a blank dashboard.
 */
function resolveActiveChainId(): number {
  const requested = envTrimmed(import.meta.env.VITE_WARD_CHAIN)?.toLowerCase();
  const wantsFuji =
    requested === "fuji" ||
    requested === "avalanche" ||
    requested === "avalanche-fuji" ||
    requested === String(AVALANCHE_FUJI_CHAIN_ID);

  if (wantsFuji) {
    if (FUJI_NETWORK) return AVALANCHE_FUJI_CHAIN_ID;
    // eslint-disable-next-line no-console
    console.warn(
      "[networks] VITE_WARD_CHAIN requested Avalanche Fuji, but VITE_WARD_ORACLE / " +
        "VITE_WARD_QUEUE are unset or invalid. Falling back to Somnia Shannon.",
    );
  }
  return SOMNIA_TESTNET_CHAIN_ID;
}

export const ACTIVE_CHAIN_ID: number = resolveActiveChainId();

/**
 * @deprecated Historical name for "the chain the dashboard targets". It is now
 * an alias of {@link ACTIVE_CHAIN_ID} and is NOT necessarily Somnia. Kept so the
 * existing call sites stay chain-aware without a repo-wide rename; prefer
 * ACTIVE_CHAIN_ID in new code.
 */
export const SOMNIA_CHAIN_ID: number = ACTIVE_CHAIN_ID;

export function getNetwork(chainId: number): NetworkConfig | undefined {
  return NETWORKS[chainId];
}

export function getActiveNetwork(): NetworkConfig {
  return NETWORKS[ACTIVE_CHAIN_ID];
}
