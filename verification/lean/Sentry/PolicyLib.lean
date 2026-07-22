import Sentry.Basic

/-!
# Sentry.PolicyLib

Mirror of `contracts/src/PolicyLib.sol::validate`.

`now` plays the role of `block.timestamp`; `spentToday` is whatever the vault's
24-hour spending tracker reports for the caller.
-/

namespace Sentry.PolicyLib

open Sentry

def validate (p : Policy) (i : Intent) (spentToday : Nat) (now : Nat) : Bool × Reason :=
  if p.paused then (false, Reason.PAUSED)
  else if now > p.expiresAt then (false, Reason.EXPIRED)
  else if i.data.length < 4 then (false, Reason.BAD_CALLDATA)
  else
    match selectorOf i.data with
    | none => (false, Reason.BAD_CALLDATA)
    | some s =>
      if s ≠ i.selector then (false, Reason.SELECTOR_MISMATCH)
      else if ¬ p.isTargetAllowed i.target then (false, Reason.TARGET_NOT_ALLOWED)
      else if ¬ p.isSelectorAllowed i.target i.selector then (false, Reason.SELECTOR_NOT_ALLOWED)
      else if i.value > p.valueCap i.target i.selector then (false, Reason.VALUE_CAP)
      else if spentToday > p.dailyCap ∨ i.value > p.dailyCap - spentToday then (false, Reason.DAILY_CAP)
      else (true, Reason.OK)

end Sentry.PolicyLib
