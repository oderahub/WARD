import type { ReactNode } from 'react';

export interface RowProps {
  label: ReactNode;
  children: ReactNode;
  mono?: boolean;
  align?: 'baseline' | 'center';
}

export function Row({ label, children, mono = false, align = 'center' }: RowProps) {
  const alignClass = align === 'baseline' ? 'items-baseline' : 'items-center';
  return (
    <div className={`grid grid-cols-[7rem_1fr] gap-2 ${alignClass}`}>
      <div className="text-xs text-text-muted">{label}</div>
      <div>{mono ? <span className="font-mono text-xs">{children}</span> : children}</div>
    </div>
  );
}
