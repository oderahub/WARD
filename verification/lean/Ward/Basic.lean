/-!
# Ward.Basic

Core types mirroring `contracts/src/PolicyTypes.sol`.

These are deliberately simple Lean representations: addresses and selectors are
`Nat`, calldata is a byte list, and policy lookup uses linear-scan `List`
helpers instead of the EVM mapping layout. Only decidable equality matters here;
the actual bit layout is irrelevant to the policy-validation semantics that
`PolicyLib.validate` exercises.
-/

namespace Ward

abbrev Address := Nat
abbrev Selector := Nat
abbrev Calldata := List Nat

/-- Extract the 4-byte selector from a calldata byte list, big-endian. -/
def selectorOf (data : Calldata) : Option Selector :=
  if data.length < 4 then none
  else some (data.take 4 |>.foldl (fun acc b => acc * 256 + b) 0)

inductive Tier : Type
  | IMMEDIATE
  | DELAYED
  | VETO_REQUIRED
deriving DecidableEq, Repr

/-- Reason codes emitted by `PolicyLib.validate`. Mirror of the `bytes32`
constants in the Solidity source. -/
inductive Reason : Type
  | OK
  | PAUSED
  | EXPIRED
  | BAD_CALLDATA
  | SELECTOR_MISMATCH
  | TARGET_NOT_ALLOWED
  | SELECTOR_NOT_ALLOWED
  | VALUE_CAP
  | DAILY_CAP
deriving DecidableEq, Repr

structure SelectorEntry where
  selector : Selector
  valueCap : Nat
  tier : Tier
  delaySeconds : Nat
deriving Repr

structure TargetEntry where
  addr : Address
  entries : List SelectorEntry
deriving Repr

structure Policy where
  targets : List TargetEntry
  dailyCap : Nat
  expiresAt : Nat
  paused : Bool
deriving Repr

structure Intent where
  target : Address
  selector : Selector
  value : Nat
  data : Calldata
deriving Repr

/-- Pure lookup helpers; total by construction. -/

def Policy.isTargetAllowed (p : Policy) (a : Address) : Bool :=
  p.targets.any (fun t => decide (t.addr = a))

def Policy.lookupSelector (p : Policy) (a : Address) (s : Selector) : Option SelectorEntry :=
  (p.targets.find? (fun t => decide (t.addr = a)))
    |>.bind (fun t => t.entries.find? (fun e => decide (e.selector = s)))

def Policy.valueCap (p : Policy) (a : Address) (s : Selector) : Nat :=
  (p.lookupSelector a s).map (·.valueCap) |>.getD 0

def Policy.isSelectorAllowed (p : Policy) (a : Address) (s : Selector) : Bool :=
  (p.lookupSelector a s).isSome

end Ward
