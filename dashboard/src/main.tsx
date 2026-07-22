import React from "react";
import ReactDOM from "react-dom/client";
import { WagmiProvider, createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { defineChain } from "viem";
import { ThemeProvider } from "next-themes";

import App from "./App";
import { Landing } from "./pages/Landing";
import "./index.css";

export const avalancheFuji = defineChain({
  id: 43113,
  name: "Avalanche Fuji",
  nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        import.meta.env.VITE_FUJI_RPC?.trim() || "https://api.avax-test.network/ext/bc/C/rpc",
      ],
    },
  },
  blockExplorers: {
    default: { name: "SnowTrace (Testnet)", url: "https://testnet.snowtrace.io" },
  },
  testnet: true,
});

export const avalanche = defineChain({
  id: 43114,
  name: "Avalanche",
  nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        import.meta.env.VITE_AVALANCHE_RPC?.trim() || "https://api.avax.network/ext/bc/C/rpc",
      ],
    },
  },
  blockExplorers: {
    default: { name: "SnowTrace", url: "https://snowtrace.io" },
  },
});

// Both chains are registered so wagmi can read from, and switchChain into,
// whichever one networks.ts resolves as active. Which one the UI targets is
// decided there (VITE_WARD_CHAIN), not here.
const wagmiConfig = createConfig({
  chains: [avalancheFuji, avalanche],
  connectors: [injected()],
  transports: {
    [avalancheFuji.id]: http(undefined, { timeout: 8_000 }),
    [avalanche.id]: http(undefined, { timeout: 8_000 }),
  },
});

const queryClient = new QueryClient();

/**
 * Any of these query params means the visitor is deep-linking into the app
 * surface (a tab, a shared policy reveal, an open drawer, or a non-default
 * deployment), so we mount the full provider tree. A bare URL gets the
 * lightweight landing, which needs no wallet / RPC / event-store and so never
 * triggers a wallet prompt. "Launch dashboard" sets `?app=1`; the existing
 * useUrlState setters preserve unknown params, so `app` sticks across in-app
 * navigation and reloads stay in the app.
 */
const APP_PARAMS = ["app", "tab", "revealed", "drawer", "oracle", "queue"];

/**
 * Decide landing vs app, and pin `app=1` into the URL on app entry. Without
 * the pin, entering via e.g. `?tab=queue` and then navigating to the Publish
 * tab — which deletes the `tab` param (useUrlState.setTab) — would leave a bare
 * `/`, so a reload would wrongly drop the user on the landing. The existing
 * useUrlState setters re-serialize ALL params, so once `app` is present it
 * survives every in-app navigation.
 */
function resolveAppRoute(): boolean {
  const params = new URLSearchParams(window.location.search);
  const onApp = APP_PARAMS.some((key) => params.has(key));
  if (onApp && !params.has("app")) {
    params.set("app", "1");
    const qs = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`,
    );
  }
  return onApp;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {resolveAppRoute() ? (
        <WagmiProvider config={wagmiConfig}>
          <QueryClientProvider client={queryClient}>
            <App />
          </QueryClientProvider>
        </WagmiProvider>
      ) : (
        <Landing />
      )}
    </ThemeProvider>
  </React.StrictMode>,
);
