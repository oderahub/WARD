# Sentry — Lean 4 model verification

This Lean project verifies a mathematical model of Sentry's policy semantics.
It does NOT verify Solidity source, compiler output, deployed bytecode, gas behavior,
storage layout, or EVM execution. These proofs reduce ambiguity in the intended semantics;
they do not replace Solidity audits, fuzzing, symbolic execution, or bytecode-level
verification.

## What is checked

A Lean 4 model under `Sentry/` mirrors the intended semantics of `PolicyLib.validate`,
`SentryQueue`'s dispatch state machine, and `SentryOracle`'s two-step ownership handoff.
**Ten theorems** in `Sentry/Theorems.lean` pin down precedence, monotonicity, timing, and
ownership-handoff properties of that model — broken down as **5 PolicyLib + 3 SentryQueue
+ 2 SentryOracle**. Every proof is checked end-to-end by `lake build`; the build fails
if any proof breaks.

## The ten theorems

`PolicyLib` (mirrors `contracts/src/PolicyLib.sol::validate`):

1. **`validate_paused_takes_precedence`** — a paused policy rejects every intent
   with `PAUSED`, no matter what other fields look like.
2. **`validate_expired_takes_precedence`** — when not paused, an expired policy
   rejects every intent with `EXPIRED`.
3. **`validate_target_not_allowed_implies_false`** — when paused/expiry/calldata/
   selector checks pass but the target is not whitelisted, validation rejects
   with `TARGET_NOT_ALLOWED`.
4. **`validate_value_cap_strict`** — when all earlier checks pass and
   `i.value` exceeds the per-call cap, validation rejects with `VALUE_CAP`.
5. **`validate_monotone_in_spentToday`** — if validation succeeds at `spentToday = s`,
   it still succeeds at any `s' ≤ s`. Lowering today's spend can only widen the
   remaining budget; no other branch depends on `spentToday`.

`SentryQueue` (mirrors `contracts/src/SentryQueue.sol`'s state machine):

6. **`dispatch_too_early`** — calling `dispatch` while `t < earliestCommitAt`
   returns `TOO_EARLY`, regardless of any other fields.
7. **`dispatch_in_window`** — calling `dispatch` while
   `earliestCommitAt ≤ t ≤ deadline` returns `ok` with `state = COMMITTED`.
8. **`dispatch_after_veto_fails`** — calling `dispatch` after `veto` always
   returns `NOT_PENDING`, regardless of timing.

`SentryOracle` (the Lean `transferOwnership` / `acceptOwnership` model the per-policy `transferPolicyOwnership` / `acceptPolicyOwnership` in `contracts/src/SentryOracle.sol`; there is no contract-level owner):

9. **`transferOwnership_alone_doesNotChangeOwner`** — calling `transferOwnership(newOwner)`
   sets `pendingOwner` but never mutates `owner` in the same call; ownership cannot
   change without the recipient's explicit acceptance.
10. **`pendingOwner_can_accept_then_owner_changes`** — after `transferOwnership(newOwner)`,
    the `acceptOwnership` call (only from `pendingOwner`) atomically moves `owner` to
    `newOwner` and clears `pendingOwner`.

The queue theorems model state transitions only. Authorization rules (DELAYED →
asker-dispatchable, VETO_REQUIRED → policyOwner-dispatchable) and policy
re-validation (`policyHealth` pause/expiry check at dispatch) are out of model
scope and covered by the 20-test Foundry suite in `contracts/test/SentryQueue.t.sol`.

## Solidity correspondence

| Lean function | Solidity source |
| --- | --- |
| `Sentry.PolicyLib.validate` | `contracts/src/PolicyLib.sol::validate` |
| `Sentry.Queue.enqueue` | `contracts/src/SentryQueue.sol::enqueue` |
| `Sentry.Queue.dispatch` | `contracts/src/SentryQueue.sol::dispatch` |
| `Sentry.Queue.veto` | `contracts/src/SentryQueue.sol::veto` |

The Lean side simplifies the Solidity layout in two ways, tracked in `Sentry/Basic.lean`:

- The EVM `mapping` lookups used by `Policy` become linear scans over a `List`
  of `TargetEntry`. Only decidable equality is exercised by `validate`, so the
  storage layout does not change the semantics being modelled.
- The `bytes32` reason strings emitted by Solidity (`"PAUSED"`, `"EXPIRED"`, …)
  become constructors of the `Sentry.Reason` inductive type. The mirroring is by
  name, not by byte representation.

## What is NOT verified

- The Solidity source compiles to bytecode that matches this model.
- Storage layout, `bytes32` packing, or any EVM-level concern.
- Gas costs, revert vs. return-with-error differences, or upgrade safety.
- The oracle wiring around `PolicyLib` (publishPolicy / updatePolicy / checkIntent / tierAndDelay) — those are pure plumbing over `validate` and `PolicyNormalizer.copy`, exercised by the SentryOracle Foundry test suite (`contracts/test/SentryOracle.t.sol`).
- Calldata decoding beyond a length check and a selector-extraction stub.
- `tierOf`, `delayFor`, the policy normalizer, `SentryQueue.expireIfStale`, or any other Solidity entry point not listed in the correspondence table.
- **UTC-day bucket selection.** The Lean model treats `spentToday` as an
  *input* to `validate`; the UTC-day bucket selection is the integrator's
  responsibility (the oracle does not track per-asker spend, since it has no custody).
- **ABI / EVM memory semantics.** `selectorOf` models only the first four
  calldata bytes as a big-endian selector. ABI argument decoding, full EVM
  memory layout, and assembly-level calldata access are outside scope.

For those guarantees, use the Solidity audit, fuzzing, and symbolic-execution
toolchains that the rest of `sentry-somnia` configures.

## Build

```bash
export PATH="$HOME/.elan/bin:$PATH"
cd verification/lean
lake build
```

`lake build` must complete with no errors and no `sorry` / `admit`. To double-check:

```bash
grep -rn "sorry\|admit\b" Sentry/ Main.lean | grep -v "^--" || echo "no sorry"
```

## Toolchain

Pinned in `lean-toolchain`:

- Lean 4.13.0
- Lake 5.0.0

No external dependencies. Stdlib only — no Mathlib, no Aesop.

## Formal model & guarantees

The proofs constrain the Lean model, not deployed bytecode. The model pins the precedence ladder, budget monotonicity, queue timing, and ownership handoff; EVM details, wiring, authorization, re-validation, and normalizer behavior remain in the Solidity test/audit surface named above.

### Source layout

- `Sentry/Theorems.lean` — the ten theorems.
- `Sentry/Basic.lean` — the model and its simplifications (mapping → `List`, reason `bytes32` → inductive constructors).
- `lean-toolchain` — pinned Lean 4.13.0 / Lake 5.0.0.
