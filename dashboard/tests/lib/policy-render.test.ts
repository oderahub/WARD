import { describe, it, expect } from "vitest";
import {
  LEGACY_ZERO_EXPIRY_LABEL,
  formatDailyCapCompact,
  formatExpiresAtForModal,
  formatExpiresAtFull,
  formatPerCallCapCompact,
  formatWeiTooltip,
  isLegacyZeroExpiry,
} from "../../src/lib/policy-render";

// Pin the "now" clock so the relative-string assertions stay deterministic.
// 2026-06-02T00:00:00Z — matches the project's currentDate in CLAUDE.md.
const NOW_SEC = BigInt(Math.floor(Date.UTC(2026, 5, 2, 0, 0, 0) / 1000));

describe("policy-render.formatExpiresAtFull", () => {
  it("collapses the legacy-0 sentinel to expired with em-dash absolute", () => {
    const r = formatExpiresAtFull(0n, NOW_SEC);
    expect(r.status).toBe("expired");
    expect(r.absolute).toBe("—");
    expect(r.relative).toBe(LEGACY_ZERO_EXPIRY_LABEL);
  });

  it("reports an already-past expiry as expired with an ago suffix", () => {
    // 2 hours 30 minutes before NOW_SEC.
    const past = NOW_SEC - BigInt(2 * 3600 + 30 * 60);
    const r = formatExpiresAtFull(past, NOW_SEC);
    expect(r.status).toBe("expired");
    expect(r.relative).toBe("expired 2h 30m ago");
  });

  it("marks expiries inside the next 24h as imminent", () => {
    // 6 hours from now.
    const soon = NOW_SEC + BigInt(6 * 3600);
    const r = formatExpiresAtFull(soon, NOW_SEC);
    expect(r.status).toBe("imminent");
    expect(r.relative).toBe("in 6h 0m");
  });

  it("marks expiries beyond 24h as future with a coarse d/h relative", () => {
    // 3 days 4 hours from now.
    const later = NOW_SEC + BigInt(3 * 86400 + 4 * 3600);
    const r = formatExpiresAtFull(later, NOW_SEC);
    expect(r.status).toBe("future");
    expect(r.relative).toBe("in 3d 4h");
  });
});

describe("policy-render.formatExpiresAtForModal", () => {
  it("returns the legacy-0 label for the sentinel", () => {
    expect(formatExpiresAtForModal(0n)).toBe(LEGACY_ZERO_EXPIRY_LABEL);
  });

  it("returns the plain locale string for a normal timestamp", () => {
    const ts = BigInt(Math.floor(Date.UTC(2027, 0, 1, 12, 0, 0) / 1000));
    const expected = new Date(Number(ts) * 1000).toLocaleString();
    expect(formatExpiresAtForModal(ts)).toBe(expected);
  });
});

describe("policy-render.isLegacyZeroExpiry", () => {
  it("is true only for 0n", () => {
    expect(isLegacyZeroExpiry(0n)).toBe(true);
    expect(isLegacyZeroExpiry(1n)).toBe(false);
  });
});

// Compact wei helpers used by PolicyDiff. The previous diff rendered
// "0.5 AVAX (500000000000000000 wei)" on EVERY row which doubled the line
// length for negligible information. We collapse to "0.5 AVAX" and thread the
// raw wei through `formatWeiTooltip` into a `title=` attribute. These tests
// pin the wording (especially the zero arms) because PolicyLib treats
// dailySpendWeiCap=0 as a hard block — getting "no cap" here would mislead
// an operator about to sign updatePolicy.
describe("policy-render.formatDailyCapCompact", () => {
  it("flags zero as blocking all native spend (NOT 'no cap')", () => {
    expect(formatDailyCapCompact(0n)).toBe("0 AVAX (blocks all native spend)");
  });

  it("renders a non-zero cap as a plain AVAX value without the raw-wei suffix", () => {
    expect(formatDailyCapCompact(500_000_000_000_000_000n)).toBe("0.5 AVAX");
    expect(formatDailyCapCompact(1_000_000_000_000_000_000n)).toBe("1 AVAX");
  });
});

describe("policy-render.formatPerCallCapCompact", () => {
  it("flags zero as no native value allowed (matches PolicyLib's per-call enforcement)", () => {
    expect(formatPerCallCapCompact(0n)).toBe("0 AVAX (no native value allowed)");
  });

  it("renders a non-zero per-call cap as a plain AVAX value", () => {
    expect(formatPerCallCapCompact(250_000_000_000_000_000n)).toBe("0.25 AVAX");
  });
});

describe("policy-render.formatWeiTooltip", () => {
  it("returns the raw wei integer with a 'wei' suffix for hover use", () => {
    expect(formatWeiTooltip(0n)).toBe("0 wei");
    expect(formatWeiTooltip(500_000_000_000_000_000n)).toBe(
      "500000000000000000 wei",
    );
  });
});
