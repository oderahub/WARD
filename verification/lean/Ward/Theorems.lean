import Ward.PolicyLib
import Ward.Queue

/-!
# Ward.Theorems

Ten theorems pinning down the on-chain semantics:
  - Five mirror `PolicyLib.validate` precedence and monotonicity.
  - Three mirror the `WardQueue` state-machine timing properties.
  - Two (T9a, T9b) mirror the 2-step `transferPolicyOwnership` /
    `acceptPolicyOwnership` handoff in `WardOracle`.

Stdlib only (no Mathlib).
-/

namespace Ward.PolicyLib

open Ward

/-- T1: paused policies always reject with PAUSED, regardless of every other input. -/
theorem validate_paused_takes_precedence
    (p : Policy) (i : Intent) (spent now : Nat)
    (hp : p.paused = true) :
    validate p i spent now = (false, Reason.PAUSED) := by
  unfold validate
  simp [hp]

/-- T2: when not paused, an expired policy always rejects with EXPIRED. -/
theorem validate_expired_takes_precedence
    (p : Policy) (i : Intent) (spent now : Nat)
    (hp : p.paused = false)
    (hexp : now > p.expiresAt) :
    validate p i spent now = (false, Reason.EXPIRED) := by
  unfold validate
  simp [hp, hexp]

/-- T3: when not paused/expired, calldata well-formed and selector matches,
    but the target is not in the policy → TARGET_NOT_ALLOWED. -/
theorem validate_target_not_allowed_implies_false
    (p : Policy) (i : Intent) (spent now : Nat)
    (hp : p.paused = false)
    (hexp : ¬ (now > p.expiresAt))
    (hlen : i.data.length ≥ 4)
    (hsel : selectorOf i.data = some i.selector)
    (hnotgt : p.isTargetAllowed i.target = false) :
    validate p i spent now = (false, Reason.TARGET_NOT_ALLOWED) := by
  unfold validate
  have hlen' : ¬ (i.data.length < 4) := Nat.not_lt.mpr hlen
  simp [hp, hexp, hlen', hsel, hnotgt]

/-- T4: when all earlier checks pass, intent.value above per-call cap → VALUE_CAP. -/
theorem validate_value_cap_strict
    (p : Policy) (i : Intent) (spent now : Nat)
    (hp : p.paused = false)
    (hexp : ¬ (now > p.expiresAt))
    (hlen : i.data.length ≥ 4)
    (hsel : selectorOf i.data = some i.selector)
    (htgt : p.isTargetAllowed i.target = true)
    (hsela : p.isSelectorAllowed i.target i.selector = true)
    (hval : i.value > p.valueCap i.target i.selector) :
    validate p i spent now = (false, Reason.VALUE_CAP) := by
  unfold validate
  have hlen' : ¬ (i.data.length < 4) := Nat.not_lt.mpr hlen
  simp [hp, hexp, hlen', hsel, htgt, hsela, hval]

/-- Helper: the only `spentToday`-dependent part of `validate` is the daily-cap
    check; we factor out the rest into a single boolean predicate so we can
    reason about monotonicity cleanly. -/
private def passesNonCap (p : Policy) (i : Intent) (now : Nat) : Bool :=
  ¬ p.paused
    ∧ ¬ (now > p.expiresAt)
    ∧ ¬ (i.data.length < 4)
    ∧ selectorOf i.data = some i.selector
    ∧ p.isTargetAllowed i.target
    ∧ p.isSelectorAllowed i.target i.selector
    ∧ ¬ (i.value > p.valueCap i.target i.selector)

/-- T5: if validate succeeds at `spentToday = s`, it succeeds at any `s' ≤ s`.
    The daily-cap check is the only place `spentToday` appears, and lowering
    `spentToday` can only widen the remaining budget. -/
theorem validate_monotone_in_spentToday
    (p : Policy) (i : Intent) (s s' now : Nat) (h : s' ≤ s)
    (hok : (validate p i s now).1 = true) :
    (validate p i s' now).1 = true := by
  -- Unfold both calls and split on the entire chain of `if`s.
  unfold validate at hok ⊢
  by_cases hpaused : p.paused = true
  · simp [hpaused] at hok
  · have hpaused' : p.paused = false := by
      cases hpb : p.paused with
      | true => exact absurd hpb hpaused
      | false => rfl
    simp [hpaused'] at hok ⊢
    by_cases hexp : now > p.expiresAt
    · simp [hexp] at hok
    · simp [hexp] at hok ⊢
      by_cases hlen : i.data.length < 4
      · simp [hlen] at hok
      · simp [hlen] at hok ⊢
        cases hsel : selectorOf i.data with
        | none => simp [hsel] at hok
        | some sv =>
          simp [hsel] at hok ⊢
          by_cases hmatch : sv = i.selector
          · simp [hmatch] at hok ⊢
            by_cases htgt : p.isTargetAllowed i.target = true
            · simp [htgt] at hok ⊢
              by_cases hsela : p.isSelectorAllowed i.target i.selector = true
              · simp [hsela] at hok ⊢
                by_cases hvcap : i.value > p.valueCap i.target i.selector
                · simp [hvcap] at hok
                · simp [hvcap] at hok ⊢
                  -- Only the daily-cap check remains. After simp it appears
                  -- with `<` rewritten from `>`.
                  by_cases hcap_s : p.dailyCap < s ∨ p.dailyCap - s < i.value
                  · simp [hcap_s] at hok
                  · -- hcap_s false ⇒ s ≤ dailyCap ∧ value ≤ dailyCap - s
                    have hcap_s_split :
                        ¬ (p.dailyCap < s) ∧ ¬ (p.dailyCap - s < i.value) := by
                      constructor
                      · intro hbad
                        exact hcap_s (Or.inl hbad)
                      · intro hbad
                        exact hcap_s (Or.inr hbad)
                    have hs_le : s ≤ p.dailyCap := Nat.not_lt.mp hcap_s_split.1
                    have hv_le : i.value ≤ p.dailyCap - s := Nat.not_lt.mp hcap_s_split.2
                    have hs'_le : s' ≤ p.dailyCap := Nat.le_trans h hs_le
                    have hbudget : p.dailyCap - s ≤ p.dailyCap - s' :=
                      Nat.sub_le_sub_left h _
                    have hv_le' : i.value ≤ p.dailyCap - s' := Nat.le_trans hv_le hbudget
                    have hnot_s' : ¬ (p.dailyCap < s') := Nat.not_lt.mpr hs'_le
                    have hnot_v' : ¬ (p.dailyCap - s' < i.value) := Nat.not_lt.mpr hv_le'
                    have hcap_s'_false :
                        ¬ (p.dailyCap < s' ∨ p.dailyCap - s' < i.value) := by
                      intro hbad
                      cases hbad with
                      | inl hl => exact hnot_s' hl
                      | inr hr => exact hnot_v' hr
                    simp [hcap_s'_false]
              · have : p.isSelectorAllowed i.target i.selector = false := by
                  cases hb : p.isSelectorAllowed i.target i.selector with
                  | true => exact absurd hb hsela
                  | false => rfl
                simp [this] at hok
            · have : p.isTargetAllowed i.target = false := by
                cases hb : p.isTargetAllowed i.target with
                | true => exact absurd hb htgt
                | false => rfl
              simp [this] at hok
          · simp [hmatch] at hok

end Ward.PolicyLib


namespace Ward.Queue

/-- T6: dispatch BEFORE the delay elapses returns TOO_EARLY. -/
theorem dispatch_too_early
    (delay window now t : Nat)
    (ht : t < now + delay) :
    dispatch (enqueue delay window now) t = DispatchResult.err QReason.TOO_EARLY := by
  unfold enqueue dispatch
  simp [ht]

/-- T7: dispatch within `[earliestCommitAt, deadline]` returns ok with state COMMITTED. -/
theorem dispatch_in_window
    (delay window now t : Nat)
    (h1 : t ≥ now + delay)
    (h2 : t ≤ now + delay + window) :
    match dispatch (enqueue delay window now) t with
    | DispatchResult.ok q' => q'.state = QState.COMMITTED
    | _                    => False := by
  unfold enqueue dispatch
  have hnot_early : ¬ (t < now + delay) := Nat.not_lt.mpr h1
  have hnot_late  : ¬ (now + delay + window < t) := Nat.not_lt.mpr h2
  simp [hnot_early, hnot_late]

/-- T8: after `veto`, `dispatch` always returns NOT_PENDING regardless of timing. -/
theorem dispatch_after_veto_fails
    (delay window now t : Nat) :
    dispatch (veto (enqueue delay window now)) t = DispatchResult.err QReason.NOT_PENDING := by
  unfold enqueue veto dispatch
  simp

end Ward.Queue


namespace Ward.Ownership

/-! Minimal model of `WardOracle.policyOwner` / `pendingPolicyOwner` and the
    two-step `transferPolicyOwnership` → `acceptPolicyOwnership` handoff. Only
    ownership state matters here; the policy payload is irrelevant to the
    access-control property we want to pin. -/

abbrev Addr := Nat

/-- Ownership state: current owner + optional pending nominee. -/
structure OwnerState where
  owner   : Addr
  pending : Option Addr
  deriving DecidableEq

/-- `transferPolicyOwnership` mirror (step 1): only the current owner may
    nominate, and zero-address (modeled as `0`) nominations are rejected.
    On success the nominee is recorded in `pending`; `owner` is unchanged. -/
def transferOwnership (s : OwnerState) (caller newOwner : Addr) : Option OwnerState :=
  if caller ≠ s.owner then none
  else if newOwner = 0 then none
  else some { owner := s.owner, pending := some newOwner }

/-- `acceptPolicyOwnership` mirror (step 2): only the pending nominee may
    accept. On success `owner` becomes the nominee and `pending` is cleared. -/
def acceptOwnership (s : OwnerState) (caller : Addr) : Option OwnerState :=
  match s.pending with
  | none      => none
  | some p    => if caller ≠ p then none
                 else some { owner := p, pending := none }

/-- `updatePolicy` access check: succeeds iff caller equals the owner. -/
def canUpdate (owner caller : Addr) : Bool := decide (caller = owner)

/-- T9a: after step 1 alone the owner is unchanged — the old owner can still
    update, the nominee cannot yet. This pins the two-step semantics. -/
theorem transferOwnership_alone_doesNotChangeOwner
    (oldOwner newOwner : Addr)
    (hnz : newOwner ≠ 0) :
    (transferOwnership { owner := oldOwner, pending := none } oldOwner newOwner).map (·.owner)
      = some oldOwner := by
  unfold transferOwnership
  simp [hnz]

/-- T9b: after step 1 then step 2 by the pending nominee, the previous owner
    can no longer pass the `updatePolicy` access check. -/
theorem pendingOwner_can_accept_then_owner_changes
    (oldOwner newOwner : Addr)
    (hne : oldOwner ≠ newOwner)
    (hnz : newOwner ≠ 0) :
    ∃ s', transferOwnership { owner := oldOwner, pending := none } oldOwner newOwner = some s'
        ∧ (acceptOwnership s' newOwner).map (·.owner) = some newOwner
        ∧ canUpdate newOwner oldOwner = false := by
  refine ⟨{ owner := oldOwner, pending := some newOwner }, ?_, ?_, ?_⟩
  · unfold transferOwnership; simp [hnz]
  · unfold acceptOwnership; simp
  · unfold canUpdate; exact decide_eq_false hne

end Ward.Ownership
