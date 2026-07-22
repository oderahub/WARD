import type { Abi, Address, Hex, PublicClient } from "viem";

/**
 * Shannon-testnet-safe gas limit for contract writes.
 *
 * Shannon's `eth_estimateGas` undershoots dramatically — often returns 0 for
 * non-trivial contract calls (publishPolicy, queue.enqueue, queue.dispatch,
 * etc.). MetaMask then rejects the tx because the resulting gas limit is
 * below the 21000 EVM minimum ("Gas limit is less than 21000. Transaction
 * can't be submitted"). The forge scripts in this repo pass
 * `--gas-estimate-multiplier 2000` (= 20x) for the same reason; the dashboard
 * has to do the equivalent in JS.
 *
 * Strategy:
 *   1. Try `estimateContractGas`. If it returns a number, multiply by
 *      `SAFETY_MULTIPLIER` (4x) to absorb the undershoot.
 *   2. Floor the result at `GAS_FLOOR` (500_000) so even if the estimate
 *      comes back tiny we stay well clear of the 21000 minimum.
 *   3. If estimation throws (RPC down, revert simulation, etc.), fall back
 *      to `GAS_FALLBACK` (3_000_000) — same ceiling as the forge scripts.
 *
 * The 4x multiplier + 500k floor is overpay relative to actual gas used, but
 * unused gas is refunded on Somnia (standard EVM behavior); the failure mode
 * we're guarding against (rejected tx) is strictly worse than overestimating.
 */

const SAFETY_MULTIPLIER = 4n;
const GAS_FLOOR = 500_000n;
const GAS_FALLBACK = 3_000_000n;

export interface ShannonGasParams {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  account: Address;
  value?: bigint;
}

export async function shannonSafeGas(
  client: PublicClient,
  params: ShannonGasParams,
): Promise<bigint> {
  let estimated: bigint;
  try {
    estimated = await client.estimateContractGas({
      address: params.address,
      abi: params.abi,
      functionName: params.functionName,
      args: params.args as readonly Hex[],
      account: params.account,
      value: params.value,
    });
  } catch {
    // RPC rejected the simulation entirely. Could be a real revert (which
    // the write will surface anyway), or an RPC quirk. Either way, return
    // the ceiling — let the actual write decide.
    return GAS_FALLBACK;
  }
  const inflated = estimated * SAFETY_MULTIPLIER;
  return inflated < GAS_FLOOR ? GAS_FLOOR : inflated;
}
