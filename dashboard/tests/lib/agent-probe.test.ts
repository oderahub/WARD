/**
 * probeAgent — exercised against a mocked PublicClient. Covers every
 * discriminated branch of ProbeState that probeAgent itself can produce:
 *   - eoa              (no contract code)
 *   - no-set-policy-id (has code, POLICY_ID() reverts)
 *   - sentry-agent     (has code, POLICY_ID() + owner() both succeed)
 *   - sentry-agent w/ owner read failing (returns owner: null)
 *
 * The "idle" / "probing" / "probe-error" branches are state-only — set by
 * call sites around probeAgent, not by probeAgent itself — so they're not
 * exercised here.
 */
import { describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";

import { probeAgent } from "../../src/lib/agent-probe";

const AGENT = "0x000000000000000000000000000000000000beef" as Address;
const OWNER = "0x000000000000000000000000000000000000feed" as Address;
const POLICY = ("0x" + "11".repeat(32)) as Hex;

type StubClient = Parameters<typeof probeAgent>[0];

function makeClient(opts: {
  code?: string;
  policyId?: Hex | Error;
  owner?: Address | Error;
}): StubClient {
  return {
    getCode: vi.fn().mockResolvedValue(opts.code ?? "0x"),
    readContract: vi.fn().mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === "POLICY_ID") {
        if (opts.policyId instanceof Error) throw opts.policyId;
        return opts.policyId ?? POLICY;
      }
      if (functionName === "owner") {
        if (opts.owner instanceof Error) throw opts.owner;
        return opts.owner ?? OWNER;
      }
      throw new Error("unexpected functionName " + functionName);
    }),
  } as unknown as StubClient;
}

describe("probeAgent", () => {
  it("returns kind:'eoa' when getCode is empty", async () => {
    const client = makeClient({ code: "0x" });
    const r = await probeAgent(client, AGENT);
    expect(r).toEqual({ kind: "eoa" });
  });

  it("returns kind:'no-set-policy-id' when POLICY_ID() reverts", async () => {
    const client = makeClient({
      code: "0xdeadbeef",
      policyId: new Error("execution reverted"),
    });
    const r = await probeAgent(client, AGENT);
    expect(r).toEqual({ kind: "no-set-policy-id" });
  });

  it("returns kind:'sentry-agent' with both POLICY_ID and owner when reads succeed", async () => {
    const client = makeClient({
      code: "0xdeadbeef",
      policyId: POLICY,
      owner: OWNER,
    });
    const r = await probeAgent(client, AGENT);
    expect(r.kind).toBe("sentry-agent");
    if (r.kind !== "sentry-agent") return;
    expect(r.currentPolicyId).toBe(POLICY);
    expect(r.owner).toBe(OWNER);
  });

  it("returns owner:null when owner() reverts but POLICY_ID succeeded", async () => {
    // SentryAgentBase derivatives may override owner() visibility — the bind
    // path still works because simulate catches NotOwner. Treat as unknown.
    const client = makeClient({
      code: "0xdeadbeef",
      policyId: POLICY,
      owner: new Error("owner() reverted"),
    });
    const r = await probeAgent(client, AGENT);
    expect(r.kind).toBe("sentry-agent");
    if (r.kind !== "sentry-agent") return;
    expect(r.currentPolicyId).toBe(POLICY);
    expect(r.owner).toBeNull();
  });
});
