/** State machine for the post-publish checklist orchestrator. */
import type { Address, Hex } from "viem";

export type BindStatus =
  | "pending"
  | "bound" // setPolicyId tx mined successfully
  | "already-bound" // probe found POLICY_ID() already matches
  | "skipped"; // user clicked skip with an agent address known

export type RegisterStatus =
  | "pending"
  | "registered"
  | "rebound"
  | "skipped";

export interface ChecklistState {
  publishedPolicyId: Hex;
  bindStatus: BindStatus;
  /** The agent address the user has resolved in Step 1 — either typed +
   *  probed successfully, or recovered from the "already-bound" idempotency
   *  shortcut. Required to render Step 2 (Register needs an `agent` prop). */
  boundAgentAddress?: Address;
  bindTxHash?: Hex;
  registerStatus: RegisterStatus;
  registerTxHash?: Hex;
}

export type ChecklistAction =
  // Step 1 — emitted by BindStep as the user interacts with it
  | { type: "agent-resolved"; agent: Address }
  | { type: "agent-cleared" }
  | { type: "bound"; agent: Address; txHash: Hex }
  | { type: "already-bound"; agent: Address }
  | { type: "bind-skipped" } // requires boundAgentAddress to be set; otherwise no-op

  // Step 2 — emitted by RegisterStep via its onDone callback
  | { type: "registered"; txHash?: Hex }
  | { type: "rebound"; txHash?: Hex }
  | { type: "register-skipped" };

export function initialChecklistState(publishedPolicyId: Hex): ChecklistState {
  return {
    publishedPolicyId,
    bindStatus: "pending",
    registerStatus: "pending",
  };
}

export function checklistReducer(
  state: ChecklistState,
  action: ChecklistAction,
): ChecklistState {
  switch (action.type) {
    case "agent-resolved": {
      // Updating boundAgentAddress while bindStatus is still pending is
      // expected — the orchestrator wants to know the agent for Step 2's
      // prefill the moment the probe completes, even before bind is clicked.
      //
      // If the user re-types a DIFFERENT address after a successful bind
      // (bindStatus === "bound" or "already-bound"), the prior bind tx
      // referenced the OLD agent and tells us nothing about the new one.
      // Reset bindStatus to "pending" + drop bindTxHash so Step 2 stays
      // hidden until the new address is bound on its own; otherwise the
      // operator would see Step 2 prefilled as already-bound for an agent
      // we've never actually probed/bound.
      if (
        state.boundAgentAddress &&
        state.boundAgentAddress.toLowerCase() === action.agent.toLowerCase()
      ) {
        return state;
      }
      if (state.bindStatus === "bound" || state.bindStatus === "already-bound") {
        return {
          ...state,
          boundAgentAddress: action.agent,
          bindStatus: "pending",
          bindTxHash: undefined,
        };
      }
      return { ...state, boundAgentAddress: action.agent };
    }
    case "agent-cleared": {
      // User cleared the input. Drop the address so Step 2 hides again, and
      // — if a prior bind had completed against the previous address — also
      // reset bindStatus + bindTxHash so a later agent-resolved on a NEW
      // address doesn't inherit a stale "bound" badge from the prior agent.
      if (
        !state.boundAgentAddress &&
        state.bindStatus !== "bound" &&
        state.bindStatus !== "already-bound"
      ) {
        return state;
      }
      const needsBindReset =
        state.bindStatus === "bound" || state.bindStatus === "already-bound";
      return {
        ...state,
        boundAgentAddress: undefined,
        ...(needsBindReset ? { bindStatus: "pending", bindTxHash: undefined } : {}),
      };
    }

    case "bound": {
      return {
        ...state,
        bindStatus: "bound",
        boundAgentAddress: action.agent,
        bindTxHash: action.txHash,
      };
    }
    case "already-bound": {
      // Idempotency shortcut from the probe. No tx hash because no tx was
      // submitted. Step 2 still reveals so the operator can register.
      return {
        ...state,
        bindStatus: "already-bound",
        boundAgentAddress: action.agent,
        bindTxHash: undefined,
      };
    }
    case "bind-skipped": {
      // Honor "skip" only when we know an agent — Step 2 needs it. If the
      // user clicked Skip without resolving an address, treat as no-op
      // (the UI affordance should also gate skip on having an address).
      if (!state.boundAgentAddress) return state;
      return { ...state, bindStatus: "skipped" };
    }

    case "registered": {
      return {
        ...state,
        registerStatus: "registered",
        registerTxHash: action.txHash,
      };
    }
    case "rebound": {
      return {
        ...state,
        registerStatus: "rebound",
        registerTxHash: action.txHash,
      };
    }
    case "register-skipped": {
      return { ...state, registerStatus: "skipped" };
    }

    default:
      return state;
  }
}

export function isRegisterRevealed(state: ChecklistState): boolean {
  return (
    state.bindStatus !== "pending" &&
    state.boundAgentAddress !== undefined
  );
}

export function isChecklistDone(state: ChecklistState): boolean {
  return state.bindStatus !== "pending" && state.registerStatus !== "pending";
}

/**
 * Build the in-app href that deep-links to the just-registered agent on the
 * Watched tab. Mirrors the existing wizard pattern (setTab("watched") + a
 * hash fragment). The `#agent-{address}` anchor is a best-effort scroll
 * target — AgentsCatalogPanel may or may not honor it today, but the tab
 * navigation works either way.
 *
 * Exported so a future scroll-into-view contract in AgentsCatalogPanel can
 * derive the same id from the same helper, and so a unit test can lock the
 * URL shape down without rendering the dashboard.
 */
export function buildWatchedAgentHref(agent: string): string {
  // Lower-case in the fragment — anchor lookups in HTML are case-sensitive
  // and downstream consumers store addresses lowercased.
  return `?tab=watched#agent-${agent.toLowerCase()}`;
}
