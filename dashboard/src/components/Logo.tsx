/**
 * Ward brand mark — inline SVG gate + "Ward" wordmark.
 *
 * Uses the same hexagonal-gate mark as the landing page (geometry lifted from
 * public/favicon.svg) rather than a raster asset, so the wordmark is always
 * "Ward" (the old PNG lockups still carried the pre-rename artwork) and it
 * stays crisp at any size and themes via currentColor / --accent.
 */
import type { CSSProperties } from "react";

interface Props {
  /** Pixel height of the gate mark. */
  size?: number;
  className?: string;
}

function GateMark({ size }: { size: number }) {
  const arrow: CSSProperties = { stroke: "var(--accent)" };
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ height: size, width: size }}
      className="text-text"
      aria-hidden
    >
      <polygon
        points="32,8 54,20 54,44 32,56 10,44 10,20"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinejoin="round"
      />
      <rect x="29" y="22" width="6" height="20" fill="currentColor" rx="2" />
      <line x1="2" y1="32" x2="18" y2="32" style={arrow} strokeWidth="4" strokeDasharray="4 3" strokeLinecap="round" />
      <line x1="46" y1="32" x2="58" y2="32" style={arrow} strokeWidth="5" strokeLinecap="round" />
      <polygon points="62,32 56,28 56,36" style={{ fill: "var(--accent)" }} />
    </svg>
  );
}

export function Logo({ size = 32, className }: Props) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ""}`} aria-label="Ward">
      <GateMark size={size} />
      <span
        className="font-semibold tracking-tight text-text"
        style={{ fontSize: Math.round(size * 0.62) }}
      >
        Ward
      </span>
    </span>
  );
}
