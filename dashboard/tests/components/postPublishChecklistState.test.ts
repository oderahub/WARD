/**
 * Unit tests for the PostPublishChecklist orchestrator's reducer. The
 * reducer is intentionally pure (no React, no wagmi) so the four scenarios
 * the design calls out — full happy path, skip-register, bind-error
 * (no register revealed), already-bound agent shows update path — are
 * expressed as plain `(initial, action[]) -> finalState` assertions.
 *
 * We do NOT use @testing-library/react here. The dashboard's test suite
 * deliberately stays in pure-node vitest (see other tests under
 * tests/lib + tests/pages); pulling RTL in just for the orchestrator
 * would expand the test matrix without surfacing rules the reducer alone
 * doesn't already express.
 */
import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";

import {
  buildWatchedAgentHref,
  checklistReducer,
  initialChecklistState,
  isChecklistDone,
  isRegisterRevealed,
  type ChecklistAction,
  type ChecklistState,
} from "../../src/components/publish/postPublishChecklistState";

const POLICY_A = ("0x" + "aa".repeat(32)) as Hex;
const POLICY_B = ("0x" + "bb".repeat(32)) as Hex;
const AGENT_A = "0x000000000000000000000000000000000000beef" as Address;
const AGENT_B = "0x0000000000000000000000000000000000001234" as Address;
const TX_HASH = ("0x" + "11".repeat(32)) as Hex;
const TX_HASH_2 = ("0x" + "22".repeat(32)) as Hex;

function run(initial: ChecklistState, actions: ChecklistAction[]): ChecklistState {
  return actions.reduce(checklistReducer, initial);
}

describe("postPublishChecklistState — initialChecklistState", () => {
  it("pins the policyId and leaves both steps in 'pending'", () => {
    const s = initialChecklistState(POLICY_A);
    expect(s.publishedPolicyId).toBe(POLICY_A);
    expect(s.bindStatus).toBe("pending");
    expect(s.registerStatus).toBe("pending");
    expect(s.boundAgentAddress).toBeUndefined();
    expect(s.bindTxHash).toBeUndefined();
    expect(s.registerTxHash).toBeUndefined();
  });

  it("hides Step 2 (Register) until Step 1 transitions and an agent is known", () => {
    const s = initialChecklistState(POLICY_A);
    expect(isRegisterRevealed(s)).toBe(false);
    expect(isChecklistDone(s)).toBe(false);
  });
});

describe("postPublishChecklistState — full happy path: bind then register", () => {
  it("walks bind→bound→register; reveals Step 2 after bind; marks done after register", () => {
    const initial = initialChecklistState(POLICY_A);
    // BindStep emits agent-resolved as soon as the probe confirms a contract,
    // BEFORE the bind tx is submitted. The orchestrator records the address
    // but keeps bindStatus 'pending' until the tx mines.
    const afterProbe = checklistReducer(initial, {
      type: "agent-resolved",
      agent: AGENT_A,
    });
    expect(afterProbe.bindStatus).toBe("pending");
    expect(afterProbe.boundAgentAddress).toBe(AGENT_A);
    // Step 2 is still hidden — bind hasn't completed.
    expect(isRegisterRevealed(afterProbe)).toBe(false);

    const afterBind = checklistReducer(afterProbe, {
      type: "bound",
      agent: AGENT_A,
      txHash: TX_HASH,
    });
    expect(afterBind.bindStatus).toBe("bound");
    expect(afterBind.boundAgentAddress).toBe(AGENT_A);
    expect(afterBind.bindTxHash).toBe(TX_HASH);
    // Now Step 2 reveals.
    expect(isRegisterRevealed(afterBind)).toBe(true);
    // But the checklist isn't "done" yet — Step 2 is still pending.
    expect(isChecklistDone(afterBind)).toBe(false);

    const final = checklistReducer(afterBind, {
      type: "registered",
      txHash: TX_HASH_2,
    });
    expect(final.registerStatus).toBe("registered");
    expect(final.registerTxHash).toBe(TX_HASH_2);
    expect(isChecklistDone(final)).toBe(true);
  });
});

describe("postPublishChecklistState — skip-register", () => {
  it("bind succeeds, register-skipped marks the checklist done without a tx hash", () => {
    const final = run(initialChecklistState(POLICY_A), [
      { type: "agent-resolved", agent: AGENT_A },
      { type: "bound", agent: AGENT_A, txHash: TX_HASH },
      { type: "register-skipped" },
    ]);
    expect(final.bindStatus).toBe("bound");
    expect(final.bindTxHash).toBe(TX_HASH);
    expect(final.registerStatus).toBe("skipped");
    expect(final.registerTxHash).toBeUndefined();
    expect(isChecklistDone(final)).toBe(true);
  });
});

describe("postPublishChecklistState — bind error: no register revealed", () => {
  it("agent-resolved alone does NOT reveal Step 2 (bind must complete or be skipped)", () => {
    // Simulates the bind-error case: the probe succeeded, the user clicked
    // bind, the simulate/write threw, BindStep stays in `tx:error` and does
    // NOT dispatch `bound`. The orchestrator should not advance.
    const state = run(initialChecklistState(POLICY_A), [
      { type: "agent-resolved", agent: AGENT_A },
      // ...bind tx error — no `bound` action dispatched
    ]);
    expect(state.bindStatus).toBe("pending");
    expect(state.boundAgentAddress).toBe(AGENT_A);
    expect(isRegisterRevealed(state)).toBe(false);
    expect(isChecklistDone(state)).toBe(false);
  });

  it("clearing the agent address mid-flight drops boundAgentAddress and keeps Step 2 hidden", () => {
    const state = run(initialChecklistState(POLICY_A), [
      { type: "agent-resolved", agent: AGENT_A },
      { type: "agent-cleared" },
    ]);
    expect(state.boundAgentAddress).toBeUndefined();
    expect(isRegisterRevealed(state)).toBe(false);
  });
});

describe("postPublishChecklistState — already-bound shortcut", () => {
  it("already-bound action advances Step 1 without a tx hash AND reveals Step 2", () => {
    const state = checklistReducer(initialChecklistState(POLICY_A), {
      type: "already-bound",
      agent: AGENT_A,
    });
    expect(state.bindStatus).toBe("already-bound");
    expect(state.boundAgentAddress).toBe(AGENT_A);
    // No tx hash because no tx was submitted — this is the idempotency
    // shortcut, not a write.
    expect(state.bindTxHash).toBeUndefined();
    expect(isRegisterRevealed(state)).toBe(true);
  });

  it("already-bound → register flows through the rebound branch (update path)", () => {
    const final = run(initialChecklistState(POLICY_A), [
      { type: "already-bound", agent: AGENT_A },
      // RegisterStep classifies this as a rebound when registered-by-me
      // entry exists with a different policyId. The reducer doesn't know
      // about that internal classification; it just records the outcome.
      { type: "rebound", txHash: TX_HASH },
    ]);
    expect(final.bindStatus).toBe("already-bound");
    expect(final.registerStatus).toBe("rebound");
    expect(final.registerTxHash).toBe(TX_HASH);
    expect(isChecklistDone(final)).toBe(true);
  });
});

describe("postPublishChecklistState — bind-skipped edge cases", () => {
  it("bind-skipped is a no-op when no agent address has been resolved yet", () => {
    // Without an agent, skipping doesn't reveal Step 2 (Step 2 needs the
    // address to render). The reducer rejects the transition rather than
    // entering an inconsistent state.
    const state = checklistReducer(initialChecklistState(POLICY_A), {
      type: "bind-skipped",
    });
    expect(state.bindStatus).toBe("pending");
    expect(isRegisterRevealed(state)).toBe(false);
  });

  it("bind-skipped with a resolved agent advances Step 1 and reveals Step 2", () => {
    const state = run(initialChecklistState(POLICY_A), [
      { type: "agent-resolved", agent: AGENT_A },
      { type: "bind-skipped" },
    ]);
    expect(state.bindStatus).toBe("skipped");
    expect(state.boundAgentAddress).toBe(AGENT_A);
    expect(state.bindTxHash).toBeUndefined();
    expect(isRegisterRevealed(state)).toBe(true);
  });
});

describe("postPublishChecklistState — input churn", () => {
  it("re-resolving the SAME agent address is a no-op (identity preserved)", () => {
    const initial = initialChecklistState(POLICY_A);
    const a = checklistReducer(initial, { type: "agent-resolved", agent: AGENT_A });
    const b = checklistReducer(a, { type: "agent-resolved", agent: AGENT_A });
    expect(b).toBe(a); // referential equality — no new object allocated
  });

  it("re-typing to a different agent after a successful bind resets bindStatus so Step 2 hides until the new agent is bound", () => {
    // Realistic flow: user binds AGENT_A, then types AGENT_B into the input
    // (perhaps because they bound the wrong agent). The prior bind tx is
    // for AGENT_A and tells us NOTHING about AGENT_B's policyId — if we
    // kept bindStatus 'bound' the operator would see Step 2 immediately
    // revealed as bound-for-AGENT_B, which is misleading. Reset to pending
    // and force a fresh probe + bind on the new address.
    const state = run(initialChecklistState(POLICY_A), [
      { type: "agent-resolved", agent: AGENT_A },
      { type: "bound", agent: AGENT_A, txHash: TX_HASH },
      { type: "agent-resolved", agent: AGENT_B },
    ]);
    expect(state.boundAgentAddress).toBe(AGENT_B);
    expect(state.bindStatus).toBe("pending");
    expect(state.bindTxHash).toBeUndefined();
    // Step 2 stays hidden until the new agent is independently bound.
    expect(isRegisterRevealed(state)).toBe(false);
  });

  it("re-typing to a different agent after an already-bound shortcut also resets bindStatus", () => {
    // Same defence for the already-bound idempotency path: the shortcut
    // proved AGENT_A already had the right POLICY_ID, but AGENT_B is a
    // different contract whose POLICY_ID we have not inspected.
    const state = run(initialChecklistState(POLICY_A), [
      { type: "already-bound", agent: AGENT_A },
      { type: "agent-resolved", agent: AGENT_B },
    ]);
    expect(state.boundAgentAddress).toBe(AGENT_B);
    expect(state.bindStatus).toBe("pending");
    expect(state.bindTxHash).toBeUndefined();
    expect(isRegisterRevealed(state)).toBe(false);
  });

  it("clearing the agent input after a successful bind also resets bindStatus so a later resolve doesn't inherit the stale bound badge", () => {
    // Without this reset, the sequence (bind A → clear → resolve B) would
    // leave bindStatus 'bound' from A and immediately reveal Step 2 for B
    // the moment its address resolved.
    const state = run(initialChecklistState(POLICY_A), [
      { type: "agent-resolved", agent: AGENT_A },
      { type: "bound", agent: AGENT_A, txHash: TX_HASH },
      { type: "agent-cleared" },
    ]);
    expect(state.boundAgentAddress).toBeUndefined();
    expect(state.bindStatus).toBe("pending");
    expect(state.bindTxHash).toBeUndefined();
    expect(isRegisterRevealed(state)).toBe(false);
  });

  it("re-resolving the SAME address after a successful bind preserves bindStatus + bindTxHash (no spurious reset)", () => {
    // Guard against an over-eager reset: the address-equality short-circuit
    // must fire BEFORE the bound/already-bound branch, otherwise repeated
    // probes of the same agent would wipe the recorded bind tx.
    const initial = initialChecklistState(POLICY_A);
    const bound = run(initial, [
      { type: "agent-resolved", agent: AGENT_A },
      { type: "bound", agent: AGENT_A, txHash: TX_HASH },
    ]);
    const reResolved = checklistReducer(bound, {
      type: "agent-resolved",
      agent: AGENT_A,
    });
    // Same reference — identity preserved means no churn for downstream
    // useMemo / shallow comparisons.
    expect(reResolved).toBe(bound);
    expect(reResolved.bindStatus).toBe("bound");
    expect(reResolved.bindTxHash).toBe(TX_HASH);
  });

  it("agent-cleared with no resolved address AND no completed bind is a no-op (identity preserved)", () => {
    // Without the bind-completion check the cleared handler still needs to
    // short-circuit when there is nothing to clear; otherwise every input
    // blur would allocate a fresh state object.
    const initial = initialChecklistState(POLICY_A);
    const cleared = checklistReducer(initial, { type: "agent-cleared" });
    expect(cleared).toBe(initial);
  });

  it("resolving then clearing mid-flight (no bind in between) drops only the address — bind stays pending", () => {
    // Mid-flight clear (no bind yet) is the original behaviour; the reset
    // logic should NOT kick in because there is no completed bind to roll
    // back. Verifies the bindStatus branch in the cleared handler.
    const state = run(initialChecklistState(POLICY_A), [
      { type: "agent-resolved", agent: AGENT_A },
      { type: "agent-cleared" },
    ]);
    expect(state.boundAgentAddress).toBeUndefined();
    expect(state.bindStatus).toBe("pending");
    expect(state.bindTxHash).toBeUndefined();
  });
});

describe("postPublishChecklistState — policyId is immutable across the lifecycle", () => {
  it("no action changes publishedPolicyId — the checklist is keyed on it", () => {
    const initial = initialChecklistState(POLICY_A);
    const final = run(initial, [
      { type: "agent-resolved", agent: AGENT_A },
      { type: "bound", agent: AGENT_A, txHash: TX_HASH },
      { type: "registered", txHash: TX_HASH_2 },
    ]);
    expect(final.publishedPolicyId).toBe(POLICY_A);
    // Defense: even if a stray POLICY_B leaked into actions, the reducer
    // ignores it (there is no action shape that carries a policyId).
    void POLICY_B;
  });
});

describe("buildWatchedAgentHref — post-register breadcrumb URL contract", () => {
  it("returns a watched-tab href with a lowercased address fragment", () => {
    // The success row in PostPublishChecklist links here so the operator can
    // jump straight to their just-registered entry; the catalog row id is
    // expected to be `agent-<lowercased>`. Lock the shape so a future tab-
    // state refactor doesn't silently break the deep link.
    const checksummed = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01" as Address;
    expect(buildWatchedAgentHref(checksummed)).toBe(
      "?tab=watched#agent-0xabcdef0123456789abcdef0123456789abcdef01",
    );
  });

  it("is stable under checksum vs lowercase inputs", () => {
    // Whether the caller passes a checksummed Address or a lowercased one,
    // the fragment id must be identical — otherwise a checksum change in an
    // upstream caller would point at a fragment id no one renders.
    const upper = "0xABCDEF0123456789ABCDEF0123456789ABCDEF01" as Address;
    const lower = "0xabcdef0123456789abcdef0123456789abcdef01" as Address;
    expect(buildWatchedAgentHref(upper)).toBe(buildWatchedAgentHref(lower));
  });
});
