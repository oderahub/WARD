export interface SpendEntry {
  timestamp: bigint;
  valueWei: bigint;
  askerAddress: `0x${string}`;
}

/** UTC day bucket matching on-chain `block.timestamp / 86400`. */
export function utcDayBucket(timestamp: bigint): bigint {
  return timestamp / 86400n;
}

/** Sum same-day spend for an asker, matching the on-chain UTC bucket. */
export function spentTodayFor(
  entries: SpendEntry[],
  asker: `0x${string}`,
  nowTimestamp: bigint,
): bigint {
  const today = utcDayBucket(nowTimestamp);
  const target = asker.toLowerCase();
  let total = 0n;
  for (const entry of entries) {
    if (utcDayBucket(entry.timestamp) !== today) continue;
    if (entry.askerAddress.toLowerCase() !== target) continue;
    total += entry.valueWei;
  }
  return total;
}
