/**
 * Centralized wrong-network detection. Returns `wrong = true` when the wallet
 * reports a chainId other than Somnia's. Every modal that submits an on-chain
 * write reads this and renders a top warning Alert + disables submit, so the
 * guard doesn't have to be duplicated (and kept in sync) per modal.
 *
 * The wallet reports `undefined` while no wallet is connected — in that case
 * we report `wrong = false` so the guard doesn't fire spuriously on an empty
 * dashboard. The actual write path will still bail because the connected
 * address is also undefined.
 */
import { useChainId } from "wagmi";
import { SOMNIA_CHAIN_ID } from "../lib/networks";

export interface WrongNetworkState {
  wrong: boolean;
  current: number | undefined;
  expected: number;
}

export function useWrongNetwork(): WrongNetworkState {
  const current = useChainId();
  return {
    wrong: current !== undefined && current !== SOMNIA_CHAIN_ID,
    current,
    expected: SOMNIA_CHAIN_ID,
  };
}
