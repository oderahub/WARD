import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

/**
 * Two-column split with a draggable vertical divider.
 *
 * Below the `lg` breakpoint the two children stack and the divider is hidden
 * (the grid drops to `grid-cols-1`). At `lg+`, the parent grid uses three
 * tracks — `${leftPct}fr | 6px gutter | ${100-leftPct}fr` — driven by the
 * inline `--split-cols` CSS variable. Dragging the divider updates `leftPct`;
 * the value is clamped so neither pane shrinks below `minPaneWidth` pixels.
 *
 * The split percentage persists per-instance under `storageKey` in
 * `localStorage` so a user's preferred ratio survives reloads. A double-click
 * on the divider resets to `defaultLeftPct`.
 *
 * Keyboard support: focus the divider (tab) then ← / → step the split by 2%
 * (10% with Shift), Home/End jump to 20/80, Enter or Space reset.
 *
 * ARIA: the divider is `role="separator"` with `aria-orientation="vertical"`
 * and live `aria-valuenow`, per the WAI-ARIA window splitter pattern.
 */

interface Props {
  left: ReactNode;
  right: ReactNode;
  /** localStorage key for persisting the split ratio. Use a stable per-surface id. */
  storageKey: string;
  /** Default percentage for the left pane (5–95). Used when no stored value exists. */
  defaultLeftPct?: number;
  /** Minimum pixel width for either pane while dragging. Prevents either side from disappearing. */
  minPaneWidth?: number;
  /** Optional extra class on the outer grid wrapper (e.g. `h-full`, `p-4`). */
  className?: string;
}

const CLAMP_MIN = 5;
const CLAMP_MAX = 95;

function readStoredPct(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) return fallback;
    if (v < CLAMP_MIN || v > CLAMP_MAX) return fallback;
    return v;
  } catch {
    return fallback;
  }
}

export function ResizableSplit({
  left,
  right,
  storageKey,
  defaultLeftPct = 50,
  minPaneWidth = 320,
  className = "",
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [leftPct, setLeftPct] = useState<number>(() => readStoredPct(storageKey, defaultLeftPct));
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(leftPct));
    } catch {
      // Quota / disabled storage — silent fallback. The next session reopens at default.
    }
  }, [leftPct, storageKey]);

  const computeClampedPct = useCallback(
    (clientX: number): number => {
      const c = containerRef.current;
      if (!c) return leftPct;
      const rect = c.getBoundingClientRect();
      const w = rect.width;
      if (w <= 0) return leftPct;
      const minPct = Math.max(CLAMP_MIN, (minPaneWidth / w) * 100);
      const maxPct = Math.min(CLAMP_MAX, 100 - minPct);
      const raw = ((clientX - rect.left) / w) * 100;
      return Math.min(maxPct, Math.max(minPct, raw));
    },
    [leftPct, minPaneWidth],
  );

  const startDrag = (e: PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setIsDragging(true);
  };

  const onDrag = (e: PointerEvent<HTMLButtonElement>) => {
    if (!isDragging) return;
    e.preventDefault();
    setLeftPct(computeClampedPct(e.clientX));
  };

  const endDrag = (e: PointerEvent<HTMLButtonElement>) => {
    if (!isDragging) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    setIsDragging(false);
  };

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const step = e.shiftKey ? 10 : 2;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setLeftPct((p) => Math.max(CLAMP_MIN, p - step));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setLeftPct((p) => Math.min(CLAMP_MAX, p + step));
    } else if (e.key === "Home") {
      e.preventDefault();
      setLeftPct(20);
    } else if (e.key === "End") {
      e.preventDefault();
      setLeftPct(80);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setLeftPct(defaultLeftPct);
    }
  };

  // CSS var drives the lg+ template; below lg the grid falls back to grid-cols-1.
  // Divider is a 1px hairline (document grade); we still render a 9px-wide hit
  // target overlaying it so the keyboard/pointer affordance stays usable.
  const style: CSSProperties = {
    ["--split-cols" as string]: `${leftPct}fr 1px ${100 - leftPct}fr`,
  };

  return (
    <div
      ref={containerRef}
      className={`grid grid-cols-1 gap-0 lg:[grid-template-columns:var(--split-cols)] ${className}`}
      style={style}
    >
      <div className="min-w-0 min-h-0">{left}</div>

      <button
        type="button"
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={Math.round(leftPct)}
        aria-valuemin={CLAMP_MIN}
        aria-valuemax={CLAMP_MAX}
        aria-label="Resize columns. Use arrow keys to adjust, Enter to reset, Home/End for 20/80 split."
        onPointerDown={startDrag}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKey}
        onDoubleClick={() => setLeftPct(defaultLeftPct)}
        data-dragging={isDragging || undefined}
        className={[
          "hidden lg:block relative cursor-col-resize",
          "bg-rule hover:bg-accent/60 data-[dragging=true]:bg-accent",
          "transition-colors",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-accent focus-visible:ring-inset",
        ].join(" ")}
        style={{ transitionDuration: "var(--motion-feedback)" }}
      >
        {/* Invisible widened hit-target so the 1px rule stays grab-able. */}
        <span aria-hidden className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-[9px]" />
      </button>

      <div className="min-w-0 min-h-0">{right}</div>
    </div>
  );
}
