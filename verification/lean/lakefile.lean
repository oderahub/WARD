import Lake
open Lake DSL

package «sentry» where

lean_lib «Sentry» where
  -- no Mathlib; stdlib only

@[default_target]
lean_exe «sentry-verify» where
  root := `Main
