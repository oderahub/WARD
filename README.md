<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="design/logo/ward-wordmark-dark.png">
  <img alt="Ward" src="design/logo/ward-wordmark-light.png" width="420">
</picture>

<h3>On-chain policy oracle + opt-in delay/veto queue for Somnia agents</h3>

<p>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <a href="https://shannon-explorer.somnia.network/address/0x3C7bF90f243d670a01f512221d9546e09fEaCC9c"><img alt="Network: Somnia Shannon" src="https://img.shields.io/badge/Somnia-Shannon%20testnet-blueviolet"></a>
  <a href="#test-surface"><img alt="Tests: 950+ passing" src="https://img.shields.io/badge/tests-950%2B%20passing-brightgreen"></a>
  <a href="verification/lean/"><img alt="Lean 4: 10 theorems, no sorry" src="https://img.shields.io/badge/Lean%204-10%20theorems%2C%20no%20sorry-informational"></a>
</p>

<p>
  <a href="#quickstart"><b>Quickstart</b></a> ·
  <a href="SKILL.md"><b>Docs</b></a> ·
  <a href="#integrate-into-your-agent"><b>Integrate</b></a> ·
  <a href="sdk/README.md"><b>SDK</b></a> ·
  <a href="#live-on-shannon-testnet"><b>Contracts</b></a>
</p>

</div>

---

**Ward is the policy gate for autonomous Solidity agents on Somnia — live on Shannon testnet.** Declare what your agent is allowed to do — in one short `POLICY.md` you compile and publish — and an on-chain modifier enforces it on every entrypoint, in the same transaction as the call. Replaces ad-hoc `onlyOwner` checks + per-call `require` lines with a single declarative policy you can version, pause, expire, or revoke without redeploying the agent. Ward does not hold funds, does not execute, and does not own anything it gates.

All three Ward contracts are deployed on **Somnia Shannon testnet (chainId 50312)** and listed in Ward's own on-chain `WardAgentRegistry` — any agent or tool that walks `findWardAgents()` discovers them by name (`WardOracle (v2)`, `WardQueue (v2)`, `WardAgentRegistry`) plus the canonical sample (`CounterAgent (canonical dual-layer sample)`).

It is a Somnia-native set of three no-custody contracts:

- **`WardOracle`** — policy registry + synchronous validator. Publish a `POLICY.md` once, get a stable `policyId`. An agent calls `checkIntent` / `checkSelector` inline before dispatching and aborts on `(false, reason)`. The v2 contract additionally exposes `checkSelector`, used by the `wardGuarded` modifier.
- **`WardQueue`** *(opt-in)* — coordination for `TIER_DELAYED` and `TIER_VETO_REQUIRED` intents. The asker enqueues; after the delay the dispatcher pulls the intent back and executes it. No custody, no execution by the queue.
- **`WardAgentRegistry`** — ownerless, permissionless on-chain directory of Ward-watched agents, powering cross-agent discovery (`findWardAgents()`) with no admin override.

## Table of contents

- [The problem this exists to solve](#the-problem-this-exists-to-solve)
- [What a policy controls](#what-a-policy-controls)
- [Why not Safe modules / Zodiac / session keys?](#why-not-safe-modules--zodiac--session-keys)
- [Safe by default](#safe-by-default-reading-only-ok-cannot-bypass-the-policy)
- [Why Somnia-native](#why-somnia-native-same-chain-same-transaction-as-the-dispatch)
- [The surfaces](#the-surfaces)
- [The audiences](#the-audiences)
- [What Ward deliberately is not](#what-ward-deliberately-is-not)
- [Architecture](#architecture)
- [Quickstart](#quickstart)
  - [Dashboard](#quickstart--dashboard)
  - [CLI + TUI](#quickstart--cli--tui)
- [Integrate into your agent](#integrate-into-your-agent)
- [Live on Shannon testnet](#live-on-shannon-testnet)
- [Using the dashboard](#using-the-dashboard)
- [Worked examples](#worked-examples)
- [Prior art](#prior-art)
- [Documentation](#documentation)
- [Workspaces](#workspaces)
- [Formal verification](#formal-verification)
- [Security](#security)
- [License](#license)

## The problem this exists to solve

An autonomous agent's job is to turn a goal into on-chain action. On Somnia, `inferToolsChat` lets an LLM return executable calldata at validator consensus — the model's output *is* a transaction the agent can dispatch. The agent reads `(target, selector, value, data)` and calls it.

Nothing in that path asks "should this call be allowed?" The bytes came from a probabilistic model; the dispatch is a state mutation that does not roll back. A prompt injection, a hallucinated target, or a value an order of magnitude too large all execute exactly like a legitimate action. Once the transaction lands there is no undo — only post-hoc cleanup.

Operators have two unsatisfying defaults today:

- **Blind executor.** The agent dispatches whatever the model returns. No gate, maximum risk.
- **Off-chain enforcer.** A wallet- or middleware-layer service evaluates the call before signing. This works, but the policy decision lives off-chain, on different infrastructure than the call it governs (see [Prior art](#prior-art) below for the full comparison).

Ward adds a third: a policy decision that runs *on-chain, inside the agent's dispatch path*, in the same transaction. The agent calls `WardOracle.checkIntent` (or `checkSelector`) before dispatching and aborts on a `(false, reason)`. The policy is a `POLICY.md` the author wrote, compiled deterministically, and published once for a stable `policyId`. The decision is synchronous, has no custody, and either lets the call through or stops it before any state mutates.

## What a policy controls

A single `POLICY.md` (compiled to one on-chain `policyId`) lets you express:

**Which calls are allowed at all**
- Pin a fixed allow-list of contracts the agent may call — anything else reverts with `TARGET_NOT_ALLOWED` (≤20 targets per policy).
- For each contract, pin the specific functions the agent may invoke — every other function on that contract reverts with `SELECTOR_NOT_ALLOWED` (≤10 selectors per target).
- Write selectors as human-readable signatures (`"transfer(address,uint256)"`) or raw 4-byte hex — typos caught at compile time.

**How much money any single call can move**
- Cap the maximum native-token (STT/ETH) value any single call to a given function may carry (`valueCapPerCall: "0.1 ether"`). Reverts with `VALUE_CAP`.

**How much money the agent can move over time**
- One rolling per-UTC-day ceiling on total native token across every allowed function combined (`dailySpendWeiCap: "5 ether"`). Reverts with `DAILY_CAP`. *Single global budget — no per-contract daily caps.*

**How fast a call is allowed to happen (three tiers)**
- `IMMEDIATE` — the oracle approves synchronously and the agent runs it in the same transaction.
- `DELAYED` — call sits in `WardQueue` and cannot execute until the per-function cooldown (`delaySeconds`) elapses; only the original asker may dispatch.
- `VETO_REQUIRED` — call sits in the queue indefinitely until the policy owner personally signs the dispatch. Time alone never releases it.
- Every queued call has a fixed 7-day execution window; miss it and the request must be re-queued.
- The policy owner can `veto(queueId, "reason")` any pending queued call before it runs, with the reason recorded on-chain.

**Lifecycle & emergency controls**
- One-bit kill switch (`paused: true`) blocks every gated call without changing other rules.
- Absolute kill-by date (`expiresAt`) auto-fails every call after the timestamp.
- Publishing a new policy version automatically invalidates any in-flight queued calls from the old version.
- Two-step ownership transfer (nominate + accept) prevents fat-finger lockouts.

**What Ward does NOT enforce** (so you don't have to guess)
- Per-argument constraints (no "allow `transfer()` only if recipient ∈ X" or "only if `amount < 100 USDC`") — the validator sees the selector + attached native value, not decoded arguments.
- ERC-20 / token-aware spending caps (only native-token wei caps).
- Rate limits, call-count limits, or minimum interval between calls.
- Time-of-day or day-of-week windows.
- Caller (`msg.sender`) allow-lists — layer those in Solidity yourself (the canonical [`examples/ward-counter/`](examples/ward-counter/) shows the `onlyOperator` pattern alongside `wardGuarded`).
- Off-chain context inputs (prices, balances, remote allow-lists) — every decision is a pure function of `(policy, block.timestamp, today's running spend)`.

→ Full reference: see the **[Ward skill](SKILL.md)** for the policy-md spec and tier model.

## Why not Safe modules / Zodiac / session keys?

Ward is for the case where an agent contract gates its OWN entrypoints synchronously, not for safe-owned multi-sig execution. Safe modules + Zodiac roles live inside a Safe and decide whether *the Safe* may run a transaction; session keys decide whether *a delegated key* may sign for an EOA over time. Ward decides whether *this specific selector at this contract* is allowed under a declared policy, evaluated in the same transaction as the call, with no custody and no execution by the gate itself. Use Ward when the agent IS the contract holding the entrypoint logic; layer a Safe module on top if a Safe owns the agent. Detailed comparison: **[Prior art](#prior-art)** below.

## Safe by default: reading only `ok` cannot bypass the policy

A naive integrator might treat the oracle as a boolean: "if not `ok`, revert; otherwise dispatch." Ward's tier model is built so that this naive reading is the *safe* reading.

`checkIntent` and `checkSelector` both return `(bool ok, bytes32 reason)` and set `ok == true` for one case only — the policy marks the `(target, selector)` as `TIER_IMMEDIATE` and the intent passes legality (`PolicyLib.validate`). Every other outcome is `ok == false`:

```solidity
// WardOracle.checkIntent — the tier branch
(ok, reason) = policies[policyId].validate(intent, spentToday);
if (!ok) return (ok, reason);
uint8 tier = policies[policyId].tierOf(intent.target, intent.selector);
if (tier == TIER_DELAYED) return (false, bytes32("REQUIRES_DELAY"));
if (tier == TIER_VETO_REQUIRED) return (false, bytes32("REQUIRES_VETO"));
return (true, bytes32(0));
```

The two non-immediate tiers — `TIER_DELAYED` and `TIER_VETO_REQUIRED` — are reported as `ok == false` with `reason` set to `"REQUIRES_DELAY"` or `"REQUIRES_VETO"`. They are *not* `ok == true`. An author who marks a selector `TIER_DELAYED` is saying "this must wait the configured delay and route through the queue before it executes." A consumer that only checks `ok` will refuse the call rather than execute it immediately — which is exactly what the author intended. The policy author's queue intent cannot be silently bypassed by a consumer that ignores the `reason`.

Two more defaults reinforce this:

- A `policyId` that was never published makes `checkIntent` / `checkSelector` **revert** with `PolicyNotFound`, not return a quiet "denied." A misconfigured reference fails loudly instead of being mistaken for a policy that allows nothing.
- The `wardGuarded(selector, value)` modifier on `WardAgentBase` — the default integration path for single-outbound-call functions — does the check, the tier post-validation, and reverts with `WardRejected(reason)` for you, so the safe behavior is the path of least resistance.

A consumer can still opt in to the queue: read the `reason`, recognize `REQUIRES_DELAY` / `REQUIRES_VETO`, and enqueue the intent in `WardQueue` to honor the tier. But that is opt-*in* coordination layered on top of a gate that already defaults to refusal.

## Why Somnia-native: same chain, same transaction as the dispatch

The reason Ward can be a *gate* and not just a *monitor* is that the policy decision and the dispatch share one execution context. Three properties follow from being Somnia-native:

- **Same place the calldata was produced.** On Somnia, the calldata comes from deterministic LLM consensus (`inferToolsChat`). The policy check runs at that same validator consensus. An off-chain enforcer structurally cannot sit inside that step; an on-chain enforcer on a different L1 cannot use deterministic LLM consensus. The author validates the bytes where the bytes were minted.
- **Same transaction as the dispatch.** The agent calls `oracle.checkIntent(...)` and then dispatches in one transaction. Either the call passes the policy and executes, or the policy says no and the whole transaction reverts. There is no window between "checked" and "executed" for state to drift, and no separate signer that can be skipped — anyone who bypasses your dApp or your tooling still hits the same on-chain revert.
- **No custody, no extra trust surface.** `WardOracle` is a pure policy registry plus synchronous validator. No Ward contract holds funds, owns agents, or executes external calls. The gate adds a `view` call to the agent's own dispatch, not a custodial intermediary that funds must pass through.

This is the difference between "the LLM returned bytes" and "the bytes passed a policy I wrote in markdown." Because the policy lives on the same chain and runs in the same transaction as the dispatch, the decision is atomic with the action it governs.

## The surfaces

The three contracts are the product; everything else exists to author policies for them, watch them, and drive them.

| Surface | What it is |
|---|---|
| **Contracts** (`contracts/`) | Foundry sources — `WardOracle`, `WardQueue`, `WardAgentRegistry`, `PolicyLib`, `PolicyNormalizer`, `PolicyTypes`, and the `WardAgentBase` / `WardCall` integration helpers — plus Lean 4 verification of policy semantics. |
| **SDK** (`sdk/`) | The TypeScript library every other surface is built on: the `POLICY.md` compiler, `PolicyBuilder`, ABIs, oracle-client, queue-client, event-store, and the `findWardAgents()` discovery helper. |
| **CLI** (`cli/`) | The headless / CI surface. A single `ward` binary: a guided interactive menu plus 16 direct commands (`compile`, `push`, `lint`, `policy:init`, `analyze:gate`, `queue:*`, …). |
| **TUI** (`tui/`) | An Ink (React-for-terminals) operator monitor — a full-screen queue console with health scope, expirable-row actions, and aging bars. `--json` streams NDJSON `StoreEvent`s for piping. |
| **Dashboard** (`dashboard/`) | The browser, wallet-based console (Vite + React + wagmi/viem). Four tabs: Publish, Queue, Watched, Watch Wizard. |
| **Frontend packages** (`packages/ward-react`, `packages/ward-vite`) | Run the same policy check in the browser before the wallet popup, so a rejected intent never asks the user to sign. This is a UX layer, not a security boundary. |
| **Scaffolder** (`packages/create-ward-agent`) | `pnpm create ward-agent` — scaffolds a `WardAgentBase`-derived Foundry project with deploy/bind scripts and a starter `POLICY.md` already wired. |

## The audiences

Ward serves three distinct entry points, each with a different amount of integration work:

1. **Greenfield agent authors.** Write a new agent contract that inherits `WardAgentBase` and tags its entrypoint with the `wardGuarded(selector, value)` modifier (or, for multi-outbound functions, gates each call inline with `_wardCheck` + `_call`). You get policy enforcement before the first dispatch. The scaffolder generates this shape for you.

2. **Operators of already-deployed agents (any author).** Paste any deployed Somnia agent address into the Watch Wizard (`?tab=watch-wizard`). The wizard discovers the agent on chain, recommends a deterministic policy tier, publishes and registers it in `WardAgentRegistry`, and wires a Slack alert — in under 60 seconds, with no integration code. Ward is honest about the boundary: agents that aren't Ward-aware get observation alerts, not real-time gating.

3. **Fleet operators.** Monitor and act on the queue. The TUI handles sweep / expire / dispatch from the terminal; the dashboard's Queue tab shows pending intents and the Watched tab shows watch-subscriptions and the violation feed. Raw chain history lives on Shannon Explorer; Ward's surfaces scope themselves to the operator's own work.

## What Ward deliberately is not

These are architectural choices, not gaps to be filled later:

- **It never holds user funds.** Ward is no-custody by design and will never custody assets.
- **It never executes calls itself.** Even the queue only coordinates timing; the dispatcher executes. The oracle only answers.
- **It is not a wallet-level off-chain enforcer.** The policy decision lives on the same chain as the call and runs in the same transaction as the dispatch — anyone bypassing a dApp's frontend check hits the same on-chain revert.
- **It is not cross-chain** in this release — Somnia Shannon only.
- **It is not a server-side alert relay.** The dashboard polls Shannon while open; a 24/7 relay is future work.
- **It is not mobile-first.** A desktop dev workstation is the assumed surface.

## Architecture

### Module map

```
contracts/src/
├── PolicyTypes.sol             # TargetRule, SelectorRule, PolicyInput, Policy, Intent + tier constants
├── PolicyLib.sol               # pure validate(Policy storage, Intent, spentToday) → (ok, reason)
├── PolicyNormalizer.sol        # copy(Policy storage, PolicyInput memory) — wipe + rewrite + structural checks
├── WardOracle.sol            # policy registry + checkIntent + tierAndDelay + policyHealth
├── WardQueue.sol             # opt-in coordination for TIER_DELAYED / TIER_VETO_REQUIRED — enqueue / dispatch / veto / expireIfStale
├── WardAgentRegistry.sol     # ownerless permissionless directory of Ward-watched agents — register / update / agentsPaginated (v0.10.0)
├── constants/
│   └── SomniaTestnet.sol       # verified mainnet/testnet platform + LLM agentId constants (for integrators)
└── interfaces/
    └── ISomniaAgentPlatform.sol # mirrors createRequest + AgentResponse/Request/Status shape (for integrators)
```

`script/Deploy.s.sol` deploys WardOracle + WardQueue in one broadcast; `script/DeployRegistry.s.sol` deploys WardAgentRegistry separately (added in v0.10.0). Both write per-chain artifacts to `contracts/deployments/$CHAINID.json` and `$CHAINID-registry.json` respectively.

No mocks, demo agents, vaults, custody-bearing contracts, or showcase code ship from `src/`. The test-only `MockTarget` fixture lives under `contracts/test/mocks/` and is never deployed.

### WardOracle — the single contract

```
                  asking agent (any Somnia contract)
                            │
                            │   bytes32 policyId; Intent intent; uint256 mySpentToday
                            ▼
   ┌─────────────────────────────────────────────────────────────────┐
   │                       WardOracle                              │
   │                                                                 │
   │  publishPolicy(label, PolicyInput) → policyId                   │
   │     ├── policyId = keccak256(abi.encode(msg.sender, label))     │
   │     ├── revert PolicyExists if owner already set                │
   │     ├── policyOwner[policyId] = msg.sender                      │
   │     ├── PolicyNormalizer.copy(policies[policyId], input)        │
   │     └── emit PolicyPublished(policyId, owner, label)            │
   │                                                                 │
   │  updatePolicy(policyId, PolicyInput)         [owner only]       │
   │     ├── revert NotPolicyOwner if mismatch                       │
   │     ├── PolicyNormalizer.copy(policies[policyId], input)        │
   │     └── emit PolicyUpdated(policyId, owner)                     │
   │                                                                 │
   │  checkIntent(policyId, intent, spentToday) → (ok, reason)       │
   │     ├── revert PolicyNotFound if policyOwner[id] == 0           │
   │     ├── PolicyLib.validate → (legal, reason)                    │
   │     ├── if !legal: return (false, reason)                       │
   │     ├── tier = policies[id].tierOf(target, selector)            │
   │     ├── if tier == DELAYED:       return (false, REQUIRES_DELAY)│
   │     ├── if tier == VETO_REQUIRED: return (false, REQUIRES_VETO) │
   │     └── return (true, 0)                                        │
   │                                                                 │
   │  tierAndDelay(policyId, target, selector) → (tier, delaySec)    │
   │     └── escape hatch for tier-aware integrators                 │
   │                                                                 │
   │  policyIdFor(publisher, label) → bytes32     [pure]             │
   │     └── precompute id off-chain or in another contract          │
   └─────────────────────────────────────────────────────────────────┘
                            │ pure view return
                            ▼
                   asking agent decides what to do
```

`checkIntent` is **safe by default**: returns `ok = true` ONLY for legal + `TIER_IMMEDIATE` calls. A naive consumer that only reads `ok` cannot silently bypass `TIER_DELAYED` / `TIER_VETO_REQUIRED` policy intent — the worst outcome of misuse is "policy too strict," never "policy silently skipped."

### WardQueue — opt-in coordination for non-immediate tiers

```
   asking agent calls checkIntent → (false, "REQUIRES_DELAY" | "REQUIRES_VETO")
                            │
                            ▼
   queue.enqueue(policyId, intent, spentToday) → execId
                            │
                            │  ... (waits delaySeconds; policy owner may veto)
                            ▼
   DELAYED:        asker       calls queue.dispatch(execId) → Intent (re-validated)
   VETO_REQUIRED:  policyOwner calls queue.dispatch(execId) → Intent
                            │
                            ▼
   dispatcher executes target.call(intent.data) themselves
   (= asker for DELAYED; = policyOwner for VETO_REQUIRED — make sure the
    address that holds the funds is also the one allowed to dispatch)
```

Authorization split:

- **`TIER_DELAYED`** → only the original `asker` can dispatch (timer-based confidence).
- **`TIER_VETO_REQUIRED`** → only `oracle.policyOwner(policyId)` can dispatch ("no veto" alone is not enough — owner has to actively dispatch).

At dispatch time the queue re-runs `oracle.policyHealth(policyId)` and compares the queued policy revision against `oracle.policyVersion(policyId)`. It reverts with `PolicyChanged("PAUSED" | "EXPIRED" | "UPDATED")` if the policy was paused, expired, or edited during the wait. It does NOT re-check value caps — the asker is the only one who knows their up-to-date `spentToday`. `expireIfStale(execId)` is permissionless after the 7-day commit deadline so anyone can garbage-collect.

The queue holds no funds, owns no agents, executes no calls. Same trust model as the oracle — relies on the asking agent honoring the contract by calling `enqueue` instead of dispatching directly.

### Per-selector storage layout

```solidity
struct Policy {
    address[] targets;                                  // ordered list for enumeration
    mapping(address => bool) isTargetAllowed;           // O(1) target check
    mapping(address => bytes4[]) selectors;             // ordered list per target
    mapping(address => mapping(bytes4 => bool)) isSelectorAllowed;
    mapping(address => mapping(bytes4 => uint256)) valueCapPerCall;
    mapping(address => mapping(bytes4 => uint8))   tier;
    mapping(address => mapping(bytes4 => uint32))  delaySeconds;
    uint256 dailySpendWeiCap;
    uint16  maxSlippageBps;
    uint64  expiresAt;
    bool    paused;
}
```

Hybrid intentional: enumeration during `publishPolicy` / `updatePolicy` (which iterates to wipe + rewrite via `PolicyNormalizer.copy`), O(1) reads during `checkIntent` (which runs on every asking-agent dispatch). Per-selector granularity lets one policy allow `approve(MAX)` as IMMEDIATE alongside `transferFrom(*)` as VETO_REQUIRED.

### End-to-end agent loop (oracle model)

```
            ┌───────────────────────┐
   user   → │  YourAgent            │
            │   (your entry point)  │
            └────────────┬──────────┘
                         │ posts inferToolsChat payload + deposit
                         ▼
          ┌─────────────────────────┐
          │  ISomniaAgentPlatform   │
          │  .createRequest         │
          └────────────┬────────────┘
                       │ subcommittee runs LLM, returns response bytes
                       ▼
          ┌─────────────────────────┐
          │  YourAgent              │
          │  .handleResponse        │   (you write this)
          └────────────┬────────────┘
                       │ build Intent from response
                       ▼
          ┌─────────────────────────┐
          │  WardOracle           │
          │  .checkIntent           │   (one synchronous view call)
          └────────────┬────────────┘
                       │ (ok, reason)
                       ▼
          ┌─────────────────────────┐
          │  YourAgent              │
          │  .target.call(...)      │   (you dispatch yourself if ok)
          └─────────────────────────┘
```

The oracle is a single view call in the middle of *your* dispatch. It returns; you decide what to do. Ward never holds your funds, never sees your private key, never executes anything.

### Somnia testnet gas note

Somnia Shannon testnet under-reports actual on-chain gas consumption by ~15x vs forge's `eth_estimateGas` simulation. Without compensation every CREATE OOGs. Deploy with `--legacy --gas-estimate-multiplier 2000`; for writes from viem use `type: "legacy"` and an explicit `gas` limit. `script/Deploy.s.sol` does two CREATEs (WardOracle + WardQueue), so a full deploy costs ~0.2-0.3 STT.

### Trust model

| Surface | Who you trust |
|---|---|
| `PolicyLib.validate` | The on-chain code itself + the 5 Lean PolicyLib theorems pinning its semantics. |
| `WardOracle` | The on-chain code itself (no off-chain workers, no validators, no admin) + the 2 Lean ownership-handoff theorems pinning the two-step `transferPolicyOwnership` flow. |
| `WardQueue` | The on-chain code itself + the 3 Lean WardQueue theorems pinning the state-transition timing. |
| `WardAgentRegistry` | The on-chain code itself — ownerless and permissionless. First-writer-wins; no admin override. Trust the first registrar to have entered the right (agent, oracle, policyId) tuple. |
| Your agent's `handleResponse` | Your own code — Ward can only protect you if you actually call `checkIntent` before dispatching. |
| The Somnia agent platform's validator consensus | Whatever you'd already trust for `inferToolsChat`. Ward is orthogonal — it runs in your asking-agent transaction, not in the validator subcommittee. |

The biggest "trust gap" in the oracle model is **integrator discipline**: nothing in `WardOracle` forces you to call `checkIntent` before dispatching. The same is true of any guardrails library. The mitigation is straightforward: keep the integration to a single, conspicuous line in your `handleResponse` (or its equivalent), and review the code path that follows a positive verdict.

## Quickstart

Two-minute tutorials — pick a lane.

### Quickstart — dashboard

1. `git submodule update --init --recursive` then `pnpm install` *(one-time; the recursive submodule init pulls `forge-std`, which the contracts workspace needs)*
2. `pnpm quickstart` — builds + serves the dashboard at <http://localhost:4173>
3. Open the URL, connect a wallet on Somnia testnet (if you don't have STT, follow the **Get STT** link in the TopBar), pick a template, fill in your contract address, click **Publish**.

Total time: **~2 minutes** after `pnpm install` finishes.

The hosted build is at **<https://ward.vercel.app>**. To run it locally instead of the production build, use `pnpm -C dashboard run dev` (Vite dev server). The default deployment targets the canonical Shannon contracts; point the dashboard at a different oracle/queue/RPC per-session with URL params — `?oracle=0x…&queue=0x…&rpc=https://…` — which is how share links carry a non-default deployment.

### Quickstart — CLI + TUI

Publish your first on-chain policy and watch it live, entirely from the terminal — no browser required.

This tutorial takes you end to end against the canonical Ward v2 oracle on the Somnia Shannon testnet (`0x3C7bF90f243d670a01f512221d9546e09fEaCC9c`, chain id `50312`). You will install the tools, run a preflight check, compile and publish the policy that ships with the `ward-counter` example, and open the live TUI monitor. By the end you will have a real `policyId` on-chain and know how to bind it to an agent.

#### Before you start

You need:

- **Node + pnpm**, and a clone of this repo.
- **A funded Somnia testnet wallet.** Bring your own private key with a little STT in it. Faucets (manual; no programmatic API as of this release):
  - <https://testnet.somnia.network/>
  - <https://faucet.somnia.network/>

  Recommend at least `0.5 STT` for a full live run (deploy + publish).

The only sample in this repo is [`examples/ward-counter/`](examples/ward-counter/) — a two-contract pair (a dumb `Counter` and a Ward-aware `CounterAgent`). This tutorial publishes the policy that gates it.

#### 1. Install and build the tools

```bash
git clone <ward-repo> && cd ward
pnpm install
```

`pnpm install` is enough — the `pnpm ward` launcher runs the CLI straight from TypeScript via `tsx` if no build is present. Building first is optional but makes invocations faster and is what CI uses:

```bash
pnpm -C cli run build
pnpm -C tui run build
```

Now wire up your wallet. Copy the root template and edit it:

```bash
cp .env.example .env
```

Set these in `.env` (the rest already point at the canonical live deployments):

| Var | Value |
|---|---|
| `PRIVATE_KEY` | Your funded testnet key, used by the CLI to sign. |
| `DEPLOYER_PK` | Same key, the name `forge` scripts read. Copy `PRIVATE_KEY` here. |
| `SOMNIA_TESTNET_RPC` | Leave as `https://dream-rpc.somnia.network` unless you run a private node. |
| `WARD_ORACLE` | Leave as `0x3C7bF90f243d670a01f512221d9546e09fEaCC9c` (v2). |

The CLI auto-loads `.env` from the directory you run it in, so anything you set here is picked up automatically.

#### 2. Preflight

Confirm your environment, network, and balance are good *before* spending gas:

```bash
pnpm ward preflight
```

It reports the RPC, the chain id, your wallet address and balance, the Somnia agent platform and LLM-inference agent id, and the configured oracle/queue, then prints a verdict:

```
# ward preflight
  rpc            https://dream-rpc.somnia.network
  chainId        50312
  wallet         0x....
  balance        ... STT
  platform       0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776
  agentId        12847293847561029384
  ward oracle  0x3C7bF90f243d670a01f512221d9546e09fEaCC9c
  ward queue   0xFB715A37951Fc8dcc920120768e91f7C8bbA54c4

  preflight: OK
```

If you see `preflight: NOT READY`, fix the `ERROR` lines (usually a missing or malformed `PRIVATE_KEY`) and re-run. A low balance is a `WARN`, not a blocker — preflight prints faucet links when your balance is under the recommended `0.5 STT`. Raise the threshold with `--min-balance <eth>`.

#### 3. Read the policy you are about to publish

The counter sample ships its policy at [`examples/ward-counter/policy.md`](examples/ward-counter/policy.md). Open it. The authorizing block is:

````markdown
```policy
version: "0.1"
dailySpendWeiCap: "0"
expiresAt: "2026-11-29T00:00:00Z"
targets:
  - target: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    selectors:
      - selector: "bump(uint256)"
        valueCapPerCall: "0"
        tier: IMMEDIATE
        delaySeconds: 0
```
````

Two things to understand here:

- **Entrypoint-policy model.** The `target` is the **agent's own address** (the contract inheriting `WardAgentBase`), and `selectors` lists the agent's *own* entrypoints — not the downstream `Counter` selectors. `bump(uint256)` is authorized; `reset()` is deliberately omitted so the agent's deny path is observable (a call to `reset()` reverts `WardRejected("SELECTOR_NOT_ALLOWED")` — the modifier-driven revert IS the deny-path proof).
- **`0xdeadbeef…` is a placeholder.** Replace it with your real agent address before publishing — that comes from `deployments/agent.json` after you deploy the agent (see [Bind it to an agent](#5-bind-it-to-an-agent)). No native value moves on this selector, so `dailySpendWeiCap` and `valueCapPerCall` are both `"0"`.

For the full grammar of the `policy` block (every field, every tier), see the policy-md spec in **[SKILL.md](SKILL.md)**.

#### 4. Compile, predict the id, publish

Three commands take a `POLICY.md` to an immutable on-chain policy. Run them from the repo root against the sample file.

**Compile** sanity-checks that the markdown parses into a canonical `PolicyInput`:

```bash
pnpm ward compile examples/ward-counter/policy.md
```

It prints the compiled policy as JSON. No transaction, no wallet needed.

**Predict the policyId.** The id is deterministic from your publisher address plus a label you choose — so you can compute it before publishing and hard-code it into your agent:

```bash
pnpm ward policyid counter-demo
```

```
# policyId
  publisher: 0x....
  label:     "counter-demo"
  id:        0x....
```

The label is an ASCII string up to 32 bytes; it is encoded as a right-padded `bytes32` (`stringToHex(label, { size: 32 })`), **not** hashed.

**Publish** to the oracle. This is a real on-chain transaction:

```bash
pnpm ward push examples/ward-counter/policy.md --label counter-demo
```

`push` simulates first (so a misconfigured policy surfaces its revert reason before you pay gas), then submits and waits for the receipt:

```
publishPolicy tx: 0x....
OK · policyId = 0x....
     reference this id in your agent contract; it is stable across updates
```

The printed `policyId` **must equal** the one `policyid` predicted. If it differs, your label is being encoded differently somewhere — check it.

`push` auto-detects publish vs. update: if a policy already exists for `(your wallet, counter-demo)` and you own it, it calls `updatePolicy` instead of `publishPolicy`, keeping the same id. If someone else owns that id, it refuses and tells you to pick a different `--label`.

#### 5. Bind it to an agent

A published policy does nothing until an agent references it. The counter sample uses the **late-binding pattern**: `POLICY_ID` is a mutable storage slot on `CounterAgent` that defaults to `bytes32(0)` (ungated), so you can deploy first and bind later.

The full deploy-and-bind walkthrough — `forge script DeployCounter`, `DeployAgent`, then `setPolicyId(bytes32)` — lives in the example's own README: [`examples/ward-counter/README.md`](examples/ward-counter/README.md). The short version, after `push` gives you a `POLICY_ID`:

```bash
cd examples/ward-counter

# deploy the counter + the (initially ungated) agent
forge script script/DeployCounter.s.sol \
  --rpc-url "$SOMNIA_TESTNET_RPC" --broadcast --legacy --gas-estimate-multiplier 2000
forge script script/DeployAgent.s.sol \
  --rpc-url "$SOMNIA_TESTNET_RPC" --broadcast --legacy --gas-estimate-multiplier 2000

# bind the policy you just published
export AGENT=$(jq -r '.agent' deployments/agent.json)
cast send "$AGENT" "setPolicyId(bytes32)" 0x<policyId> \
  --private-key "$DEPLOYER_PK" --rpc-url "$SOMNIA_TESTNET_RPC" --legacy
```

`--gas-estimate-multiplier 2000` is required: Shannon's RPC under-reports gas by roughly 15×, and this multiplier is baked into every deploy in the repo.

One caveat for real use: the policy's `target` must be the **agent address you just deployed** (from `deployments/agent.json`), not the `0xdeadbeef…` placeholder. Edit `policy.md`, re-run `push` (it will `updatePolicy` under the same label), then bind.

For integrating Ward into *your own* agent — the `wardGuarded` modifier, the inline `checkIntent` path, and how to choose between them — see the integration guide in **[SKILL.md](SKILL.md)**.

#### 6. Watch it live in the TUI

Open the full-screen queue monitor:

```bash
pnpm ward tui
```

The TUI shows live queue activity, health cards (sync state, pending / expirable / dispatchable counts), an "expirable now" list, aging buckets, and a chronological event tail. Keys: `[↑↓]` move, `[x]` expire the focused request, `[s]` sweep all expirable, `[q]` quit; `[a/e/d/v/r]` filter the event tail (all / enqueued / dispatched / vetoed / expired).

`IMMEDIATE` calls — like the counter's `bump` — execute inline in the agent's own transaction and emit no Ward queue events, so they will not appear here. The TUI is for the coordinated tiers (`DELAYED`, `VETO_REQUIRED`) that route through `WardQueue`.

For a machine-readable stream instead of the full-screen UI:

```bash
pnpm --silent ward tui --json | jq
```

#### What next

- **Integrate your own agent**, **monitor the queue**, every **CLI command/flag/output**, and the **POLICY.md grammar** — all in **[SKILL.md](SKILL.md)**.

## Integrate into your agent

Inherit `WardAgentBase` and stack two orthogonal access-control layers — a plain Solidity caller allow-list (`onlyOperator`) and the Ward policy gate (`wardGuarded(selector, value)`). The policy decision lands in the same transaction as the call:

```solidity
import "ward/WardOracle.sol";
import "ward/integration/WardAgentBase.sol";

contract CounterAgent is WardAgentBase {
    Counter public immutable counter;

    mapping(address => bool) public isOperator;          // caller allow-list
    error NotOperator();
    modifier onlyOperator() { if (!isOperator[msg.sender]) revert NotOperator(); _; }

    constructor(WardOracle _oracle, Counter _counter, address _owner)
        WardAgentBase(_oracle, _owner)
    {
        counter = _counter;
        isOperator[_owner] = true;                       // bootstrap deployer
    }

    function addOperator(address op) external onlyOwner { isOperator[op] = true; }
    function removeOperator(address op) external onlyOwner { isOperator[op] = false; }

    function bump(uint256 by)
        external
        onlyOperator                                     // 1. cheap Solidity ACL
        wardGuarded(this.bump.selector, 0)             // 2. Ward policy gate
    {
        counter.bump(by);                                 // runs only if both layers allow
    }
}
```

Modifier order is deliberate: Solidity runs modifiers left-to-right, so `onlyOperator` rejects unauthorized callers *before* the agent makes the external oracle call — gas saved on doomed calls. `POLICY_ID` is inherited and late-bound via `setPolicyId(0xNEW)`; while unbound the Ward layer short-circuits, so the agent can ship to testnet before a policy exists (`setPolicyId(0)` is the Ward kill switch). For **multi-outbound** functions (e.g. `approve` + `swap`), use the inline `oracle.checkIntent` / `_wardCheck` + `_call` path instead — see the integration models + integration guide in **[SKILL.md](SKILL.md)**. Canonical sample: **[`examples/ward-counter/`](examples/ward-counter/)**.

## Live on Shannon testnet

Canonical (v2) deployment — chain id `50312`:

| Contract | Address |
|---|---|
| `WardOracle` | [`0x3C7bF90f243d670a01f512221d9546e09fEaCC9c`](https://shannon-explorer.somnia.network/address/0x3C7bF90f243d670a01f512221d9546e09fEaCC9c) |
| `WardQueue` | [`0xFB715A37951Fc8dcc920120768e91f7C8bbA54c4`](https://shannon-explorer.somnia.network/address/0xFB715A37951Fc8dcc920120768e91f7C8bbA54c4) |
| `WardAgentRegistry` | [`0x97F743A9AAa5AcAA73075C1B8F1921274755CF70`](https://shannon-explorer.somnia.network/address/0x97F743A9AAa5AcAA73075C1B8F1921274755CF70) |

The v1 oracle (`0x68d4B045B24F8d1012974b9d34684cA5aeD11DDf`) and v1 queue (`0x98A3f7C38D19edF1ddA7E3bc38fa4B935aD590D5`) stay live for policies published before the v2 deploy; new `wardGuarded` agents bind to **v2** (it adds the `checkSelector` view the modifier uses). v1 lacks `checkSelector`, so it backs inline `checkIntent` callers only, not the `wardGuarded` modifier. Full history: **[CHANGELOG](CHANGELOG.md)**.

### Discoverable on chain — Ward registered in its own registry

All three Ward contracts are themselves registered as entries in `WardAgentRegistry`, so other agents and tooling can find Ward by name without hard-coded addresses:

```bash
# Walk the registry for everything named "ward-core"
cast call 0x97F743A9AAa5AcAA73075C1B8F1921274755CF70 "agentCount()(uint256)" \
  --rpc-url https://dream-rpc.somnia.network
# → 8 (4 historical demo agents + 3 ward-core meta-entries + the canonical CounterAgent sample)

# Read one of the entries
cast call 0x97F743A9AAa5AcAA73075C1B8F1921274755CF70 \
  "getAgent(address)((address,address,address,bytes32,uint64,uint64,bool,string,string,string[]))" \
  0x3C7bF90f243d670a01f512221d9546e09fEaCC9c \
  --rpc-url https://dream-rpc.somnia.network
# → name: "WardOracle (v2)", tags: ["ward-core","oracle"], metadataURI: github link
```

The canonical sample agent (`CounterAgent (canonical dual-layer sample)` at [`0x809F01268B718Ea6d17438b94190749159Eee311`](https://shannon-explorer.somnia.network/address/0x809F01268B718Ea6d17438b94190749159Eee311)) is also in the registry — `findWardAgents()` SDK helpers surface it alongside Ward's own contracts.

Source verification on Shannon Blockscout is the one remaining discoverability gap — pending a working `forge verify-contract` config for the Somnia explorer's API.

## Using the dashboard

The dashboard is a four-tab operator console for Somnia Shannon (chain id 50312):
**Publish** a policy, watch the **Queue**, inspect **Watched** agents and your own
policies, and run the **Watch wizard** to bind alerts to an agent. Every write is
signed by your connected wallet; Ward never takes custody.

This section assumes you have a wallet (e.g. MetaMask) with a little STT on
Shannon. The hosted build is at **<https://ward.vercel.app>** or run it
locally with `pnpm -C dashboard run dev` (Vite dev server).

Connect your wallet from the top-right of the **TopBar**. If you are on the wrong
network the TopBar shows a **"Wrong network. Switch to Somnia"** button; click it
to switch to chain id 50312. When your balance is low or zero the TopBar surfaces a
**"Get STT →"** link to `https://testnet.somnia.network/`. The connected address
becomes the **publisher** of any policy you publish.

The left **Sidebar** has the four tabs:

| Tab | Purpose |
| --- | --- |
| Publish | Compile and publish a policy on-chain |
| Queue | Pending intents and recent oracle events |
| Watched | Watch-mode violations from immutable agents |
| Watch wizard | Discover a Somnia agent and set up Slack alerts in 60 seconds |

### Publish tab: author and publish a policy

The Publish tab opens on the **Publish a policy** document. Its front matter shows
the **Publisher** (your wallet, or "not connected"), **Namespace** (Somnia Shannon,
chain id 50312), the **WardOracle** address, the block the dashboard is indexed
through, and the current **Mode**.

**Pick a mode.** The TopBar exposes an **Enforce | Watch** toggle while you are on
the Publish tab:

- **Enforce** (default) — the policy is meant for an agent that calls
  `WardOracle.checkIntent` / `checkSelector` itself, so the oracle blocks
  disallowed calls in real time.
- **Watch** — publishes a policy for an already-deployed agent and receives
  violation alerts as the agent transacts. It never blocks the call. In Watch mode
  the page leads with **Bind an existing agent** and an agent-discovery panel.

**Start from a template.** While the policy form is still empty, a **Templates**
section appears (it disappears as soon as the form has content). The four starter
templates are:

| Template | Description |
| --- | --- |
| DEX swapper | Trading bot that swaps via dreamDEX router |
| NFT mint guard | Mints NFTs with per-call price cap |
| Treasury bot | Treasury ops with VETO_REQUIRED on withdrawals |
| LLM dispatcher | LLM-agent dispatcher with delayed review window |

Each card shows its tier mix (e.g. `IMMEDIATE + DELAYED`). Picking a card hydrates
the form — you still have to swap in the real target addresses before the policy
compiles. For a worked-out example policy, see the conservative-policy reference in
**[SKILL.md](SKILL.md)**.

**Author and preview.** Edit the policy in the form on the left: a label, plus one
or more **targets**, each with selectors carrying a **tier** (`TIER_IMMEDIATE` /
`TIER_DELAYED` / `TIER_VETO_REQUIRED`) and optional caps. The right-hand pane
renders a live **POLICY.md / YAML preview** of exactly what will be compiled — the
dashboard uses the same SDK compile path the CLI uses, so the on-chain `PolicyInput`
is identical. The **Intent simulator** under the Publish section lets you dry-run a
check against the compiled input before you spend gas.

**Publish and read the policyId.** Connect your wallet (if you haven't), then click
the publish button under the **Publish** section. The transaction is decoded for the
`PolicyPublished` event to capture the canonical **policyId**.

On success the page swaps to a **post-publish reveal**:

- The **policyId** is the hero artifact — copy it and paste it into your agent
  contract. (`Click copy → paste into your agent contract`.)
- **Copy tx hash** and an explorer link for the publish transaction.
- **Copy share link** — a bookmarkable URL (`?tab=publish&revealed=<policyId>`)
  that re-renders this reveal for anyone you send it to, carrying any non-default
  oracle/queue/rpc.
- A **post-publish checklist** to bind the policy to a deployed agent and register
  it in the catalog. In **Watch** mode the reveal instead shows the
  **WatchAgentBinding** panel — no agent code changes needed; bind one or more
  agent addresses there.

The reveal is bookmarkable: revisiting `?revealed=<policyId>` later restores it from
the local cache, the in-memory event store, or a direct on-chain `policyOwner`
lookup. If the id is unknown on the active oracle you'll see **"No policy at this
ID"**; a transient RPC failure shows **"Cannot reach the chain right now"** with a
**Retry**. Click **publish another** to return to the form.

### Queue tab: dispatch, veto, and expire from the exec drawer

The Queue tab lists pending intents and recent oracle events. `TIER_DELAYED` and
`TIER_VETO_REQUIRED` intents surface here for coordination (no custody). Open the
**exec drawer** for a request by clicking its row, or use the TopBar search — visible
only on the Queue tab — to **"Jump to request #, or 0x policy id"** (type `42` for a
request number, or a `0x` policy id).

The drawer header reads `REQUEST #<id>`. The body shows the request's **state**
(None / Pending / Committed / Vetoed / Expired), **tier**, **policy** (clickable —
opens the policy drawer), **requester**, the **call** (contract, function selector,
value in wei, request #), and **timing** (enqueued-at, **executable after** with a
"commits in" countdown, and **deadline** with an "expires in" countdown). For
`TIER_VETO_REQUIRED` requests a **handoff** panel reads `policyOwner` from the oracle
and surfaces a recommended command.

The action footer (`WriteActions`) gates on who you are and where the clocks are.
Only **Pending** records expose actions; terminal states show *"Terminal state — no
actions available."* Connect a wallet to see the buttons. The actions:

- **Reject…** — vetoes the request. Visible only to the **policy owner** while the
  request is Pending.
- **Execute…** — dispatches the request. Shown to the **policy owner** for a
  `TIER_VETO_REQUIRED` request, or to the **requester** for a `TIER_DELAYED`
  request, once the delay window has elapsed (`earliestCommitAt` reached) and the
  request is still **within its deadline**.
- **Clear…** — expires the request. Available to **anyone** once the request is
  **past its deadline**.

If your connected wallet has no rights yet, the footer lists why — e.g. *"Only the
policy owner or the requester can act on this."* or *"The mandatory delay window
hasn't elapsed yet."* Each action opens a confirmation modal and signs a queue write;
a toast reports `Reject` / `Execute` / `Clear` success, revert, or failure.

For the operator workflow around the queue and policy lifecycle, see the
"Monitor the queue" and "Operate policies" guides in **[SKILL.md](SKILL.md)**.

### Watched tab: the agent and policy catalog

The Watched tab is titled **Ward-watched agents on Somnia Shannon**. Its front
matter shows the **Registry contract** (`WardAgentRegistry`), network, RPC, the
indexed-through block, and how many agents are watched. It contains:

- **Registered agents** — the permissionless on-chain catalog, read from the
  registry by `AgentsCatalogPanel`. Each row shows **Name**, **Address**, **Tags**,
  **Policy** (clickable — opens the policy drawer — with a copy button), and
  **Status** (active / inactive). A freshness badge marks the list **live ·
  on-chain** or **cached**, with **Refresh** to re-walk the registry. The **add to
  watch →** action opens that agent in the Watch wizard with its address pre-filled.
  Registration is permissionless: the first wallet to call
  `register(agent, policyId, …)` for an address becomes its registrar and the only
  one who can later update or deactivate it.

- **My policies** — policies you published, keyed by your connected wallet. Recent
  ones load automatically; **Discover** scans full historical `PolicyPublished`
  events for your address. Click any policy row to open its drawer.

- **Violations · last 7 days** — KPIs (watched agents, violations 24h, worst entry,
  trace coverage), an hourly time chart, a top-violators list, and a recent-violations
  log. Watch mode reads transactions via `debug_traceTransaction`; if the RPC doesn't
  expose it the section is replaced by **"Watch mode unavailable on this RPC."**

- **Subscriptions** — your saved alert bindings (see below). Each row shows the
  agent, recommendation tier, masked webhook/Telegram fingerprint, and created-at,
  with **Replace** (re-run the wizard for that agent) and **Remove** (forget the
  subscription locally — does not touch on-chain state).

### Watch wizard: bind alerts to an agent

The Watch wizard is a three-step flow to discover a Somnia agent and bind alerts. Its
front matter tracks the registry contract, your wallet, the target agent, and an
elapsed-seconds counter.

1. **Paste address** — paste a `0x` agent address (or **Paste my own wallet**) and
   click **Discover**. This runs read-only RPC probes only; no transaction. The
   wizard rejects the Ward oracle/queue/registry addresses (watching them would be
   circular) and reserved precompiles.

2. **Discover & recommend** — the wizard reads `WardAgentRegistry` + `WardQueue`,
   reports whether the agent is **Ward-aware**, and offers three deterministic
   policy tiers — **CONSERVATIVE / BALANCED / AGGRESSIVE** — with the recommended one
   pre-selected. If the agent is not Ward-aware it runs in **observation mode**:
   alerts fire *after the fact*, not in real time. If the agent is already registered
   by another wallet, the publish/register steps are skipped and you can still
   subscribe to alerts bound to the existing policyId.

3. **Publish & subscribe** — optionally **publish** the chosen-tier policy and
   **register** the agent (both signed writes), then bind an alert channel. Choose
   **Slack** (an incoming-webhook URL,
   `https://hooks.slack.com/services/T…/B…/…`) or **Telegram** (a bot token from
   @BotFather plus a numeric chat_id). **Save** stores the binding in **this
   browser's IndexedDB only** — credentials never leave the browser and are shown
   masked afterward. **Send test alert** posts a clearly-marked test message to the
   channel. You can **Skip** the alert channel.

When done, the wizard deep-links into the **Subscriptions** section of the Watched
tab so you land on the row you just saved.

## Worked examples

Two reference integrations live under [`examples/`](examples/), both kept end to end:
a Ward-gated contract, and a Ward-gated React frontend. Start with
`ward-counter` — it is the smallest complete integration in the repo and
everything else builds on the pattern it shows.

| Example | What it teaches | Layer |
|---|---|---|
| [`ward-counter`](examples/ward-counter/) | The smallest possible Ward-gated agent — gates a single write through `WardOracle` with the `wardGuarded` modifier, and captures both an allow and a deny in one run. | Contract |
| [`ward-react-app`](examples/ward-react-app/) | A React + wagmi single-page demo that gates one `CounterAgent` write with `useWardGuardedWrite`, reading the live oracle before the wallet opens. | Frontend |

### Prerequisites

Both examples share the same setup:

- `pnpm install` at the repo root.
- A funded Somnia Shannon wallet. `pnpm ward preflight` checks this for you.
- For the contract example, a `.env` populated with `DEPLOYER_PK`, `SOMNIA_TESTNET_RPC`, and `WARD_ORACLE`.
- For the frontend example, an injected wallet (MetaMask, Rabby, etc.) with the Somnia Testnet network configured.

### `ward-counter` — the canonical contract integration

This pair of contracts gates a single counter write through `WardOracle`. It
answers one question: *what does the integration actually look like?* `CounterAgent`
inherits `WardAgentBase`, and the happy-path entrypoint is gated by the
`wardGuarded` modifier — from [`examples/ward-counter/src/CounterAgent.sol`](examples/ward-counter/src/CounterAgent.sol):

```solidity
function bump(uint256 by) external wardGuarded(this.bump.selector, 0) {
    counter.bump(by);
}

function reset() external wardGuarded(this.reset.selector, 0) {
    counter.reset();
}
```

The modifier asks the oracle `checkSelector(POLICY_ID, address(this), selector, value, spentToday)` before the body runs; if the policy denies, it reverts with `WardRejected(reason)`. This is the entrypoint-policy model: the policy targets the agent address with the agent's own selectors (`bump(uint256)` and `reset()`), and the body is free to call the downstream `Counter` without per-target policy entries.

**What's in the folder:**

| File | Role |
|---|---|
| [`policy.md`](examples/ward-counter/policy.md) | The POLICY.md this agent is gated against — published to `WardOracle` to mint the `policyId` you bind to `CounterAgent` via `setPolicyId`. |
| [`src/Counter.sol`](examples/ward-counter/src/Counter.sol) | The dumb counter being gated. No Ward awareness — just `bump(uint256)` and `reset()`. |
| [`src/CounterAgent.sol`](examples/ward-counter/src/CounterAgent.sol) | The Ward-aware wrapper, inheriting `WardAgentBase`. Holds the oracle plus a mutable `POLICY_ID` slot (late-binding pattern). Two normal functions — `bump(uint256)` and `reset()` — each gated by the `wardGuarded` modifier. When `POLICY_ID == 0x0`, the gate is a no-op and the agent runs ungated. |
| [`script/DeployCounter.s.sol`](examples/ward-counter/script/DeployCounter.s.sol) | Deploys the dumb counter and writes its address to `deployments/counter.json`. |
| [`script/DeployAgent.s.sol`](examples/ward-counter/script/DeployAgent.s.sol) | Deploys `CounterAgent` against an already-deployed `Counter`. `POLICY_ID` is optional — if set, the script binds it immediately; if unset, the agent ships ungated and you bind later. Writes `deployments/agent.json`. |

**The late-binding pattern.** `POLICY_ID` is a mutable storage slot that defaults to
`bytes32(0)` (= ungated) and is bound later via `setPolicyId(bytes32) onlyOwner`.
That lets you ship to testnet, exercise the agent, then add gating once you have
figured out the right policy.

**Run it: deploy ungated first, bind later** (recommended for new agents):

```bash
cd examples/ward-counter

# 1. Deploy the dumb counter.
forge script script/DeployCounter.s.sol \
  --rpc-url "$SOMNIA_TESTNET_RPC" \
  --broadcast --legacy --gas-estimate-multiplier 2000
export COUNTER=$(jq -r '.counter' deployments/counter.json)

# 2. Deploy the agent WITHOUT a POLICY_ID. It runs ungated — every bump
#    succeeds, every reset succeeds, nothing consults WardOracle.
unset POLICY_ID
forge script script/DeployAgent.s.sol \
  --rpc-url "$SOMNIA_TESTNET_RPC" \
  --broadcast --legacy --gas-estimate-multiplier 2000
export AGENT=$(jq -r '.agent' deployments/agent.json)

# 3. Exercise the agent freely while you figure out the right policy.
cast send "$AGENT" "bump(uint256)" 5 \
  --private-key "$DEPLOYER_PK" --rpc-url "$SOMNIA_TESTNET_RPC" --legacy

# 4. Author + publish the policy when you're ready.
pnpm ward push ./policy.md --label counter-demo
export POLICY_ID=0x... # from the publish output

# 5. Bind it. From now on every bump / reset is gated.
cast send "$AGENT" "setPolicyId(bytes32)" "$POLICY_ID" \
  --private-key "$DEPLOYER_PK" --rpc-url "$SOMNIA_TESTNET_RPC" --legacy
```

The `--gas-estimate-multiplier 2000` is required because Shannon's RPC under-reports gas by roughly 15×; this multiplier is baked into every deploy in this repo.

**Alternative: publish first, deploy bound in one go:**

```bash
cd examples/ward-counter

pnpm ward push ./policy.md --label counter-demo
export POLICY_ID=0x...

forge script script/DeployCounter.s.sol \
  --rpc-url "$SOMNIA_TESTNET_RPC" \
  --broadcast --legacy --gas-estimate-multiplier 2000
export COUNTER=$(jq -r '.counter' deployments/counter.json)

# POLICY_ID env is set → DeployAgent calls setPolicyId() in the same broadcast.
forge script script/DeployAgent.s.sol \
  --rpc-url "$SOMNIA_TESTNET_RPC" \
  --broadcast --legacy --gas-estimate-multiplier 2000
```

**What you'll observe.** After deploy, calling `CounterAgent.bump(by)` will:

1. If `POLICY_ID == 0x0`: the `wardGuarded` modifier short-circuits and the body forwards to `Counter.bump(by)`.
2. Otherwise: the modifier calls `WardOracle.checkSelector(POLICY_ID, address(this), this.bump.selector, 0, spentToday)`, and reverts with `WardRejected(<reason>)` (e.g. `EXPIRED`, `SELECTOR_NOT_ALLOWED`, `DAILY_CAP`) if the oracle says no.
3. On allow, the body forwards `Counter.bump(by)` (which emits `Bumped` on the downstream `Counter` address).

`reset()` is gated the same way, but the bundled policy authorizes only `bump(uint256)` — it deliberately omits `reset()`. So under the published policy, `reset()` reverts with `WardRejected("SELECTOR_NOT_ALLOWED")` and `bump(by)` lands. The end-to-end smoke run therefore captures one allow and one deny across two transactions; the deny-path proof is the typed revert, not an emitted event.

Watch the calls land in the dashboard's [Queue tab](http://localhost:5174/?tab=queue) (or `:5173` if your dev server took the default port). Raw chain history lives on Shannon Explorer.

**Operational primitives:**

| Action | Call | Who |
|---|---|---|
| Bind / migrate policy | `setPolicyId(0xNEW)` | `owner` only |
| Emergency kill-switch (re-ungate) | `setPolicyId(bytes32(0))` | `owner` only |
| Hand off control | `transferOwnership(newOwner)` | current `owner` only |

**Trust caveat.** Because `POLICY_ID` is mutable, the agent's behavior *can* change after users interact with it — a rebind or an unbind is a single transaction. Every change emits `PolicyBound(newPolicyId, oldPolicyId, by)`; the dashboard's WatchWizard reads `POLICY_ID()` live and surfaces the current binding. External observers should subscribe to `PolicyBound` to detect rebinds.

### `ward-react-app` — the React/wagmi frontend gate

A single-page React + wagmi demo that gates one `CounterAgent` write with `useWardGuardedWrite` from `@ward/react`. The preflight reads the live Somnia Shannon Testnet `WardOracle`, so the decision the UI shows is the same one the on-chain agent will see.

The on-chain gate still does the heavy lifting. If a user bypasses this UI and calls the agent directly, the contract reverts on the same policy. The frontend gate is for fast feedback and a clean wallet popup, not for security.

**Run it.** From the repo root:

```bash
pnpm install
pnpm --filter ward-react-app-example dev
```

`predev` builds `@ward/sdk` and `@ward/react` first so the workspace deps resolve to real `dist/` output.

Open the URL Vite prints. Connect an injected wallet (MetaMask, Rabby, etc.) that has the Somnia Testnet network configured.

**What the demo does:**

- Connects an injected wallet and confirms you are on chain `50312`.
- Lets you edit the agent address and the policy ID. Sane defaults:
  - agent `0x14F7271Dec889acC152101674A4fb4C52388f517`
  - policy `0x5cb2578abeb7f3fd1cec125b589721e6fd474901d49a4ffd1ab1b05f4754bd9e`
- "Bump counter" calls `useWardGuardedWrite` with `source.kind = "chain"`.
- The hook reads `WardOracle.checkIntent` on Somnia and surfaces the decision (`Allowed`, `Source`, `Reason code`, `Reason`).
- On a reject the wallet popup never opens. On allow, wagmi submits `CounterAgent.bump` and the panel shows the tx hash.

> **Heads up — re-deploy needed.** The default `agent` / `policy` above were published against the pre-v0.12.0 `tryBump(uint256,uint256)` / `tryReset(uint256)` ABI. The simplified `bump(uint256)` / `reset()` shape (current at HEAD) does not match the live contract until an operator redeploys via `examples/ward-counter/script/DeployAgent.s.sol`, republishes `examples/ward-counter/policy.md`, and updates these defaults.

**See the reject path manually.** Point "Policy ID" at a policy that exists on the oracle but does not authorize `bump` on the agent surface. For example, swap in any deployed policy ID that omits the `bump(uint256)` selector. The decision pane will show `Allowed: no` and the wallet popup will stay closed.

Do not paste a random non-existent hex string. The oracle reverts with the `PolicyNotFound()` custom error for unknown policies and the hook surfaces that as an error instead of a decision.

**Where to look:**

- `src/App.tsx` owns wallet, chain, and form state. It only mounts the panel once the wallet is connected and the public client is ready.
- `src/GuardedBumpPanel.tsx` is the gated panel. The `useWardGuardedWrite` call sits at the top.
- `src/wagmi.ts` holds the Somnia chain definition and the `WardOracle` address.
- `src/abi.ts` is the minimal ABI fragment for `CounterAgent.bump`.

**Tests:**

```bash
pnpm --filter ward-react-app-example test
```

The smoke test mocks wagmi and the SDK preflight, clicks the button, and asserts that on a reject the decision text reaches the DOM and `writeContract` is never called.

### The policy artifacts

Both examples are gated against a published POLICY.md — `ward-counter` against [`examples/ward-counter/policy.md`](examples/ward-counter/policy.md), and `ward-react-app` against a policy already deployed on the live oracle. The counter's policy is minimal: one target, one selector, `IMMEDIATE` tier, native spending capped at zero (the counter accepts no value).

For the exact POLICY.md grammar — the fields, tiers, and selector syntax these policies are written in — see **[SKILL.md](SKILL.md)**.

## Prior art

Ward did not invent policy-bounded agent execution. The intent-policy enforcement pattern (validate an agent-proposed action against a written policy before any state mutates) has been explored before in two adjacent shapes.

### Off-chain runtime enforcers

**[`kashaf12/mandate`](https://github.com/kashaf12/mandate)** is an MIT-licensed TypeScript SDK that intercepts agent tool calls and evaluates them against a JSON policy. Its lifecycle (`Authorization → Execution → Settlement → Commit-only-on-success`) and fail-closed default are the direct conceptual ancestors of Ward's two-phase executor and revert-on-policy-violation semantics. The project at [`synthesis.mandate.md`](https://synthesis.mandate.md/projects/mandate-approve-intent-not-just-transactions-c4cc) extends the SDK with 11 control layers (spend caps, address allowlists, prompt-injection scanning, transaction simulation, self-learning policy suggestions) targeting Ethereum, Base, Solana, TON, and BNB. Both run off-chain at the wallet/middleware layer.

### On-chain veto patterns

**[RageQuit Escrow](https://synthesis.mandate.md/projects/ragequit-escrow-cec5)** is an on-chain (Celo) execution layer where an agent's payout enters an escrow with a human-veto window; the payment commits if no veto arrives. Ward's risk-tiered policy (`IMMEDIATE` / `DELAYED` / `VETO_REQUIRED`) is a direct descendant of that pattern. The oracle exposes tier metadata via `tierAndDelay` and refuses to mark non-immediate calls as `ok`; `WardQueue` hosts the commit/veto/expire state machine for integrators that honor those tiers.

### What Ward adds

- **Validator-consensus authorization.** The policy decision runs at the same place that produced the calldata (Somnia's deterministic LLM consensus). Off-chain enforcers structurally cannot match this; on-chain enforcers on other L1s cannot use deterministic LLM consensus.
- **AgentRegistry-native identity.** Ward uses Somnia's built-in `AgentRegistry` (`0xaD3101C37F091593fEe7cb471e92b5E9A1205194` mainnet) for canonical `agentId`s. No external identity standard is required.
- **Selector-granular policy.** Per-target / per-selector tier, value cap, and delay. Lets an author authorize `approve(spender, X)` IMMEDIATE while keeping `transfer(to, *)` on `VETO_REQUIRED`.
- **`POLICY.md` format.** Plain markdown wrapper around a fenced YAML block; SDK ships a deterministic compiler to `PolicyInput`. The format is the human-authoring surface; the compiler is the bridge.
- **Namespaced shared registry.** `WardOracle.publishPolicy(label, …)` keys policies by `keccak256(publisher, label)`, so multiple agents share one deployed oracle without colliding. Publishers can iterate on their policy (`updatePolicy`) without changing the `policyId` integrators reference — same `policyId` is stable across updates.

### Where Ward deliberately does NOT compete

- **Prompt-injection scanning.** Out of scope; an off-chain enforcer (e.g. Mandate's Venice.ai integration) can sit upstream of Ward. Ward trusts what `inferToolsChat` consensus delivers.
- **Off-chain reputation/identity standards (ERC-8004, x402).** Somnia provides agent identity natively; Ward does not depend on these. Apps that want to interop with external chains can layer those above Ward's receipts.

### License compatibility

`kashaf12/mandate` is MIT. Ward is MIT.

## Documentation

The bulk of the docs now live in three top-level files. Start with whichever matches
the work you're doing:

| Where | What it covers |
| --- | --- |
| **[SKILL.md](SKILL.md)** | The single canonical reference: POLICY.md spec, contracts API, CLI reference, integration guide, tier model, gotchas, scaffold-an-agent, operate / monitor / AI-assisted-onboarding guides, integration models, and the conservative-policy worked example. |
| **[sdk/README.md](sdk/README.md)** | TypeScript SDK reference — POLICY.md compiler, PolicyBuilder, ABIs, oracle/queue/registry clients, preflight, event-store, plus the frontend gating packages (`@ward/react`, `@ward/vite`) and how to gate a frontend. |
| **[SECURITY.md](SECURITY.md)** | Trust + threat model, the no-custody invariants, per-function contract invariants, and how to report a vulnerability. |
| **[verification/lean/README.md](verification/lean/README.md)** | The Lean 4 formal model — 10 theorems, no `sorry` — and what they pin about the on-chain semantics. |
| **[Prior art](#prior-art)** (in this README) | Detailed positioning against off-chain enforcers, on-chain monitors, Safe modules, Zodiac, and session keys. |
| **[CONTRIBUTING.md](CONTRIBUTING.md)** | How to reproduce the test surface from source, repo layout, and the dashboard's internal design-system notes. |
| **[examples/](examples/)** | `ward-counter` (contract) and `ward-react-app` (frontend) — the two reference integrations covered in [Worked examples](#worked-examples) above. |

## Workspaces

```
contracts/   Foundry — WardOracle + WardQueue + WardAgentRegistry + PolicyLib/PolicyNormalizer/PolicyTypes
             + integration/ helpers (WardAgentBase, QueueAgentBase, WardCall)
sdk/         TypeScript — POLICY.md compiler, PolicyBuilder, ABIs, oracle/queue/registry clients, preflight, event-store
cli/         TypeScript — the `ward` binary (guided menu + direct commands)
dashboard/   React + viem — browser console (publish / queue / watched / watch-wizard)
tui/         Ink — operator queue monitor (`--json` NDJSON mode)
packages/    create-ward-agent scaffolder · ward-react + ward-vite frontend gating
verification/lean/   Lean 4 model — 10 theorems, no `sorry`
policy-spec/ POLICY.md format spec
examples/    ward-counter (contract) · ward-react-app (frontend)
```

## Formal verification

A Lean 4 model under [`verification/lean/`](verification/lean/) pins precedence, monotonicity, queue timing, and two-step policy-ownership properties — every proof checks under `lake build`, no `sorry`. This is *model* verification, not bytecode; scope is in **[verification/lean/README.md](verification/lean/README.md)**.

<a id="test-surface"></a>**Test surface** across the workspace: 133 Foundry core + 17 sample-agent · 196 SDK · 485 dashboard · 72 CLI · 31 ward-react · 7 ward-vite · 27 create-ward-agent · 1 ward-react-app (reproducible from source per **[CONTRIBUTING](CONTRIBUTING.md)**).

## Security

Unaudited prototype. Trust + threat model, per-function invariants, and vulnerability reporting all live in **[SECURITY.md](SECURITY.md)**.

## License

MIT.
