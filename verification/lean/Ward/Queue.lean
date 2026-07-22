import Ward.Basic

/-!
# Ward.Queue

Mathematical model of `WardQueue.sol`'s state machine. Models only the
state transitions — authorization (asker vs policyOwner), policy re-validation
at dispatch, and event emission are out of scope (covered by 20 Foundry tests
in `contracts/test/WardQueue.t.sol`).

The on-chain queue rejects dispatch when state ≠ Pending, when `t` is outside
`[earliestCommitAt, deadline]`, or when the policy was paused/expired since
enqueue. This model captures the first two; pause/expiry post-enqueue is a
policy-layer concern not a queue-layer one.
-/

namespace Ward.Queue

inductive QState : Type
  | NONE
  | PENDING
  | COMMITTED
  | VETOED
  | EXPIRED
deriving DecidableEq, Repr

inductive QReason : Type
  | OK
  | NOT_PENDING
  | TOO_EARLY
  | PAST_DEADLINE
deriving DecidableEq, Repr

structure Queued where
  earliestCommitAt : Nat
  deadline : Nat
  state : QState
deriving Repr

inductive DispatchResult : Type
  | ok (q : Queued)
  | err (r : QReason)
deriving Repr

/-- Empty record (used as the pre-enqueue zero state). -/
def empty : Queued := { earliestCommitAt := 0, deadline := 0, state := QState.NONE }

/-- Mirror of `WardQueue.enqueue` (state transitions only). -/
def enqueue (delay window now : Nat) : Queued :=
  { earliestCommitAt := now + delay
  , deadline := now + delay + window
  , state := QState.PENDING }

/-- Mirror of `WardQueue.dispatch` (state + timing checks only). -/
def dispatch (q : Queued) (now : Nat) : DispatchResult :=
  match q.state with
  | QState.PENDING =>
    if now < q.earliestCommitAt then DispatchResult.err QReason.TOO_EARLY
    else if now > q.deadline    then DispatchResult.err QReason.PAST_DEADLINE
    else DispatchResult.ok { q with state := QState.COMMITTED }
  | _ => DispatchResult.err QReason.NOT_PENDING

/-- Mirror of `WardQueue.veto` (Pending → Vetoed; no-op on terminal states
    matches the on-chain revert via NotPending — captured by `dispatch_after_veto_fails`). -/
def veto (q : Queued) : Queued :=
  match q.state with
  | QState.PENDING => { q with state := QState.VETOED }
  | _ => q

end Ward.Queue
