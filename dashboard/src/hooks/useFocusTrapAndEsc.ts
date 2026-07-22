import { useEffect, useRef, type RefObject } from 'react';

export interface UseFocusTrapAndEscOptions {
  active?: boolean;
  restoreFocusTo?: HTMLElement | null;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

function getFocusable(container: HTMLElement): HTMLElement[] {
  const nodes = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
  return Array.from(nodes).filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1);
}

function isFocusable(el: HTMLElement | null): el is HTMLElement {
  if (!el) return false;
  if (!document.contains(el)) return false;
  if (el.hasAttribute('disabled')) return false;
  if (el.tabIndex === -1 && !el.hasAttribute('tabindex')) {
    // Elements like <body> have tabIndex -1 but can still receive focus()
    // programmatically; allow them only if explicitly passed via restoreFocusTo.
    return typeof el.focus === 'function';
  }
  return typeof el.focus === 'function';
}

interface HookHandle {
  handleKeyDown: (event: KeyboardEvent) => void;
}

// Module-level stack so the topmost active trap wins regardless of React's
// effect ordering. Belt-and-braces with stopImmediatePropagation.
const TRAP_STACK: HookHandle[] = [];

export function useFocusTrapAndEsc(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  options?: UseFocusTrapAndEscOptions,
): void {
  const active = options?.active !== false;
  const restoreFocusTo = options?.restoreFocusTo ?? null;

  // Hold latest onClose in a ref so the effect doesn't re-subscribe.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;

    // Capture the previously-focused element BEFORE we move focus into the trap
    // so we can restore it on cleanup (WCAG 2.4.3).
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Focus first focusable on mount.
    const focusable = getFocusable(container);
    if (focusable.length > 0) {
      focusable[0].focus();
    } else {
      container.focus();
    }

    const handle: HookHandle = {
      handleKeyDown: (event: KeyboardEvent) => {
        // Only the topmost trap in the stack handles the event.
        if (TRAP_STACK[TRAP_STACK.length - 1] !== handle) return;

        if (event.key === 'Escape') {
          event.stopImmediatePropagation();
          onCloseRef.current();
          return;
        }
        if (event.key !== 'Tab') return;

        const current = ref.current;
        if (!current) return;
        const items = getFocusable(current);
        if (items.length === 0) {
          event.preventDefault();
          event.stopImmediatePropagation();
          current.focus();
          return;
        }

        const first = items[0];
        const last = items[items.length - 1];
        const activeEl = document.activeElement as HTMLElement | null;

        if (event.shiftKey) {
          if (activeEl === first || !current.contains(activeEl)) {
            event.preventDefault();
            event.stopImmediatePropagation();
            last.focus();
          }
        } else if (activeEl === last) {
          event.preventDefault();
          event.stopImmediatePropagation();
          first.focus();
        }
      },
    };

    TRAP_STACK.push(handle);
    document.addEventListener('keydown', handle.handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handle.handleKeyDown);
      const idx = TRAP_STACK.lastIndexOf(handle);
      if (idx !== -1) TRAP_STACK.splice(idx, 1);

      const target = restoreFocusTo ?? previouslyFocused;
      if (isFocusable(target)) {
        target.focus();
      }
    };
  }, [ref, active, restoreFocusTo]);
}
