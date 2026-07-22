import { forwardRef } from 'react';
import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';

const BASE =
  'rounded-md border border-sentry-border bg-surface px-2 text-xs placeholder:text-text-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  className?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={`h-8 ${BASE} ${className ?? ''}`} {...rest} />;
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  className?: string;
  rows?: number;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, rows = 3, ...rest },
  ref,
) {
  return <textarea ref={ref} rows={rows} className={`py-1.5 ${BASE} ${className ?? ''}`} {...rest} />;
});
