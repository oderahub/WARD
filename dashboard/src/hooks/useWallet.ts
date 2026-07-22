import { useEffect, useRef } from "react";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useSwitchChain,
  type Connector,
} from "wagmi";
import { ACTIVE_CHAIN_ID } from "../lib/networks";

export interface WalletState {
  address: `0x${string}` | undefined;
  isConnected: boolean;
  connect: () => void;
  disconnect: () => void;
  connectors: readonly Connector[];
}

/**
 * Thin wagmi facade. We only ship one connector (injected), so `connect()`
 * picks the first available one — keeps the call sites trivial. Components
 * that want a chooser can read `connectors` directly.
 *
 * After a successful connect we try to switch to Avalanche; wagmi 2.x's
 * `switchChain` auto-prompts the wallet to add the chain when missing.
 * If it fails (user rejects, connector can't add), the post-connect
 * "Wrong network" button in TopBar remains as the manual fallback.
 */
export function useWallet(): WalletState {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();

  const autoSwitchedRef = useRef(false);

  useEffect(() => {
    if (!isConnected) {
      autoSwitchedRef.current = false;
      return;
    }
    if (autoSwitchedRef.current) return;
    if (chainId === ACTIVE_CHAIN_ID) {
      autoSwitchedRef.current = true;
      return;
    }
    autoSwitchedRef.current = true;
    switchChain(
      { chainId: ACTIVE_CHAIN_ID },
      {
        onError: (err) => {
          // Fallback: TopBar's wrong-network button stays visible.
          console.warn("[useWallet] auto switch to Avalanche failed:", err);
        },
      },
    );
  }, [isConnected, chainId, switchChain]);

  return {
    address,
    isConnected,
    connectors,
    connect: () => {
      const first = connectors[0];
      if (first) connect({ connector: first });
    },
    disconnect: () => disconnect(),
  };
}
