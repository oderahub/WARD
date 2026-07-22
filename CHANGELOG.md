# Changelog

## v0.12.0 — 2026-06-08

Consolidated samples to a single canonical agent — `CounterAgent` in `examples/sentry-counter/`, restructured to inherit `SentryAgentBase` and use the `sentryGuarded(selector, value)` modifier (the v0.10.5+ default for single-outbound functions). Removed every other sample agent, the seeder script that referenced them, and every current-state-doc pointer at the removed samples. Their on-chain bytecode + historical tx hashes remain resolvable on Shannon Explorer, but the source no longer ships from this repo.

- **Removed:** `examples/sentry-swapper/` (TutorialAgent + PayableVault + scripts + README + policy-tutorial.md).
- **Removed:** `examples/sentry-swapper-fe/` (React FE preflight demo for the deleted swapper).
- **Removed:** `examples/llm-echo/` (LLMEchoAgent v1 + v2 + EchoTarget + scripts + README + deploy.sh + policy.md + the deployment JSON artifacts under `deployments/`).
- **Removed:** `contracts/script/SeedRegistry.s.sol` — seeded 4 historical demo agents (LLMEchoAgent v1, LLMEchoAgent v2, TutorialAgent v2, one third-party agent). The on-chain registry rows survive the seeder's deletion; the script's source no longer ships.
- **Changed:** `examples/sentry-counter/src/CounterAgent.sol` rebuilt against `SentryAgentBase` and collapsed to two normal functions — `bump(uint256)` and `reset()` — each gated by the `sentryGuarded(this.{name}.selector, 0)` modifier. The hand-rolled `oracle` / `POLICY_ID` / `owner` / `setPolicyId` / `transferOwnership` / `_gate` / `PolicyBound` / `OwnershipTransferred` / `NotOwner` / `ZeroOwner` / `BUMP_SELECTOR` / `RESET_SELECTOR` were dropped — all come from `SentryAgentBase` now. No in-contract `AllowedCallExecuted` / `DeniedCallRejected` events, no `tryBump` / `tryReset` request-id wrappers, no manual `oracle.checkSelector` + catch-and-emit deny path: the forge test publishes a policy that authorizes `bump` but omits `reset`, so the modifier's `SentryRejected("SELECTOR_NOT_ALLOWED")` revert on `reset()` is the deny-path proof. `Counter` is typed as `Counter public immutable counter`, not the prior generic `address public immutable target`. Down from the prior ~60-line two-entrypoint shape to ~22 lines of contract body. Mirrors the `counter-fixture` template in `packages/create-sentry-agent/src/templates/index.ts` byte-for-byte.
- **Re-deploy needed:** the live CounterAgent at `0x14F7271Dec889acC152101674A4fb4C52388f517` (referenced as `DEFAULT_AGENT_ADDRESS` in `examples/sentry-react-app/src/App.tsx` and in `docs/getting-started/examples.md`) carries the pre-simplification `tryBump(uint256,uint256)` / `tryReset(uint256)` ABI, and the policy at `0x5cb2578a…` was published against those selectors. Operators bringing on-chain in sync need to: (1) redeploy via `examples/sentry-counter/script/DeployAgent.s.sol`, (2) republish `examples/sentry-counter/policy.md` (now selector `bump(uint256)`), (3) update `DEFAULT_AGENT_ADDRESS` + `DEFAULT_POLICY_ID` in `examples/sentry-react-app/src/App.tsx`. The dashboard's `useAgentWatcher.ts` RPC-first path also degrades against the new shape — the agent no longer emits its own events; `Bumped` / `Reset` come from the downstream `Counter` address, so the Blockscout fallback (not the RPC path) carries the watcher for the new CounterAgent.
- **Changed:** `examples/sentry-counter/script/DeployAgent.s.sol` — constructor call updated to `new CounterAgent(oracle, Counter(counter), deployer)`, added `import {Counter} from "../src/Counter.sol";`, and added `vm.createDir("deployments", true);` so first-run deploys no longer fail on a missing `deployments/` directory.
- **Changed:** `examples/sentry-counter/script/DeployCounter.s.sol` — added the same `vm.createDir("deployments", true);` pre-write so the counter-only deploy script is symmetric with `DeployAgent.s.sol`.
- **Changed:** `examples/sentry-counter/test/CounterAgentLateBinding.t.sol` — updated to construct the agent as `new CounterAgent(oracle, counter, deployer)` (typed `Counter`), to assert the typed `SentryAgentBase.NotOwner` / `SentryAgentBase.ZeroOwner` / `SentryAgentBase.SentryRejected(reason)` errors instead of the old `CounterAgent.*` errors, and to publish the test policy against `address(agent)` with the agent's own `bump(uint256)` selector (entrypoint-policy model) instead of the prior `bump(uint256)`-on-`Counter` policy. The deny-path test calls the omitted `reset()` and asserts the `SentryRejected("SELECTOR_NOT_ALLOWED")` revert directly — no in-contract catch-and-emit needed. Test count tracked alongside the forge floor; see "Test surface" below for the post-refactor number.
- **Changed:** `examples/sentry-counter/policy.md` — the YAML block's `target` is now the placeholder `0xdead…dead` (operator pastes their agent address after deploy) instead of a stale `Counter` deployment address, and the `selectors` block lists `bump(uint256)` (matches the entrypoint-policy model; `reset()` is deliberately omitted so the e2e test verifies the modifier's `SentryRejected("SELECTOR_NOT_ALLOWED")` deny path).
- **Removed:** `contracts/script/deploy-and-seed-registry.sh` — the bash wrapper around `SeedRegistry.s.sol`; deleting it alongside the script avoids a dangling-reference footgun. `contracts/broadcast/SeedRegistry.s.sol/` (dated broadcast artifacts) was also removed.
- **Changed — `pnpm-workspace.yaml`:** dropped the `examples/sentry-swapper-fe` workspace entry alongside the directory removal so `pnpm install` no longer surfaces a missing-importer warning. The `pnpm-lock.yaml` will refresh on the next `pnpm install`.
- **Changed:** `packages/create-sentry-agent/src/templates/index.ts` — dropped the apology header on the `counter-fixture` template (the "uses the SentryAgentBase pattern, not the standalone style from the canonical example" comment + the "mirrors examples/sentry-counter" line) now that the canonical sample genuinely IS this shape. Also added `vm.createDir("deployments", true);` before the `vm.writeFile("deployments/agent.json", ...)` call in both the greenfield and counter-fixture deploy templates so first-run scaffolds match the canonical sample's behavior.
- **Changed:** `examples/sentry-counter/README.md` + `examples/sentry-counter/policy.md` — snippets updated to the `SentryAgentBase` + modifier shape; cross-references to the deleted `sentry-swapper` dropped; policy `target` confirmed as the agent's own address (entrypoint-policy model) with the agent's own selectors.
- **Changed — docs purge:** `README.md`, `PRODUCT.md`, `AGENTS.md`, `SKILL.md`, `docs/USAGE.md`, `docs/INTEGRATION-MODELS.md`, `docs/DOCS-IA-PLAN.md`, `sdk/README.md`, `skills/sentry-onboard/sentry-onboard.md` — every `TutorialAgent` / `LLMEchoAgent` / `LLMEchoAgentV2` / `sentry-swapper` / `sentry-swapper-fe` / `llm-echo` / `SeedRegistry` pointer in current-state docs was removed or rewritten to point at `examples/sentry-counter/` (the only remaining sample). `AGENTS.md` + `SKILL.md` §6.5 (late-binding pattern) replaced the standalone-shape canonical template with the `SentryAgentBase` + `sentryGuarded` shape; the §A model-picker line stopped referring to `_gate` and now describes the `sentryGuarded` modifier directly; the `sentry analyze:gate` row was updated to mention `sentryGuarded(...)` + `_sentryCheck(...)` alongside `SentryCall.check(...)`. Hits remain only in historical CHANGELOG entries (v0.10.3, v0.10.5, v0.11.0 still narrate the removed samples in their original release context), in `contracts/broadcast/` dated outputs, and in archived plans under `docs/superpowers/plans/`.
- **Trimmed (not deleted) — `docs/INTEGRATION-MODELS.md`:** both models stay documented (modifier for single-outbound, inline `_sentryCheck` + `_call` / direct `oracle.checkIntent` for multi-outbound) so the conceptual picker survives; the file pointer to the deleted `TutorialAgent` was replaced with `SentryAgentBase`'s `_sentryCheck` + `_call` helpers and an `examples/sentry-counter/` cross-link.
- **Banner added — `docs/DOCS-IA-PLAN.md`:** an internal audit-plan doc; flagged the three bug entries that referenced the now-deleted samples as MOOT. The line references are preserved as audit provenance.
- **Cleaned — `dashboard/`:** `dashboard/src/lib/abi-fetch.ts` comment refs to `sentry-swapper` / `LLMEchoAgent` dropped (the file never held an ABI snippet for either, just a comment example listing); `dashboard/src/lib/selector-display.ts` drops the tutorial-vault selectors (`payInvoice` / `deposit` / `withdraw`) + the sentry-swapper router-swap selectors AND the entire sentry-swapper `KNOWN_TARGETS` map (now empty — the canonical Sentry addresses are resolved via `contractName.ts` LOCAL map); `dashboard/src/lib/contractName.ts` drops the `PayableVault` / `TIN` / `TOUT` / `MockRouter` LOCAL entries and the prose pointer to "known sentry-swapper tutorial contracts"; `dashboard/src/hooks/useAgentWatcher.ts` + `dashboard/src/components/publish/TargetRow.tsx` comment mentions updated. `contracts/.env.example` drops the TutorialAgent variable.
- **Changed — `dashboard/tests/`:** `tests/lib/contractName.test.ts` swapped its `PayableVault` LOCAL-map probe address for `SentryOracle` (v2) — the test now asserts the `LOCAL_NAME = "SentryOracle"` from one of the two remaining canonical entries. `tests/lib/selector-display.test.ts` dropped the `payInvoice` positive assertion (replaced with a negative-assertion test that pins payInvoice as no-longer-in-the-map), and the two `lookupTarget` positive tests for `MockRouter (sentry-swapper)` / `PayableVault (sentry-swapper)` were replaced with one negative-assertion test (the map is now empty) + one case-insensitivity test that exercises the lowercase normalization on the empty map. Net dashboard test count stays at 485.
- **Changed — `SUBMISSION.md`:** Beat 3 rewritten around the canonical `CounterAgent` integration showcase (60-line agent, allow-path + deny-path in one transcript) instead of the deleted `LLMEchoAgentV2` autonomous loop. Beat 4 + 5 + section 4/6/7 narrative + bullet lists updated to drop every `LLMEchoAgentV2` mention. Section 8's Foundry test floor narrative bumped from 118 → 133.
- **Changed — `examples/sentry-react-app/`:** distinct from the removed `sentry-swapper-fe`; the React-dApp sample is kept. Its `src/abi.ts` ABI fragment + `src/GuardedBumpPanel.tsx` + `src/App.tsx` lede + README walkthrough + `package.json` description were updated from the pre-simplification `tryBump(uint256 reqId, uint256 by)` selector to the new `bump(uint256)` selector. The `reqId` form-field on the panel was dropped (the agent no longer takes one). The single vitest in `tests/App.test.tsx` is unaffected — it mocks `writeContract` + `preflight` without pinning the function name. README also flags the live-agent migration above so users hitting the default address know to redeploy.
- **Unchanged — `design/briefs/`:** the day-5 demo-rehearsal + deck-draft still describe the `LLMEchoAgentV2` Tape moment for the originally-planned 3:30 recording. The video has not been recorded; if it is recorded against the new Beat-3 narrative, the briefs are the next file to rewrite.
- **Changed — dual-layer access control on `CounterAgent`:** `examples/sentry-counter/src/CounterAgent.sol` gains a second access-control layer LAYERED ON TOP OF Sentry — a plain Solidity caller allow-list (`mapping(address => bool) public isOperator` + `onlyOperator` modifier + owner-managed `addOperator` / `removeOperator` with no-op-guarded `OperatorAdded` / `OperatorRemoved` emissions + a `NotOperator()` typed error). Both entrypoints become `bump(uint256) external onlyOperator sentryGuarded(this.bump.selector, 0)` and `reset() external onlyOperator sentryGuarded(this.reset.selector, 0)`. Modifier order is load-bearing: Solidity executes modifiers left-to-right, so `onlyOperator` fires FIRST and rejects unauthorized callers with `NotOperator` *before* the agent makes the external oracle call — gas saved on doomed calls. The two layers are orthogonal (Sentry policies have no visibility into `msg.sender`; caller ACLs belong at the Solidity layer); each layer has one revert reason and the two distinct reasons are the proof each is doing exactly one job. The constructor bootstraps `_owner` as the initial operator so the deployer can call entrypoints immediately. The operator registry is independent of ownership — `transferOwnership` does NOT auto-rotate operators. Re-frames the sample from "minimal" to "canonical dual-layer" (the prior 22-line framing is deliberately traded away here per design choice).
- **Changed — `examples/sentry-counter/test/CounterAgentLateBinding.t.sol`:** added 7 operator-layer tests on top of the existing late-binding suite (climbs from 10 → 17). One test is the load-bearing **modifier-order pin** and runs under a BOUND rejecting policy — alice (not an operator) calls `reset()` after the bump-only policy is bound, and the test asserts the revert is `NotOperator` (the cheap Solidity layer caught it first). Under a regression that reordered modifiers to `sentryGuarded onlyOperator`, that same call would revert `SentryRejected("SELECTOR_NOT_ALLOWED")` from the oracle instead — so this is the test that actually pins the order. Other operator tests cover: unauthorized caller on `bump` (ungated path) reverts `NotOperator`; owner adds bob then bob can `bump`; owner removes bob then bob's `bump` reverts `NotOperator` again; non-owner calling `addOperator` reverts `NotOwner` (typed error from `SentryAgentBase`); fresh deploy auto-bootstraps the owner into `isOperator[owner]`.
- **Changed — `packages/create-sentry-agent/src/templates/index.ts`:** the `counter-fixture` template's `CounterAgent.sol` output mirrors the dual-layer shape byte-for-byte (same `isOperator` mapping, `onlyOperator` modifier, no-op-guarded add/remove, constructor bootstrap, `onlyOperator sentryGuarded(...)` modifier order on both entrypoints). The scaffolded forge test mirrors the new operator tests. The scaffolded `POLICY.md` and scaffolded README mention the dual layer and the modifier-ordering rationale.
- **Changed — `packages/create-sentry-agent/tests/index.test.ts`:** added ONE fresh test pinning `isOperator`, `onlyOperator`, and `sentryGuarded` substrings in the generated agent template (positive assertions). Climbs from 26 → 27.
- **Changed — `examples/sentry-counter/README.md`:** re-framed from "smallest possible" to "canonical dual-layer sample". Added a "Why two layers" subsection explaining the orthogonality + modifier-order rationale. Extended the Behavior section to show both reverts (`NotOperator` from non-operators, `SentryRejected("SELECTOR_NOT_ALLOWED")` from operators calling the omitted `reset`). Extended the Operational primitives table with `addOperator` / `removeOperator` rows.
- **Changed — `examples/sentry-counter/policy.md`:** added a one-line prose note before the YAML fence clarifying that the policy does NOT restrict `msg.sender` — caller identity is enforced separately at the Solidity layer via the operator registry. The policy YAML itself is unchanged (still `bump(uint256)` only, `reset()` deliberately omitted as the deny-path proof).
- **Changed — `AGENTS.md` + `SKILL.md` §6.5:** replaced the canonical-template snippet with the dual-layer shape (operator mapping + add/remove + bootstrap + `onlyOperator sentryGuarded(...)` entrypoint). Added a new sub-section "Layering Solidity access control on top of Sentry" explaining the orthogonality, why modifier order matters, why a bound rejecting policy is required to *actually* pin the order (an unbound-path test passes either way thanks to the `sentryGuarded` short-circuit), and that the operator registry is independent of ownership.
- **Changed — `README.md` (root) "Integrate into your agent":** snippet updated to the dual-layer shape so the lead example matches the canonical sample and §6.5.
- **Re-deploy note (operator layer):** the on-chain `CounterAgent` at `0x9c19681189f9F445CAe45bA026527921a7386200` (the live-QA deployment used by the React demo at `examples/sentry-react-app/`) was built with the prior bare-`bump`/`reset` ABI — the bump/reset selectors are unchanged, so the React demo keeps working against it. Demoing the operator gate on-chain would require a redeploy + re-bind; the source change here does not affect the deployed bytecode.

### Test surface

examples/sentry-counter forge climbs +7 (operator-layer tests, 10 → 17); create-sentry-agent climbs +1 (dual-layer template-output pin, 26 → 27). Core forge floor unchanged at 133 (the operator tests live in `examples/sentry-counter/test/` and run via `forge test` from that subdir). Net: contracts forge 133, examples/sentry-counter forge 17, SDK 196, dashboard 485 (tsc clean), CLI 72, sentry-react 31, sentry-vite 7, create-sentry-agent 27, examples/sentry-react-app 1.

## v0.11.0 — 2026-06-08

Shipped a second deployment of `SentryOracle` + `SentryQueue` on Somnia Shannon so the v0.10.5 `sentryGuarded` modifier has the view surface it needs. The v1 oracle (`0x68d4B045…`) was deployed before `checkSelector(policyId, target, selector, value, spentToday)` existed; the modifier-synthesized `Intent` path needs that view to keep the gate atomic with the function body, and bytecode upgrades aren't an option for an immutable contract. v2 is the canonical target for any new integration that uses `sentryGuarded` (or any code path that calls `checkSelector` directly); v1 stays live, unchanged, and keeps serving every policy + agent that was published against it before today.

- **Added — v2 oracle on Shannon:** `SentryOracle` at `0x3C7bF90f243d670a01f512221d9546e09fEaCC9c`. Same source surface as v0.10.5 plus the `checkSelector` view that `SentryAgentBase.sentryGuarded` calls internally. Empty on deploy — the first published policy under v2 is whatever the first modifier-based agent's owner registers.
- **Added — v2 queue on Shannon:** `SentryQueue` at `0xFB715A37951Fc8dcc920120768e91f7C8bbA54c4`, paired with the v2 oracle for `TIER_DELAYED` / `TIER_VETO_REQUIRED` flows from modifier-based agents.
- **Unchanged — `SentryAgentRegistry`:** `0x97F743A9AAa5AcAA73075C1B8F1921274755CF70`. The registry is oracle-agnostic — `getAgent(address)` carries the agent's bound oracle in its row, so v1- and v2-bound agents coexist in the same directory. The 4 seeded entries (LLMEchoAgent v1, LLMEchoAgent v2, TutorialAgent v2, one third-party agent) keep their v1-oracle bindings; re-seeding would mutate first-writer-wins demo state.
- **Unchanged — v1 oracle + v1 queue.** Both stay deployed at their original addresses. Every policy already published against v1 (including the 4 seeded registry agents and the `LLMEchoAgentV2` autonomous-showcase demo at `0x3E397269…`) continues to resolve and gate exactly as it did pre-v0.11.0. v1 lacks `checkSelector`, so it cannot back the new modifier, but `checkIntent` is unchanged — inline-pattern agents (the `TutorialAgent` multi-outbound shape) remain a first-class integration path on v1.
- **Unchanged — `examples/llm-echo/deployments/50312.json` + `llm-echo-v2-50312.json`.** These are dated deployment artifacts pinned to v1; the demo replay flow continues to point at the v1 oracle by design.
- **Changed — runtime defaults to v2.** Code defaults that previously resolved v1 now resolve v2 unless an operator overrides `SENTRY_ORACLE` / `SENTRY_QUEUE`: `dashboard/src/lib/networks.ts` (NETWORKS[50312] `oracleAddress` + `queueAddress`), `tui/src/lib/env.ts` (`DEFAULT_ORACLE` + `DEFAULT_QUEUE`), `examples/sentry-react-app/src/wagmi.ts` (`SENTRY_ORACLE_ADDRESS`), `contracts/script/PublishAndBind.s.sol` (`DEFAULT_ORACLE` + the corresponding natspec), `sdk/scripts/smoke-event-store.ts` (`ORACLE` + `QUEUE` + `ORACLE_DEPLOY` block bumped to the v2 deploy block 403805414), `.env.example`, `contracts/.env.example`. `dashboard/src/lib/contractName.ts` adds v2 entries to the known-contracts map and keeps the v1 entries (relabelled `"SentryOracle (v1)"` / `"SentryQueue (v1)"`) so the dashboard still labels v1 traffic that's still gating real on-chain agents.
- **Unchanged — `contracts/script/SeedRegistry.s.sol`.** Pinned at v1 by design. The 4 seeded agents (LLMEchoAgent v1, LLMEchoAgent v2, TutorialAgent v2, the third-party demo) have an immutable `oracle` field set to v1 at construction time; re-pointing this seed script at v2 would produce registry rows whose `oracle` column contradicts the actual on-chain agent binding. New modifier-based agents are added to the registry separately.

### What new integrators should do

- New agents that adopt `SentryAgentBase` + `sentryGuarded(selector, value)` (the v0.10.5 default for single-outbound functions) must bind to the v2 oracle. Publish your `POLICY.md` against v2 by overriding `SENTRY_ORACLE=0x3C7bF90f243d670a01f512221d9546e09fEaCC9c` when you `sentry push`, and pass the v2 oracle address into your agent's constructor.
- New agents that stay on the inline `oracle.checkIntent` pattern (the multi-outbound shape used by `TutorialAgent`) can target v1 or v2 — both expose `checkIntent` with identical semantics. Pick v2 if you want the option to add a `checkSelector`-using modifier later without a redeploy.
- Existing v1 agents do not need to migrate. Re-publishing a v1 policy under v2 changes the `policyId` (publisher × label namespace is per-oracle) and would require a `setPolicyId(0xNEW)` call on the agent.

### Test surface

All floors held: forge 133+, SDK 196, dashboard 485 (tsc clean), CLI 72, sentry-react 31, sentry-vite 7, create-sentry-agent 26, examples/sentry-react-app 1. No test changes in this release — the v2 contract is a redeploy of the v0.10.5 source surface, covered by the existing Foundry suite; the runtime-default address swaps land in fall-through string literals that the test suites don't pin (suites mock the RPC or override the address explicitly), so dashboard / TUI / SDK / CLI / package suites pass against the v2 defaults unchanged.

## v0.10.5 — 2026-06-08

Shipped the `sentryGuarded(selector, value)` modifier on `SentryAgentBase` so the simple single-outbound-call case becomes one line on the function signature instead of a manual `oracle.checkIntent` + `_call` pair in the body. The modifier mirrors `oracle.checkIntent`'s tier handling by synthesizing an `Intent` (selector + value, packed via `abi.encodePacked(selector)` so PolicyLib stays untouched and Lean re-verification isn't required), running the oracle check, post-validating the tier so `TIER_DELAYED` / `TIER_VETO_REQUIRED` surface as `SentryRejected("REQUIRES_DELAY")` / `SentryRejected("REQUIRES_VETO")` instead of silently passing, and pre-reserving `msg.value` against the daily-spend tally *before* running the function body. No `nonReentrant` baked in (callers add `ReentrancyGuard` where needed); `_call` was updated to perform the same spend pre-reservation so multi-call paths through `_call` get matching accounting. Policy-owner lookups now go through `policyOwner[policyId]` (not the prior `Policy.publisher` field).

- **Added:** `docs/INTEGRATION-MODELS.md` — when to use the `sentryGuarded` modifier vs. inline `oracle.checkIntent`, with the modifier as the default for one-outbound functions and the inline path for multi-outbound functions (`approve` + `swap`, mint + transfer). Documents the approve-after-gate ordering rule from `TutorialAgent.triggerSwap`, the `REQUIRES_DELAY` enqueue branch, and the explicit non-promises of the modifier (no reentrancy guard, no per-argument constraints, no `SentryQueue` replacement).
- **Changed:** `README.md` "Integrate into your agent" — leads with the modifier as the simple-case default (full snippet using `SentryAgentBase` + `sentryGuarded`), points multi-outbound integrators at `TutorialAgent`, and cross-links `docs/INTEGRATION-MODELS.md` for the model picker. Section heading dropped the stale "three lines" suffix; header anchor link updated to match.
- **Note:** `TutorialAgent` (`examples/sentry-swapper/`) stays on the inline pattern — multi-outbound is the use case the inline model exists for. `CounterAgent` migration to the modifier is follow-up work, not in this release.

### Test surface

All floors held: forge 118+, SDK 196, dashboard 485, CLI 72, sentry-react 31, sentry-vite 7, create-sentry-agent 26, examples/sentry-react-app 1. Forge climb expected from the new modifier tests in `SentryAgentBase`.

## v0.10.4 — 2026-06-08

Removed the `subgraph/` directory entirely and collapsed the dashboard agents catalog from a 3-tier read fallback to a 2-tier one. The Ormi tier was operator-facing dead weight — the live endpoint at `https://api.subgraph.somnia.network` is unreachable as of 2026-06-08, the subgraph was never deployed, and the dashboard's on-chain walk via `findSentryAgents()` already serves the same data with the same correctness guarantees. Shipping the fallback meant carrying ~190 lines of Ormi-specific fetch / pagination / mapping code, a build-time `VITE_ORMI_SUBGRAPH_URL` env knob, a runtime `window.__ORMI_SUBGRAPH_URL__` override, and a 3-state freshness badge for a tier that never produced a single live read for our operator audience. Removing it lands the dashboard at the level of abstraction the integration actually needs.

- **Removed:** `subgraph/` directory (schema, mappings, abis, package, lockfile, README). Never deployed; the Sentry contracts and SDK do not depend on it.
- **Changed:** `dashboard/src/lib/agents-catalog.ts` — collapsed the read fallback from `Ormi → chain → IDB` to `chain → IDB`. The `AgentsFreshness` union drops `"live-ormi"` and renames `"live-chain"` to `"live"`. The `source` union drops `"ormi"`. The `cachedSourceTier` field, the `LoadAgentsCatalogOpts.subgraphUrl` field, the `UseAgentsCatalogOpts.subgraphUrl` field, and the exported `ORMI_SUBGRAPH_URL` constant are all removed.
- **Changed:** `dashboard/src/components/AgentsCatalogPanel.tsx` — drops the `live · subgraph` badge variant and the `cached from subgraph` tooltip branch. The freshness badge now reads `live · on-chain` or `cached · {age} ago` or `no agents`.
- **Changed:** `dashboard/src/lib/persistence.ts` — `CachedAgentsRecord.sourceTier` and `saveCachedAgents`'s `sourceTier` param narrow from `"ormi" | "chain"` to `"chain"`. No `DB_VERSION` bump and no migration: pre-v0.10.4 cache rows that carry `sourceTier: "ormi"` are simply overwritten on the next live load (the catalog no longer reads the field).
- **Changed:** `dashboard/.env.example` — drops the `--- Ormi subgraph (Tier 1 of the agents catalog fallback) ---` block, including `VITE_ORMI_SUBGRAPH_URL`. The preamble's reference to "subgraph endpoints" becomes "registry address overrides".
- **Changed:** `dashboard/index.html` — removes the runtime-override comment block that documented `window.__ORMI_SUBGRAPH_URL__`.
- **Changed:** `PRODUCT.md` — current-state language updated from "3-tier" to "2-tier"; the SentryAgentRegistry bullet drops the "Subgraph wired and built" tail.
- **Changed:** `SUBMISSION.md` — the highlights list, architecture diagram, narrative paragraph, innovation row, and outstanding list all drop their Ormi mentions. The architecture diagram's bottom dashboard box no longer reads `+ Ormi`.

### Operator-visible change

The Watched tab's catalog freshness badge no longer renders `live · subgraph` as a possible value. It now reads `live · on-chain` when the chain walk succeeds, or `cached · {age} ago` when the chain walk fails and an IDB snapshot exists, or `no agents` when both fail with no cache. Tooltip copy is updated to match (`Last live on-chain result, fetched {age} ago`).

### Test surface

All floors held: forge 118, SDK 196, dashboard 485 (tsc clean), CLI 72, sentry-react 31, sentry-vite 7, create-sentry-agent 26, examples/sentry-react-app 1. No tests asserted on the removed symbols (`ormi`, `live-ormi`, `live-chain`, `cachedSourceTier`, `ORMI_SUBGRAPH_URL`), so no test edits were needed. The TypeScript union narrowings catch every consumer at compile time — dashboard typecheck must stay green to merge.

## v0.10.3 — 2026-06-08

Pinned `CounterAgent` (in `examples/sentry-counter/`) as the canonical "sample agent code" reference. Dropped historical and orphan demo material that was diluting that message.

- **Removed:** `examples/sentry-swapper/src/SwapAgent.sol`, `examples/sentry-swapper/script/DeployAgent.s.sol`, and `examples/sentry-swapper/policy.md` — the historical two-path `SwapAgent`-only deployment that the swapper README already labeled "NOT the canonical replay". On-chain bytecode + legacy tx hashes remain resolvable via Shannon Explorer; the source + its broadcast/out artifacts no longer ship.
- **Removed:** `examples/operator-alerts/` (Slack-webhook NDJSON consumer recipe). Superseded by the in-Watch-Wizard Slack + Telegram channel binding shipped in v0.10.x.
- **Changed:** `examples/sentry-swapper/README.md` — dropped the "Historical SwapAgent demo" section and added a one-line intro pointing first-time integrators at `examples/sentry-counter/`.
- **Changed:** `examples/sentry-counter/src/CounterAgent.sol` — one-line header comment positioning it as the canonical minimal sample, with a pointer to `examples/sentry-swapper/` for multi-tier.
- **Changed:** `SECURITY.md` — out-of-scope list updated; "approve-before-gate" guidance now references only the live `TutorialAgent` revision.
- **Changed:** `docs/COMPETITIVE-ONBOARDING-AUDIT.md` — alert-destinations gap text updated to reflect the in-wizard Slack + Telegram binding, with a one-line note about the `operator-alerts/` recipe removal.
- **Changed:** `dashboard/src/hooks/useAgentWatcher.ts` — comment mention of `SwapAgent` updated to `CounterAgent, TutorialAgent`.

### Test surface

All floors held exactly: forge 118, SDK 196, dashboard 485 (tsc clean), CLI 72, sentry-react 31, sentry-vite 7, create-sentry-agent 26, examples/sentry-react-app 1. No new tests; no regressions.

## v0.10.2 — 2026-06-08

Removed the Live Event Tape page (`?tab=tape`). Empty-by-default UX for the dominant operator workflow plus redundancy with Watched + Queue + Shannon Explorer made it more noise than signal.

- **Removed:** `dashboard/src/pages/TapePage.tsx`, `dashboard/src/lib/event-tape.ts`, `dashboard/tests/lib/event-tape.test.ts` (net -2142 LOC, -26 vitests, intentional). Sidebar drops to 4 nav entries (publish / queue / watched / watch-wizard). `?tab=tape` URLs fall back to publish via the existing default branch in `parseTab`.
- **Changed:** `useAgentWatcher` + `rpcChunk` lost the coupling-only comment mentions of `event-tape`; the chunking logic and re-exports are unchanged. The 5 Sentry-aware agent lifecycle decoders (InferenceRequested / IterationKickedOff / PlanExecuted / PlanFailed / LoopHalted) were Tape-only consumers and were removed alongside the page; operators who want raw lifecycle history use Shannon Explorer.

### Test surface

- forge: **118 / 118** passing (unchanged).
- SDK: **196 / 196** passing (unchanged).
- Dashboard: **485 / 485** passing across 35 files (-26 vitests vs v0.10.1, intentional — Tape suite retired with the page).
- CLI: **72 / 72** passing (unchanged).
- sentry-react: **31 / 31** passing.
- sentry-vite: **7 / 7** passing.
- create-sentry-agent: **26 / 26** passing.
- examples/sentry-react-app: **1 / 1** passing.
- Lean / TUI: unchanged.

## v0.10.1 — 2026-06-05

User-first dashboard pass.

- **Removed:** the hardcoded-to-LLMEchoAgentV2 Cockpit page (`?tab=cockpit`) and its `agent-cockpit` read helpers. A first-time operator now lands on a dashboard scoped to their own work, not to a featured demo agent.
- **Changed:** the Tape's agent-event sources now come from the operator's own Watch-Wizard subscriptions (`loadAllWatchSubscriptions`) instead of a hardcoded featured-agent address. The 5 Sentry-aware agent lifecycle decoders (InferenceRequested / IterationKickedOff / PlanExecuted / PlanFailed / LoopHalted) remain — they're open knowledge usable against any subscribed agent. (removed in v0.10.2)
- **Changed:** the Tape's empty state teaches the operator how to populate it — it deep-links to the Watch Wizard when no agent subscription exists. (removed in v0.10.2)
- Sidebar drops to 5 nav entries (publish / queue / watched / watch-wizard / tape). (Tape removed in v0.10.2; sidebar now 4 entries.)

### Test surface

- forge: **115 / 115** passing.
- SDK: **191 / 191** passing.
- Dashboard: **438 / 438** passing (Cockpit-page tests retired alongside the page; new Tape-source-from-subscriptions tests added). (Tape-source tests removed in v0.10.2 alongside the page.)
- CLI: **67 / 67** passing.
- sentry-react: **27 / 27** passing.
- sentry-vite: **3 / 3** passing.
- Lean / TUI: unchanged.

## v0.10.0 — 2026-06-05

Agent discoverability + zero-friction onboarding. v0.10.0 ships a new on-chain `SentryAgentRegistry`, the `findSentryAgents()` SDK helper for cross-agent discovery, a 3-step Watch Wizard that turns "paste a deployed agent address" into "publish + register + Slack alert" in under 60 seconds, and two new dashboard surfaces — the autonomous Cockpit and the unified Live Event Tape. The Watch Wizard is honest about its two operating modes: real-time gating (for Sentry-aware agents) versus observation-only (for any agent the operator doesn't control). (Cockpit removed in v0.10.1; Live Event Tape removed in v0.10.2.)

### Added — `SentryAgentRegistry` (Day 1)

- New `contracts/src/SentryAgentRegistry.sol` — ownerless, permissionless registry of Sentry-watched agents on Somnia Shannon. Deployed at `0x97F743A9AAa5AcAA73075C1B8F1921274755CF70` (deploy block `400534088`, deploy tx `0x6691e83dc3b7738fd74e14042f877a2a7948f5c0bd60c0fe89d83179866a83e5`).
- Each entry: `{agent, registrar, oracle, policyId, name, metadataURI, tags[], updatedAt, active}`. First registrar of an agent owns subsequent updates / deactivations; no admin override.
- Three events for indexers: `AgentRegistered`, `AgentUpdated`, `AgentStatusChanged`. Pagination via `agentsPaginated(offset, limit)`; `agentCount()`; canonical `getAgent(address)` lookup.
- Seeded with 4 entries on deploy (LLMEchoAgent v1, LLMEchoAgent v2, TutorialAgent v2, one third-party agent) so the dashboard catalog isn't empty on first paint.
- Subgraph wired in `subgraph/` (Ormi-compatible, deployable to `https://api.subgraph.somnia.network/deploy` with an operator-provided key).

### Added — SDK discoverability (Day 2)

- `sdk/src/agent-registry-client.ts` — new `findSentryAgents({ publicClient, registryAddress, onlyActive? })` helper that walks `agentsPaginated` under a snapshot of `agentCount()`. Returns a `Result` envelope `{ ok, agents, totalCount: bigint, pagesRead, error? }` so partial reads survive a mid-walk failure. Exported from the SDK barrel as `findSentryAgents` + `SENTRY_AGENT_REGISTRY_ABI` + `RegistryAgent`.
- README section in `sdk/README.md` — "Find Sentry-watched agents" with a copy-paste `createPublicClient` + `findSentryAgents` snippet, so 3rd-party operators reading the npm-published package see the helper immediately.
- Dashboard `dashboard/src/lib/agents-catalog.ts` — 3-tier read fallback (`Ormi GraphQL → on-chain via SDK helper → IndexedDB cache`) with real per-tier 8-second timeouts. Empty `VITE_ORMI_SUBGRAPH_URL` silently skips the Ormi tier. Env override `VITE_SENTRY_AGENT_REGISTRY` is validated via viem `isAddress` before use.
- IndexedDB v10 — additive `cachedAgents` store, no breaking change to v9 stores.

### Added — Watch Wizard (Day 3)

- `dashboard/src/pages/WatchWizardPage.tsx` (`?tab=watch-wizard`) — 3-step wizard: paste any deployed Somnia agent → discover its on-chain shape → pick one of three deterministic policy tiers (CONSERVATIVE / BALANCED / AGGRESSIVE) → publish + register + save Slack webhook + send test alert. Honest mode banner distinguishes real-time gating from observation.
- `dashboard/src/lib/discovery.ts` — pure read-only chain probes, ~7 RPC happy-path / ~20 worst-case. Detects EOA vs contract, ERC-165 / ERC-20 / ERC-721 fingerprints, Sentry-aware signal (via `SentryAgentRegistry.AgentRegistered` + `SentryQueue.Enqueued` topic-filtered logs, chunked at 999 blocks).
- `dashboard/src/lib/policy-recommender.ts` — pure deterministic recommender. Same `(report, nowSec)` → byte-identical 3-tier output forever. No clock reads inside; throws on `nowSec ≤ 0n`.
- `dashboard/src/lib/slack.ts` — `sendTestAlert` posts `application/x-www-form-urlencoded` to dodge CORS preflight; never throws (AbortError returns `{ok:false, status:0, errorMessage:'cancelled'}`); webhook URL never logged or rendered in full (`type="password"` input + `maskWebhookUrl` in all UI).
- IndexedDB v11 — additive `watchSubscriptions` store, no breaking change to v10.
- `dashboard/src/pages/WatchedPage.tsx` — new `Subscriptions` section (`id="subscriptions"`) lists saved watch subscriptions with mask + tier badge + Replace/Remove.
- `dashboard/src/components/AgentsCatalogPanel.tsx` — "Watch in wizard" deep-link per row writes `?address=…&tab=watch-wizard`; the wizard pre-fills on first mount.

### Added — Cockpit + Live Event Tape (Day 4)

- `dashboard/src/pages/CockpitPage.tsx` (`?tab=cockpit`) — showcase for `LLMEchoAgentV2` (deployed at `0x3E397269e4600e7Ef414Aff724D3F93689D1eE4F`): live iteration progress, 4 kill-switch panel rows (`paused` / iterations / balance / `canContinue`), recent iteration history. Owner-only "Trigger next iteration" button runs `(top-up if needed) → triggerInference(prompt)` with a two-click pre-confirm gate quoting the exact STT amount and target address. Sentry contracts remain funds-free; the 1-STT top-up goes to the agent.
- `dashboard/src/pages/TapePage.tsx` (`?tab=tape`) — unified chronological event feed across `SentryOracle` / `SentryQueue` / `SentryAgentRegistry` / `LLMEchoAgentV2`. Backfill ~5000 blocks (chunked at 999), 5-second incremental polling. Filters by agent address, event family (incl. Ownership), and time window (15m / 1h / 24h). `+N pending ts` indicator surfaces when timestamp resolution is still in flight (no silent exclusion). (removed in v0.10.2)
- `dashboard/src/lib/event-tape.ts` — shared polling driver + per-(contract, event) decoders. `EventRow.requestId` is first-class (no summary-string regex coupling). Registry rows attribute `actor` to the **registrar** wallet so the Tape's address filter hits the right party. (removed in v0.10.2)
- `dashboard/src/lib/agent-cockpit.ts` — split into `readAgentImmutables` (once on mount) + `readAgentMutables` (5s tick, 6 calls) + `readPendingFlag`. Per-tick RPC dropped 14 → 6.
- `dashboard/src/lib/rpcChunk.ts` — extracted the chunker out of `useAgentWatcher` so `lib/` no longer reverses into `hooks/`.
- `fetchAgentBackfill` + `fetchAgentTail` for single-agent scoping (Cockpit history was 4× over budget — now 6 chunks instead of 24).

### Changed

- `dashboard/src/lib/persistence.ts` — bumped `DB_VERSION` 9 → 11 (additive: `cachedAgents` in v10, `watchSubscriptions` in v11). All pre-existing store upgrade paths preserved.
- `dashboard/src/main.tsx` — viem HTTP transport now configured with `{ timeout: 8_000 }` so per-request RPC reads can't hang the UI.
- `dashboard/src/components/AgentsCatalogPanel.tsx` — `resolveRegistryAddress(chainId)` helper replaces direct `NETWORKS[…].registryAddress` lookup; chain pinned to Somnia Shannon via `usePublicClient({ chainId: SOMNIA_CHAIN_ID })`.

### Test surface

- forge: unchanged (no contract logic touched beyond the new `SentryAgentRegistry`).
- SDK: **104 / 104** passing (includes new `SENTRY_AGENT_REGISTRY_ABI` smoke test).
- Dashboard: **410 / 410** passing across 27 files — includes 39 new Day-3 + Day-4 tests (`discovery.test.ts`, `policy-recommender.test.ts`, `slack.test.ts`, `persistence-v11.test.ts`, `event-tape.test.ts`, `agent-cockpit.test.ts`, `rpcChunk.test.ts`). (`event-tape.test.ts` removed in v0.10.2 alongside the page; `agent-cockpit.test.ts` removed in v0.10.1.)
- CLI / Lean / TUI: unchanged.

### Codex collaboration

- Day 2, Day 3 design pass + Day 3 fixup confirmation pass all done via the `codex` CLI in read-only sandbox at `high` reasoning. Day 2 caught a per-RPC vs per-tier timeout misdesign; Day 3 caught a webhook URL leaked through `type="url"` and an AbortError that violated the "never throws" contract — both fixed before SHIP.

### Standing limits acknowledged

- Slack alerting is dashboard-resident polling — production would want a server-side relay.
- The Watch Wizard's observation mode is observation, not gating: for agents that don't call `SentryOracle.checkIntent` themselves, Sentry can publish + alert but cannot block on-chain execution. The wizard UI surfaces this distinction in Step 2.
- Subgraph not yet deployed — Ormi deploy key is operator-provided; the dashboard handles its absence by falling through to direct on-chain reads.

---

## v0.9.0 — 2026-05-30

Design-system hardening on top of v0.8.0. The dashboard moves from "polished console" to "branded operator tool": Geist + JetBrains Mono, a desaturated accent that survives long-session glare, Phosphor icons, framer-motion micro-interactions, and a flatter cockpit-7 information density. Contracts gain a 2-step policy ownership transfer; SDK, CLI, TUI, and Lean otherwise unchanged.

### Added
- Design-token layer in `dashboard/src/index.css` (`--bg`, `--surface`, `--surface-elev`, `--border`, `--text*`, `--accent`, `--success`, `--warn`, `--danger`) consumed via Tailwind theme extension.
- Geist (sans) + JetBrains Mono (mono) wired through `index.html` and `tailwind.config.js`; Inter retired.
- UI primitives under `dashboard/src/components/primitives/`: `Button` (3 intents × 3 sizes, tactile `:active`, aria-busy), `Input`, `Textarea`, `Alert`, `AddressChip`, `SkeletonLines`.
- Phosphor icons (`@phosphor-icons/react`) replace inline SVGs across nav, drawers, chips, and status pills.
- framer-motion drawer slide-in, alert fade, and tab crossfade, all gated by `useReducedMotion`.
- Tactile `:active` (`translate-y-px scale-[0.99]`) on buttons and chips.
- Network mismatch banner with one-click "Switch to Somnia testnet" via `wagmi.useSwitchChain`; write actions disabled until resolved.
- `og:` / `twitter:` meta tags (title, description, `/sentry.png`, card type) in `index.html` for shareable previews.
- Dashboard template gallery, intent simulator (`IntentSimulator`), and a spent-tracker helper in the SDK.
- 2-step `transferPolicyOwnership` in `SentryOracle.sol`: setter stages `pendingPolicyOwner`; new `acceptPolicyOwnership` completes the handoff; new `cancelPolicyOwnershipTransfer` aborts. New events `PolicyOwnershipTransferStarted` / `PolicyOwnershipTransferCancelled`; existing `PolicyOwnershipTransferred` preserved for indexers.
- Multi-network registry so the dashboard, SDK, and CLI resolve oracle/queue addresses per chainId.
- `examples/operator-alerts/` — NDJSON consumer recipe for the TUI `--json` stream.
- `design-taste-frontend` workflow + Phosphor icon set adopted as the brand-locked icon source.

### Changed
- Palette migration across 17 dashboard files (~280 class swaps); CSS bundle 25 KB → 17.5 KB as the legacy palette is purged.
- Queue and Publish sections flattened to cockpit-7 density: outer `Card` wrappers dropped, separation via `border-t border-sentry-border`; cards reserved for alerts and forms.
- Copy simplified to plain operator voice across Queue empty-state, Publish CTA hints, drawer tooltips, and disabled-button microcopy (no jargon, no parentheticals).
- Drawer width clamped at `clamp(28rem, 38vw, 36rem)`.
- Accent saturation `#3B82F6` → `#4B7FD1` (WCAG AA on text + focus-ring) to cut long-session glare against the navy `#0B1220` bg.
- framer-motion code-split out of the initial chunk to keep first paint lean.
- `WriteActions` extracted from `ActionModal` so the publish and queue flows share one submit pipeline.

### Fixed
- Focus trap + restore in `useFocusTrapAndEsc` now restores focus to the original trigger from virtualized rows; `stopImmediatePropagation` prevents stacked drawer-over-modal Esc double-close.
- Drawer double-shell regression from v0.8.0 removed.
- `PublishButton` and `WriteActions` assert `chainId === 50312` before submit so wallets on the wrong network can't post unresolvable txs.
- `humanizeError.ts` handles viem `ContractFunctionRevertedError` via `shortMessage` + `data.errorName` instead of falling through to the raw message.
- `PublishButton` preserves the original error object so revert decoding survives the humanize layer.
- Stale `DASHBOARD_VERSION` bumped `v0.6.0` → `v0.9.0`.

Test surface: Foundry tests on `PolicyLib` / `PolicyNormalizer` / `SentryOracle` / `SentryQueue` + property suites; vitest cases across SDK (compiler, ABI extraction, oracle/queue clients, intent-parity, event-store) / CLI / dashboard; plus Lean 4 theorems on `PolicyLib` + `SentryQueue`. Test files are gitignored in this public repo; the full suite is reproducible from source on request.

---

## v0.7.0 — 2026-05-29

Sprint 3 — closes the onboarding loop for non-developer policy authors. The dashboard now publishes policies from a form, joining the CLI and the `sentry-onboard` Claude Code skill as the third onboarding surface. Contracts are unchanged.

### Added — `dashboard/` Publish tab (Sprint 3)
- **New `Publish` tab** in the existing dashboard. Form on the left (identity / global caps / repeating targets+selectors), live POLICY.md preview + compile-status badge on the right, post-publish reveal with `bytes32 POLICY_ID` copy-as-Solidity-constant and a `policy.md` download for git tracking.
- **`dashboard/src/lib/policy-draft.ts`** — zod schema mirroring the v0.1 POLICY.md spec with form-friendly string types + a `renderPolicyMarkdown()` that emits a single fenced YAML block. Description text is sanitized for triple-backticks (CP51 nit) to prevent fence collision.
- **`dashboard/src/hooks/usePolicyDraft.ts`** — single state machine: schema parse first (field-path errors), then SDK `compilePolicy` (semantic errors). **Goes through the same compiler the CLI uses** — published `PolicyInput` is bit-identical to `sentry compile`.
- **`dashboard/src/components/publish/PublishButton.tsx`** — wagmi `useWriteContract` against `SentryOracle.publishPolicy`. Precomputes `policyId` via `policyIdFor(publisher, labelHex)` and shown in the UI before submit; after receipt, parses the `PolicyPublished` event and **fails loudly if the on-chain id ≠ the precomputed one** (catches label-encoding bugs — labels are `padHex({size:32, dir:"right"})`, never keccak'd).
- **`dashboard/src/components/publish/SelectorRow.tsx`** — tier `<select>` now resets `delaySeconds → 0` when leaving DELAYED (CP51 nit) so users can't get stuck in invalid form state with a disabled input.
- **`dashboard/src/hooks/useUrlState.ts`** — adds `tab: "queue" | "publish"` + `setTab` that closes any open drawer on switch.
- **`dashboard/tests/lib/policy-draft.test.ts`** — 12 vitests pinning: schema validation (addresses, signatures, label byte length, tier/delay legality, `1 ether` shorthand), single-fence emission, round-trip parity with SDK compile, multi-target/multi-selector compile, fence-collision regression (CP51).

### Why this exists
With v0.6.0 we had two onboarding surfaces (CLI and the `sentry-onboard` skill), both of which require terminal fluency. v0.7.0 adds the dashboard publish form for the persona who's accountable for what an agent does but doesn't write Solidity — founders, CFOs, DAO members, security leads. All three surfaces publish through the same `SentryOracle.publishPolicy` path with identical encoding, so a `policyId` produced by any surface is interchangeable with any other.

### Test surface
- forge: **87 / 87** (unchanged; contracts untouched).
- SDK: **49 / 49** (unchanged).
- CLI: **19 / 19** (unchanged).
- Lean: **8 / 8** (unchanged).
- dashboard: **12 / 12** (NEW — vitest harness added for `policy-draft`), typecheck + build clean (largest chunk 343 KB, no warning).
- TUI: typecheck + build clean.
- **Total: 167 tests + 8 Lean theorems = 175 checks**, all green.

### Codex collaboration
- CP51 plain-text critic: LGTM with nits. Both nits applied:
  - Description triple-backtick sanitization in `renderPolicyMarkdown`
  - `SelectorRow` tier change resets `delaySeconds` when leaving DELAYED

### Notes
- No new on-chain deploys for v0.7.0; the dashboard's publish flow calls the existing `SentryOracle` at `0x68d4B045…` directly via the user's wallet.
- The Publish tab is `?tab=publish`; the existing Queue tab is the default and unchanged.

---

## v0.6.0 — 2026-05-29

Two operator front-ends on top of v0.5.x. Contracts are unchanged; this release is pure off-chain tooling. **No custody added** — both surfaces are read + tx-relay only; signing stays in the operator's wallet.

### Added — `@sentry-somnia/sdk` event-store (Sprint 0)
- **`sdk/src/event-store.ts`** — `createEventStore({ publicClient, oracleAddress, queueAddress, oracleDeploymentBlock, queueLookbackBlocks? })` returns a unified live store of policy + queue events.
  - **Deep policy backfill** from `oracleDeploymentBlock` to head (policies are immutable + cheap to rescan, and the dashboard needs the full set to resolve `policyId → label`).
  - **Shallow queue backfill** of `head − queueLookbackBlocks` (default ~7 days at 1 block/sec).
  - **Chunked at 1000 blocks** to respect Shannon's `eth_getLogs` cap.
  - **Live tail** via `watchContractEvent` polling once the backfill drains.
  - **Header hydration** — `Enqueued` triggers an immediate `getRecordHeader(execId)` against the live state; the result re-checks the `disposed` flag after the await to prevent post-dispose mutation.
  - **Subscriber contract** is "live events only" — historical replay goes through `recentEvents(N)` so consumers can dump-then-subscribe without duplicates.
  - API: `init() / subscribe() / dispose() / listPolicies() / listPending() / getQueueRecord(id) / recentEvents(n) / cursor()` and an `onProgress({phase, current, total})` hook for UI surfaces.
- **`sdk/tests/event-store.test.ts`** — 6 vitests pinning: chunk math, dispose-time mutation race regression, subscribe ordering, header hydration, recentEvents windowing, listPending state filter.

### Added — `dashboard/` browser console (Sprint 1)
- **Vite + React 18 + TypeScript + Tailwind + wagmi 2.x + viem 2.x** workspace. Built artifact is the only output; no SSR.
- **Single Queue tab** with one row per `Enqueued` `execId`, drawer-on-click surfaces:
  - Read view: asker, policyId+label, deadline countdown, dispatcher, current state.
  - Write actions (wallet-gated): `dispatch` (asker or policy owner depending on tier), `veto` (policy owner, 32-byte UTF-8 reason — `padHex({size:32, dir:"right"})`, never keccak-hashed — mirrors the CLI), `expireIfStale` (anyone, after deadline).
- **`useEventStore` hook** wraps the SDK event-store with the URL-state hook for drawer focus + tab persistence.
- **`pnpm -C dashboard run dev | build | preview`** all clean; smoke confirmed at `localhost:4173` (title "Sentry Console", HTTP 200).
- Build size: 725 KB (the real `WriteActions.tsx` and `PolicyActions.tsx` are bundled — earlier placeholder shadows were removed during CP43b).

### Added — `tui/` operator terminal monitor (Sprint 2)
- **`sentry-tui` binary** — ink + react single-screen 3-pane monitor:
  - **Expirable-Now pane** — every `state == Pending && now > deadline` record, focused row highlighted, `[↑↓]` move, `[x]` fires `expireIfStale(execId)` on focused, `[s]` sweeps all (serial tx-per-row loop with per-row revert reporting; no contract batch entrypoint, so race losses surface explicitly).
  - **Aging-Pending pane** — one-line bucket count (`overdue / <1h / <1d / <7d / total`) for at-a-glance health.
  - **Live-Events pane** — chronological tail (newest at bottom), `[a/e/d/v]` filter (all / enqueued / dispatched / vetoed). Per-event color + truncated identifiers for terminal width.
  - **Header** shows current store cursor, wallet status (or `read-only` if no `PRIVATE_KEY`), and RPC host; **footer** shows the keymap.
- **`--json` mode** — skips the TUI entirely and streams one NDJSON `StoreEvent` per line to stdout (with bigints stringified via a replacer), for piping into operator scripts. Backfill progress goes to stderr; SIGINT cleanly disposes the store and exits 0.
- **Env knobs** — `PRIVATE_KEY` (optional; readonly mode if absent), `SENTRY_RPC`, `SENTRY_ORACLE`, `SENTRY_QUEUE`, `SENTRY_ORACLE_DEPLOY_BLOCK` (cap the policy backfill window), `SENTRY_QUEUE_LOOKBACK_BLOCKS` (cap the queue backfill window).
- **Live smoke** against Shannon replayed the known `PolicyPublished` from block 394500162 (label `llm-echo-dogfood`) end-to-end through the NDJSON stream.

### Changed — README
- New "Operator surfaces" section documenting the dashboard + TUI.
- Workspaces tree extended with `dashboard/` and `tui/`.

### Test surface
- forge: **87 / 87** (unchanged; contracts untouched).
- SDK: **49 / 49** (was 42; +7 event-store).
- CLI: **19 / 19** (unchanged).
- Lean: **8 / 8** (unchanged).
- dashboard: typecheck + build + preview clean (no test runner wired yet — UI-only).
- TUI: typecheck + build clean, live smoke against Shannon confirms NDJSON stream.
- **Total: 155 tests + 8 Lean theorems = 163 checks**, all green.

### Codex collaboration
- CP42 (SDK event-store), CP43/CP43b (dashboard placeholder-shadow fix), CP44 (TUI critic) — all plain-text reviews, no schema-validated workflow critics this release.

### Notes
- v0.5.1's oracle/queue at `0x68d4B045…` / `0x98A3f7C3…` remain live; v0.6.0 does not redeploy.
- Dashboard `--dev` requires raising the user-level `fs.inotify.max_user_watches`; `--build && --preview` does not.
- The TUI's `--json` mode pairs naturally with `jq`, `tee`, and operator alerting scripts (`./tui/dist/index.js --json | jq -c 'select(.type=="Vetoed")'`).

---

## v0.5.1 — 2026-05-28

Dogfood + tightening. Three small things on top of v0.5.0; no breaking changes.

### Added — LLM-loop dogfood
- **`examples/llm-echo/`** — separate forge sub-project (own `foundry.toml`, symlinks to `../../contracts/{lib,src}` for shared types). Contains `EchoTarget.sol` (state-mutating call sink) + `LLMEchoAgent.sol` (Somnia agent that calls `inferString` → decodes verdict → calls `oracle.checkIntent` → dispatches). Three-phase `deploy.sh` orchestrator (target → publish policy → agent). `README.md` with the reproduction recipe.
- **Verified live on Shannon**: trigger tx `0x0be0ee5625c3c927e686d41c2a876df4612ec273817efc214b1f66d2745df2de` → real LLM consensus (verdict `"SAFE"`) → real `oracle.checkIntent` returned `(true, 0)` → real `EchoTarget.recordVerdict(2797562, "SAFE")` mutated state, `count = 1`. The Sentry-specific code is bannered (`// ============ SENTRY INTEGRATION ============`) and is five lines.
- **Deposit-sizing finding**: Somnia's `platform.getRequestDeposit()` returns the validator-reward budget but doesn't include the LLM execution cost. 0.12 STT (JSON-API default) is insufficient for `ILLMAgent.inferString` — validator submits a Failed response with payload `"insufficient budget for execution cost"`. Empirically, **1 STT works** for short prompts with the default subcommittee. Documented in `LLMEchoAgent.sol`'s NatSpec and in the example README. Minimum is undocumented by Somnia; will tighten if/when they expose an agent-specific deposit oracle.
- **Live addresses (testnet)**: EchoTarget `0x11A92b678147664FC597Ef78Db6CC2F5EB23b21f`, LLMEchoAgent `0x4C31C239Ee36D60B72F94905D45ffA5358310E22`, policyId `0xb4bd701e2eee00050def9b5b1ec59bbcde6fcbc7b3ed597dcac4ac8bd59f3bab`.

### Added — Section B deepenings (architecture review → workflow)
- **B5: Intent TS↔Solidity parity test.** New `sdk/tests/intent-parity.test.ts` (5 vitests) pins the TS `Intent` interface to the Solidity `Intent` struct via the auto-extracted `SENTRY_ORACLE_ABI`. Asserts tuple length + every field's `name` and `type`, then asserts viem byte-level encoding parity between a hand-written TS spec and the ABI-sliced spec on an Intent with distinguishing values (so any silent reorder fails the bytes match). Round-trip decode sanity check. Top-of-file comment documents the intentional friction: editing `types.ts` requires updating the test's literal mirror.
- **B6: kill `perCallCap` alias.** `sdk/src/policy-compiler.ts` previously accepted both `valueCapPerCall` and `perCallCap` as silent aliases. Hard-removed: dropped from `RawSelector` interface, AJV schema, normalize line. `additionalProperties: false` now rejects any POLICY.md still using `perCallCap` with a clear "unknown property" error. +1 negative test in `policy-compiler.test.ts` locks the removal. `policy-builder.ts` fluent API is a separate surface and intentionally untouched.
- **B7: surface Sentry integration in `LLMEchoAgent.sol`.** Added `// ============ SENTRY INTEGRATION ============` banner around the 5 Sentry-specific lines + closing `// ===== END SENTRY INTEGRATION =====`. Zero code change; readers see at a glance what's Sentry and what's Somnia plumbing.

### Test surface
- forge: **87 / 87** (unchanged).
- SDK: **42 / 42** (was 36; +5 intent-parity, +1 perCallCap-rejection).
- CLI: **19 / 19** (unchanged).
- Lean: **8 / 8** (unchanged).
- **Total: 148 tests + 8 Lean theorems = 156 checks**, all green.

### Codex collaboration
- CP41 workflow: parallel design + parallel implement + verify barrier for B5/B6/B7. No regressions vs v0.5.0 baseline.

---

## v0.5.0 — 2026-05-28

Adds the opt-in **`SentryQueue`** coordination layer (still no custody) and a small `SentryOracle.policyHealth` view to support it. The three Lean queue theorems dropped in v0.4 return, retargeted to the new contract.

### Added
- **`contracts/src/SentryQueue.sol`** — coordination layer for `TIER_DELAYED` and `TIER_VETO_REQUIRED` intents. Asking agent enqueues, waits the policy-configured delay, then dispatches (only the asker for DELAYED, only `oracle.policyOwner(policyId)` for VETO_REQUIRED). Policy owner can `veto` in the window; anyone can `expireIfStale` after the 7-day commit deadline. **Holds no funds, owns no agents, executes no calls** — purely metadata + state-machine + audit-trail.
- **`SentryOracle.policyHealth(policyId) → (paused, expiresAt)`** — minimal new view added to support SentryQueue dispatch re-validation. Doesn't require `spentToday` (the VETO_REQUIRED dispatcher is the policyOwner, who doesn't have the asker's spend state).
- **`contracts/test/SentryQueue.t.sol`** — 20 tests covering: enqueue legitimacy (rejects IMMEDIATE / illegal intents), enqueue happy paths for both DELAYED and VETO_REQUIRED tiers, dispatch authorization splits, timing-window enforcement (TooEarly / PastDeadline / NotPending), policy-revalidation reverts (PolicyChanged "PAUSED" / "EXPIRED"), veto authorization + state-machine terminal-once, expireIfStale permissionless after deadline. Two of the dispatch + enqueue tests also assert event-arg correctness (`calldataHash`, `intentHash`).
- **`verification/lean/Sentry/Queue.lean`** + 3 retargeted theorems in `Sentry/Theorems.lean`:
  - **T6 `dispatch_too_early`** — calling dispatch while `t < earliestCommitAt` returns `TOO_EARLY`.
  - **T7 `dispatch_in_window`** — dispatch in the valid window returns `ok` with `state = COMMITTED`.
  - **T8 `dispatch_after_veto_fails`** — dispatch after veto returns `NOT_PENDING` regardless of timing.
- **`sdk/src/queue-client.ts`** — viem wrapper `createQueueClient({publicClient, walletClient?, queueAddress})` with `enqueue / dispatch / veto / expireIfStale / getRecord / getRecordHeader / nextExecId`. State enum decoded from numeric to string union.
- **CLI:** `sentry queue:status`, `sentry queue:dispatch`, `sentry queue:veto`, `sentry queue:expire` (9 commands total). Preflight now also surfaces `SENTRY_QUEUE` address + warns if malformed.
- **Deploy.s.sol** deploys both contracts in one broadcast; artifact carries `sentryOracle` and `sentryQueue` fields.

### Changed
- **`contracts/foundry.toml`** — added `via_ir = true`. The `enqueue` function copies an `Intent` struct (with unbounded `bytes data`) into storage and emits a 7-arg event — without via-IR, this hits stack-too-deep at compile.
- **`SDK index.ts`** — exports `queue-client.ts` alongside `oracle-client.ts`.
- **`README.md`, `verification/lean/README.md`** — updated for the two-contract surface and 8 theorems. The "one-line plug-in" oracle-only story remains the primary integration; queue is documented as opt-in for tier-aware integrators.

### Test surface
- Contracts: **87 forge tests** (was 65 in v0.4; +20 SentryQueue, +2 SentryOracle.policyHealth).
- SDK: **36 vitest tests** (was 28; +3 new ABI / event assertions for SentryQueue, +5 queue-client state-decoding tests added in CP40).
- CLI: **19 vitest tests** (unchanged — the 4 new queue commands are thin wrappers over the SDK).
- Lean 4: **8 theorems** (was 5; +3 queue state-machine theorems).
- **Total: 142 tests + 8 Lean theorems = 150 checks**, all passing.

### Live on Shannon testnet
- SentryOracle: `0x68d4B045B24F8d1012974b9d34684cA5aeD11DDf` (new address — bytecode changed when `policyHealth` was added)
- SentryQueue:  `0x98A3f7C38D19edF1ddA7E3bc38fa4B935aD590D5`
- v0.4's oracle at `0xB436eeFB5cf8D2b0BBEC18Ca7AB5f4833042cCff` is now stale and should not be referenced by new integrators.

### Why
v0.4 left `TIER_DELAYED` / `TIER_VETO_REQUIRED` integrators with `(false, "REQUIRES_DELAY" | "REQUIRES_VETO")` and no standard waiting/veto module — they'd have to roll their own queue. v0.5 fills that gap with a contract that mirrors what the v0.3 vault offered for tier-aware execution, minus the custody. The queue is opt-in: integrators that only need IMMEDIATE never touch it.

### Codex collaboration
- CP38: SentryQueue ABI design — Codex BLOCKED on missing paused/expired re-validation primitive on SentryOracle.
- CP38b: revised with `policyHealth` extension + RecordHeader nit + intentHash event nit. LGTM.
- CP39: implementation review of SentryQueue + policyHealth. LGTM with 2 NITs (expanded header + event-arg test assertions). Both applied.

### Forward
- v0.6+: ownership transfer for SentryOracle policies. Currently `policyOwner` is permanent at publish; a `transferPolicyOwnership` flow would let teams hand off veto authority cleanly.
- v0.6+: dogfood — wire a real Somnia agent through the oracle + queue end-to-end on Shannon.

---

## v0.4.0 — 2026-05-28

**Breaking.** The vault is gone. Sentry is now a single no-custody on-chain contract: `SentryOracle.sol`. Any agent calls `oracle.checkIntent(policyId, intent, mySpentToday)` synchronously and dispatches itself. Sentry holds no funds, owns no agents, executes no calls.

### Removed
- **Vault contracts**: `contracts/src/Sentry.sol`, `contracts/src/SentryAgent.sol`, `contracts/src/VetoQueue.sol`, `contracts/src/interfaces/ISafeAgentExecutor.sol`.
- **Vault tests**: `contracts/test/Sentry.t.sol`, `SentryAgent.t.sol`, `SentryAgentReentrancy.t.sol`, `Hostile.t.sol`, `VetoQueue.t.sol`, `properties/VetoQueueProperties.t.sol`, `invariants/` (whole directory: Handler.sol, SentryInvariants.t.sol).
- **Vault-only mocks**: `contracts/test/mocks/MockAgentPlatform.sol`, `contracts/test/mocks/MaliciousTarget.sol`.
- **Vault CLI commands**: `sentry exec`, `sentry authorize`, `sentry revoke`, `sentry veto`, `sentry pending`, `sentry receipt`, `sentry tail`, `sentry tui`, `sentry logs`. The whole `cli/src/tui/` directory (~1275 LOC, 11 ink components). The `--to oracle` flag on `sentry push` is now the only mode (vault path dropped).
- **Vault SDK surface**: `SENTRY_ABI`, `agent-client.ts`, `receipt-watcher.ts`, `ExecReceipt` type, `RECEIPT_STATUS` const.
- **CLI deps**: dropped `ink`, `ink-spinner`, `ink-text-input`, `react`, `@types/react`, `ink-testing-library` (47 transitive packages removed).
- **Lean theorems**: 3 VetoQueue theorems (`enqueue_then_canCommit_too_early`, `enqueue_then_canCommit_window`, `markCommitted_after_veto_fails`) and the entire `Sentry/VetoQueue.lean` module. Will return when `SentryQueue.sol` ships (v0.5+).

### Changed
- **`contracts/script/Deploy.s.sol`** — deploys only `SentryOracle` now (single CREATE; ~half the gas of the v0.3 dual-deploy).
- **CLI surface**: `sentry compile`, `sentry push <path> --label <name>` (publishes to oracle, auto-detects update vs publish), `sentry policyid <label>`, `sentry inspect <intent.json>`, `sentry preflight`. Five commands total, all relevant to the oracle workflow.
- **`cli/src/lib/env.ts`** — `requireSentry()` dropped; only `requireSentryOracle()` remains. `EnvSettings.sentry` field removed.
- **`cli/src/lib/decode.ts`** — known ABIs are `SENTRY_ORACLE_ABI` + `ERC20_ABI`.
- **`contracts/deployments/50312.json`** — `sentry` field removed; only `sentryOracle` remains.
- **Docs**: README, SUBMISSION, `docs/INTEGRATION-IN-20-MIN.md`, `docs/ARCHITECTURE.md`, `verification/lean/README.md` all rewritten to drop the vault narrative entirely. The "two integration models" framing from v0.3 is gone — there's only the oracle model now.

### Test surface
- Contracts: **65 forge tests** (was 144 in v0.3; -79 vault/invariant/hostile/property/SentryAgent tests). Now: `PolicyLib.t.sol`, `PolicyNormalizer.t.sol`, `SentryOracle.t.sol`, plus `properties/PolicyLibProperties.t.sol` and `properties/PolicyNormalizerProperties.t.sol`.
- SDK: **28 vitest tests** (was 36; -8 abi+agent-client tests for deleted surface).
- CLI: **19 vitest tests** (was 32; -13 TUI tests).
- Lean 4: **5 theorems** (was 8; -3 VetoQueue theorems).
- **Total: 112 tests + 5 Lean theorems = 117 checks**, all passing.

### Live deployment
- SentryOracle: `0xB436eeFB5cf8D2b0BBEC18Ca7AB5f4833042cCff` (Shannon testnet, unchanged from v0.3 — same bytecode, same address, still the live integration point).

### Why
The user's directive: *"Sentry should not hold funds at all."* The v0.3 vault was a custody-bearing executor (deposit, withdraw, daily-spend tracking, `target.call{value}` from Sentry's own balance). The oracle model added in v0.3 was the right architecture for "plug into any agent" — but shipping it *alongside* the vault meant two integration stories, two trust models, two CLI surfaces, two SDK clients. v0.4 collapses to one: Sentry is the oracle. Anyone who wants the vault pattern can fork from the v0.3.0 git tag.

### Forward
- v0.5: `SentryQueue.sol` — coordination-only (no custody, by definition) module for asking agents that want to honor `TIER_DELAYED` / `TIER_VETO_REQUIRED` without rolling their own waiting queue. `policyOwner` is the natural veto authority.
- v0.5 also re-adds the 3 Lean theorems against the queue's state machine.

### Codex collaboration
- CP37 (pending): cross-cut review of the vault excision — confirm no orphan imports, no dead refs, every doc/test honest about what shipped.

---

## v0.3.0 — 2026-05-28

Two big surface changes shipped together:

1. **Repository cleanup** — all demo, mock, and showcase code removed from `contracts/src/`. Sentry now ships as a pure on-chain policy primitive against real Somnia testnet; test-only fixtures live under `contracts/test/mocks/` (never deployed).
2. **Oracle pivot (added)** — new `SentryOracle.sol` ships *alongside* the existing vault as a second integration model. Any Somnia agent can `oracle.checkIntent(policyId, intent, spentToday)` synchronously inline (no async callback, no deposit, atomic with the dispatch) — the "one-line plug-in" model. The vault's `SentryAgent` base + `authorizeAndExecute` flow remains untouched for custody-bearing integrators. Both models share `PolicyLib`, `PolicyTypes`, `PolicyNormalizer`, the POLICY.md compiler, and the 8 Lean theorems.

### Added — SentryOracle (the plug-in model)
- `contracts/src/SentryOracle.sol` — shared on-chain policy registry. `publishPolicy(label, input) → policyId` (publisher-namespaced, stable across updates), `updatePolicy(policyId, input)` (only by publisher), `checkIntent(policyId, intent, spentToday) → (ok, reason)` (safe-by-default: returns `ok=true` only for legal + `TIER_IMMEDIATE` selectors; returns `(false, "REQUIRES_DELAY" | "REQUIRES_VETO")` for non-immediate tiers so naive consumers cannot silently bypass the policy author's queue intent), `tierAndDelay` (escape hatch for tier-aware consumers), `policyIdFor` (pure helper).
- `contracts/test/SentryOracle.t.sol` — 17 tests covering publish + emit + collision, per-publisher namespacing, owner-only update, every PolicyLib reason passthrough (TARGET_NOT_ALLOWED, DAILY_CAP, VALUE_CAP, BAD_CALLDATA), daily-cap boundary, both REQUIRES_DELAY / REQUIRES_VETO paths, legality-precedence-over-tier, PolicyNotFound revert, policyIdFor parity with on-chain.
- `contracts/script/Deploy.s.sol` extended to deploy both Sentry + SentryOracle in one broadcast and write `deployments/$CHAINID.json`.
- `sdk/src/oracle-client.ts` — thin viem wrapper (`createOracleClient`) + pure `policyIdFor(publisher, label)`. Reference vector pinned against on-chain `policyIdFor` result.
- `cli/src/cmd/policy.ts` — `pushCmd` accepts `--to oracle --label <name>`; auto-detects publish-vs-update via on-chain `policyOwner` read. New `sentry policyid <label>` helper.
- `docs/INTEGRATION-IN-20-MIN.md` — opens with "two integration models" and adds full "Oracle model — one-line plug-in" section with Solidity + TS examples. Daily-spend-by-UTC-day pattern documented.
- **Live on Shannon testnet** (verified in-session): Sentry `0x5d61182Ed3eb5A5dD46B2B8B0724a91Af92ac0D2`, SentryOracle `0xB436eeFB5cf8D2b0BBEC18Ca7AB5f4833042cCff`. End-to-end published a real policy via `sentry push --to oracle`, verified `policyOwner` set on chain.

### Removed — Repository cleanup

- `contracts/src/showcase/` (whole directory)
- `contracts/src/examples/` (whole directory)
- `contracts/src/adapters/` (whole directory)
- `contracts/script/DeployDemoLive.s.sol`, `DeployDemoMock.s.sol`, `SeedDemoBalances.s.sol`, `SeedPolicy.s.sol`, `AuthorizeBot.s.sol`, `TriggerRefill.s.sol`, `SimulateCallback.s.sol`
- `contracts/test/DemoLLMAgent.t.sol`, `DailyRefillBot.t.sol`, `MockDreamDEX.t.sol`, `DelayedAgentExample.t.sol`, `Integration.t.sol`, `EnumDrift.t.sol`
- `cli/src/cmd/live.ts`, `cli/src/cmd/keeper.ts`
- SDK ABIs: `DAILY_REFILL_BOT_ABI`, `AGENT_EXAMPLE_ABI`, `MOCK_DREAM_DEX_ABI`, `MOCK_ERC20_ABI`, `MOCK_AGENT_PLATFORM_ABI`
- `docs/REAL_PLATFORM_DEMO.md`, `docs/DEMO_RUNBOOK.md`

### Changed
- `contracts/test/SentryAgent.t.sol` + `SentryAgentReentrancy.t.sol` rewritten to use the generic `MockTarget` test fixture (replacing the deleted ERC20+DEX-flavoured tests). Concrete `SentryAgent` subclasses for testing are now inlined as `BaseOnlyAgent` / `OverriddenAgent` / `TestAgent`.
- `cli/src/cmd/logs.ts` — dropped `--bot` flag (was DailyRefillBot-specific). Now strictly tails Sentry events.
- `cli/src/lib/decode.ts` — known-ABIs set trimmed to `SENTRY_ABI` + `ERC20_ABI`. No demo/mock ABIs.
- `sdk/scripts/extract-abis.ts` — extracts only `SENTRY_ABI` from forge; `ERC20_ABI` is now a hand-curated standard subset (not derived from the deleted `MockERC20`).
- `README.md`, submission writeup, `docs/*` — purged demo references; replaced the "deploy the demo stack" sections with a single `forge script Deploy.s.sol --legacy --gas-estimate-multiplier 2000` invocation against real testnet.

### Test surface
- Contracts: **144 forge tests** (was 160 in v0.2.0; -33 demo-specific tests deleted, +17 SentryOracle).
- SDK: **36 vitest tests** (-5 demo-ABI, +1 ERC20 standard-shape, +3 oracle-client).
- CLI: **32 vitest tests** (unchanged).
- Lean 4: **8 theorems** (unchanged).
- **Total: 212 tests + 8 Lean theorems = 220 checks**, all passing.

### Why
v0.2.0 shipped Sentry plus a full demo stack (MockDreamDEX, MockERC20, DemoLLMAgent, DailyRefillBot) so the README's one-command demo worked without external setup. That stack obscured the actual production surface — readers had to mentally separate "Sentry the primitive" from "this DEX/bot scaffolding". CP33 (the cleanup) collapsed the surface to the primitive plus the integration template.

CP34-CP36 then added the oracle pivot. The trigger: investigation confirmed Somnia's AgentRegistry is curated until Phase 2 (2026 per their public docs), so "Sentry-as-a-registered-Somnia-agent" can't ship until then. The substantive answer to "plug-in for any agent" turned out to be a shared on-chain primitive any agent calls directly — `SentryOracle.checkIntent(policyId, intent, spentToday)` — atomic, free per call (just gas), no validator round-trip. The same `PolicyLib` + POLICY.md + Lean theorems back both models. The vault still exists for users who want Sentry to hold custody.

### Codex collaboration
- CP33: in-session cleanup of demo/showcase surface.
- CP34: SentryOracle ABI design — Codex blocked on tier fail-open, recommended `tierAndDelay` view.
- CP34b: revised ABI with safer-by-default `checkIntent` (returns `(false, "REQUIRES_DELAY"/"REQUIRES_VETO")` for non-immediate tiers) — LGTM.
- CP35: implementation review of `SentryOracle.sol` + 17 tests — LGTM with 3 optional boundary-test nits, applied.
- CP36: cross-cut review of deploy + SDK + CLI + docs — BLOCKED on two doc bugs (lifetime spend tracker, missing SDK export of `encodeLabel`).
- CP36b: confirmed both doc fixes — LGTM.

---

## v0.2.0 — 2026-05-28

Major surface expansion: integration fluidity, full-screen TUI, real-platform ABI compatibility, fork-verified end-to-end demo, expanded test surface.

### Integration fluidity
- `contracts/src/SentryAgent.sol` — new optional abstract base contract. Inherit and override one function (`_buildIntent`) to integrate; the base handles request/response plumbing, platform-only callback check, unknown-request rejection, prompt-hash bookkeeping, and the default IMMEDIATE dispatch.
- `_dispatchToSentry(Intent)` virtual hook on `SentryAgent` — subclasses for DELAYED/VETO_REQUIRED tiers override to call `sentry.authorize` (queue) instead of `authorizeAndExecute` (atomic). Default = IMMEDIATE.
- `contracts/src/examples/AgentExample.sol` refactored from 93 → 67 lines; demonstrates the IMMEDIATE pattern.
- `contracts/src/examples/DelayedAgentExample.sol` — new; demonstrates the DELAYED/VETO_REQUIRED pattern with a `_dispatchToSentry` override.
- `sdk/src/agent-client.ts` — `createAgentClient({publicClient, walletClient, agentAddress, sentryAddress})` helper. `planAndExecute`, `watchPlanExecuted`, `getReceipt`. Works in read-only mode without `walletClient`.

### Real Somnia agent platform ABI
- `contracts/src/interfaces/ISomniaAgentPlatform.sol` rewritten to match the live ABI:
  - `ResponseStatus { None=0, Pending=1, Success=2, Failed=3, TimedOut=4 }` (was `{Success=0, Failure=1, Timeout=2}`).
  - `AgentResponse { validator, result, status, receipt, timestamp, executionCost }` (was `{data, reportedCost}`).
  - Full 14-field `AgentRequest` with subcommittee, responses, threshold, deadline, consensusType, remainingBudget.
  - `IAgentRequester`-style platform interface with `createAdvancedRequest`, `getRequest`, `hasRequest`, `getRequestDeposit`, `getAdvancedRequestDeposit`.
  - Canonical `ILLMAgent { inferString, inferNumber, inferChat, inferToolsChat }`.
- `contracts/src/constants/SomniaTestnet.sol` with verified `LLM_INFERENCE_AGENT_ID = 12847293847561029384` (cross-referenced from Kali-Decoder/Somnia-Agentic-examples + on-chain trace).
- `MockAgentPlatform` updated to mirror the real shapes; emits the canonical `RequestCreated`/`RequestFinalized` events.

### Real-platform demo
- `contracts/src/showcase/DemoActionTarget.sol` — controlled state-mutating target; `recordVerdict(uint256,string)` with one-write-per-request guard.
- `contracts/src/showcase/DemoLLMAgent.sol` — `SentryAgent` subclass using real `inferString` with `allowedValues = [SAFE, RISK, REVIEW]`.
- `contracts/src/showcase/DailyRefillBot.sol` — refactored from mock-platform-only to real `inferString` with `allowedValues = [REFILL, SKIP]`. The LLM picks; the bot constructs swap calldata deterministically (agent never controls calldata).
- `contracts/script/SimulateCallback.s.sol` — forked-anvil helper: impersonates the real platform address and delivers synthetic SUCCESS callback.
- `contracts/script/DeployDemoLive.s.sol` rewritten to deploy Sentry + DemoActionTarget + DemoLLMAgent and write a machine-readable artifact to `contracts/deployments/$CHAINID.json`.
- `docs/REAL_PLATFORM_DEMO.md` — full runbook for the forked-anvil + impersonation path AND the live-testnet path.
- **End-to-end fork demo verified in-session**: real Somnia testnet platform bytecode accepted `createRequest`, real validator subcommittee selected, synthetic callback delivered, Sentry receipt status=OK.

### CLI
- `sentry tui` — full-screen ink-rendered dashboard (vault status, pending queue with live countdowns, last 20 receipts with decoded calldata, live event stream, drill-down modal, owner-veto). ~1275 LOC across 11 ink components.
- `sentry live` — one-command demo: preflight → forge deploy → trigger via `cast send` → wait for callback (90s timeout) → decoded receipt + target state. `--fork` flag for in-session anvil-fork verification.
- `sentry preflight` — env + wallet checker: verifies PRIVATE_KEY/DEPLOYER_PK shape, RPC reachability, chainId match, balance against a configurable floor (default 0.5 STT); prints Somnia faucet links when low. Catches misconfig before `sentry live` wastes a deposit.
- Root `.env.example` — labeled template (PRIVATE_KEY, DEPLOYER_PK, SOMNIA_TESTNET_RPC, SOMNIA_AGENT_PLATFORM, LLM_INFERENCE_AGENT_ID, optional SENTRY) with faucet URLs in comments.
- Total CLI commands: 15.

### Test surface
- Contracts: 160 forge tests (was 104). +5 DemoLLMAgent, +8 SentryAgent, +4 DelayedAgentExample, +2 EnumDrift, +1 SentryAgentReentrancy (CP30 regression), +9 invariants, +27 properties; DailyRefillBot rewritten (9 tests).
- SDK: 37 vitest tests (was 29). +8 agent-client.
- CLI: 32 vitest tests (was 11). +13 TUI, +8 preflight.
- Lean 4: 8 theorems still proven (unchanged from v0.1.0).
- **Total: 229 tests + 8 Lean theorems = 237 checks**, all passing.

### Formal verification & invariants
- 9 stateful Foundry invariants via actor-based handler: receipt status domain, terminal-once, nextExecId monotonic, no orphan receipts, policy violations don't increment nextExecId, VETO_REQUIRED owner-only, terminal states irreversible, queued daily cap not bypassable, expired execIds status=5.
- 27 property fuzz tests across PolicyLib, VetoQueue, PolicyNormalizer.
- Lean 4 model verification suite untouched; 8 theorems still proven without `sorry`.

### Codex collaboration
- 30 checkpoints (CP1 through CP30). CP25 master plan for the three v0.2 tracks; CP25-bis pivot on real-ABI fidelity; CP26-28 combined adversarial review; CP29 v0.2 design pass; CP30 final ship review.

### Roadmap (v0.3+)
- DailyRefillBot full `inferToolsChat` integration (currently uses `inferString` shortcut).
- Per-agent reputation aggregator queryable as `Sentry.scoreForAgent(agentId, taskClass)`.
- Multi-hop receipt provenance.
- Stream Studio firehose subscription.
- Cross-chain veto via LI.FI for multi-chain agents.
- `kashaf12/mandate` JSON → POLICY.md migration tool (if community demand appears).

---

## v0.1.0 — 2026-05-27

First public release. Targets the Somnia Agentathon (May 18 – June 11, 2026).

### Contracts (`contracts/`)
- `Sentry.sol` — two-phase on-chain executor (`authorize` / `execute` / `authorizeAndExecute`), policy enforcement at `validate` time, receipt emission at commit time, owner-veto + auto-expire.
- `PolicyTypes.sol` — `TargetRule`, `SelectorRule`, `PolicyInput`, storage `Policy`, `Intent`, `ExecReceipt`, tier constants.
- `PolicyLib.sol` — pure validation library; selector-mismatch / value-cap / daily-cap / target-allow / selector-allow / paused / expired checks.
- `PolicyNormalizer.sol` — `PolicyInput memory → Policy storage` with structural invariants (no duplicates, no zero target/selector, tier-delay consistency, `MAX_TARGETS=20`, `MAX_SELECTORS_PER_TARGET=10`).
- `VetoQueue.sol` — state machine: `Pending → Committed | Vetoed | Expired`. Commit-window default 7 days.
- `interfaces/ISafeAgentExecutor.sol` — the public spec other implementations can target.
- `interfaces/ISomniaAgentPlatform.sol` — mirrors `createRequest` shape + `AgentResponse` / `AgentRequest` / `ResponseStatus`.
- `examples/AgentExample.sol` — canonical integration template (plan → callback → authorizeAndExecute).
- `showcase/DailyRefillBot.sol` — continuous policy-enforced refill loop; per-deployment `(tokenIn, tokenOut, floor, refillAmount, minAmountOut, minPeriod)`.
- `adapters/MockERC20.sol` + `adapters/MockDreamDEX.sol` — self-contained mocks for tests + demo.

### Scripts (`contracts/script/`)
- `Deploy.s.sol` — bare Sentry deploy with STT preflight.
- `DeployDemoMock.s.sol` — full mock stack.
- `DeployDemoLive.s.sol` — full stack wired to real Somnia agent platform (fails hard without `LLM_INFERENCE_AGENT_ID`).
- `SeedPolicy.s.sol`, `AuthorizeBot.s.sol`, `SeedDemoBalances.s.sol`, `TriggerRefill.s.sol`.

### SDK (`sdk/`)
- POLICY.md compiler (markdown → fenced YAML → canonical `PolicyInput`) with strict schema validation and tier-delay invariants.
- `PolicyBuilder` fluent API for programmatic policy construction.
- Auto-generated ABIs (6 + `ERC20_ABI` alias) via `scripts/extract-abis.ts`.
- `watchReceipts` helper for streaming Sentry events.

### CLI (`cli/`)
- 12 commands: `compile`, `push`, `authorize`, `revoke`, `exec`, `receipt`, `tail`, `veto`, `pending`, `keeper`, `logs`, `inspect`.
- Calldata inspector decodes against known ABIs (Sentry, DailyRefillBot, MockDreamDEX, MockERC20).
- Keeper preflight skips on `AboveFloor` / `PeriodGuard` to avoid wasted STT on predictable reverts.
- Logs backfill sorts by `(blockNumber, logIndex)`.

### Tests
- 102 forge tests across 8 suites (PolicyLib, PolicyNormalizer, VetoQueue, Sentry, Hostile, MockDreamDEX, DailyRefillBot, Integration).
- 29 SDK vitest tests (compiler, builder, ABI extraction).
- 11 CLI vitest tests (compile, inspect, decode, env loader).
- Total: **142 green** at v0.1.0.

### Docs
- Root `README.md` — developer-focused pitch with the full loop in <20 lines.
- `docs/PRIOR_ART.md` — credits `kashaf12/mandate`, Synthesis Mandate, RageQuit Escrow.
- `docs/POLICY-COMPAT.md` — POLICY.md v0.1 schema + tier semantics + porting notes.
- `docs/INTEGRATION-IN-20-MIN.md` — 4 × 5-min sections.
- `docs/ARCHITECTURE.md` — module map + ASCII flow diagrams + storage layout.
- `docs/DEMO_RUNBOOK.md` — reproducible 2-minute demo script (mock + live mode).
- Security review document — known limitations + scope of v0.1.0 (available on request).
- `LICENSE` — MIT.

### Formal verification (`verification/lean/`)
- Lean 4.13.0 + Lake 5.0 project mirroring `PolicyLib.validate` and `VetoQueue` state machine as pure Lean functions.
- 8 theorems proven without `sorry` or `admit`: 5 PolicyLib (paused/expired precedence, target-not-allowed, value-cap-strict, monotone-in-spentToday) + 3 VetoQueue (too-early, in-window, veto-then-commit fails).
- No Mathlib dependency; stdlib only. Clean `lake build` in ~1.8s.
- README explicitly scopes out UTC-day bucketing, VETO_REQUIRED owner guard, ABI/EVM memory semantics, and the full vault wiring — those remain covered by Foundry tests and future audits.

### Codex collaboration
- 24 checkpoints across the build (CP1 through CP24 spanning research, ideation, plan-writing, scaffold, 14 task implementations + reviews, and Lean 4 verification design + fidelity review).

## Roadmap

### v0.2 (post-Agentathon)
- Per-policy configurable `commitWindowSeconds`.
- CI `slither` + `forge coverage --fail-under 90` gates.
- Optional `kashaf12/mandate` JSON → POLICY.md migration tool (if demand appears).
- Real adapter against finalized dreamDEX ABI.
- Per-agent reputation aggregator queryable as `Sentry.scoreForAgent(agentId, taskClass)`.

### v0.3+
- Multi-hop agent chains with receipt provenance.
- Optional Stream Studio firehose subscription for receipts.
- Cross-chain veto via LI.FI bridge for multi-chain agents.
