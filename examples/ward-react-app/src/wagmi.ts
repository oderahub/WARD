import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { defineChain } from "viem";

export const ACTIVE_CHAIN_ID = 43113;

export const avalancheFuji = defineChain({
  id: ACTIVE_CHAIN_ID,
  name: "Avalanche Fuji",
  nativeCurrency: { name: "Avalanche Test Token", symbol: "AVAX", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://api.avax-test.network/ext/bc/C/rpc"] },
  },
  blockExplorers: {
    default: {
      name: "Fuji Explorer",
      url: "https://testnet.snowtrace.io",
    },
  },
});

// No canonical Avalanche deployment exists yet; supply the address from
// contracts/deployments/43113.json via VITE_WARD_ORACLE.
export const WARD_ORACLE_ADDRESS = (import.meta.env.VITE_WARD_ORACLE?.trim() ||
  "0x0000000000000000000000000000000000000000") as `0x${string}`;

export const wagmiConfig = createConfig({
  chains: [avalancheFuji],
  connectors: [injected()],
  transports: {
    [avalancheFuji.id]: http(undefined, { timeout: 8_000 }),
  },
});
