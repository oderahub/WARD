# Security

Security spec for Ward: status, scope, the trust + threat model, per-function
contract invariants, and how to report a vulnerability.

## Contents

- [Status](#status)
- [Scope](#scope)
- [Reporting a vulnerability](#reporting-a-vulnerability)
- [Security model](#security-model)
  - [What Ward addresses](#what-ward-addresses)
  - [What Ward deliberately does NOT address](#what-ward-deliberately-does-not-address)
  - [Trust assumptions](#trust-assumptions)
  - [Example-contract foot-guns](#example-contract-foot-guns)
  - [Preflight is a UX layer, not a security boundary](#preflight-is-a-ux-layer-not-a-security-boundary)
- [Contract invariants](#contract-invariants)
  - [Global invariants](#global-invariants)
  - [WardOracle per-function invariants](#wardoracle-per-function-invariants)
  - [WardQueue per-function invariants](#wardqueue-per-function-invariants)

## Status

**Ward is an unaudited prototype.** No third-party audit. Lean 4 specifies and
verifies the policy validation core — `PolicyLib.validate` precedence/monotonicity
plus the `WardQueue` state machine, no `sorry` — see
[`verification/lean/`](verification/lean/). The Solidity contracts (Solidity
0.8.26) have manual review only — no symbolic execution or Halmos/Echidna
fuzzing. Lean proves properties about the model, not about the deployed bytecode.

Do not place high-value flows behind Ward without independent security review.

## Scope

**In scope:**

- `contracts/src/WardOracle.sol`
- `contracts/src/WardQueue.sol`
- `contracts/src/WardAgentRegistry.sol`
- `contracts/src/PolicyLib.sol`
- `contracts/src/PolicyNormalizer.sol`
- `contracts/src/PolicyTypes.sol`
- The integration helpers under `contracts/src/integration/`
- The TypeScript SDK in `sdk/src/` and the CLI in `cli/src/`

**Out of scope:**

- Test harnesses under `contracts/test/`.
- The reference integration under `examples/` (`CounterAgent`, `Counter`) —
  discussed in the trust model only because the assumptions it exposes apply to
  any integrator.
- Off-chain prompt-injection defence, MEV protection, gas-price oracles, and the
  upstream LLM. Ward validates calldata against a published policy; it does
  not interpret model output.

## Reporting a vulnerability

Found a vulnerability? Open a GitHub security advisory on this repository rather
than a public issue. For private disclosure, email the maintainer listed in the
repo metadata.

---

## Security model

Ward is a synchronous, no-custody on-chain policy oracle. It validates
calldata against a published policy and returns a decision. It does not
interpret intent, hold funds, or execute calls.

### What Ward addresses

The on-chain gate rejects calldata that violates the published policy. From
`WardOracle.checkIntent` and the `PolicyLib.validate` chain it drives:

- A `target` outside the policy's allow-list → `TARGET_NOT_ALLOWED`.
- An allowed target with a forbidden selector → `SELECTOR_NOT_ALLOWED`.
- Calldata whose first 4 bytes don't match the claimed `intent.selector` →
  `SELECTOR_MISMATCH`.
- Calldata shorter than 4 bytes → `BAD_CALLDATA`.
- `intent.value` over the per-call cap → `VALUE_CAP`.
- Cumulative spend over the per-day cap, **as reported by the asker** →
  `DAILY_CAP`.
- A paused or expired policy → `PAUSED` / `EXPIRED`, re-checked at
  `WardQueue.dispatch` (alongside a `policyVersion` equality check) so a
  queued intent cannot ship after the owner pulls the kill switch or edits the
  policy.
- Non-immediate tiers surfaced as a rejection rather than a silent pass:
  `TIER_DELAYED` → `(false, "REQUIRES_DELAY")`, `TIER_VETO_REQUIRED` →
  `(false, "REQUIRES_VETO")`, so a naive consumer cannot bypass the queue.

### What Ward deliberately does NOT address

- **Prompt injection at the LLM layer.** If the upstream model is jailbroken
  into producing wrong-but-policy-valid calldata, Ward lets it through.
  Ward validates calldata against a published policy; it does not interpret
  intent or model output. Mitigate upstream and keep policies narrow.
- **Compromised policy owner key.** The owner can `updatePolicy` to widen the
  surface, `veto` legitimate intents, or pause the policy entirely. Treat the
  owner key like any other privileged on-chain role.
- **Compromised asker contract / operator.** Ward cannot constrain an asker
  that lies about `spentToday`, fails to revoke approvals, or runs side effects
  outside the gate.
- **Reentrancy in the target.** `WardOracle` is pure-view and `WardQueue`
  never executes the call, so neither holds a `nonReentrant` guard — there is
  nothing to reenter. Reentrancy safety lives in the asker contract.
- **MEV / ordering attacks** on the eventual dispatch transaction.
- **Off-chain concerns** generally: prompt-injection defence, MEV protection,
  gas-price oracles, and the upstream LLM are all out of scope.

### Trust assumptions

Ward's safety rests on a small set of assumptions. Each is a place where the
gate's guarantee ends and yours begins.

- **Ward never holds funds.** `WardOracle` is pure-view (registry plus
  validators). `WardQueue` stores `Intent` metadata and state-machine
  transitions only; it neither receives `value` nor executes calls.
- **The policy owner is the on-chain authority.** The address that called
  `publishPolicy` — or accepted ownership via the two-step handoff
  (`transferPolicyOwnership` then `acceptPolicyOwnership`) — can update, pause,
  transfer, or veto. There is no role above the owner.
- **The asker contract is trusted by its operator.** Ward only gates the
  intents an asker submits; it cannot constrain what the asker does outside the
  gate (spend tracking, value handling, post-dispatch execution).
- **The caller executes after dispatch.** `WardQueue.dispatch` returns the
  `Intent` struct to the caller and emits `Dispatched`; the caller performs
  `target.call{value: i.value}(i.data)`. Ward never executes. If the asker
  forgets to execute, the intent is marked `Committed` but nothing ships.

Five assumptions are worth calling out individually because each is a sharp
edge for integrators:

1. **`WardQueue.dispatch` does not re-run `PolicyLib.validate`.** It does not
   re-check value caps, daily spend, the target allow-list, or the selector
   allow-list against the live policy. The only policy re-checks at dispatch
   time are `paused`, `expiresAt`, and a `policyVersion` equality check: `dispatch`
   reads `oracle.policyHealth` and compares `oracle.policyVersion(policyId)`
   against the version snapshotted at `enqueue`. If the owner edits the policy
   (any `updatePolicy`, narrowing or widening) between `enqueue` and `dispatch`,
   `policyVersion` no longer matches and `dispatch` reverts
   `PolicyChanged("UPDATED")` — the queued intent becomes undispatchable rather
   than shipping under stale validation. Spend/cap correctness for the original
   snapshot still remains the asker's responsibility, since `spentToday` is never
   re-read here.

2. **`updatePolicy` has no on-chain timelock.** Ownership transfer is two-step,
   but policy *content* updates take effect immediately and mutate the same
   `policyId` in place (`policies[policyId].copy(input)` in
   `updatePolicy`). Pinning a `policyId` therefore does **not** protect against
   in-place edits — the asker is pinned to that id and the bytes underneath
   change. Note that in-flight queued intents are not silently re-validated
   against the edited policy: `WardQueue.dispatch` snapshots `policyVersion`
   at enqueue and reverts `PolicyChanged("UPDATED")` if the policy was edited
   before dispatch (see assumption 1), so an edit invalidates queued intents
   rather than re-validating them. Mitigations: treat policies as immutable and
   `publishPolicy` a fresh `label` (new `policyId`) when a change is needed;
   watch `PolicyUpdated(policyId, owner)` events so operators re-enqueue or
   re-pin under the new policy after a change; or hold the owner key behind a
   timelocked multisig.

3. **`WardQueue.enqueue` is open to any caller.** Ward treats `msg.sender`
   as the `asker` and stores it; there is no per-policy asker allow-list. A
   hostile enqueue is still validated against the policy, so the worst it can do
   is create queue noise and (for `TIER_DELAYED`) leave a record only that
   hostile caller can later dispatch. For `TIER_VETO_REQUIRED` the owner must
   actively `dispatch`, so hostile enqueues are inert unless ratified. Operators
   who care should filter `Enqueued` events by `asker`.

4. **`spentToday` is tracked by the asker, not Ward.** Ward has no view into
   the asker's wallet balance or historical spend — the asker passes
   `spentToday` into `checkIntent`, `checkSelector`, and `enqueue`. A buggy
   asker that under-reports `spentToday` defeats the `DAILY_CAP` check. The
   contract surface assumes the asker is honest about its own ledger.

5. **`PolicyNotFound` is a revert, not a denial.** `checkIntent`,
   `checkSelector`, `tierAndDelay`, and `policyHealth` all revert
   `PolicyNotFound` for an unpublished `policyId` rather than returning
   `ok == false`, so a consumer cannot silently treat a misconfigured reference
   as "policy denied." A reference to the wrong id fails loudly.

### Example-contract foot-guns

The samples under `examples/` are reference integrations meant to be copied.
They are **not** vulnerabilities in `contracts/src/`, but the patterns they
demonstrate are exactly the patterns an integrator inherits. Watch for these
when adapting them:

- **Gate first, side-effect second.** A view-only `checkIntent` /
  `checkSelector` call costs nothing and reverts nothing on its own — so run it
  *before* any state change. The danger pattern is approve-before-gate: grant a
  router allowance, then check the policy, then bail on rejection while leaving
  a live allowance a malicious target could `transferFrom`. The correct
  ordering is to gate first and only grant the allowance once the gate passes,
  keeping approve+call an atomic pair. If your flow forces approve-first, reset
  the allowance to `0` on rejection or use a permit-style flow that ties
  approval to a single call. The surviving sample, `CounterAgent` in
  `examples/ward-counter/`, is single-outbound and uses the `wardGuarded`
  modifier so the gate runs before the call by construction — preserve that
  ordering when you add side effects.

- **`spentToday` accounting is the asker's job, and it is easy to get wrong.**
  If you increment a daily counter at enqueue time, a later `veto` or
  `expireIfStale` leaves the budget consumed until the next UTC-day rollover
  (`block.timestamp / 1 days`). Production integrators should either store
  per-`execId` `(enqueueDay, enqueueAmount)` and roll back on veto/expire, or
  knowingly accept the cap-consumed-until-midnight behaviour.

- **The day boundary is UTC.** Any per-day spend tracking uses
  `block.timestamp / 1 days`, which rolls over at 00:00 UTC. Integrators in
  non-UTC operations should expect that.

### Preflight is a UX layer, not a security boundary

The frontend-gating packages (e.g. `@ward/react` under
`packages/ward-react/`) run a Ward policy *preflight* before opening the
wallet. `useWardGuardedWrite` evaluates the policy locally, from a spec, or
via the on-chain oracle, then calls `writeContract` only if it passes. A rejected
preflight throws `WardPreflightRejectedError` and never shows a wallet prompt.

Preflight runs in the user's browser and can be bypassed by anyone who calls the
agent contract directly. The real gate is the on-chain `checkIntent` /
`checkSelector` call inside the agent, or the `wardGuarded` modifier that wraps
it. If that gate is missing from the contract, frontend preflight does not make
the flow safe.

---

## Contract invariants

Per-function preconditions, postconditions, and authorization for
`WardOracle` and `WardQueue`, lifted from the contract source.

This is a lookup reference. For the threat narrative behind these guarantees,
see [Security model](#security-model) above.

Source of truth: `contracts/src/WardOracle.sol`, `contracts/src/WardQueue.sol`,
`contracts/src/PolicyLib.sol`, `contracts/src/PolicyTypes.sol`. Solidity 0.8.26.

Convention used below:

- **Pre** — what must hold before the call, else the listed revert fires.
- **Post** — the observable state change after a successful call.
- **Auth** — who may call. "Anyone" means no caller restriction.

### Global invariants

These hold across every function in both contracts.

- **No custody.** Neither contract has a `payable` function, holds a balance, or forwards `value`. `WardOracle` is pure registry + view. `WardQueue` stores metadata and state only. The external `target.call{value: i.value}(i.data)` is always the caller's job after `dispatch` returns the `Intent`.
- **No execution.** Neither contract performs the gated external call. `checkIntent` / `checkSelector` are `view`; `dispatch` mutates state and returns the `Intent` struct but does not call into `target`.
- **Policy authority is the policy owner.** Every mutating `WardOracle` function except `publishPolicy` checks `policyOwner[policyId] == msg.sender`. There is no global admin and no contract owner.
- **`policyId` is content-addressed by publisher.** `policyId == keccak256(abi.encode(msg.sender, label))`. A given `(publisher, label)` pair maps to exactly one policy slot for the life of the contract.
- **Unknown `policyId` reverts, never silently denies.** Every oracle read except `policyIdFor` reverts `PolicyNotFound` when `policyOwner[policyId] == address(0)`, so a misconfigured reference cannot be misread as "policy denied".

### WardOracle per-function invariants

State touched: `policies` (private), `policyOwner`, `pendingPolicyOwner`, `policyVersion`. Errors: `NotPolicyOwner`, `NotPendingOwner`, `NoPendingTransfer`, `PolicyExists`, `PolicyNotFound`, `ZeroAddress`.

#### `publishPolicy(bytes32 label, PolicyInput input) → bytes32 policyId`

- **Auth:** anyone. `msg.sender` becomes the owner.
- **Pre:** `policyOwner[policyId] == address(0)` for the derived `policyId`, else revert `PolicyExists`. `input` must satisfy the normalizer bounds below, else `PolicyNormalizer.copy` reverts.
- **Post:** `policyOwner[policyId] = msg.sender`; policy content copied in; `policyVersion[policyId] = 1`. Emits `PolicyPublished(policyId, msg.sender, label)`.
- **Invariant:** `policyId == keccak256(abi.encode(msg.sender, label))` — equal to what `policyIdFor(msg.sender, label)` returns.

`PolicyInput` shape bounds enforced by `PolicyNormalizer.copy` (see the policy spec section in `SKILL.md`): `MAX_TARGETS = 20`, `MAX_SELECTORS_PER_TARGET = 10`. A zero-address target (`ZeroTarget`), a zero-value selector (`ZeroSelector`), a duplicate target (`DuplicateTarget`), a duplicate selector (`DuplicateSelector`), an out-of-range tier (`InvalidTier`), and `delaySeconds != 0` on a non-`TIER_DELAYED` tier (`InvalidDelay`) each revert with a named error; over-`MAX_TARGETS` reverts `TooManyTargets` and over-`MAX_SELECTORS_PER_TARGET` reverts `TooManySelectors`. Larger policies revert; they do not silently truncate. (An empty `targets` array or a target with no selectors does **not** revert — `copy` only validates the entries present.)

#### `updatePolicy(bytes32 policyId, PolicyInput input)`

- **Auth:** `policyOwner[policyId]` only, else revert `NotPolicyOwner`.
- **Pre:** `input` satisfies the normalizer bounds.
- **Post:** policy content replaced in place under the **same** `policyId`; `policyVersion[policyId] += 1`. Emits `PolicyUpdated(policyId, msg.sender)`.
- **Invariant:** `policyId` is unchanged — there is **no on-chain timelock** and pinning a `policyId` does not protect against in-place edits. The monotonically increasing `policyVersion` is the only on-chain signal of a content change, and `WardQueue.dispatch` keys its `UPDATED` re-check on it. To freeze content, never call `updatePolicy`; publish a fresh `label` instead. See the [Trust assumptions](#trust-assumptions) section above.

#### `transferPolicyOwnership(bytes32 policyId, address newOwner)`

- **Auth:** `policyOwner[policyId]` only, else revert `NotPolicyOwner`.
- **Pre:** `newOwner != address(0)`, else revert `ZeroAddress`.
- **Post:** `pendingPolicyOwner[policyId] = newOwner`. **Ownership does not change.** Emits `PolicyOwnershipTransferStarted(policyId, msg.sender, newOwner)`.
- **Invariant:** calling again overwrites any prior pending nominee. No effect on `policyOwner` until `acceptPolicyOwnership`.

#### `acceptPolicyOwnership(bytes32 policyId)`

- **Auth:** `pendingPolicyOwner[policyId]` only, else revert `NotPendingOwner`.
- **Pre:** a pending nominee equal to `msg.sender` exists (implied by the auth check; if none is set, `pending == address(0) != msg.sender` reverts `NotPendingOwner`).
- **Post:** `policyOwner[policyId] = msg.sender`; `pendingPolicyOwner[policyId]` deleted. Emits `PolicyOwnershipTransferred(policyId, previousOwner, msg.sender)`.
- **Invariant:** the previous owner immediately loses all update/transfer/veto rights. Ownership change is atomic with clearing the pending slot.

#### `cancelPolicyOwnershipTransfer(bytes32 policyId)`

- **Auth:** `policyOwner[policyId]` only, else revert `NotPolicyOwner`.
- **Pre:** `pendingPolicyOwner[policyId] != address(0)`, else revert `NoPendingTransfer`.
- **Post:** `pendingPolicyOwner[policyId]` deleted. Emits `PolicyOwnershipTransferCancelled(policyId, msg.sender, cancelledNominee)`.

#### `checkIntent(bytes32 policyId, Intent intent, uint256 spentToday) → (bool ok, bytes32 reason)` — `view`

- **Auth:** anyone.
- **Pre:** `policyOwner[policyId] != address(0)`, else revert `PolicyNotFound`.
- **Post:** none (pure view, no state change).
- **Invariant (safe-by-default):** returns `(true, bytes32(0))` **only** when (a) `PolicyLib.validate(intent, spentToday)` returns `ok == true`, **and** (b) the tier for `(intent.target, intent.selector)` is `TIER_IMMEDIATE`. Otherwise:
  - validation failure → `(false, <PolicyLib reason>)`.
  - `TIER_DELAYED` → `(false, "REQUIRES_DELAY")`.
  - `TIER_VETO_REQUIRED` → `(false, "REQUIRES_VETO")`.

  A naive consumer that only proceeds on `ok == true` therefore cannot dispatch a `DELAYED` or `VETO_REQUIRED` intent — it is forced through `WardQueue`.

`PolicyLib.validate` reason precedence, in evaluation order (first failing check wins):

| Order | Reason | Condition |
|---|---|---|
| 1 | `PAUSED` | `p.paused` |
| 2 | `EXPIRED` | `block.timestamp > p.expiresAt` |
| 3 | `BAD_CALLDATA` | `i.data.length < 4` |
| 4 | `SELECTOR_MISMATCH` | first 4 bytes of `i.data` != `i.selector` |
| 5 | `TARGET_NOT_ALLOWED` | target not in allow-list |
| 6 | `SELECTOR_NOT_ALLOWED` | selector not allowed for that target |
| 7 | `VALUE_CAP` | `i.value > valueCapPerCall[target][selector]` |
| 8 | `DAILY_CAP` | `spentToday > dailySpendWeiCap` OR `i.value > dailySpendWeiCap - spentToday` |

This precedence is property-tested (`test/properties/PolicyLibProperties.t.sol`).

#### `checkSelector(bytes32 policyId, address target, bytes4 selector, uint256 value, uint256 spentToday) → (bool ok, bytes32 reason)` — `view`

- **Auth:** anyone.
- **Pre:** `policyOwner[policyId] != address(0)`, else revert `PolicyNotFound`.
- **Post:** none.
- **Invariant:** calldata-less variant of `checkIntent`. Internally synthesizes an `Intent` with `data = abi.encodePacked(selector)` (so `BAD_CALLDATA` and `SELECTOR_MISMATCH` cannot fire) and the remaining intent fields zeroed (`agentId`, `requestId`, `promptHash`, `taskClass`). Same tier handling and same safe-by-default guarantee as `checkIntent`. This is the function the `wardGuarded` modifier on `WardAgentBase` uses.

#### `tierAndDelay(bytes32 policyId, address target, bytes4 selector) → (uint8 tier, uint32 delaySeconds)` — `view`

- **Auth:** anyone.
- **Pre:** `policyOwner[policyId] != address(0)`, else revert `PolicyNotFound`.
- **Invariant:** returns the configured `tier` and `delaySeconds` for the pair. Use to distinguish "policy denied" from "policy requires queueing" and to size a queue window. `WardQueue.enqueue` reads it to compute `earliestCommitAt`.

#### `policyHealth(bytes32 policyId) → (bool paused, uint64 expiresAt)` — `view`

- **Auth:** anyone.
- **Pre:** `policyOwner[policyId] != address(0)`, else revert `PolicyNotFound`.
- **Invariant:** returns only the kill-switch fields. Designed for `WardQueue.dispatch` re-validation, where the dispatcher (the policy owner for `VETO_REQUIRED`) may lack the asker's `spentToday` and so cannot re-run a full `checkIntent`.

#### `policyIdFor(address publisher, bytes32 label) → bytes32` — `pure`

- **Auth:** anyone. The only oracle read that does **not** revert `PolicyNotFound` (it is pure and touches no state).
- **Invariant:** returns `keccak256(abi.encode(publisher, label))` — the `policyId` that `publishPolicy` would assign for that pair. Off-chain helper for deriving the canonical id before publishing.

### WardQueue per-function invariants

`WardQueue` is a metadata + state-machine + audit-trail contract bound to one immutable `oracle` (set in the constructor). It holds no funds and executes no calls.

#### State machine

```
State.None ──enqueue──▶ State.Pending ──dispatch──▶ State.Committed
                              │
                              ├──veto──▶ State.Vetoed
                              │
                              └──expireIfStale──▶ State.Expired
```

`State.Pending` is the only state from which a transition is possible. `Committed`, `Vetoed`, and `Expired` are terminal. Every transition guards `q.state != State.Pending` with revert `NotPending`, so each `execId` transitions at most once.

`COMMIT_WINDOW_SECONDS = 7 days`, hard-coded. `nextExecId` starts at `1` and increments per `enqueue`; `execId == 0` is never assigned (slot is permanently `State.None`).

Errors: `NotPending`, `TooEarly`, `PastDeadline`, `NotAuthorizedDispatcher`, `NotPolicyOwner`, `NotQueueable(bytes32 reason)`, `PolicyChanged(bytes32 reason)`.

#### `enqueue(bytes32 policyId, Intent intent, uint256 spentToday) → uint256 execId`

- **Auth:** anyone. `msg.sender` is stored as `asker`. (There is no per-policy asker allow-list; a hostile enqueue is inert — `DELAYED` records are only dispatchable by that same hostile caller, and `VETO_REQUIRED` records require the policy owner to ratify. Filter `Enqueued` by `asker`.)
- **Pre:** `oracle.checkIntent(policyId, intent, spentToday)` must return `ok == false` with `reason ∈ {"REQUIRES_DELAY", "REQUIRES_VETO"}`. `ok == true` reverts `NotQueueable("IMMEDIATE_NO_QUEUE_NEEDED")`; any other reason reverts `NotQueueable(reason)`. (Inherits `checkIntent`'s `PolicyNotFound` revert for unknown `policyId`.)
- **Post:** allocates `execId = nextExecId++` and writes a `QueuedIntent` with `state = State.Pending`, storing the full `intent`, the `asker`, the `tier` and `policyVersion` read from the oracle, and:
  - `enqueuedAt = block.timestamp`
  - `earliestCommitAt = block.timestamp + delaySeconds`
  - `deadline = earliestCommitAt + COMMIT_WINDOW_SECONDS` (i.e. `+ 7 days`)

  Emits `Enqueued(execId, policyId, asker, tier, earliestCommitAt, deadline, keccak256(intent.data))`.
- **Invariant:** the recorded `policyVersion` pins the policy content snapshot at enqueue time; `dispatch` later compares against the live version.

#### `dispatch(uint256 execId) → Intent intent`

- **Auth (split by tier):**
  - `TIER_VETO_REQUIRED` → `msg.sender == oracle.policyOwner(q.policyId)`, else revert `NotPolicyOwner`. "No veto" alone does not ship the intent; the owner must actively dispatch.
  - any other tier (`TIER_DELAYED`) → `msg.sender == q.asker`, else revert `NotAuthorizedDispatcher`. The delay is the confidence interval; there is no separate human-consent step.
- **Pre (in order, via `_checkDispatchAuthorized` then `_checkPolicyStillActive`):**
  1. `q.state == State.Pending`, else revert `NotPending`.
  2. `block.timestamp >= q.earliestCommitAt`, else revert `TooEarly`.
  3. `block.timestamp <= q.deadline`, else revert `PastDeadline`.
  4. tier-based authorization (above).
  5. policy still active: `oracle.policyHealth(q.policyId)` must report `paused == false` (else revert `PolicyChanged("PAUSED")`) and `block.timestamp <= expiresAt` (else revert `PolicyChanged("EXPIRED")`); and `oracle.policyVersion(q.policyId) == q.policyVersion`, else revert `PolicyChanged("UPDATED")`.
- **Post:** `q.state = State.Committed`. Returns `q.intent` for the caller to execute. Emits `Dispatched(execId, msg.sender, q.policyId, keccak256(abi.encode(intent)))`.
- **Invariant — what `dispatch` does NOT re-check:** it does **not** re-run `PolicyLib.validate`, so it does not re-check value caps, daily spend, target allow-list, or selector allow-list. The only policy re-checks are `paused`, `expiresAt`, and the `policyVersion` equality. A policy *content* edit between enqueue and dispatch is caught by the `UPDATED` version check (the queued intent becomes undispatchable), but spend/cap correctness for the original snapshot remains the asker's responsibility — `spentToday` is supplied by the asker and never re-read here. See the [Trust assumptions](#trust-assumptions) section above.
- **Invariant — caller executes:** `dispatch` returns the `Intent` and emits `Dispatched`; it performs no external call. If the caller never executes `target.call{value: i.value}(i.data)`, the record stays `Committed` and nothing ships. A second `dispatch` of the same `execId` reverts `NotPending`.

#### `veto(uint256 execId, bytes32 reason)`

- **Auth:** `msg.sender == oracle.policyOwner(q.policyId)` only, else revert `NotPolicyOwner`.
- **Pre:** `q.state == State.Pending`, else revert `NotPending`.
- **Post:** `q.state = State.Vetoed` (terminal). Emits `Vetoed(execId, q.policyId, reason)`.
- **Invariant:** veto reads the **current** `oracle.policyOwner`, so a post-enqueue ownership transfer moves veto authority to the new owner. No time bound — a pending intent can be vetoed any time before it is dispatched or expired.

#### `expireIfStale(uint256 execId)`

- **Auth:** anyone.
- **Pre:** `q.state == State.Pending`, else revert `NotPending`; **and** `block.timestamp > q.deadline`, else revert `TooEarly`.
- **Post:** `q.state = State.Expired` (terminal). Emits `Expired(execId, q.policyId)`.
- **Invariant:** the only permissionless state transition. It cannot fire before `deadline`, and once a record is `Committed`/`Vetoed` it is unreachable.

#### `getRecord(uint256 execId) → QueuedIntent` / `getRecordHeader(uint256 execId) → RecordHeader` — `view`

- **Auth:** anyone.
- **Pre:** none. An unused `execId` returns a zero-valued struct (`state == State.None`); these reads never revert.
- **Invariant:** `getRecord` returns the full struct including `intent.data`; `getRecordHeader` returns every fixed-size field (including `target`, `selector`, `value`, `requestId`) but omits the unbounded `intent.data`, for cheap filtering. Audit-trail reads only — no state change.
