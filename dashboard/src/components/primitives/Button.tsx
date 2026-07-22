import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'accent' | 'danger' | 'success' | 'warn' | 'ghost';
export type ButtonSize = 'xs' | 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
  className?: string;
}

const VARIANT_MAP: Record<ButtonVariant, string> = {
  accent: 'bg-accent text-white border-accent hover:bg-accent-hover',
  danger: 'bg-danger/20 border-danger text-white hover:bg-danger/30',
  success: 'bg-success/20 border-success text-white hover:bg-success/30',
  warn: 'bg-warn/20 border-warn text-white hover:bg-warn/30',
  ghost:
    'bg-transparent border-sentry-border text-text-muted hover:text-text hover:border-text-muted',
};

const SIZE_MAP: Record<ButtonSize, string> = {
  xs: 'px-2 py-1 text-[11px]',
  sm: 'px-2.5 py-1 text-xs',
  md: 'px-3 py-1.5 text-xs',
};

const BASE =
  'rounded-md border font-medium transition-colors transition-transform active:scale-[0.98] active:translate-y-[1px] disabled:opacity-50 disabled:cursor-not-allowed';

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size = 'md', children, className, type = 'button', ...rest },
  ref,
) {
  const classes = `${BASE} ${VARIANT_MAP[variant]} ${SIZE_MAP[size]} ${className ?? ''}`;
  return (
    <button ref={ref} type={type} className={classes} {...rest}>
      {children}
    </button>
  );
});
