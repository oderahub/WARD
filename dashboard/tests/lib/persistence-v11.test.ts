import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { openDB } from "idb";
import type { Address, Hex } from "viem";

import {
  openSentryDB,
  saveWatchSubscription,
  loadWatchSubscription,
  WATCH_SUBSCRIPTIONS_STORE,
} from "../../src/lib/persistence";

const DB_NAME = "sentry-store";
const OWNER_INDEX_STORE = "ownerIndex";
const CONTRACT_NAME_STORE = "contractName";
const CACHED_AGENTS_STORE = "cachedAgents";
const PUBLISHED_CACHE_STORE = "publishedCache";

const CHAIN_ID = 50312;
const AGENT = "0x000000000000000000000000000000000000bEEf" as Address;
const POLICY_ID = ("0x" + "ab".repeat(32)) as Hex;
// Fixture URL — NEVER a real webhook secret.
const WEBHOOK_URL = "https://hooks.slack.com/services/T_TEST/B_TEST/SECRET_TEST";

beforeEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
});

/**
 * Seed a v10-shaped database: every store that v10 carries, but NOT
 * `watchSubscriptions`. Mirrors the upgrade-callback's contains-guarded
 * additive pattern so we can prove v11 adds the new store without
 * touching v10 records.
 */
async function seedV10Db(seed: { ownerIndexKey: string; ownerIndexValue: unknown }) {
  const db = await openDB(DB_NAME, 10, {
    upgrade(db) {
      for (const [name, keyPath] of [
        ["snapshots", "namespace"],
        ["watched", "key"],
        ["spend-daily", "key"],
        ["violations", "key"],
        [OWNER_INDEX_STORE, "key"],
        [PUBLISHED_CACHE_STORE, "key"],
        [CONTRACT_NAME_STORE, "key"],
        [CACHED_AGENTS_STORE, "key"],
      ] as const) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath });
        }
      }
    },
  });
  await db.put(OWNER_INDEX_STORE, {
    key: seed.ownerIndexKey,
    entries: [{ policyId: POLICY_ID, publishedBlock: "1000" }],
    lastSeenBlock: "1500",
    savedAtMs: 1_700_000_000_000,
  });
  expect(db.objectStoreNames.contains(WATCH_SUBSCRIPTIONS_STORE)).toBe(false);
  db.close();
}

describe("v10 → v11/v12/v13 additive migration", () => {
  it("DB_VERSION is 13 (v13 telegram-field bump) and the watchSubscriptions store is created on upgrade", async () => {
    const db = await openSentryDB();
    try {
      expect(db.version).toBe(13);
      expect(db.objectStoreNames.contains(WATCH_SUBSCRIPTIONS_STORE)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("v10 records survive the v10 → v13 upgrade unchanged (purely additive)", async () => {
    const KEY = `${CHAIN_ID}:0xoracleplaceholder:0xowner`;
    await seedV10Db({ ownerIndexKey: KEY, ownerIndexValue: null });

    // openSentryDB triggers v10 → v13 in one shot — additive at every step.
    const upgraded = await openSentryDB();
    try {
      expect(upgraded.version).toBe(13);
      expect(upgraded.objectStoreNames.contains(WATCH_SUBSCRIPTIONS_STORE)).toBe(true);

      const ownerRec = (await upgraded.get(OWNER_INDEX_STORE, KEY)) as
        | {
            key: string;
            entries: Array<{ policyId: Hex; publishedBlock: string }>;
            lastSeenBlock: string;
          }
        | undefined;
      expect(ownerRec).toBeDefined();
      expect(ownerRec!.entries).toHaveLength(1);
      expect(ownerRec!.entries[0].policyId).toBe(POLICY_ID);
      expect(ownerRec!.entries[0].publishedBlock).toBe("1000");
      expect(ownerRec!.lastSeenBlock).toBe("1500");

      // The new store starts empty.
      const subs = await upgraded.getAll(WATCH_SUBSCRIPTIONS_STORE);
      expect(subs).toEqual([]);
    } finally {
      upgraded.close();
    }
  });

  it("saveWatchSubscription + loadWatchSubscription round-trip a Slack-channel record", async () => {
    await saveWatchSubscription({
      chainId: CHAIN_ID,
      agent: AGENT,
      policyId: POLICY_ID,
      slackWebhookUrl: WEBHOOK_URL,
      tier: "balanced",
    });
    const loaded = await loadWatchSubscription(CHAIN_ID, AGENT);
    expect(loaded).not.toBeNull();
    expect(loaded!.chainId).toBe(CHAIN_ID);
    expect(loaded!.agent).toBe(AGENT.toLowerCase());
    expect(loaded!.policyId).toBe(POLICY_ID.toLowerCase());
    expect(loaded!.tier).toBe("balanced");
    // The persisted record carries the URL verbatim because the persistence
    // layer is a dumb key/value store — masking is a UI concern. The store
    // is operator-local IDB; the URL never leaves the browser.
    expect(loaded!.slackWebhookUrl).toBe(WEBHOOK_URL);
    // Slack-only rows do NOT carry a telegram field.
    expect(loaded!.telegram).toBeUndefined();
    expect(typeof loaded!.createdAt).toBe("number");
  });

  it("saveWatchSubscription + loadWatchSubscription round-trip a Telegram-channel record", async () => {
    const TELEGRAM = {
      botToken: "1234567890:SECRET_TEST_TOKEN_VALUE_ABCDEF1234",
      chatId: "987654321",
    };
    await saveWatchSubscription({
      chainId: CHAIN_ID,
      agent: AGENT,
      policyId: POLICY_ID,
      telegram: TELEGRAM,
      tier: "aggressive",
    });
    const loaded = await loadWatchSubscription(CHAIN_ID, AGENT);
    expect(loaded).not.toBeNull();
    expect(loaded!.tier).toBe("aggressive");
    expect(loaded!.slackWebhookUrl).toBeUndefined();
    expect(loaded!.telegram).toEqual(TELEGRAM);
  });

  it("legacy v12-shaped row (Slack only, no telegram field) loads cleanly under the v13 type", async () => {
    // Hand-write a row that mirrors what v11/v12 would have written: no
    // `telegram` key at all, just `slackWebhookUrl`. The v13 type-widening
    // (telegram optional) must accept it without throwing or normalizing it
    // into a telegram-shaped row.
    const db = await openSentryDB();
    try {
      const tx = db.transaction(WATCH_SUBSCRIPTIONS_STORE, "readwrite");
      await tx.store.put({
        key: `${CHAIN_ID}:${AGENT.toLowerCase()}`,
        chainId: CHAIN_ID,
        agent: AGENT.toLowerCase(),
        policyId: POLICY_ID.toLowerCase(),
        slackWebhookUrl: WEBHOOK_URL,
        tier: "conservative" as const,
        createdAt: 1_700_000_000_000,
      });
      await tx.done;
    } finally {
      db.close();
    }
    const loaded = await loadWatchSubscription(CHAIN_ID, AGENT);
    expect(loaded).not.toBeNull();
    expect(loaded!.slackWebhookUrl).toBe(WEBHOOK_URL);
    expect(loaded!.telegram).toBeUndefined();
    expect(loaded!.tier).toBe("conservative");
  });

  it("saveWatchSubscription throws when both channels are provided (XOR violation)", async () => {
    await expect(
      saveWatchSubscription({
        chainId: CHAIN_ID,
        agent: AGENT,
        policyId: POLICY_ID,
        slackWebhookUrl: WEBHOOK_URL,
        telegram: { botToken: "1234567890:abc", chatId: "1" },
        tier: "balanced",
      }),
    ).rejects.toThrow(/exactly one alert channel/);
  });

  it("saveWatchSubscription throws when no channel is provided", async () => {
    await expect(
      saveWatchSubscription({
        chainId: CHAIN_ID,
        agent: AGENT,
        policyId: POLICY_ID,
        tier: "balanced",
      }),
    ).rejects.toThrow(/exactly one alert channel/);
  });
});
