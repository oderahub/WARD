/**
 * Shared rendering helpers for policy display surfaces.
 *
 * Legacy policies still carry `expiresAt: 0` on-chain (the publish path stopped
 * accepting it, but old policies persist). PolicyLib.validate treats any
 * non-future expiry as EXPIRED, so every UI surface that renders `expiresAt`
 * MUST show the legacy-0 case as expired — not "never", not "no expiry". This
 * module centralizes that wording so the policy drawer, the post-publish
 * reveal, the diff modal, and the extend-expiry preview all agree.
 */
import { formatEther } from "viem";

export const LEGACY_ZERO_EXPIRY_LABEL = "expired (legacy 0 sentinel)";

/**
 * Compact "0.5 AVAX" wei rendering for the diff view. The previous
 * `fmtWei` rendered "0.5 AVAX (500000000000000000 wei)" which doubled the line
 * length with low information density — the raw wei is debug noise next to
 * the human form. The raw value is preserved via `rawWeiTooltip` (caller
 * threads it into a `title=` attribute) so an operator who needs to sanity-
 * check the on-chain integer still can, just on hover instead of in-line.
 *
 * Two semantics for zero:
 *   - `dailySpendWeiCap = 0`  → "0 (blocks all native spend)" — PolicyLib
 *     treats this as a hard cap of 0, not "unlimited" (`spentToday + i.value`
 *     overflows past `dailySpendWeiCap` for any positive value, so DAILY_CAP
 *     reverts every call with msg.value > 0).
 *   - `valueCapPerCall = 0`  → "0 (no native value allowed for this call)" —
 *     same enforcement (`v > p.valueCapPerCall` reverts on positive value),
 *     but per-selector instead of policy-wide.
 *
 * These wordings are paired with the `dailySpendWeiCap=0 blocks all` callout
 * in PolicyDiff so the operator sees a consistent story between the diff row
 * and the YAML-style edit form.
 */
export function formatDailyCapCompact(wei: bigint): string {
  if (wei === 0n) return "0 AVAX (blocks all native spend)";
  return `${formatEther(wei)} AVAX`;
}

export function formatPerCallCapCompact(wei: bigint): string {
  if (wei === 0n) return "0 AVAX (no native value allowed)";
  return `${formatEther(wei)} AVAX`;
}

/**
 * Render the raw wei integer as a tooltip body — used by PolicyDiff to
 * thread the exact on-chain value into a `title=` attribute beside the
 * compact AVAX form. Kept as a separate helper so the caller doesn't have to
 * remember the "wei" suffix or worry about bigint → string coercion.
 */
export function formatWeiTooltip(wei: bigint): string {
  return `${wei.toString()} wei`;
}

/**
 * Format an `expiresAt` bigint (unix seconds) for display.
 *
 *   - `0n` → "expired (legacy 0 sentinel)"
 *   - otherwise → locale string `<absolute> (<unixSec>)`
 *
 * The `(unixSec)` suffix is included so the operator can sanity-check the
 * exact on-chain value alongside the human-readable date — useful in the
 * diff modal where both before/after sit side by side.
 */
export function formatExpiresAtForDiff(unixSec: bigint): string {
  if (unixSec === 0n) return LEGACY_ZERO_EXPIRY_LABEL;
  const ms = Number(unixSec) * 1000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return unixSec.toString();
  return `${date.toLocaleString()} (${unixSec.toString()})`;
}

/**
 * Format an `expiresAt` bigint for the post-publish reveal / metadata strip
 * (no parenthetical unix-seconds suffix; the surrounding UI shows its own
 * "(expired / in the future)" hint).
 */
export function formatExpiresAtForReveal(expiresAt: bigint): string {
  if (expiresAt === 0n) return LEGACY_ZERO_EXPIRY_LABEL;
  const ms = Number(expiresAt) * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return expiresAt.toString();
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Returns true when the given `expiresAt` is the legacy 0 sentinel — callers
 * use this to apply danger-status coloring without re-checking the magic value
 * inline.
 */
export function isLegacyZeroExpiry(expiresAt: bigint): boolean {
  return expiresAt === 0n;
}

/**
 * Full-shape render result used by the policy drawer's HEALTH row. Status
 * drives color (expired → danger, imminent → warn, future → subtle). The
 * `no-expiry` arm is retained for backward compatibility with the drawer's
 * existing render switch, even though `formatExpiresAtFull` never produces it
 * today (legacy-0 is reported as `expired`, not `no-expiry`).
 */
export interface ExpiresAtRenderResult {
  absolute: string;
  relative: string;
  status: "no-expiry" | "expired" | "imminent" | "future";
}

function formatSecsCoarse(secs: bigint): string {
  const n = Number(secs);
  if (!Number.isFinite(n)) return `${secs.toString()}s`;
  if (n < 60) return `${n}s`;
  if (n < 3600) return `${Math.floor(n / 60)}m ${n % 60}s`;
  if (n < 86400) return `${Math.floor(n / 3600)}h ${Math.floor((n % 3600) / 60)}m`;
  return `${Math.floor(n / 86400)}d ${Math.floor((n % 86400) / 3600)}h`;
}

/**
 * Drawer-shape expiry formatter. The absolute string carries `timeZoneName:
 * "short"` so the operator can disambiguate UTC vs local at a glance, and the
 * relative string is computed against `nowSeconds` (defaulting to wall-clock
 * now, but callers tick this once per second so the countdown stays live).
 *
 * Legacy-0 collapses to `{ absolute: "—", relative: "expired (legacy 0
 * sentinel)", status: "expired" }` to match PolicyLib.validate's treatment.
 */
export function formatExpiresAtFull(
  expiresAt: bigint,
  nowSeconds: bigint = BigInt(Math.floor(Date.now() / 1000)),
): ExpiresAtRenderResult {
  if (isLegacyZeroExpiry(expiresAt)) {
    return { absolute: "—", relative: LEGACY_ZERO_EXPIRY_LABEL, status: "expired" };
  }
  const ms = Number(expiresAt) * 1000;
  const d = new Date(ms);
  const absolute = Number.isNaN(d.getTime())
    ? expiresAt.toString()
    : d.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      });
  const delta = expiresAt - nowSeconds;
  if (delta <= 0n) {
    return { absolute, relative: `expired ${formatSecsCoarse(-delta)} ago`, status: "expired" };
  }
  return {
    absolute,
    relative: `in ${formatSecsCoarse(delta)}`,
    status: delta < 86400n ? "imminent" : "future",
  };
}

/**
 * Modal-shape expiry formatter (current-expiry display in ExtendExpiryModal).
 * Returns the plain locale string with no parenthetical suffix and no
 * explicit option bag — the modal renders this beside its own "previously-
 * expired" alert which provides the surrounding context.
 */
export function formatExpiresAtForModal(expiresAt: bigint): string {
  if (isLegacyZeroExpiry(expiresAt)) return LEGACY_ZERO_EXPIRY_LABEL;
  const d = new Date(Number(expiresAt) * 1000);
  if (Number.isNaN(d.getTime())) return expiresAt.toString();
  return d.toLocaleString();
}
