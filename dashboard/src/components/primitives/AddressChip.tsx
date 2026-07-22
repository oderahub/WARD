import { useState } from 'react';
import { Check as CheckIcon } from '@phosphor-icons/react';
import { ExplorerLink } from './ExplorerLink';
import { useContractName } from '../../lib/contractName';
import { ACTIVE_CHAIN_ID, getNetwork } from '../../lib/networks';
import { useUrlState } from '../../hooks/useUrlState';

export interface AddressChipProps {
  address?: `0x${string}`;
  label?: string;
  className?: string;
  /**
   * Chain to resolve the contract name against. Defaults to Fuji (43113).
   * Callers that already know the chain (e.g. owner-scoped views) should pass
   * it explicitly so cross-chain misses don't inherit the wrong name.
   */
  chainId?: number;
}

function truncate(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function AddressChip({ address, label, className, chainId = ACTIVE_CHAIN_ID }: AddressChipProps) {
  const [copied, setCopied] = useState(false);
  // Privacy gate: every chip would otherwise fire a per-address fetch at the
  // Avalanche explorer, leaking the user's viewing pattern. Pass the explorer
  // URL down to useContractName ONLY when the user has opted in via
  // ?explorerNames=1. Local-map and IDB-cache hits still resolve names.
  const { explorerNames } = useUrlState();
  const explorerApiUrl = explorerNames ? getNetwork(chainId)?.explorer : undefined;
  const { name, source } = useContractName(chainId, address, explorerApiUrl);

  if (!address) {
    return <span className={`text-text-subtle ${className ?? ''}`}>—</span>;
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore — clipboard may be unavailable
    }
  };

  const nameTitle =
    source === 'explorer'
      ? 'Verified on Avalanche Explorer'
      : source === 'local'
        ? 'Known local contract'
        : undefined;

  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      {label ? <span className="text-text-subtle text-xs">{label}</span> : null}
      {name ? (
        <>
          <span className="text-xs font-medium text-text" title={nameTitle}>
            {name}
          </span>
          <span className="text-text-muted text-xs">·</span>
        </>
      ) : null}
      <span className="font-mono text-xs tabular-nums text-text">{truncate(address)}</span>
      <button
        type="button"
        onClick={handleCopy}
        className="inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-text transition-colors active:scale-[0.98]"
      >
        {copied ? (
          <>
            <CheckIcon size={11} weight="bold" /> copied
          </>
        ) : (
          'copy'
        )}
      </button>
      <ExplorerLink address={address} />
    </span>
  );
}
