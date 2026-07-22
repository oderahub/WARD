import type { ReactNode } from 'react';
import { X as XIcon } from '@phosphor-icons/react';

export interface DrawerHeaderProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  onClose: () => void;
}

export function DrawerHeader({ eyebrow, title, onClose }: DrawerHeaderProps) {
  return (
    <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-rule bg-surface px-6 py-4">
      <div className="min-w-0">
        {eyebrow ? (
          <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-text-muted">
            {eyebrow}
          </div>
        ) : null}
        <div className="mt-1 text-base font-semibold tracking-tight text-text">{title}</div>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close drawer"
        className="p-1 text-text-muted hover:text-text"
      >
        <XIcon size={16} weight="regular" />
      </button>
    </div>
  );
}
