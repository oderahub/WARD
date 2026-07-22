import { describe, it, expect } from "vitest";
import { spentTodayFor, utcDayBucket, type SpendEntry } from "../src/spent-tracker.js";

const ALICE = "0x000000000000000000000000000000000000A11C" as `0x${string}`;
const BOB = "0x000000000000000000000000000000000000B0B0" as `0x${string}`;

// 2026-05-30 00:00:00 UTC = 1779840000 — comfortably mid-bucket for the tests below.
const NOW = 1779849600n; // 2026-05-30 02:40:00 UTC
const TODAY = utcDayBucket(NOW);
const TODAY_START = TODAY * 86400n;
const YESTERDAY_TS = TODAY_START - 1n;

describe("spent-tracker", () => {
  it("utcDayBucket(0) === 0", () => {
    expect(utcDayBucket(0n)).toBe(0n);
  });

  it("utcDayBucket(86400) === 1", () => {
    expect(utcDayBucket(86400n)).toBe(1n);
  });

  it("sums today's entries for the requested asker, excluding yesterday", () => {
    const entries: SpendEntry[] = [
      { timestamp: TODAY_START + 10n, valueWei: 100n, askerAddress: ALICE },
      { timestamp: NOW, valueWei: 250n, askerAddress: ALICE },
      { timestamp: YESTERDAY_TS, valueWei: 999n, askerAddress: ALICE },
    ];
    expect(spentTodayFor(entries, ALICE, NOW)).toBe(350n);
  });

  it("matches asker case-insensitively", () => {
    const entries: SpendEntry[] = [
      { timestamp: NOW, valueWei: 42n, askerAddress: ALICE.toUpperCase() as `0x${string}` },
    ];
    expect(spentTodayFor(entries, ALICE.toLowerCase() as `0x${string}`, NOW)).toBe(42n);
  });

  it("returns 0n when no entries match", () => {
    const entries: SpendEntry[] = [
      { timestamp: YESTERDAY_TS, valueWei: 100n, askerAddress: ALICE },
      { timestamp: NOW, valueWei: 100n, askerAddress: BOB },
    ];
    expect(spentTodayFor(entries, ALICE, NOW)).toBe(0n);
  });

  it("only sums the requested asker when multiple askers spent today", () => {
    const entries: SpendEntry[] = [
      { timestamp: NOW, valueWei: 100n, askerAddress: ALICE },
      { timestamp: NOW, valueWei: 500n, askerAddress: BOB },
      { timestamp: NOW, valueWei: 25n, askerAddress: ALICE },
    ];
    expect(spentTodayFor(entries, ALICE, NOW)).toBe(125n);
    expect(spentTodayFor(entries, BOB, NOW)).toBe(500n);
  });
});
