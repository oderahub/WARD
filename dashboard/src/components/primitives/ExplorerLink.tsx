import type { ReactNode } from 'react';
import { ArrowSquareOut } from '@phosphor-icons/react';

export interface ExplorerLinkProps {
  txHash?: `0x${string}`;
  address?: `0x${string}`;
  children?: ReactNode;
  className?: string;
}

const BASE_URL = 'https://shannon-explorer.somnia.network';

export function ExplorerLink({
  txHash,
  address,
  children,
  className = 'inline-flex items-center gap-1 text-accent hover:underline',
}: ExplorerLinkProps) {
  if (!txHash && !address) {
    console.warn('ExplorerLink: neither txHash nor address provided; skipping render.');
    return null;
  }
  const href = txHash ? `${BASE_URL}/tx/${txHash}` : `${BASE_URL}/address/${address}`;
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className}>
      {children ?? (
        <>
          <ArrowSquareOut size={11} /> explorer
        </>
      )}
    </a>
  );
}
