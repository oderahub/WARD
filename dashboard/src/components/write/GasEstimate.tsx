import { useEffect, useState } from "react";
import {
  formatEther,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { useEstimateFeesPerGas } from "wagmi";

import { humanizeWeb3Error } from "../../lib/humanizeError";
import { Alert } from "../primitives";
import { buildCallData, type ModalKind } from "./actionConfig";

interface Props {
  kind: ModalKind;
  execId: bigint;
  reason: string;
  reasonValid: boolean;
  publicClient: PublicClient | null;
  walletClient: WalletClient | null;
  queueAddress: Address;
}

export function GasEstimate({
  kind,
  execId,
  reason,
  reasonValid,
  publicClient,
  walletClient,
  queueAddress,
}: Props) {
  const [gas, setGas] = useState<bigint | null>(null);
  const [gasError, setGasError] = useState<string | null>(null);

  // Live EIP-1559 fee estimate so we can show the cost in AVAX alongside gas
  // units. wagmi caches this query; the modal's lifetime is short enough that
  // the extra request is negligible.
  const { data: feesPerGas } = useEstimateFeesPerGas();

  // Build the call data we'd submit. For veto, recompute when the reason
  // changes so the gas estimate tracks the actual call. We swallow errors
  // here because the simulate call below will surface them with a useful
  // revert reason in the user-facing error block.
  useEffect(() => {
    if (!publicClient || !walletClient?.account) return;
    if (kind === "veto" && !reasonValid) {
      setGas(null);
      setGasError(null);
      return;
    }

    let cancelled = false;
    setGasError(null);

    const data = buildCallData(kind, execId, reason);

    publicClient
      .estimateGas({
        account: walletClient.account.address,
        to: queueAddress,
        data,
      })
      .then((g) => {
        if (!cancelled) setGas(g);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setGas(null);
        setGasError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [kind, reason, reasonValid, publicClient, walletClient, queueAddress, execId]);

  const gasCostStt =
    gas !== null && feesPerGas?.maxFeePerGas
      ? formatEther(gas * feesPerGas.maxFeePerGas)
      : null;

  const humanizedGasError = gasError
    ? humanizeWeb3Error(new Error(gasError))
    : null;

  return (
    <>
      <div className="mt-4 space-y-1 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-text-subtle">Gas estimate</span>
          {gas !== null && (
            <span className="font-mono tabular-nums text-text">
              {gasCostStt
                ? `~${gasCostStt} AVAX (~${gas.toString()} gas)`
                : `~${gas.toString()} gas`}
            </span>
          )}
          {gas === null && !gasError && (
            <span className="text-text-subtle">…</span>
          )}
          {gasError && (
            <span className="font-mono tabular-nums text-danger" title={gasError}>
              estimate failed
            </span>
          )}
        </div>
      </div>

      {humanizedGasError && (
        <Alert variant="danger" title={humanizedGasError.headline} className="mt-3">
          <div className="text-text">
            This usually means the call would revert. Check the intent matches the policy.
          </div>
          <details className="mt-2">
            <summary className="cursor-pointer text-text-muted hover:text-text">
              Show raw error
            </summary>
            <div className="mt-1 break-all font-mono text-[11px] text-text-muted">
              {humanizedGasError.detail ?? gasError}
            </div>
          </details>
        </Alert>
      )}
    </>
  );
}
