import { useState } from "react";
import { usePublicClient } from "wagmi";
import type { Address, Hex } from "viem";
import { Button, Input } from "../primitives";
import { addWatchedPolicy } from "../../lib/watched-policies";

interface Props {
  policyId: Hex;
  label: string;
  chainId: number;
  oracleAddress: Address;
  /**
   * JSON-serialized PolicyInput captured at publish time. Persisted alongside
   * the watched entry so the watcher can evaluate without re-fetching the
   * policy from chain — important because the on-chain event window is only
   * 7 days and older policies would otherwise become unevaluable.
   */
  policyInputJSON?: string;
}

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function truncateAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Binds an already-deployed agent address to this watch-mode policy. Each
 * bind is stored in the local watched-policies registry; useAgentWatcher
 * picks it up on its next poll and starts evaluating the agent's txs
 * against the policy.
 *
 * The same policy can be bound to multiple agents — the input clears after
 * each successful add so the user can keep typing.
 */
export function WatchAgentBinding({
  policyId,
  label,
  chainId,
  oracleAddress,
  policyInputJSON,
}: Props) {
  const [address, setAddress] = useState("");
  const [lastAdded, setLastAdded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const publicClient = usePublicClient();

  const valid = ADDRESS_RE.test(address);

  async function onAdd() {
    if (!valid) return;
    setSubmitting(true);
    setError(null);
    try {
      let startBlock = 0n;
      try {
        startBlock = publicClient ? await publicClient.getBlockNumber() : 0n;
      } catch {
        startBlock = 0n;
      }
      await addWatchedPolicy({
        policyId,
        watchedAgentAddress: address as Address,
        label,
        chainId,
        oracleAddress,
        addedAtMs: Date.now(),
        lastCheckedBlock: startBlock.toString(),
        policyInputJSON,
      });
      setLastAdded(address);
      setAddress("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-sentry-border bg-surface p-3">
      <div className="text-[11px] uppercase tracking-wider text-text-subtle">
        bind an agent to this watch policy
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={address}
          onChange={(e) => {
            setAddress(e.target.value.trim());
            setError(null);
          }}
          placeholder="0x… (deployed agent address)"
          className="flex-1 font-mono"
          spellCheck={false}
        />
        <Button
          variant="accent"
          size="sm"
          disabled={!valid || submitting}
          onClick={onAdd}
        >
          {submitting ? "adding…" : "Start watching"}
        </Button>
      </div>
      {error && <div className="text-xs text-warn">{error}</div>}
      {lastAdded && (
        <div className="text-xs text-success">
          Now watching{" "}
          <span className="font-mono">{truncateAddr(lastAdded)}</span>. Violations
          will appear in Watched.
        </div>
      )}
    </div>
  );
}
