/**
 * Network registry. Currently a single Shannon testnet entry; add additional
 * NetworkConfig records here when Sentry deploys to new chains.
 */
export const SOMNIA_CHAIN_ID = 50312;

export interface NetworkConfig {
  chainId: number;
  name: string;
  rpc: string;
  oracleAddress: `0x${string}`;
  queueAddress: `0x${string}`;
  /**
   * SentryAgentRegistry deployment for this chain. Optional because not every
   * future chain entry is guaranteed to have a registry deployed at the same
   * time as the oracle/queue. Consumed by `agents-catalog.ts` as the
   * NETWORKS-first fallback when `VITE_SENTRY_AGENT_REGISTRY` is unset on a
   * fresh clone.
   */
  registryAddress?: `0x${string}`;
  explorer: string;
  nativeSymbol: string;
}

export const NETWORKS: Record<number, NetworkConfig> = {
  50312: {
    chainId: 50312,
    name: "Somnia Shannon Testnet",
    rpc: "https://dream-rpc.somnia.network",
    oracleAddress: "0x3C7bF90f243d670a01f512221d9546e09fEaCC9c",
    queueAddress: "0xFB715A37951Fc8dcc920120768e91f7C8bbA54c4",
    registryAddress: "0x97F743A9AAa5AcAA73075C1B8F1921274755CF70",
    explorer: "https://shannon-explorer.somnia.network",
    nativeSymbol: "STT",
  },
};

export function getNetwork(chainId: number): NetworkConfig | undefined {
  return NETWORKS[chainId];
}
