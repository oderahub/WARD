# Contributing to Sentry

How to set up the monorepo, build and test each workspace, and follow the docs conventions.

This is a how-to for contributors who are already oriented on what Sentry is. For the product overview, start at the [README](README.md); for a first run, see the [CLI + TUI quickstart in the README](README.md#quickstart--cli--tui).

## Prerequisites

- **Node** `>=20` (`engines.node` in `package.json`; `.nvmrc` pins `20`).
- **pnpm** `10.33.0` (`packageManager` in `package.json`). Use `corepack enable` to get the pinned version.
- **Foundry** (`forge`) for the `contracts/` workspace. Install via [`foundryup`](https://book.getfoundry.sh/getting-started/installation). The pinned solc is `0.8.26` (`contracts/foundry.toml`).
- **Lean 4 / `lake`** only if you touch `verification/lean/` — see [`verification/lean/README.md`](verification/lean/README.md).

## Repo layout: the workspaces

This is a pnpm workspace. The members are declared in `pnpm-workspace.yaml`:

| Path | Package name | What it is |
|---|---|---|
| `contracts/` | `@sentry-somnia/contracts` | Foundry — `SentryOracle`, `SentryQueue`, `SentryAgentRegistry`, `PolicyLib`, `PolicyNormalizer`, `PolicyTypes`, and the `SentryAgentBase` / `SentryCall` integration helpers |
| `sdk/` | `@sentry-somnia/sdk` | TypeScript — POLICY.md compiler, `PolicyBuilder`, ABIs, oracle-client, queue-client, event-store |
| `cli/` | `@sentry-somnia/cli` | TypeScript — the single `sentry` binary (guided menu + direct commands) |
| `policy-spec/` | `@sentry-somnia/policy-spec` | POLICY.md format spec + worked example (no build/test scripts) |
| `dashboard/` | `@sentry-somnia/dashboard` | React + viem — browser queue console |
| `tui/` | `@sentry-somnia/tui` | ink — operator terminal monitor; `--json` NDJSON pipe mode |
| `packages/create-sentry-agent/` | `create-sentry-agent` | `pnpm create` scaffolder for new `SentryAgentBase`-derived Foundry projects |
| `packages/sentry-react/` | `@sentry-somnia/react` | React hooks for front-end policy gating |
| `packages/sentry-vite/` | `@sentry-somnia/vite-plugin` | Vite plugin for front-end policy gating |
| `examples/sentry-react-app/` | `sentry-react-app-example` | React + wagmi demo gating a `CounterAgent` write |

Not pnpm workspaces but part of the repo: `verification/lean/` (Lean 4 model, built with `lake`), `design/` (brand assets), `scripts/` (root tooling), and `examples/sentry-counter/` (the canonical Solidity sample). Standalone documentation now lives at the repo root (`README.md`, `SKILL.md`, `SECURITY.md`, `sdk/README.md`, `verification/lean/README.md`) rather than under a `docs/` tree.

## Dev setup

`forge-std` is a git submodule (`contracts/lib/forge-std`, declared in `.gitmodules`), so the recursive init is required before contracts will build.

```bash
# 1. clone with submodules, or init them after the fact
git submodule update --init --recursive

# 2. install all workspace dependencies
pnpm install

# 3. build the SDK + CLI (the rest depend on these)
pnpm -C sdk run build
pnpm -C cli run build

# 4. build the contracts
pnpm -C contracts exec forge build

# 5. wallet env — copy the template and paste a funded testnet key
cp .env.example .env   # then edit PRIVATE_KEY / DEPLOYER_PK
```

### Build order

`sdk` is the dependency root: the `cli`, `dashboard`, `tui`, `sentry-react`, `sentry-vite`, and the example app all consume `@sentry-somnia/sdk`. Build it first, then `cli`, then anything else. The example app encodes this dependency explicitly — its `predev` / `prebuild` / `pretest` hooks run `pnpm -F @sentry-somnia/sdk build && pnpm -F @sentry-somnia/react build` before its own commands.

To build every workspace at once (each runs its own `build` script if present):

```bash
pnpm build   # → pnpm -r --if-present run build
```

### Environment

`.env` is gitignored; copy `.env.example` and fill the slots. The required keys (from `.env.example`):

- `PRIVATE_KEY` — funded Somnia Shannon testnet key, used by the CLI write paths.
- `DEPLOYER_PK` — same key, named for `forge script ... --private-key $DEPLOYER_PK`. May equal `PRIVATE_KEY`; if you set only one, copy it to the other before running deploy scripts.
- `SOMNIA_TESTNET_RPC` — defaults to `https://dream-rpc.somnia.network`.
- `SENTRY_ORACLE` / `SENTRY_QUEUE` — the canonical live deployments (`0x3C7bF90f243d670a01f512221d9546e09fEaCC9c` / `0xFB715A37951Fc8dcc920120768e91f7C8bbA54c4`); leave as-is unless you re-deploy a fork.
- `SOMNIA_EXPLORER_KEY` — optional, only for contract verification against the Shannon explorer.

Forge scripts pick up `DEPLOYER_PK` from the shell, so `set -a; source .env; set +a` before bare `forge` invocations.

## Build & test

### Per-workspace commands

Run a single workspace's script with `pnpm -C <dir> run <script>` (or `pnpm -F <package-name> run <script>`):

| Workspace | Build | Test | Typecheck |
|---|---|---|---|
| `contracts/` | `pnpm -C contracts run build` (`forge build --sizes`) | `pnpm -C contracts run test` (`forge test -vvv`) | — |
| `sdk/` | `pnpm -C sdk run build` | `pnpm -C sdk run test` (`vitest run`) | `pnpm -C sdk run typecheck` |
| `cli/` | `pnpm -C cli run build` | `pnpm -C cli run test` (`vitest run`) | — |
| `dashboard/` | `pnpm -C dashboard run build` | `pnpm -C dashboard run test` (`vitest --run`) | `pnpm -C dashboard run typecheck` |
| `tui/` | `pnpm -C tui run build` | `pnpm -C tui run test` (no tests yet) | `pnpm -C tui run typecheck` |
| `packages/create-sentry-agent/` | `pnpm -C packages/create-sentry-agent run build` | `pnpm -C packages/create-sentry-agent run test` (`vitest run`) | — |
| `packages/sentry-react/` | `pnpm -C packages/sentry-react run build` | `pnpm -C packages/sentry-react run test` (`vitest run`) | `pnpm -C packages/sentry-react run typecheck` |
| `packages/sentry-vite/` | `pnpm -C packages/sentry-vite run build` | `pnpm -C packages/sentry-vite run test` (`vitest run`) | `pnpm -C packages/sentry-vite run typecheck` |
| `examples/sentry-react-app/` | `pnpm -C examples/sentry-react-app run build` | `pnpm -C examples/sentry-react-app run test` (`vitest run`) | `pnpm -C examples/sentry-react-app run typecheck` |

### Root commands

| Command | Runs |
|---|---|
| `pnpm build` | `pnpm -r --if-present run build` |
| `pnpm test` | `pnpm -r --if-present run test` (note: test files are not shipped in the public repo; missing-test-file output is tolerated) |
| `pnpm lint` | `pnpm -r --if-present run lint` |
| `pnpm lint:docs` | `node scripts/check-doc-launchers.mjs` |
| `pnpm forge:build` | `forge build --sizes` in `contracts/` |
| `pnpm forge:test` | `forge test -vvv` in `contracts/` |
| `pnpm forge:fmt` | `forge fmt` in `contracts/` |
| `pnpm audit:prod` | `pnpm audit --prod` (with the configured CVE ignore) |
| `pnpm quickstart` | builds `sdk` + `cli` + `dashboard`, then `dashboard` preview |

### Test floors

Changes must not drop test counts below these floors. The current surface (from the [`CHANGELOG.md`](CHANGELOG.md) v0.12.0 "Test surface" section):

- **Foundry:** 133+ tests across `PolicyLib` / `PolicyNormalizer` / `SentryOracle` / `SentryQueue` / `SentryAgentBase` / `QueueAgentBase` / `PublishAndBind` + property suites.
- **SDK:** 196 vitest cases.
- **dashboard:** 485 vitest cases.
- **CLI:** 72 vitest cases.
- **sentry-react:** 31 vitest cases.
- **sentry-vite:** 7 vitest cases.
- **create-sentry-agent:** 26 vitest cases.
- **examples/sentry-react-app:** 1 vitest case.
- **Lean 4:** 10 theorems machine-checked at `lake build`, zero `sorry`/`admit`.

If you add a feature, add tests in the corresponding workspace and keep its count at or above the floor.

## Docs conventions

The documentation is consolidated into a small set of canonical root-level files. The earlier `docs/` Diátaxis tree (`docs/getting-started/`, `docs/guides/`, `docs/reference/`, `docs/concepts/`) was merged into the files below.

| Surface | Home | What lives there |
|---|---|---|
| Product overview, quickstart (dashboard + CLI), worked examples, prior art | [`README.md`](README.md) | The narrative entry point. |
| Integration manual (contracts API, CLI reference, POLICY.md spec, scaffold-an-agent, operate / monitor / AI-onboarding guides, tier model, gotchas, integration models, the conservative-policy worked example) | [`SKILL.md`](SKILL.md) | Single canonical reference; AI agents read this. |
| TypeScript SDK + frontend gating | [`sdk/README.md`](sdk/README.md) | API walkthrough plus the exhaustive reference section. |
| Trust + threat model, per-function contract invariants | [`SECURITY.md`](SECURITY.md) | |
| Lean 4 formal model | [`verification/lean/README.md`](verification/lean/README.md) | |

Root-level governance docs: `README.md`, `CONTRIBUTING.md`, [`SECURITY.md`](SECURITY.md), [`CHANGELOG.md`](CHANGELOG.md), `LICENSE`, [`SUBMISSION.md`](SUBMISSION.md).

Style: start each doc with an H1 and a one-line purpose sentence. Concise and technical — no marketing adjectives, no filler. Every code snippet, signature, address, command, error name, and event name must be copied from the source it documents, never invented. Use fenced code blocks with language tags and relative markdown links.

### `AGENTS.md` is a generated pointer — do not hand-edit

The canonical full integration manual is [`SKILL.md`](SKILL.md). `AGENTS.md` at the repo root is a generated 7-line stub that points AI agents at `SKILL.md` — it is NOT a duplicate of the SKILL body. The stub is wrapped in `<!-- sentry-ai-init:begin -->` / `<!-- sentry-ai-init:end -->` markers and carries the `GENERATED` header. To regenerate (after editing `SKILL.md`):

```bash
pnpm sentry ai:init --codex   # rewrites the marked Sentry section in AGENTS.md
```

`ai:init` also emits Cursor (`--cursor` → `.cursor/rules/sentry.mdc`, gets the full body) and Claude (`--claude` → `.claude/skills/sentry-integration/SKILL.md`, gets the full body) targets, or all three with `--all`. Cursor and Claude get the full SKILL body inline because their conventions consume the file as the entire context; the Codex AGENTS.md convention auto-discovers + follows links, so the pointer is sufficient and avoids 700+ lines of duplication at the root. Hand-edits to generated destinations are refused unless you pass `--force`.

### Internal docs

There is no separate internal docs tree at the moment — earlier `docs/internal/` runbooks were removed along with the rest of the `docs/` Diátaxis tree. The design system source of truth is now inline below (see [Design system](#design-system)).

Every contributor should also read:

- [`CLAUDE.md`](CLAUDE.md) — agent-contributor guardrails: think before coding, simplicity first, surgical changes, goal-driven execution. These apply to every change, human or agent. Per-workspace `CLAUDE.md` files (where present) extend the root.

## Design system

Single source of truth for visual identity across the dashboard, TUI color palette, README badges, and future surfaces. Kept deliberately tight — Sentry is a developer tool, not a consumer brand. Component code (dashboard, TUI) must conform to these tokens; raw hex is not permitted in component code.

### Brand mark

The Sentry mark is a hexagonal gate pierced by a blue arrow that transitions from **dashed** (intent in motion) to **solid** (verified dispatch) as it passes through the gate. This is a literal rendering of the `checkIntent` flow:

```
  intent  ┊┊┊→  [ POLICY GATE ]  ───→  dispatch
```

**Master assets:** `design/logo/sentry.png` (mark) and `design/logo/sentry-wordmark.png` (lockup).

**Clearspace:** at minimum, half the hexagon's height on every side. Never compress the arrow or recolor the gate.

**Don'ts:**
- Don't fill the hexagon with color (always white-on-dark or dark-on-white).
- Don't change the arrow color (always `--accent`, see below).
- Don't add a drop shadow or gradient.

### Color tokens

Two layers: **raw palette** (named hex values) and **semantic tokens** (what UI code references). Only semantic tokens should appear in component code.

#### Raw palette

| Token | Hex | Source |
|---|---|---|
| `--navy-950` | `#0B1220` | logo background |
| `--navy-900` | `#11192C` | one step lighter — surfaces |
| `--navy-800` | `#1A2540` | two steps — elevated surfaces (drawers, cards) |
| `--navy-700` | `#1F2A44` | borders |
| `--slate-400` | `#9AA4BD` | muted text |
| `--slate-500` | `#5B6478` | subtle text / disabled |
| `--white` | `#FFFFFF` | hexagon white + primary text |
| `--ice` | `#F5F7FA` | display text (slightly softer than pure white) |
| `--blue-500` | `#3B82F6` | original arrow blue — kept in the raw palette for chart/legacy use |
| `--blue-400` | `#60A5FA` | hover state |
| `--blue-600` | `#2563EB` | pressed state |
| `--emerald-500` | `#22C55E` | success ("compiles", tx ok) |
| `--amber-500` | `#F59E0B` | warning (paused, near-expiry) |
| `--red-500` | `#EF4444` | error (veto, revert) |

#### Semantic tokens (use these in code)

| Token | Value | Used for |
|---|---|---|
| `--bg` | `--navy-950` | page background |
| `--surface` | `--navy-900` | panels, form sections |
| `--surface-elev` | `--navy-800` | drawers, modal content |
| `--border` | `--navy-700` | dividers, input borders |
| `--text` | `--white` | primary text |
| `--text-display` | `--ice` | headlines, wordmark |
| `--text-muted` | `--slate-400` | labels, helper text |
| `--text-subtle` | `--slate-500` | placeholder, disabled |
| `--accent` | `#4B7FD1` | links, focus rings, primary buttons, the arrow (desaturated from `--blue-500` in v0.9.0 to cut long-session glare; WCAG AA against `--navy-950`) |
| `--accent-hover` | `--blue-400` | hover state |
| `--accent-pressed` | `--blue-600` | active/pressed |
| `--success` | `--emerald-500` | ✓ compiles, tx success |
| `--warn` | `--amber-500` | paused, near-expiry |
| `--danger` | `--red-500` | veto, revert, schema errors |

### Typography

Sans-serif geometric. In order of preference:
1. **Geist** (web-loaded via Google Fonts) — body + UI. Replaced Inter in v0.9.0.
2. **JetBrains Mono** (web-loaded) — code, addresses, hashes, YAML
3. System fallback: `system-ui, -apple-system, "Segoe UI", Roboto, ui-sans-serif`

**Scale (rem):**

| Token | Size | Use |
|---|---|---|
| `text-xs` | 0.75 | metadata, badges |
| `text-sm` | 0.875 | body, form fields |
| `text-base` | 1 | default |
| `text-lg` | 1.125 | section headers |
| `text-xl` | 1.25 | page titles |
| `text-2xl` | 1.5 | page hero |

**Tracking:** uppercase metadata (`SECTION LABEL`, `STATUS BADGE`) gets `tracking-wider`. Nothing else.

### Components — visual contract

These shapes recur across the dashboard and TUI. Define them once.

#### Status badge

```
┌─────────────┐
│ ✓ COMPILES  │   bg = --success @ 30%, text = --emerald-500, uppercase, tracking-wider, text-xs
└─────────────┘
```

#### Primary button

```
┌─────────────────────────┐
│  publish policy         │   bg = --accent, text = --white
└─────────────────────────┘
                              hover: bg = --accent-hover
                              disabled: bg = --navy-700, text = --slate-500
```

#### Code chip (addresses, hashes, ids)

```
0xe275db398c69f91c…361e   [📋]
```
Monospace, `--surface`, padded, with copy affordance.

#### Drawer / elevated card

`--surface-elev` background, `--border` 1px, rounded-md, padding 4.

### TUI palette mapping

Ink only supports a small named palette. Map semantic tokens to nearest ink colors:

| Semantic | ink color | used for |
|---|---|---|
| `--accent` | `"cyan"` (closest match to desaturated #4B7FD1; ink does not support arbitrary hex) | header, filter highlight |
| `--success` | `"green"` | Dispatched events, OK tx |
| `--danger` | `"red"` | Vetoed events, reverts |
| `--warn` | `"yellow"` | EXPIRABLE pane, overdue rows |
| `--text-muted` | `dimColor` | metadata, addresses |

Full fidelity to `--accent` (#4B7FD1) requires a terminal with truecolor (24-bit) support — Kitty, WezTerm, or iTerm2.

### Asset checklist

| Asset | Path | Status |
|---|---|---|
| Master mark (raster) | `design/logo/sentry.png` | shipped |
| Wordmark lockup (raster) | `design/logo/sentry-wordmark.png` | shipped |
| Favicon | `dashboard/public/favicon.svg` | shipped (SVG, not PNG) |
| Dashboard logo asset | `dashboard/public/sentry.png` | shipped |
| Inline UI mark | `dashboard/src/components/Logo.tsx` | shipped — renders the raster master via `<img src="/sentry.png">`. |

### Application

- **Dashboard**: Tailwind config + `index.css` reflect these tokens; component palettes (`bg-zinc-*`, `bg-neutral-*`) are migrated to semantic classes via Tailwind theme extension.
- **TUI**: ink color mapping above; no other change needed.
- **README**: keep markdown; embed the logo via `![Sentry](design/logo/sentry.png)` or the wordmark via `![Sentry](design/logo/sentry-wordmark.png)`.
- **Skill**: text-only surface — no design surface to update.

### Motion

State-change motion only. **Never decorative, never orchestrated page loads.** Motion conveys state transitions (dispatch confirmed, violation arrives, drawer opens, mode toggles); it never exists for its own sake.

| Token | Value | Use |
|---|---|---|
| `--motion-feedback` | `150ms` | Press states, color shifts, toggle slides, hover state changes |
| `--motion-state` | `200ms` | Drawer slide, dropdown open, tab switch, row appear, mode swap |
| `--motion-layout` | `300ms` | Accordion expand, full-pane reveal, sidebar collapse |
| `--motion-ease` | `cubic-bezier(0.25, 1, 0.5, 1)` | `ease-out-quart`. Default for every transition. |
| `--motion-ease-exit` | same curve, ~75% duration | Drawer close, mode toggle exit, dropdown dismiss |

**Library:** `framer-motion` (already in deps). Use for entrances, AnimatePresence, exit transitions. Use plain CSS `transition` for hover / focus / active feedback.

**Reduced motion:** every transition above 50ms must respect `@media (prefers-reduced-motion: reduce)` — the existing rule in `dashboard/src/index.css` clamps animation/transition durations to 1ms globally; bespoke framer-motion animations must also short-circuit when `useReducedMotion()` returns true.

**Bans:**
- No bounce or elastic easing (`cubic-bezier(0.34, 1.56, ...)`).
- No animation of layout properties (`width`, `height`, `top`, `left`, margins) unless FLIP-style.
- No orchestrated page-load choreography. The dashboard opens into a task; the user does not watch it load.
- No decorative motion. If the motion does not convey state, cut it.

### Non-goals

- No multi-theme support (dark only — Sentry's audience runs dark IDEs and dark explorers).
- No icon library beyond Phosphor (existing primary), Lucide (only when an installed shadcn / efferd registry block specifically depends on it), and the brand mark.
- No print/email tokens.
