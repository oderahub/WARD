import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import type { Hex } from "viem";
import {
  addWatchedPolicy,
  removeWatchedPolicy,
  listWatchedPolicies,
  getWatchedPolicy,
  updateLastCheckedBlock,
  getCachedPolicyInput,
  type WatchedPolicy,
} from "../../src/lib/watched-policies";

const POLICY_ID = "0xabc0000000000000000000000000000000000000000000000000000000000001" as Hex;
const AGENT = "0xAAaaaaaaAaAaAAAaaAAaAaaAAAAaAaaAAAaaAaA0" as Hex;
const ORACLE_A = "0x1111111111111111111111111111111111111111" as Hex;
const ORACLE_B = "0x2222222222222222222222222222222222222222" as Hex;

function sample(overrides: Partial<WatchedPolicy> = {}): WatchedPolicy {
  return {
    policyId: POLICY_ID,
    watchedAgentAddress: AGENT,
    label: "counter-agent",
    chainId: 43113,
    oracleAddress: ORACLE_A,
    addedAtMs: 1_700_000_000_000,
    lastCheckedBlock: "0",
    ...overrides,
  };
}

// Wipe the IDB between tests so cases stay isolated. fake-indexeddb exposes a
// fresh factory via /auto registration; we just delete the db.
beforeEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase("ward-store");
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
});

describe("watched-policies registry", () => {
  it("add + list returns the entry", async () => {
    const entry = sample();
    await addWatchedPolicy(entry);
    const list = await listWatchedPolicies(entry.chainId, entry.oracleAddress);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(entry);
  });

  it("remove deletes the entry", async () => {
    const entry = sample();
    await addWatchedPolicy(entry);
    await removeWatchedPolicy(
      entry.chainId,
      entry.oracleAddress,
      entry.policyId,
      entry.watchedAgentAddress,
    );
    const got = await getWatchedPolicy(
      entry.chainId,
      entry.oracleAddress,
      entry.policyId,
      entry.watchedAgentAddress,
    );
    expect(got).toBeUndefined();
    const list = await listWatchedPolicies(entry.chainId, entry.oracleAddress);
    expect(list).toEqual([]);
  });

  it("list filters by chainId+oracle (different chain returns empty)", async () => {
    await addWatchedPolicy(sample());
    const otherChain = await listWatchedPolicies(1, ORACLE_A);
    expect(otherChain).toEqual([]);
    const otherOracle = await listWatchedPolicies(43113, ORACLE_B);
    expect(otherOracle).toEqual([]);
  });

  it("updateLastCheckedBlock persists", async () => {
    const entry = sample();
    await addWatchedPolicy(entry);
    await updateLastCheckedBlock(
      entry.chainId,
      entry.oracleAddress,
      entry.policyId,
      entry.watchedAgentAddress,
      12345n,
    );
    const got = await getWatchedPolicy(
      entry.chainId,
      entry.oracleAddress,
      entry.policyId,
      entry.watchedAgentAddress,
    );
    expect(got?.lastCheckedBlock).toBe("12345");
  });

  it("persists policyInputJSON and rehydrates bigint fields via getCachedPolicyInput", async () => {
    const policyInput = {
      agent: AGENT,
      dailySpendWeiCap: 1_000_000_000_000_000_000n,
      expiresAt: 1_900_000_000n,
      valueCapPerCall: 500_000_000_000_000_000n,
      delaySeconds: 60n,
      allowedTargets: [ORACLE_A],
    };
    const policyInputJSON = JSON.stringify(policyInput, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    const entry = sample({ policyInputJSON });
    await addWatchedPolicy(entry);

    const list = await listWatchedPolicies(entry.chainId, entry.oracleAddress);
    expect(list).toHaveLength(1);
    expect(list[0].policyInputJSON).toBe(policyInputJSON);

    const cached = getCachedPolicyInput(list[0]);
    expect(cached).not.toBeNull();
    expect(cached?.dailySpendWeiCap).toBe(1_000_000_000_000_000_000n);
    expect(cached?.expiresAt).toBe(1_900_000_000n);
    expect(cached?.valueCapPerCall).toBe(500_000_000_000_000_000n);
    expect(cached?.delaySeconds).toBe(60n);
    expect(cached?.agent).toBe(AGENT);
    expect(cached?.allowedTargets).toEqual([ORACLE_A]);
  });

  it("backward-compat: entry without policyInputJSON yields null from getCachedPolicyInput", async () => {
    const entry = sample();
    expect(entry.policyInputJSON).toBeUndefined();
    await addWatchedPolicy(entry);
    const got = await getWatchedPolicy(
      entry.chainId,
      entry.oracleAddress,
      entry.policyId,
      entry.watchedAgentAddress,
    );
    expect(got).toBeDefined();
    expect(got!.policyInputJSON).toBeUndefined();
    expect(getCachedPolicyInput(got!)).toBeNull();
  });

  it("chain isolation: chain A entry does not appear in chain B list", async () => {
    await addWatchedPolicy(sample({ chainId: 43113 }));
    await addWatchedPolicy(
      sample({
        policyId: "0xdef0000000000000000000000000000000000000000000000000000000000002" as Hex,
        chainId: 1,
      }),
    );
    const a = await listWatchedPolicies(43113, ORACLE_A);
    const b = await listWatchedPolicies(1, ORACLE_A);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].chainId).toBe(43113);
    expect(b[0].chainId).toBe(1);
  });
});
