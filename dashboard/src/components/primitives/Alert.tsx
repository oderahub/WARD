import type { ReactNode } from 'react';

export type AlertVariant = 'danger' | 'warn' | 'success' | 'info';

export interface AlertProps {
  variant: AlertVariant;
  title?: string;
  children: ReactNode;
  className?: string;
}

const VARIANT_MAP: Record<AlertVariant, string> = {
  danger: 'border-danger bg-danger/20',
  warn: 'border-warn bg-warn/20',
  success: 'border-success bg-success/20',
  info: 'border-accent/40 bg-surface-elev',
};

export function Alert({ variant, title, children, className }: AlertProps) {
  return (
    <div
      role="alert"
      className={`rounded-md border ${VARIANT_MAP[variant]} p-3 text-xs text-text ${className ?? ''}`}
    >
      {title ? <div className="font-semibold mb-1 text-text">{title}</div> : null}
      {children}
    </div>
  );
}
