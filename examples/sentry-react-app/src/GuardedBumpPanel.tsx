import { useState } from "react";
import type { Address, Hex, PublicClient } from "viem";
import { useAccount } from "wagmi";
import {
  SentryPreflightRejectedError,
  useSentryGuardedWrite,
} from "@sentry-somnia/react";

import { COUNTER_AGENT_ABI } from "./abi.js";
import { SENTRY_ORACLE_ADDRESS } from "./wagmi.js";

interface Props {
  agentAddress: Address;
  policyId: Hex;
  publicClient: PublicClient;
}

export function GuardedBumpPanel({ agentAddress, policyId, publicClient }: Props) {
  const { address: account } = useAccount();
  const { write, isPreflightPending, lastDecision } = useSentryGuardedWrite({
    source: {
      kind: "chain",
      publicClient,
      oracleAddress: SENTRY_ORACLE_ADDRESS,
      policyId,
    },
  });

  const [txHash, setTxHash] = useState<Hex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bumpBy, setBumpBy] = useState<string>("1");

  // Some wallets cannot estimate custom-chain gas; pre-estimate via RPC and pass it explicitly.
  async function estimateGasOr(fallback: bigint, args: {
    functionName: "bump" | "reset";
    args: readonly [bigint] | readonly [];
    account: Address;
  }): Promise<bigint> {
    try {
      const estimate = await publicClient.estimateContractGas({
        abi: COUNTER_AGENT_ABI,
        address: agentAddress,
        functionName: args.functionName,
        args: args.args as never,
        account: args.account,
      });
      // 20% buffer to absorb minor variance.
      return (estimate * 120n) / 100n;
    } catch {
      return fallback;
    }
  }

  async function onBump() {
    setError(null);
    setTxHash(null);
    try {
      const gas = await estimateGasOr(300_000n, {
        functionName: "bump",
        args: [BigInt(bumpBy || "0")],
        account: account ?? (("0x" + "0".repeat(40)) as Address),
      });
      const hash = await write({
        abi: COUNTER_AGENT_ABI,
        address: agentAddress,
        functionName: "bump",
        args: [BigInt(bumpBy || "0")],
        gas,
      });
      setTxHash(hash);
    } catch (err) {
      if (err instanceof SentryPreflightRejectedError) {
        // The decision panel already surfaces the rejection.
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onReset() {
    setError(null);
    setTxHash(null);
    try {
      const gas = await estimateGasOr(300_000n, {
        functionName: "reset",
        args: [],
        account: account ?? (("0x" + "0".repeat(40)) as Address),
      });
      const hash = await write({
        abi: COUNTER_AGENT_ABI,
        address: agentAddress,
        functionName: "reset",
        args: [],
        gas,
      });
      setTxHash(hash);
    } catch (err) {
      if (err instanceof SentryPreflightRejectedError) {
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="stack">
      <div className="row">
        <label>
          Bump by
          <input value={bumpBy} onChange={(e) => setBumpBy(e.target.value)} />
        </label>
      </div>

      <div className="row">
        <button type="button" onClick={onBump} disabled={isPreflightPending}>
          {isPreflightPending ? "Checking policy" : "Bump counter"}
        </button>

        <button type="button" onClick={onReset} disabled={isPreflightPending}>
          Reset counter
        </button>
      </div>

      {lastDecision && (
        <div className="decision" data-testid="decision-pane">
          <h3>Decision</h3>
          <dl>
            <dt>Allowed</dt>
            <dd data-testid="decision-ok">{lastDecision.ok ? "yes" : "no"}</dd>
            <dt>Source</dt>
            <dd>{lastDecision.source}</dd>
            <dt>Reason code</dt>
            <dd>
              <code>{lastDecision.reason}</code>
            </dd>
            <dt>Reason</dt>
            <dd data-testid="decision-reason">{lastDecision.reasonText}</dd>
          </dl>
        </div>
      )}

      {txHash && (
        <div className="success">
          Submitted: <code>{txHash}</code>
        </div>
      )}

      {error && <div className="warn">Write failed: {error}</div>}
    </div>
  );
}
