/**
 * PostPublishChecklist — orchestrator for the operator checklist that appears
 * directly below `<PublishedReveal />` after a fresh publish (or on revisit
 * via `?revealed=`).
 *
 * Two steps, each independently skippable:
 *   1. Bind  — flip the deployed agent's POLICY_ID to the freshly published
 *              policyId (only meaningful for SentryAgentBase derivatives).
 *   2. Register — write the (agent → policyId) row to SentryAgentRegistry so
 *              downstream indexers can discover the binding.
 *
 * State for the orchestrator lives in `postPublishChecklistState.ts` as a
 * pure reducer so the transition rules can be unit-tested without React or
 * wagmi. This file is the React shell: it composes BindStep + RegisterStep,
 * wires their callbacks into the reducer, and pulls registry/oracle addresses
 * from the URL state + NETWORKS map.
 */
import { useCallback, useReducer } from "react";
import type { Address, Hex } from "viem";

import { useUrlState } from "../../hooks/useUrlState";
import { useWrongNetwork } from "../../hooks/useWrongNetwork";
import { NETWORKS } from "../../lib/networks";

import { Alert, ExplorerLink } from "../primitives";
import { BindStep } from "./BindStep";
import { RegisterStep } from "./RegisterStep";
import {
  buildWatchedAgentHref,
  checklistReducer,
  initialChecklistState,
  isRegisterRevealed,
  type ChecklistState,
  type ChecklistAction,
} from "./postPublishChecklistState";
import { CheckCircle } from "@phosphor-icons/react";

export interface PostPublishChecklistProps {
  /** Freshly published policyId. Pinned for the lifetime of the checklist —
   *  the orchestrator never re-keys on this because PublishPage already
   *  unmounts the success branch when the user goes "publish another". */
  policyId: Hex;
  /** Human label shown inside the Bind confirm dialog. */
  label: string;
  /**
   * Pre-filled agent address from the agent-first Publish entry point. When
   * the operator pastes an agent at the top of the form, this propagates so
   * BindStep doesn't ask them to paste it again. Undefined for the greenfield
   * path where no agent was provided up front.
   */
  prefilledAgentAddress?: Address;
}

export function PostPublishChecklist({
  policyId,
  label,
  prefilledAgentAddress,
}: PostPublishChecklistProps) {
  const { oracle } = useUrlState();
  const { wrong: wrongNetwork, current: currentChainId, expected: expectedChainId } =
    useWrongNetwork();

  // Initial state lazy via useReducer init — initialChecklistState runs once,
  // not on every render. Reducer is plain (state, action) so React's strict
  // mode double-invoke is safe.
  const [state, dispatch] = useReducer<
    React.Reducer<ChecklistState, ChecklistAction>,
    Hex
  >(checklistReducer, policyId, initialChecklistState);

  // Each BindStep callback is stable per-render via useCallback so BindStep's
  // internal effect deps don't churn unnecessarily.
  const onAgentResolved = useCallback(
    (agent: Parameters<NonNullable<React.ComponentProps<typeof BindStep>["onAgentResolved"]>>[0]) =>
      dispatch({ type: "agent-resolved", agent }),
    [],
  );
  const onAgentCleared = useCallback(
    () => dispatch({ type: "agent-cleared" }),
    [],
  );
  const onBound = useCallback(
    (agent: Parameters<NonNullable<React.ComponentProps<typeof BindStep>["onBound"]>>[0], txHash: Hex) =>
      dispatch({ type: "bound", agent, txHash }),
    [],
  );
  const onAlreadyBound = useCallback(
    (agent: Parameters<NonNullable<React.ComponentProps<typeof BindStep>["onAlreadyBound"]>>[0]) =>
      dispatch({ type: "already-bound", agent }),
    [],
  );
  const onBindSkip = useCallback(() => dispatch({ type: "bind-skipped" }), []);

  const onRegisterDone = useCallback(
    (outcome: "skipped" | "registered" | "rebound") => {
      if (outcome === "skipped") dispatch({ type: "register-skipped" });
      else if (outcome === "registered") dispatch({ type: "registered" });
      else dispatch({ type: "rebound" });
    },
    [],
  );

  // Registry address is a per-chain constant pulled from the NETWORKS map.
  // We deliberately do NOT take it as a prop — the rest of the dashboard
  // resolves it identically (see agents-catalog.ts comment in networks.ts)
  // and threading another address through PublishPage would be redundant.
  const registryAddress = NETWORKS[expectedChainId]?.registryAddress;

  // Both child steps gate internally, but the checklist needs a top-level signal.
  if (wrongNetwork) {
    return (
      <section className="space-y-3 rounded-lg border border-rule bg-surface p-4">
        <ChecklistHeader />
        <Alert variant="warn" title="Wrong network">
          Switch your wallet to Somnia testnet (chain {expectedChainId}). Currently on
          chain {currentChainId ?? "?"}. Binding + registering are disabled until
          you switch.
        </Alert>
      </section>
    );
  }

  // Defensive: a chain entry without a registry address means the second
  // step can't function. This is unreachable today (Somnia ships with one)
  // but the type allows it, so surface a soft warning rather than crash.
  const registerStepAvailable = registryAddress !== undefined;

  return (
    <section className="space-y-4 rounded-lg border border-rule bg-surface p-4">
      <ChecklistHeader />

      <div className="space-y-2">
        <StepHeading
          n={1}
          title="Bind the agent"
          status={describeBindStatus(state)}
        />
        <BindStep
          publishedPolicyId={state.publishedPolicyId}
          publishedLabel={label}
          onAgentResolved={onAgentResolved}
          onAgentCleared={onAgentCleared}
          onBound={onBound}
          onAlreadyBound={onAlreadyBound}
          onSkip={onBindSkip}
          prefilledAgentAddress={prefilledAgentAddress}
        />
      </div>

      {isRegisterRevealed(state) && registerStepAvailable && state.boundAgentAddress && (
        <>
          <div className="border-t border-rule" aria-hidden />
          <div className="space-y-2">
            <StepHeading
              n={2}
              title="Register in the catalog"
              status={describeRegisterStatus(state)}
            />
            <RegisterStep
              agent={state.boundAgentAddress}
              publishedPolicyId={state.publishedPolicyId}
              registryAddress={registryAddress}
              oracleAddress={oracle}
              onDone={onRegisterDone}
            />
            {(state.registerStatus === "registered" ||
              state.registerStatus === "rebound") && (
              <RegisterDoneBreadcrumb
                agent={state.boundAgentAddress}
                txHash={state.registerTxHash}
                rebound={state.registerStatus === "rebound"}
              />
            )}
          </div>
        </>
      )}

      {isRegisterRevealed(state) && !registerStepAvailable && (
        <Alert variant="warn" title="Registry not deployed on this chain">
          The catalog step can't run because no SentryAgentRegistry address is
          configured for chain {expectedChainId}. Step 1's bind tx (if any)
          stands on its own — the agent will still gate calls against the
          published policy.
        </Alert>
      )}
    </section>
  );
}

function ChecklistHeader() {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wider text-accent">
        Post-publish checklist
      </div>
      <p className="mt-1 text-[12px] text-text-muted">
        Two optional follow-ups. Step 1 points an already-deployed agent
        contract at this new policy (writing the new id into its{" "}
        <code className="font-mono text-[11px]">POLICY_ID</code> slot).
        Step 2 adds the agent to the public Watched catalog so dashboards
        and alerters can find it.
      </p>
    </div>
  );
}

interface StepHeadingProps {
  n: 1 | 2;
  title: string;
  status: string;
}

function StepHeading({ n, title, status }: StepHeadingProps) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h4 className="text-[13px] font-medium text-text">
        <span className="mr-2 text-text-muted">{n}.</span>
        {title}
      </h4>
      <span className="text-[11px] text-text-muted">{status}</span>
    </div>
  );
}

function describeBindStatus(state: ChecklistState): string {
  switch (state.bindStatus) {
    case "bound":
      return "bound";
    case "already-bound":
      return "already bound";
    case "skipped":
      return "skipped";
    default:
      return "pending";
  }
}

function describeRegisterStatus(state: ChecklistState): string {
  switch (state.registerStatus) {
    case "registered":
      return "registered";
    case "rebound":
      return "registry updated";
    case "skipped":
      return "skipped";
    default:
      return "pending";
  }
}

interface RegisterDoneBreadcrumbProps {
  agent: import("viem").Address;
  txHash: Hex | undefined;
  rebound: boolean;
}

/**
 * Tiny "you're done — here's where you landed" row that renders after Step 2
 * mines successfully. The href is derived from buildWatchedAgentHref so the
 * URL shape is unit-testable (Watched tab + agent fragment). The link is a
 * plain anchor — no setTab() call — so the browser handles the navigation
 * the same way a user-typed URL would, and so the test can assert href.
 */
function RegisterDoneBreadcrumb({ agent, txHash, rebound }: RegisterDoneBreadcrumbProps) {
  const href = buildWatchedAgentHref(agent);
  return (
    <div
      data-testid="register-done-breadcrumb"
      className="mt-2 flex flex-wrap items-center gap-3 rounded-md border border-success/40 bg-success/[0.06] p-3 text-[12px]"
    >
      <CheckCircle size={14} weight="fill" className="text-success" aria-hidden />
      <span className="text-text">
        {rebound ? "Registry entry updated." : "Agent registered."}
      </span>
      <a
        href={href}
        className="font-medium text-accent hover:underline"
        data-testid="view-on-watched-link"
      >
        View on Watched →
      </a>
      {txHash && <ExplorerLink txHash={txHash} />}
    </div>
  );
}

// default export for React.lazy; named export kept for test imports
export default PostPublishChecklist;
