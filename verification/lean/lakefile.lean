import Lake
open Lake DSL

package «ward» where

lean_lib «Ward» where
  -- no Mathlib; stdlib only

@[default_target]
lean_exe «ward-verify» where
  root := `Main
