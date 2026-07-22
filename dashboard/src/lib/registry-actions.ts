/**
 * Registry-actions — single canonical import surface for WardAgentRegistry
 * writes, shared between the Watch Wizard's register sub-card and the
 * standalone Register step in the post-publish checklist.
 *
 * `simulateAndWriteRegisterAgent` lives in ./writes.ts (alongside
 * `simulateAndWritePublish` and the queue/policy helpers); it's re-exported
 * here so consumers wiring up registry calls have ONE module to import from
 * regardless of which write path they need.
 *
 * Why no `update(...)` helper: the registry's `register(...)` is idempotent
 * for the original registrar — re-calling overwrites every field including
 * `name`, which `update(...)` (the alternative) cannot. RegisterStep
 * deliberately ALWAYS calls register() for both new and same-registrar
 * re-register flows (see the docstring in RegisterStep.tsx), so a separate
 * update helper is unused production code.
 *
 * `simulateAndWriteRegisterAgent`:
 *   1. simulates via the public client so registry-revert reasons (e.g.
 *      `NotRegistrar`) surface in the UI before the wallet popup opens;
 *   2. computes a Shannon-safe gas override via `shannonSafeGas`;
 *   3. submits through wagmi's `writeContractAsync`, optionally pinned to
 *      `chainId` so the wallet aborts at the network boundary instead of
 *      submitting to the wrong chain.
 */
export { simulateAndWriteRegisterAgent } from "./writes";
