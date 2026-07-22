import type { ReactNode } from 'react';

export type CardPadding = 'none' | 'sm' | 'md' | 'lg';

export interface CardProps {
  className?: string;
  children: ReactNode;
  padding?: CardPadding;
}

const PADDING_MAP: Record<CardPadding, string> = {
  none: '',
  sm: 'p-2',
  md: 'p-3',
  lg: 'p-4',
};

export function Card({ className, children, padding = 'md' }: CardProps) {
  const paddingClass = PADDING_MAP[padding];
  return (
    <div
      className={`rounded-md border border-ward-border bg-surface ${paddingClass} ${className ?? ''}`}
    >
      {children}
    </div>
  );
}
