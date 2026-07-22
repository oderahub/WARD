import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { defineChain } from "viem";

export const SOMNIA_CHAIN_ID = 50312;

export const somniaTestnet = defineChain({
  id: SOMNIA_CHAIN_ID,
  name: "Somnia Testnet",
  nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://dream-rpc.somnia.network"] },
  },
  blockExplorers: {
    default: {
      name: "Shannon Explorer",
      url: "https://shannon-explorer.somnia.network",
    },
  },
});

export const WARD_ORACLE_ADDRESS =
  "0x3C7bF90f243d670a01f512221d9546e09fEaCC9c" as const;

export const wagmiConfig = createConfig({
  chains: [somniaTestnet],
  connectors: [injected()],
  transports: {
    [somniaTestnet.id]: http(undefined, { timeout: 8_000 }),
  },
});
