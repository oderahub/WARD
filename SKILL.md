---
name: ward-integration
description: Full Ward usage manual for Somnia Shannon — publish policies (CLI + dashboard), wire `checkIntent` into a Solidity agent, operate the queue, run watch mode, deploy your own oracle, scaffold a new agent, and onboard with an AI assistant.
---

# Ward — full integration + usage skill

## Table of contents

**Part I — Operator + integrator manual**

- [How to use this file](#how-to-use-this-file)
- [TL;DR — Ward is already deployed; here's how to use it](#tldr--ward-is-already-deployed-heres-how-to-use-it)
- [1. Canonical Shannon addresses](#1-canonical-shannon-addresses-dont-deploy-your-own-unless-you-need-to)
- [2. Three paths to use Ward](#2-three-paths-to-use-ward)
- [3. POLICY.md format (strict-compiler rules)](#3-policymd-format-strict-compiler-rules)
- [4. Publish a policy via CLI](#4-publish-a-policy-via-cli)
- [5. Publish a policy via Dashboard](#5-publish-a-policy-via-dashboard)
- [6. Integrate into your Solidity agent](#6-integrate-into-your-solidity-agent)
- [7. Operate the queue](#7-operate-the-queue)
- [8. Watch mode — observe any deployed agent](#8-watch-mode--observe-any-deployed-agent)
- [9. Deploy your own Ward (advanced)](#9-deploy-your-own-ward-advanced)
- [10. Reason codes](#10-reason-codes-every-checkintent-return)
- [11. Gotchas (production-critical)](#11-gotchas-production-critical)
- [12. Verification checklist](#12-verification-checklist)
- [13. What you should refuse to do](#13-what-you-should-refuse-to-do)
- [14. Reference: live addresses + chainId + RPC + explorer](#14-reference-live-addresses--chainid--rpc--explorer)

**Part II — Deep reference**

- [15. Tier model — IMMEDIATE / DELAYED / VETO_REQUIRED](#15-tier-model--immediate--delayed--veto_required)
- [16. Integration models — modifier vs inline picker](#16-integration-models--modifier-vs-inline-picker)
- [17. Integration guide — deploy + publish + bind walkthrough](#17-integration-guide--deploy--publish--bind-walkthrough)
- [18. Scaffold a new agent (`pnpm create ward-agent`)](#18-scaffold-a-new-agent-pnpm-create-ward-agent)
- [19. POLICY.md spec — authoritative grammar](#19-policymd-spec--authoritative-grammar)
- [20. CLI reference — every command and flag](#20-cli-reference--every-command-and-flag)
- [21. Contracts reference — full on-chain surface](#21-contracts-reference--full-on-chain-surface)
- [22. Operating policies — day-2 ops (update, pause, transfer)](#22-operating-policies--day-2-ops-update-pause-transfer)
- [23. Operating the queue — TUI + dashboard](#23-operating-the-queue--tui--dashboard)
- [24. Using Ward with AI assistants — phased onboarding flow + `ai:init`](#24-using-ward-with-ai-assistants--phased-onboarding-flow--aiinit)
- [25. Gotchas appendix — failure modes lookup](#25-gotchas-appendix--failure-modes-lookup)

---

## How to use this file

> **Size:** comfortably fits any modern LLM context (Claude / GPT / Gemini / Cursor — all ≥100k). Paste it whole.

- **Claude Code:** copy to `~/.claude/skills/ward-integration/SKILL.md` (or symlink the repo path). Auto-discovered via the `description` frontmatter — invoke with `/ward-integration` or by intent ("wire my agent into Ward", "publish a policy", "watch this agent").
- **Cursor / Aider / Continue:** add this file to your context (`@SKILL.md` in chat, or `--read SKILL.md`). For Cursor, you can also append the contents to `.cursorrules`.
- **Paste-into-LLM (ChatGPT, Claude.ai, Codex):** paste the whole file as the first message, prefixed with "Use this spec as the authoritative reference for the following request."

This file is self-contained: every address, command, schema rule, selector, struct, and reason code an LLM needs to publish a policy, integrate it, and operate it is inline. Do not look elsewhere unless the user asks something this file does not answer.

---

## TL;DR — Ward is a live agent on Shannon; here's how to use it

- **Ward is live on Somnia Shannon testnet (chainId 50312).** All three contracts (Oracle, Queue, AgentRegistry) are deployed and registered in Ward's own `WardAgentRegistry` — they show up by name in `findWardAgents()` so other agents and tooling can discover the gate without hard-coded addresses.
- **You almost never deploy Ward.** Both core contracts are ownerless, fundless, pure metadata/view.
- **Three things you do:** (1) publish a `POLICY.md` to get a `policyId`, (2) wire `oracle.checkIntent(policyId, intent, spentToday)` in front of every external call in your agent, (3) optionally use `WardQueue` for delayed / vetoable selectors.
- **Canonical for new integrations (v0.11.0+):** use the v2 oracle, v2 queue, and registry listed in §1. The v1 oracle and queue in that table stay live for pre-v0.11.0 policies but lack `checkSelector`, so they cannot back the `wardGuarded` modifier.
- **Pragma:** Solidity `0.8.26` everywhere.

---

## 1. Canonical Shannon addresses (don't deploy your own unless you need to)

| Thing | Value |
|---|---|
| `WardOracle` *(v2, canonical for new integrations)* | `0x3C7bF90f243d670a01f512221d9546e09fEaCC9c` |
| `WardQueue` *(v2)* | `0xFB715A37951Fc8dcc920120768e91f7C8bbA54c4` |
| `WardAgentRegistry` *(v0.10.0, oracle-agnostic)* | `0x97F743A9AAa5AcAA73075C1B8F1921274755CF70` |
| `WardOracle` *(v1, still live for pre-v0.11.0 policies)* | `0x68d4B045B24F8d1012974b9d34684cA5aeD11DDf` |
| `WardQueue` *(v1, still live)* | `0x98A3f7C38D19edF1ddA7E3bc38fa4B935aD590D5` |
| Somnia agent platform | `0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776` |
| LLM inference agent id | `12847293847561029384` (uint256) |
| JSON API agent id | `13174292974160097713` (uint256) |
| Default request deposit | `0.12 ether` (validator reward only; see §11 gotcha 14) |
| Chain | Somnia Shannon testnet, chainId `50312` |
| RPC | `https://dream-rpc.somnia.network` |
| Explorer | `https://shannon-explorer.somnia.network` |

These are the **only** addresses your agent should reference unless you've deliberately deployed a private fork (§9).

---

## 2. Three paths to use Ward

| Path | When | What you do |
|---|---|---|
| **A. Publish + integrate (most common)** | You're building a new (or modifying an existing) agent and want it gated. | Inherit `WardAgentBase` and tag each state-changing entrypoint with `wardGuarded(this.entryName.selector, value)`. `WardAgentBase` already supplies the mutable `POLICY_ID` slot, `setPolicyId(bytes32) onlyOwner` with `PolicyBound` events, the spend tracker, and the modifier's no-op-when-unbound shortcut — so deploys ship ungated by default. Author + publish a `POLICY.md` (§4 CLI or §5 dashboard) when ready, then `setPolicyId(0xYOURPOLICY)`. Use `setPolicyId(0x0)` as an emergency kill-switch; use `setPolicyId(0xNEW)` to migrate policies without redeploying. See §6.5 for the canonical shape. |
| **B. Watch an existing agent** | You did NOT write the agent (3rd party, no source, can't redeploy) but want to observe its calls against a policy. | Use dashboard Watch mode (§8). No on-chain change to the target agent; just publishes a `mode=watch` policy and replays the agent's recent txs via `debug_traceTransaction`. |
| **C. Operate the queue** | You're the asker (DELAYED) or the policy owner (VETO_REQUIRED) for pending intents. | Use `ward queue:*` CLI (§7) or the dashboard Queue tab. |
| **D. FE preflight (no on-chain agent)** | Pure FE app — no Ward-aware contract; you want every outgoing call gated client-side BEFORE signing. | Author a `POLICY.md`, bundle it with the FE, call `preflight({ source: { kind: 'spec', yaml }, intent, spentTodayWei })` before submitting. See `sdk/src/preflight.ts` + the React hook surface in `packages/ward-react/`. |

Mental model: Ward is a **synchronous, view-only on-chain policy oracle**. Four nouns:

- **Policy** — stable, namespace-derived rule set (`bytes32 policyId = keccak256(abi.encode(publisher, label))`) listing allowed `(target, selector)` pairs with per-call value caps, a daily wei cap, an expiry, and a tier per selector. Same `(publisher, label)` always yields the same id, across `publishPolicy` and `updatePolicy`.
- **Intent** — the call your agent is about to make, packed as a struct.
- **Oracle** — `WardOracle.checkIntent(policyId, intent, spentToday) returns (bool ok, bytes32 reason)`. Pure view. No funds, no execution.
- **Queue** (opt-in) — `WardQueue` coordinates `TIER_DELAYED` and `TIER_VETO_REQUIRED` intents. Still no custody, still no execution — only stores metadata and emits events. The asker calls `dispatch(execId)` and performs the call itself.

---

## 3. POLICY.md format (strict-compiler rules)

The compiler is **strict** — unknown fields fail. A `POLICY.md` is a free-form markdown document that contains **exactly one fenced code block with language tag `policy`**. That block holds the canonical `PolicyInput` YAML — the schema. Everything outside the fence (titles, prose, rationale) is for humans and ignored by the compiler. Canonical example: `examples/ward-counter/policy.md`.

````md
# My Agent Policy

Free-form rationale, links, threat-model notes — anything you want above the fence.

```policy
version: "0.1"
dailySpendWeiCap: "1 ether"
expiresAt: "2026-12-31T23:59:59.000Z"
targets:
  - target: "0x1111111111111111111111111111111111111111"
    selectors:
      - selector: "doThing(uint256)"
        tier: IMMEDIATE
        valueCapPerCall: "0.1 ether"
        delaySeconds: 0
      - selector: "doDelayed(uint256)"
        tier: DELAYED
        valueCapPerCall: "0.5 ether"
        delaySeconds: 3600
      - selector: "withdraw(address)"
        tier: VETO_REQUIRED
        valueCapPerCall: "0"
        delaySeconds: 0
```

More prose below the fence is also fine.
````

Schema rules (compiler is strict — extra/unknown fields are rejected):

- The fence language SHOULD be `policy`. A single untagged ```` ``` ```` block is also accepted as a fallback (multiple untagged blocks fail with an "ambiguous" error). Plain ```` ```yaml ```` is not detected as either form.
- The `label` is supplied by the CLI (`--label` flag) or the dashboard form, **not** the YAML. The YAML has no `label` field.
- Top-level required keys: `version` (currently `"0.1"`), `dailySpendWeiCap`, `expiresAt`, `targets`.
- `tier` MUST be uppercase, one of `IMMEDIATE` / `DELAYED` / `VETO_REQUIRED`. No `TIER_` prefix.
- `delaySeconds` MUST be `0` for `IMMEDIATE` and `VETO_REQUIRED`. Only `DELAYED` may set it `> 0`.
- Each target row keys on `target:` (the address). Each selector row keys on `selector:` (the function signature). The compiler computes the 4-byte selector itself.
- `valueCapPerCall` is per `(target, selector)`, in wei. Accepts `"1 ether"` shorthand or raw integer strings.
- `dailySpendWeiCap` is the per-UTC-day rolling cap across ALL selectors (native wei only — ERC20 amounts are not summed).
- `expiresAt` is ISO-8601; after that timestamp `checkIntent` returns `(false, "EXPIRED")`.
- Caps: `MAX_TARGETS = 20`, `MAX_SELECTORS_PER_TARGET = 10`. Larger policies revert at publish; they do not silently truncate.
- Reserved target: `WardOracle` itself (v2 `0x3C7bF90f…CC9c` or v1 `0x68d4B045…11DDf` — whichever your agent binds to) — including it fails compilation.
- Labels (separate from the YAML) are encoded as `padHex({size:32, dir:"right"}, stringToBytes(label))` — UTF-8 right-padded with zeros. **Never `keccak256(label)`.** The CLI handles this for you.

For the complete authoritative grammar (every field, every validation rule, EIP-55 enforcement, error messages, `maxSlippageBps` semantics), see [§19 POLICY.md spec](#19-policymd-spec--authoritative-grammar).

---

## 4. Publish a policy via CLI

Use `pnpm ward` for the guided CLI menu, or `pnpm ward <command>` for direct commands after `pnpm -C cli run build`. Env (`.env` in repo root): `PRIVATE_KEY=0x…`. `WARD_ORACLE` / `WARD_QUEUE` default to the canonical addresses above.

Full direct surface (16 commands + 1 alias, sourced from `cli/src/index.ts`):

| Command | What it does | Example |
|---|---|---|
| `ward compile <path>` | Compile `POLICY.md` → canonical `PolicyInput` JSON. No RPC, no wallet. Validates schema (reserved targets, oversized labels, bad selectors). | `ward compile ./POLICY.md` |
| `ward push <path> [--label <name>]` | Compile + publish (or update) on-chain under `(wallet, label)`; auto-detects publish vs. update via `policyOwner`. Prints tx hash + `OK · policyId = 0x…`. | `ward push ./POLICY.md --label my-agent` |
| `ward policyid <label> [--publisher <addr>]` | Pure helper — compute the deterministic `policyId` for `(publisher, label)` without RPC. Useful to hardcode `POLICY_ID` BEFORE publish. | `ward policyid my-agent --publisher 0xAbCd…` |
| `ward inspect <intent.json>` | Pretty-print an Intent JSON, decode `data` against known ABIs, sanity-check `selector == data[0:4]`. | `ward inspect ./intent.json` |
| `ward lint <path> [--abi <path>] [--oracle <addr>] [--rpc <url>] [--policy-id <id>] [--fail-on <rules>] [--json]` | Lint POLICY.md for common Ward integration mistakes (8 rules). | `ward lint ./POLICY.md --abi out/MyAgent.sol/MyAgent.json` |
| `ward policy:init --abi <path> --target <addr> [--profile strict\|balanced\|aggressive] [--expires <iso>]` | Generate a starter POLICY.md from a contract ABI. | `ward policy:init --abi out/MyAgent.sol/MyAgent.json --target 0xAbCd…` |
| `ward analyze:gate <path> [--json]` | Static check that every dispatch in an agent contract is gated by `wardGuarded(...)`, `_wardCheck(...)`, or `WardCall.check(...)`. | `ward analyze:gate src/MyAgent.sol` |
| `ward ai:init [--cursor] [--claude] [--codex] [--all] [--force]` | Regenerate Cursor / Claude / Codex (AGENTS.md) context files from this SKILL.md. | `ward ai:init --codex --force` |
| `ward preflight [--min-balance <eth>]` | Verify env (PK shape, platform, agentId, oracle/queue), reach Somnia RPC, fetch chainId + STT balance. Exit 0 if ready, 1 otherwise. | `ward preflight --min-balance 0.5` |
| `ward tui [--json]` | Open the full-screen Ink queue monitor; `--json` streams NDJSON events to stdout instead. | `ward tui --json \| jq` |
| `ward queue:status <execId>` | Cheap header read (skips `intent.data`): `state`, `tier`, `policyId`, `asker`, `target`, `selector`, `value`, `enqueuedAt`, `earliestCommitAt`, `deadline`. | `ward queue:status 42` |
| `ward queue:handoff <execId>` (alias `handoff`) | Print operator handoff guidance for a queued execution (including the agent-side `dispatchQueued(uint256)` wrapper when the ABI exposes it). | `ward queue:handoff 42 --agent 0xAbCd… --abi out/MyAgent.sol/MyAgent.json` |
| `ward queue:enqueue <intent.json> <policyId> [--spent-today <wei>]` | Submit an Intent under a policyId (DELAYED / VETO_REQUIRED only; IMMEDIATE reverts `IMMEDIATE_NO_QUEUE_NEEDED`). Submits the tx and reports the tx hash — it does NOT parse the `Enqueued` event for you. Fetch the execId yourself (see below). | `ward queue:enqueue ./intent.json 0xb4bd701e…` |
| `ward queue:dispatch <execId> [--execute]` | Transition Pending → Committed; with `--execute`, also send the returned Intent from the caller wallet. | `ward queue:dispatch 42 --execute` |
| `ward queue:veto <execId> <reason>` | Policy owner cancels with a ≤32-byte reason (right-padded). Reverts if caller isn't owner or record is terminal. | `ward queue:veto 42 "owner-reject-bad-call"` |
| `ward queue:expire <execId>` | Permissionless GC after `deadline`. Reverts if still in window or already terminal. | `ward queue:expire 42` |

Typical first-publish flow:

```bash
ward preflight                          # verify env + balance
ward compile ./POLICY.md                # local validation
ward policyid my-agent                  # precompute id (paste into agent)
ward push ./POLICY.md --label my-agent  # ship; confirm policyId matches
```

**Verify the precomputed `policyId` matches the published one.** If they differ, stop — something is wrong with label encoding.

For every flag, every environment variable, every exit code, and the guided menu mapping, see [§20 CLI reference](#20-cli-reference--every-command-and-flag).

---

## 5. Publish a policy via Dashboard

Run `pnpm -C dashboard run dev` → open `http://localhost:5173`. Four tabs: **Publish**, **Queue**, **Watched**, **Watch Wizard** (`?tab=watch-wizard`).

Enforce-mode publish (8 steps):

1. **Connect Wallet** (top right). The connected address becomes the policy publisher.
2. **Open the Publish tab.** ModeToggle defaults to **Enforce**. Left pane = form, right pane = live POLICY.md preview.
3. **Pick a starter.** Four `PolicyTemplates` cards: **DEX swapper**, **NFT mint guard**, **Treasury bot**, **LLM dispatcher**. Click one to pre-fill targets/selectors/caps. Alternative: open "Already have an agent on Shannon? Import its call surface" disclosure to use Discover (§8).
4. **Fill identity.** `policy name`, `short id` (label, ≤32 bytes), `daily limit` (e.g. `1 ether`), `valid until`. Replace placeholder `0x0000…0000` target with your real contract address — compile check (green ✓ / red ✗) blocks publish until valid.
5. **Tune selectors.** Per row: function signature like `transfer(address,uint256)`, approval mode (`IMMEDIATE` / `DELAYED` / `VETO_REQUIRED`), `valueCapPerCall`, `delaySeconds`.
6. **Preview with `IntentSimulator`** (below publish button) — paste target+selector+value, see what `checkIntent` would return.
7. **Click "publish policy"** → wallet prompts for `publishPolicy(PolicyInput)` on `WardOracle`. ~10s on Shannon.
8. **Reveal panel** (`PublishedReveal`) shows `bytes32 POLICY_ID = 0x…` (copy as Solidity constant), downloadable `.md`, and updates URL to `?revealed=<policyId>` (shareable; hydrates via cache → EventStore → `lookupPolicyOnChain`).

---

## 6. Integrate into your Solidity agent

ABI cheatsheet:

```solidity
// WardOracle (pure view)
function checkIntent(bytes32 policyId, Intent calldata intent, uint256 spentToday)
    external view returns (bool ok, bytes32 reason);
function policyOwner(bytes32 policyId) external view returns (address);
function policyHealth(bytes32 policyId) external view returns (bool paused, uint64 expiresAt);
// reverts PolicyNotFound() if never published

// WardQueue (no custody)
function enqueue(bytes32 policyId, Intent calldata intent, uint256 spentToday)
    external returns (uint256 execId);
function dispatch(uint256 execId) external returns (Intent memory intent);  // asker- or owner-only by tier
function veto(uint256 execId, bytes32 reason) external;                      // policyOwner only
function expireIfStale(uint256 execId) external;                              // anyone after deadline

// Tier constants (uint8 in policy storage)
// TIER_IMMEDIATE = 0  — ok=true if legal
// TIER_DELAYED   = 1  — checkIntent returns (false, "REQUIRES_DELAY")
// TIER_VETO_REQUIRED = 2 — checkIntent returns (false, "REQUIRES_VETO")
```

`Intent` struct — field order is load-bearing (positional ABI, must match `PolicyTypes.sol` exactly):

```solidity
struct Intent {
    uint256 agentId;       // your Somnia agentId, or 0 if not an LLM agent
    uint256 requestId;     // your nonce / correlation id
    address target;        // call destination
    bytes4  selector;      // first 4 bytes of data; MUST match data[0:4]
    bytes   data;          // full calldata, selector included
    uint256 value;         // wei to send
    bytes32 promptHash;    // hash of LLM prompt, or bytes32(0)
    uint8   taskClass;     // 0 by default
}
```

`spentToday` (third arg to `checkIntent`) — two valid patterns:

- **Stateless**: pass `0`. Safe when the agent only ever fires `value: 0` calls (so the daily cap never bites), or when the agent fires one call per day. Cheapest.
- **Stateful**: keep `mapping(uint64 => uint256) _wardDailySpent;` keyed by `uint64(block.timestamp / 1 days)`, pass that value to `checkIntent`, bump it by `intent.value` after a successful dispatch. Use this whenever your policy can carry native value.

**`dailySpendWeiCap: "0"` does NOT mean "no daily cap" — it BLOCKS all native spending under the policy.** The cap is always enforced; `0` means only calls with `intent.value == 0` pass (any `intent.value > 0` returns `(false, "DAILY_CAP")`). Same rule applies per-selector: `valueCapPerCall: "0"` blocks any call carrying msg.value > 0. To get effectively "no cap", set a ceiling well above any plausible spend, e.g. `dailySpendWeiCap: "1000 ether"`.

If the policy genuinely never carries native value (all selectors are ERC20 / view-style), `dailySpendWeiCap: "0"` is fine and stateless `0` for `spentToday` is correct. Otherwise wire the stateful tracker.

### Canonical agent template

Drop into a new file; replace `target`, `DO_SELECTOR`, `DELAYED_SELECTOR`, and `POLICY_ID` with your values.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Remappings required in foundry.toml:
///   remappings = ["ward/=lib/ward/contracts/src/"]
/// Add as forge dep:
///   forge install <user>/ward
import "ward/WardOracle.sol";
import "ward/WardQueue.sol";
import "ward/PolicyTypes.sol";

contract MyAgent {
    WardOracle public immutable oracle;
    WardQueue  public immutable queue;        // omit if you never queue
    bytes32      public immutable POLICY_ID;
    address      public immutable target;
    address      public immutable owner;

    bytes4 internal constant DO_SELECTOR      = bytes4(keccak256("doThing(uint256)"));
    bytes4 internal constant DELAYED_SELECTOR = bytes4(keccak256("doDelayed(uint256)"));

    // UTC-day -> native wei spent. Asker owns this; queue cannot see it.
    mapping(uint64 => uint256) public spentToday;

    event Dispatched(uint256 indexed reqId);
    event Queued(uint256 indexed reqId, uint256 indexed execId);
    event Rejected(uint256 indexed reqId, bytes32 reason);

    error CallFailed();
    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(WardOracle _oracle, WardQueue _queue, bytes32 _policyId, address _target) {
        oracle = _oracle;
        queue = _queue;
        POLICY_ID = _policyId;
        target = _target;
        owner = msg.sender;
    }

    function _today() internal view returns (uint64) {
        return uint64(block.timestamp / 1 days);
    }

    function _buildIntent(
        uint256 reqId,
        address t,
        bytes4 selector,
        bytes memory data,
        uint256 value
    ) internal pure returns (Intent memory i) {
        i = Intent({
            agentId: 0,
            requestId: reqId,
            target: t,
            selector: selector,
            data: data,
            value: value,
            promptHash: bytes32(0),
            taskClass: 0
        });
    }

    // ---------------- IMMEDIATE path ----------------
    function triggerImmediate(uint256 reqId, uint256 arg) external payable onlyOwner {
        bytes memory data = abi.encodeWithSelector(DO_SELECTOR, arg);
        Intent memory intent = _buildIntent(reqId, target, DO_SELECTOR, data, msg.value);

        (bool ok, bytes32 reason) = oracle.checkIntent(POLICY_ID, intent, spentToday[_today()]);
        if (!ok) { emit Rejected(reqId, reason); return; }

        spentToday[_today()] += msg.value;
        (bool s,) = target.call{value: msg.value}(data);
        if (!s) revert CallFailed();
        emit Dispatched(reqId);
    }

    // ---------------- DELAYED path ----------------
    function triggerDelayed(uint256 reqId, uint256 arg) external payable onlyOwner {
        bytes memory data = abi.encodeWithSelector(DELAYED_SELECTOR, arg);
        Intent memory intent = _buildIntent(reqId, target, DELAYED_SELECTOR, data, msg.value);

        (bool ok, bytes32 reason) = oracle.checkIntent(POLICY_ID, intent, spentToday[_today()]);
        if (!ok && reason != bytes32("REQUIRES_DELAY")) {
            emit Rejected(reqId, reason);
            return;
        }
        uint256 execId = queue.enqueue(POLICY_ID, intent, spentToday[_today()]);
        spentToday[_today()] += msg.value;  // tally at enqueue; not rolled back on veto/expire
        emit Queued(reqId, execId);
    }

    // Asker dispatches its own DELAYED intent after the delay window opens.
    function dispatchQueued(uint256 execId) external onlyOwner {
        Intent memory i = queue.dispatch(execId);
        (bool ok,) = i.target.call{value: i.value}(i.data);
        if (!ok) revert CallFailed();
    }

    receive() external payable {}
}
```

For an LLM-driven async-callback agent (Somnia platform `createRequest` → `handleResponse` → Ward gate → dispatch), the integration is identical: build the `Intent` inside `handleResponse` (after asserting `msg.sender == address(PLATFORM)`), call `oracle.checkIntent`, then dispatch yourself. No code in this repo ships an LLM sample; the integration surface is the same five lines as the canonical template above.

### 6.1 Self-perpetuating loop pattern

A self-perpetuating LLM agent re-queues itself with the Somnia platform after each callback, gated by the same `checkIntent` on every iteration. The policy does NOT change — one gated selector, the same `dailySpendWeiCap` covers every cycle.

Four kill switches an LLM-perpetuated agent MUST include — any one trips and the loop halts cleanly:

1. **`paused` boolean** — owner-flippable (`setPaused(true)`), checked first.
2. **`iterationsThisRun >= maxIterations`** — immutable hard cap set at construction.
3. **`address(this).balance < PER_ITERATION_DEPOSIT`** — refuse to re-queue when the deposit floor (≈1 STT) won't cover the next `createRequest`.
4. **Model verdict `STOP`** — let the LLM itself terminate; treat as authoritative.

Wrap the self-kickoff in `try/catch` so a platform-side revert flips `paused` instead of bubbling and bricking `handleResponse`.

### 6.5 Late-binding pattern (recommended for new agents)

The template in §6 declares `bytes32 public immutable POLICY_ID`, which is correct when you publish the policy BEFORE deploying the agent. For greenfield work the more ergonomic shape is a **mutable** `POLICY_ID` that the owner binds later — you can ship the agent to testnet, exercise it ungated, and add gating once you've figured out the right policy. The same lever doubles as an emergency kill-switch and a no-redeploy migration path.

The canonical dual-layer shape (full source: `examples/ward-counter/src/CounterAgent.sol`):

```solidity
import "ward/WardOracle.sol";
import "ward/integration/WardAgentBase.sol";
import {Counter} from "./Counter.sol";

contract MyAgent is WardAgentBase {
    Counter public immutable counter;

    /// Caller allow-list. Owner-managed; independent of POLICY_ID.
    mapping(address => bool) public isOperator;

    event OperatorAdded(address indexed operator, address indexed by);
    event OperatorRemoved(address indexed operator, address indexed by);
    error NotOperator();

    modifier onlyOperator() {
        if (!isOperator[msg.sender]) revert NotOperator();
        _;
    }

    constructor(WardOracle _oracle, Counter _counter, address _owner)
        WardAgentBase(_oracle, _owner)
    {
        counter = _counter;
        // Owner bootstrapped as the initial operator so the deployer can
        // call entrypoints immediately. No POLICY_ID required at deploy —
        // inherited mutable slot starts at bytes32(0) and the
        // wardGuarded modifier short-circuits while unbound, so the
        // agent ships ungated by Ward (caller allow-list still applies).
        isOperator[_owner] = true;
        emit OperatorAdded(_owner, address(0));
    }

    function addOperator(address op) external onlyOwner {
        if (!isOperator[op]) { isOperator[op] = true; emit OperatorAdded(op, msg.sender); }
    }

    function removeOperator(address op) external onlyOwner {
        if (isOperator[op]) { isOperator[op] = false; emit OperatorRemoved(op, msg.sender); }
    }

    /// Modifier order is deliberate: `onlyOperator wardGuarded(...)`.
    /// Solidity runs modifiers left-to-right, so the cheap Solidity ACL
    /// check fires FIRST — non-operators revert with NotOperator before
    /// the oracle staticcall happens, saving gas on doomed calls.
    function doThing(uint256 by)
        external
        onlyOperator
        wardGuarded(this.doThing.selector, 0)
    {
        counter.bump(by);
    }
}
```

`WardAgentBase` (see `contracts/src/integration/WardAgentBase.sol`)
gives you the mutable `POLICY_ID` slot, `owner` + `onlyOwner` +
`transferOwnership`, `setPolicyId` with `PolicyBound` events, and the
spend tracker — so the per-agent boilerplate collapses to a constructor
and the modifier-tagged entrypoint(s). For multi-outbound flows that need
per-outbound gating, drop the modifier and call `_wardCheck` + `_call`
directly.

#### Layering Solidity access control on top of Ward

`onlyOperator` and `wardGuarded` are **orthogonal** access-control
layers — each one answers a different question and neither subsumes the
other:

- **`onlyOperator` answers *who can call this?***. It's plain Solidity. A
  `mapping(address => bool)` registry the `owner` manages with
  `addOperator` / `removeOperator`. Ward policies have NO visibility
  into `msg.sender`, so caller-identity ACLs must live at the Solidity
  layer.
- **`wardGuarded` answers *is this call allowed by the policy?***. It
  staticcalls `WardOracle.checkSelector(POLICY_ID, address(this),
  selector, value, spentToday)` and reverts with `WardRejected(reason)`
  if the oracle says no. It enforces what the *agent* can do, regardless
  of who triggered it.

**Modifier order matters.** Write them as `onlyOperator wardGuarded(...)`.
Solidity executes modifiers left-to-right, so the cheap Solidity check
fires FIRST — non-operators revert with `NotOperator` *before* the agent
makes the external oracle call, saving gas on doomed calls. Reversing the
order to `wardGuarded(...) onlyOperator` is functionally broken in two
ways: (a) under an unbound `POLICY_ID == 0x0` the `wardGuarded`
short-circuit lets the call reach `onlyOperator` either way, masking the
order regression in any unbound-path test; (b) under a *bound* rejecting
policy, the same unauthorized-caller call would revert
`WardRejected("SELECTOR_NOT_ALLOWED")` instead of `NotOperator`,
silently swapping the two layers' jobs. The dual-layer tests in
`examples/ward-counter/test/CounterAgentLateBinding.t.sol` pin a bound
+ unauthorized variant for exactly this reason.

The operator registry is **independent of ownership** — `transferOwnership`
does NOT auto-rotate operators. Operators are an operational allow-list,
not a security role.

Three operational primitives the pattern unlocks:

| Action | Call | Effect |
|---|---|---|
| Bind | `setPolicyId(0xPOLICY)` | Agent becomes gated against `0xPOLICY`. |
| Emergency kill-switch | `setPolicyId(bytes32(0))` | Agent instantly returns to ungated. Use when Ward misfires. |
| Migrate | `setPolicyId(0xNEW)` | Swap to a new policyId without redeploying. |

**Trust caveat.** A mutable `POLICY_ID` means the agent's behavior can change AFTER users have interacted with it — a rebind or unbind is a single transaction signed by `owner`. The pattern intentionally mitigates this by:

1. Emitting `PolicyBound(newPolicyId, oldPolicyId, by)` on EVERY change so external observers can detect rebinds.
2. Exposing `POLICY_ID()` as a public view so the dashboard WatchWizard surfaces the **current** binding in its Step 2 discovery report (a non-zero binding shows the bound policy; `0x0` shows "agent is ungated — calls run without Ward").

If your threat model requires immutable bindings (e.g. the agent custodies user funds and policy stability is part of the trust assumption), keep `POLICY_ID` `immutable` as in the §6 template. Otherwise prefer the late-binding shape — it makes both the iteration loop and the emergency response materially cleaner.

---

## 7. Operate the queue

Per-tier dispatcher rules:

- **DELAYED:** the original `asker` (your agent) dispatches once `earliestCommitAt` has passed. A CLI / dashboard / multisig **cannot** call `queue.dispatch` directly — you MUST expose an `onlyOwner` wrapper on the agent (`dispatchQueued(execId)` in the template above).
- **VETO_REQUIRED:** the current `policyOwner` dispatches (not the asker). "No veto" alone does not ship; the owner has to actively call `dispatch`. If `policyOwner` is a multisig with no execution path into your agent, VETO calls will revert at dispatch — use DELAYED unless the dispatcher path is wired.
- **Expire:** anyone may call `expireIfStale(execId)` after the deadline. `COMMIT_WINDOW_SECONDS = 7 days` is hard-coded.

CLI:

| Command | Purpose |
|---|---|
| `ward queue:status <execId>` | Cheap header read (skips `intent.data`): `state`, `tier`, `policyId`, `asker`, `target`, `selector`, `value`, `enqueuedAt`, `earliestCommitAt`, `deadline`. |
| `ward queue:enqueue <intent.json> <policyId> [--spent-today <wei>]` | Submit an Intent under a policyId (DELAYED / VETO_REQUIRED only; IMMEDIATE reverts `IMMEDIATE_NO_QUEUE_NEEDED`). Submits the tx and reports the tx hash — it does NOT parse the `Enqueued` event for you. Fetch the execId yourself (see below). |
| `ward queue:dispatch <execId> [--execute]` | Transition Pending → Committed; with `--execute`, also send the returned Intent from the caller wallet. |
| `ward queue:veto <execId> <reason>` | Policy owner cancels with a ≤32-byte reason (right-padded). Reverts if caller isn't owner or record is terminal. |
| `ward queue:expire <execId>` | Permissionless GC after `deadline`. Reverts if still in window or already terminal. |

Per-command example + common failure:

```bash
# queue:status — read a known execId
ward queue:status 42
# common failure: "Pending=false, state=Vetoed" → it's already terminal; can't dispatch.

# queue:enqueue — submit an Intent. Does NOT print execId.
ward queue:enqueue ./intent.json 0xb4bd701e2eee… --spent-today 0
# common failure: "IMMEDIATE_NO_QUEUE_NEEDED" → that (target, selector) is IMMEDIATE tier; don't queue, call directly.

# queue:dispatch — commit a pending execId, optionally execute
ward queue:dispatch 42 --execute
# common failure: "NotYetCommittable" → block.timestamp < earliestCommitAt; wait out delaySeconds.

# queue:veto — policy owner cancels with a short reason
ward queue:veto 42 "owner-reject-bad-call"
# common failure: "NotPolicyOwner" → connected wallet isn't the publisher of policyId.

# queue:expire — anyone, after deadline
ward queue:expire 42
# common failure: "NotYetExpired" → still within the 7-day COMMIT_WINDOW_SECONDS.
```

**Fetching execId after `queue:enqueue`** — three ways:

1. **Dashboard** — open the Queue tab; the new row shows up under Pending with the execId column.
2. **`cast logs`** — scan the `Enqueued` event from the enqueue tx forward. The on-chain signature (see `contracts/src/WardQueue.sol:65`) is:
   ```
   Enqueued(uint256 indexed execId, bytes32 indexed policyId, address indexed asker, uint8 tier, uint64 earliestCommitAt, uint64 deadline, bytes32 calldataHash)
   ```
   `execId`, `policyId`, and `asker` are the three indexed topics; `tier`, `earliestCommitAt`, `deadline`, and `calldataHash` live in the non-indexed data. Query:
   ```bash
   cast logs --address $WARD_QUEUE \
     --from-block <enqueue-tx-block> --to-block latest \
     "Enqueued(uint256,bytes32,address,uint8,uint64,uint64,bytes32)"
   ```
   `topics[1]` (the first indexed param after the event sig) is the execId.
3. **Poll `queue:status <execId>`** — only if you can guess the id (e.g. monotonic from previous enqueues).

Dashboard equivalent: **Queue** tab — Pending list, click row to expand (policy/target/selector/value/asker/deadline), buttons appear per role (asker sees Dispatch on DELAYED, owner sees Dispatch on VETO_REQUIRED + Veto, anyone sees Expire after deadline). Recent activity feed tails `Enqueued / Executed / Vetoed / Expired` events.

**Step-by-step Queue dashboard flow:**

1. Open the **Queue** tab → the **Pending executions** table renders, one row per outstanding execId.
2. Click a row to expand → you see `asker`, `target`, `selector` (decoded if known), `value`, `earliestCommitAt`, `deadline`, and the policy id.
3. Once `block.timestamp >= earliestCommitAt`, the **Dispatch** button enables for the eligible caller (asker for DELAYED, policy owner for VETO_REQUIRED) — click to commit. With an `--execute`-style follow-up (or wired wrapper) the call actually fires.
4. If your connected wallet is the policy owner, the **Veto** button enables with a **32-byte reason** input — provide a short label (right-padded) and sign to cancel.
5. After `block.timestamp >= deadline` (7 days past `earliestCommitAt`), the **Expire** button enables for anyone — permissionless GC, no special role needed.

Source: `dashboard/src/components/QueueTab.tsx`.

For the operator-facing TUI (`ward tui`), keybindings, NDJSON streaming, and the full op workflow, see [§23 Operating the queue](#23-operating-the-queue--tui--dashboard).

---

## 8. Watch mode — observe any deployed agent

End state: a watch-mode policy is bound to an agent address; the dashboard polls and surfaces violations without blocking calls. Use this to monitor a 3rd-party agent you can't redeploy.

**Canonical onboarding path (v0.10.0+): Watch Wizard.** Open the dashboard and go to `?tab=watch-wizard` (served by `dashboard/src/pages/WatchWizardPage.tsx`) — a 3-step paste-discover-publish flow that turns any deployed Somnia agent address into a published policy + saved Slack webhook in under 60 seconds:

1. **Paste the deployed agent address.** The wizard pre-fills if you arrived via a deep-link (`?address=…&tab=watch-wizard`) — e.g. from the Agents catalog's "Watch in wizard" button.
2. **Discover** runs `dashboard/src/lib/discovery.ts` — pure read-only chain probes (~7 RPC happy-path / ~20 worst-case). Detects EOA vs contract, ERC-165 / ERC-20 / ERC-721 fingerprints, and the Ward-aware signal (via `WardAgentRegistry.AgentRegistered` + `WardQueue.Enqueued` topic-filtered logs, chunked at 999 blocks). Step 2 surfaces the **honest mode banner** — real-time gating for Ward-aware agents, observation-only for everyone else.
3. **Pick a deterministic policy tier** — `CONSERVATIVE` / `BALANCED` / `AGGRESSIVE`, computed by `dashboard/src/lib/policy-recommender.ts` (pure, byte-identical output for a given `(report, nowSec)`). Then publish + register in `WardAgentRegistry` + save Slack webhook + send a test alert. Webhook URLs are stored in IDB as operator secrets, password-typed input, never logged in full.

After the wizard runs, the saved subscription appears in the **Watched tab's** `Subscriptions` section (`id="subscriptions"`) with mask + tier badge + Replace/Remove.

### Legacy flow (still works — Watched-tab → Publish-with-`?mode=watch`)

For users who want hand-built watch-mode policies (custom selectors, caps not in the wizard's 3 tiers):

1. **Open the Watched tab.** If nothing is bound: `EmptyState` shows **"Publish a watch-mode policy"** → routes to Publish tab with `?mode=watch`.
2. In Publish (watch mode), the layout flips: `AgentDiscovery` leads; templates demote to a disclosure.
3. **Paste the deployed agent address** into `AgentDiscovery` → click **"Scan functions"**.
4. Fill name / short-id / caps, click **publish policy**, sign the `publishPolicy` tx (same selector as enforce — `mode=watch` is a dashboard convention).
5. Back on Watched, the policy appears in `MyPoliciesPanel`; click **Bind** (`WatchAgentBinding`) to attach the agent address.
6. `useAgentWatcher` polls every `POLL_INTERVAL_MS`, re-evaluating recent txs from that agent against the policy via `debug_traceTransaction`.
7. KPI tiles + hourly 168-bin histogram + violation log populate as `Violation` rows arrive.
8. Banner appears if the RPC lacks `debug_traceTransaction` ("Watch mode unavailable on this RPC").

### Discover call surface (works on ANY agent, no source needed)

`AgentDiscovery` first classifies the pasted address via `eth_getCode`:

- **EOA agents** (`code == "0x"`) — the agent originates txs. Fetches the agent's recent outbound txs from Shannon Blockscout (`from == agent`, capped at `DEFAULT_MAX_TXS = 50`, newest first).
- **Contract agents** (`code != "0x"`) — users invoke the agent. RPC-first: scans `eth_getLogs` for events emitted by the agent within the last `RPC_LOOKBACK_BLOCKS = 604_800` blocks (~7 days at 1s blocks), chunked at 999 blocks/call to fit Shannon's `eth_getLogs` cap; falls back to Blockscout txlist if the RPC returns nothing. Filters to `to == agent`, capped at 50.

Each invocation is then replayed via `debug_traceTransaction` (callTracer). Every `CALL` / `CALLCODE` / `STATICCALL` frame whose `from` is the agent (direct or nested) yields a `(target, selector)` pair → that's the agent's real call surface. `DELEGATECALL` frames are explicitly excluded (the executing context is the agent itself, so the gate would record the agent's own selectors instead of external dependencies — useless for policy authoring). If the RPC doesn't expose `debug_traceTransaction`, the tx is skipped and `traceFailed` flips so the UI shows a banner — there is deliberately no receipt-log fallback (event-sig hashes are not function selectors). See `dashboard/src/lib/agent-discovery.ts`.

Selectors resolve via (a) verified-source ABI from Shannon explorer if available, otherwise (b) bytecode disassembly + `openchain.xyz` signature lookup. View/pure selectors are filtered out. Imported functions default to `tier: IMMEDIATE`, `valueCapPerCall: "0"`, `delaySeconds: 0` (see `dashboard/src/components/publish/AgentDiscovery.tsx:155`) — there are NO smart suggestions per selector. You must manually adjust tier, caps, and delay per-selector in the form before publishing. "Add N selected" deep-merges into the draft (preserves user-edited tiers/caps; only appends NEW selectors).

---

## 9. Deploy your own Ward (advanced)

For private oracles, custom chains, or forks of policy semantics. Skip this if you're on Shannon — use the canonical addresses.

```bash
# 1. clone + install (forge-std is a git submodule)
git submodule update --init --recursive
pnpm install

# 2. fund deployer and set key (script requires >= 0.1 ether native)
cp .env.example .env   # then edit DEPLOYER_PK

# 3. deploy
cd contracts
forge script script/Deploy.s.sol \
  --rpc-url <RPC_URL> \
  --broadcast --legacy \
  --gas-estimate-multiplier 2000 \
  --private-key $DEPLOYER_PK
```

The script (`contracts/script/Deploy.s.sol`):

1. Reads `DEPLOYER_PK` from env, asserts balance ≥ 0.1 ether.
2. Deploys `WardOracle`, then `WardQueue(oracle)`.
3. Writes `{chainId, wardOracle, wardQueue, deployer, deployedAt}` to `contracts/deployments/$CHAINID.json`.

Wire downstream tools:

```bash
export WARD_ORACLE=0x…   # from deployments/$CHAINID.json
export WARD_QUEUE=0x…
# Optional for TUI backfill bounds:
# WARD_ORACLE_DEPLOY_BLOCK, WARD_QUEUE_LOOKBACK_BLOCKS
```

**Shannon-specific flags (critical):**

- `--legacy` — Shannon RPC doesn't accept EIP-1559 envelopes.
- `--gas-estimate-multiplier 2000` — Shannon's `eth_estimateGas` under-reports actual gas by ~15x; without this, every `CREATE` runs OOG. On other EVM chains, drop or retune (default `100` is usually fine).

Compiler settings pinned in `foundry.toml`: `solc 0.8.26`, `evm_version = shanghai`, `via_ir = true`, `optimizer_runs = 200`. Keep aligned if verifying bytecode against canonical.

---

## 10. Reason codes (every `checkIntent` return)

`checkIntent` returns `bytes32(0)` on success. On failure it returns one of these (checked in this exact precedence order — fix in order):

| Code | Cause | Fix |
|---|---|---|
| `"PAUSED"` | policy kill-switch on | wait, or contact `policyOwner` |
| `"EXPIRED"` | `block.timestamp > expiresAt` | publish a new policy version |
| `"BAD_CALLDATA"` | `intent.data.length < 4` | include the selector in `data` |
| `"SELECTOR_MISMATCH"` | `data[0:4] != intent.selector` | rebuild `data` with `abi.encodeWithSelector(selector, ...)` |
| `"TARGET_NOT_ALLOWED"` | target not in policy | add target to POLICY.md |
| `"SELECTOR_NOT_ALLOWED"` | selector not allowed for that target | add selector to POLICY.md |
| `"VALUE_CAP"` | `intent.value > valueCapPerCall[target][selector]` | lower value or raise cap |
| `"DAILY_CAP"` | `spentToday + intent.value > dailySpendWeiCap` | wait for UTC midnight or raise cap |
| `"REQUIRES_DELAY"` | selector tier is `TIER_DELAYED` | call `queue.enqueue`, dispatch after `delaySeconds` |
| `"REQUIRES_VETO"` | selector tier is `TIER_VETO_REQUIRED` | call `queue.enqueue`, `policyOwner` dispatches if no veto |

`checkIntent` REVERTS (does not return) with `PolicyNotFound()` if `policyId` was never published. `DAILY_CAP` is checked against **native wei only** — ERC20 amounts are not summed.

---

## 11. Gotchas (production-critical)

1. **Shannon gas multiplier — every CREATE OOGs without it.** Deploy with `--legacy --gas-estimate-multiplier 2000`; viem: `type: "legacy"` + explicit `gas`. Full Ward deploy is ~0.2–0.3 STT.

2. **`spentToday` tracks NATIVE value only, not ERC20 amounts.** `DAILY_CAP` checks `intent.value` (wei). ERC20 size limits must be enforced by the asker (`require(amountIn <= MAX)` pre-gate) or by routing the selector through `TIER_DELAYED`.

3. **DELAYED is async — `checkIntent` returns `REQUIRES_DELAY`; you must enqueue and someone must come back to dispatch.** Ward never executes. Flow: `enqueue` → wait `delaySeconds` → `dispatch(execId)` → execute the returned `Intent` yourself.

4. **DELAYED dispatcher = original `asker`; VETO_REQUIRED dispatcher = current `policyOwner` (NOT the asker).** For VETO_REQUIRED, "no veto" alone doesn't ship; the owner must call `dispatch`. If the policy owner is a multisig with no execution path into the agent, VETO dispatches revert — prefer DELAYED unless that path is wired.

5. **Mid-flight policy NARROWING does NOT cancel queued intents.** `WardQueue.dispatch` only re-checks pause + expiry; it does NOT re-validate value caps, daily spend, or target/selector allowlist. Tighten policy → queued intent ships with the LOOSER pre-update validation. Mitigation: pause the policy while tightening + veto in-flight intents.

6. **`updatePolicy` has NO timelock.** Pinning a `policyId` does not protect against in-place edits. Mitigations: never call `updatePolicy` (publish a new label), subscribe to `PolicyUpdated`, or wrap `policyOwner` in a timelock-multisig.

7. **`spentToday` is tracked by the asker, NOT Ward.** A buggy asker that under-reports defeats `DAILY_CAP`. Use `_dailySpent[uint64(block.timestamp / 1 days)]` and increment after the gate passes.

8. **Veto/expire does NOT auto-rollback `spentToday`.** The template tallies at enqueue; vetoed or expired intents leak budget until UTC midnight. Production fix: store `(enqueueDay, enqueueAmount)` per `execId` and roll back on hook.

9. **UTC-day boundary is hard-coded** (`block.timestamp / 1 days`). Daily caps roll over at 00:00 UTC regardless of operator timezone.

10. **`COMMIT_WINDOW_SECONDS = 7 days` is hard-coded.** A queued intent not dispatched within 7 days of `earliestCommitAt` is past deadline; anyone may then call `expireIfStale(execId)`.

11. **`WardQueue.enqueue` is open to ANY caller — no asker allow-list per policy.** Worst case for DELAYED is queue noise (only the hostile enqueuer can dispatch). For VETO_REQUIRED hostile enqueues are inert unless the owner ratifies. Operators should filter `Enqueued` events by `asker`.

12. **Swap-first reorder pattern — gate BEFORE approve.** Approving the router pre-gate leaves a live allowance on rejection. Run `checkIntent` first; approve + swap only as an atomic pair after both gates pass. If approve-first is unavoidable, reset to 0 on rejection or use permit.

13. **`checkIntent` is safe-by-default:** `ok = true` ONLY for legal + `TIER_IMMEDIATE`. DELAYED/VETO selectors cannot silently slip through; worst misuse is "policy too strict."

14. **LLM agents on Somnia: ~1 STT deposit floor for short prompts.** `getRequestDeposit()` covers ONLY the validator-reward budget, NOT the LLM execution cost. 0.12 STT empirically fails with `"insufficient budget for execution cost"`. Use ~1 STT for short prompts; scale with prompt length.

15. **LLM callback fires async (~5–90s) and `msg.sender` is the platform contract.** Guard the callback: `require(msg.sender == address(PLATFORM))`.

16. **`WardQueue.dispatch` returns the `Intent` — it does NOT execute the call.** Caller performs `target.call{value: i.value}(i.data)`. Double-dispatch reverts `NotPending`.

17. **`Intent` struct field ordering is load-bearing.** Match `PolicyTypes.sol` exactly — the oracle decodes positionally.

18. **DELAYED dispatch needs an asker-side wrapper for off-chain dispatchers.** Your agent IS the asker; a CLI / dashboard / multisig cannot call `queue.dispatch` directly. Expose `dispatchQueued(execId)` on the agent (typically `onlyOwner`).

19. **Compromised policy-owner key = full bypass.** Owner can `updatePolicy`, `veto` legitimate intents, or `pause`. Deploy policy from a multisig, or use the two-step `transferPolicyOwnership` / `acceptPolicyOwnership` flow.

20. **Ward has no `nonReentrant` guards and holds no funds.** Reentrancy safety on the target call lives in your agent.

21. **Policy caps: `MAX_TARGETS = 20`, `MAX_SELECTORS_PER_TARGET = 10`.** Larger policies revert at publish — they do not silently truncate.

22. **`policyId = keccak256(abi.encode(publisher, label))`, label is `bytes32` right-padded** (UTF-8 + zeros). SDK's `policyIdFor` needs `stringToHex(label, { size: 32 })` to match the CLI. **Never `keccak256(label)`.** Mismatched padding → wrong `policyId` → `PolicyNotFound` revert.

23. **`PolicyLib.validate` precedence is fixed and property-tested.** See §10 reason-codes table — fix violations in that order.

24. **Ward does NOT defend against prompt injection or MEV.** A jailbroken LLM producing policy-valid calldata sails through. Keep policies narrow; the contract validates calldata shape, not intent. MEV/ordering on the dispatch tx is also out of scope.

25. **Ward contracts are unaudited.** Solidity 0.8.26, manual review only. Lean 4 covers 10 theorems (no `sorry`): 5 `PolicyLib.validate` precedence/monotonicity, 3 `WardQueue` state machine, 2 `WardOracle` ownership handoff. Solidity has no symbolic / Halmos / Echidna coverage. Do not place high-value flows behind it without independent review.

26. **`dispatchQueued`-style wrappers should be `onlyOwner` of the agent, distinct from the policy owner.** Same address is fine; the access-control surfaces are independent.

27. **`policyId = keccak256(abi.encode(publisher, label))` and is STABLE across edits.** Once you hardcode `POLICY_ID` into your agent, `ward push` to the same `(wallet, label)` runs `updatePolicy` under the hood — the id stays valid, the rules change in place. Changing the **label** or pushing from a **different publisher wallet** produces a new id; editing fields inside the policy does not — no content-hash migration to perform. (See `contracts/src/WardOracle.sol:43,45` and `cli/src/cmd/policy.ts:100`.)

28. **Caps in wei, not STT.** The markdown says `"1 ether"` — the compiler normalizes to `10^18` wei. Don't hand-write hex caps.

29. **CLI tier check.** `compile` will reject `delaySeconds > 0` on IMMEDIATE / VETO_REQUIRED with a clear error. If you wrote `delaySeconds: 60` for an IMMEDIATE selector, you probably meant DELAYED.

30. **Lost publisher key?** `transferPolicyOwnership(bytes32 policyId, address newOwner)` on WardOracle (only current owner; reverts on zero address). Recovery path — no policy re-publish needed.

For a categorized failure-modes lookup with symptom/cause/rule for each common trap, see [§25 Gotchas appendix](#25-gotchas-appendix--failure-modes-lookup).

---

## 12. Verification checklist

Before returning code to the user, the LLM MUST confirm every box:

1. `POLICY_ID` is either `immutable` (set once in the constructor) OR a mutable storage slot guarded by `setPolicyId(bytes32) onlyOwner` that emits `PolicyBound` (the late-binding pattern in §6.5). Mutable is the recommended default for new agents — it enables ungated dev, an emergency kill-switch via `setPolicyId(0x0)`, and policy migration without redeploy. Choose `immutable` only when policy stability is part of the trust assumption.
2. **Every** outbound external call is preceded by `oracle.checkIntent(POLICY_ID, intent, spentToday[_today()])`. No code path bypasses it.
3. `intent.data[0:4] == intent.selector`. Build `data` via `abi.encodeWithSelector(selector, ...)` and pass the same `selector` to `_buildIntent`.
4. `spentToday[_today()]` is incremented **after** a successful (or queued) gate, and **only** with `intent.value` (native wei). ERC20 amounts are not summed.
5. Branching on `reason`: `REQUIRES_DELAY` → enqueue path; any other non-empty reason → reject and return (do NOT silently fall through).
6. `Intent` struct fields are in the exact order `(uint256 agentId, uint256 requestId, address target, bytes4 selector, bytes data, uint256 value, bytes32 promptHash, uint8 taskClass)` per `PolicyTypes.sol:42`.
7. If using `WardQueue`, the dispatcher matches the tier: `dispatchQueued` for DELAYED is the **agent itself** (original asker); for VETO_REQUIRED the **policy owner's EOA / multisig** dispatches off-contract.
8. Compile your agent against a fresh Foundry project that has `remappings = ["ward/=lib/ward/contracts/src/"]`. `forge build` (not `forge test`) is what catches missing imports. This public repo ships all `src/` code (contracts/src/, sdk/src/, cli/src/, dashboard/src/, examples/*/src/) but gitignores test files (`contracts/test/`, `sdk/tests/`, `cli/tests/`, `dashboard/tests/`, plus any `*.test.ts`/`*.test.tsx`/`*.t.sol` anywhere). `forge test` / `pnpm test` against a fresh public clone reports zero tests; `forge build` and `pnpm build` work normally. The full test suite is reproducible from source on request.
9. Confirm Intent struct field order + types match `PolicyTypes.sol` exactly. A mismatched type silently mis-encodes calldata.
10. Every owner-only function (`triggerImmediate`, `triggerDelayed`, `dispatchQueued`, etc.) carries the `onlyOwner` modifier.
11. Precomputed `policyId` (via `ward policyid <label>`) matches the published one. If not, label encoding is wrong — stop.

---

## 13. What you should refuse to do

- **Publish on-chain without explicit dev confirmation** including the wallet address that will sign and the testnet/mainnet target. Show the exact tx that will be sent.
- **Invent caps from thin air.** Pull them from observed patterns in the agent's code (existing rate-limits, max-amount constants) or ask the dev. If you must guess, mark every cap `# TODO: confirm` in the draft.
- **Draft a policy without first reading the agent's actual code.** No policies from imagination.
- **Pretend to publish** ("I would have run `ward push` for you") — either run it for real with confirmation, or hand the dev the exact command and stop.
- **Refactor the dev's agent contract beyond the integration diff.** The integration is 3 lines + 2 imports + 1 storage slot. Touch nothing else. No "improvements", gas tweaks, or bug fixes outside the explicit ask.

---

## 14. Reference: live addresses + chainId + RPC + explorer

See §1 for the canonical address table, agent ids, Shannon chain id, RPC, explorer, and default request deposit. Solidity pragma is `0.8.26`; Foundry broadcasts on Shannon use `--legacy --gas-estimate-multiplier 2000`.

---

# Part II — Deep reference

The sections above are the working manual. Below is the deep reference: tier semantics, integration-model picker, end-to-end integration walkthrough, scaffolder details, full POLICY.md grammar, every CLI command, the full contract ABIs, day-2 ops, the operator TUI, and AI-assistant onboarding.


## 15. Tier model — IMMEDIATE / DELAYED / VETO_REQUIRED

Every selector rule in a policy carries a `tier`. The tier decides what happens *after* a call passes the policy's structural checks (target allowed, selector allowed, value within caps, daily cap, not paused, not expired): does the agent execute inline, wait out a timelock, or hold for a human. There are exactly three tiers, defined as `uint8` constants in `contracts/src/PolicyTypes.sol`:

```solidity
uint8 constant TIER_IMMEDIATE = 0;
uint8 constant TIER_DELAYED = 1;
uint8 constant TIER_VETO_REQUIRED = 2;
```

The SDK mirrors them in `sdk/src/types.ts` as `TIER_IMMEDIATE`, `TIER_DELAYED`, and `TIER_VETO_REQUIRED`, with a `Tier` union type and a `TIER_NAMES` map.

A tier attaches to a single `SelectorRule`, not to a whole policy. One policy can mix tiers — a hot path on `IMMEDIATE`, a treasury sweep on `VETO_REQUIRED`:

```solidity
struct SelectorRule {
    bytes4 selector;
    uint256 valueCapPerCall;
    uint8 tier;
    uint32 delaySeconds;
}
```

The tier and its companion `delaySeconds` are stored per (target, selector) and read back through `PolicyLib.tierOf(...)` and `PolicyLib.delayFor(...)`.

### IMMEDIATE

Auto-execute. The agent runs the call inline, in the same transaction that asks Ward for authorization. No coordination, no waiting, no second party.

`IMMEDIATE` is the right choice for low-risk, frequent calls — the ones whose damage is already bounded by `valueCapPerCall` and `dailySpendWeiCap`. For these, the structural policy check *is* the entire control: if the intent passes `validate`, it proceeds.

`delaySeconds` **must be `0`** for an `IMMEDIATE` rule. A non-zero wait only has meaning for `DELAYED`, and the policy compiler rejects an `IMMEDIATE` rule that sets one. In a POLICY.md block:

```policy
- selector: "transfer(address,uint256)"
  valueCapPerCall: "0"
  tier: IMMEDIATE
  delaySeconds: 0
```

`IMMEDIATE` calls never touch WardQueue and emit no Ward events — they live entirely inside your agent's dispatch transaction.

### DELAYED

Timelock. The agent does not execute inline; it enqueues the request into WardQueue. After `delaySeconds` have elapsed, the agent (the *asker*) can execute it. During the wait window, the policy owner can `veto` it.

`DELAYED` buys a reaction window: "if something looks wrong, I can stop it before it lands." It is the middle ground between fully autonomous (`IMMEDIATE`) and fully gated (`VETO_REQUIRED`) — the call still goes through on its own, but not instantly, and a watching owner retains a veto.

A `DELAYED` rule **requires `delaySeconds > 0`**. The duration is the timelock length in seconds:

```policy
- selector: "swap(address,uint256,uint256)"
  valueCapPerCall: "0"
  tier: DELAYED
  delaySeconds: 3600
```

### VETO_REQUIRED

Human-in-the-loop. The agent enqueues the request, and **only the policy owner can execute it.** There is no auto-dispatch even after time passes — the request sits in the queue until the owner explicitly commits it, or vetoes it, or it expires.

`VETO_REQUIRED` is for calls where every individual invocation should require human sign-off: treasury withdrawals, ownership transfers, upgrades, pauses, anything where "the agent decided to" is not a sufficient authorization. The dashboard's function scanner auto-suggests this tier for `payable` functions and admin patterns (`setX`, `upgrade`, `pause`, `withdraw`, `migrate`, ownership transfers).

Like `IMMEDIATE`, a `VETO_REQUIRED` rule sets `delaySeconds: 0` — the gate here is the owner's signature, not a clock:

```policy
- selector: "withdraw(uint256)"
  valueCapPerCall: "0"
  tier: VETO_REQUIRED
  delaySeconds: 0
```

### How a tier surfaces at the gate

The structural policy check is tier-agnostic. `PolicyLib.validate(...)` returns `(bool ok, bytes32 reason)` purely from the policy's caps and allowlists:

```solidity
function validate(Policy storage p, Intent memory i, uint256 spentToday)
    internal view returns (bool ok, bytes32 reason)
```

Its `reason` codes are structural — `PAUSED`, `EXPIRED`, `BAD_CALLDATA`, `SELECTOR_MISMATCH`, `TARGET_NOT_ALLOWED`, `SELECTOR_NOT_ALLOWED`, `VALUE_CAP`, `DAILY_CAP` — and a passing intent returns `(true, bytes32(0))`.

The tier is layered on top of `validate` by the oracle's `checkIntent` / `checkSelector` answer. A call that is structurally fine but carries a non-`IMMEDIATE` tier must not be allowed to slip through as `ok = true`, because that would let a consumer silently bypass the queue. So the oracle surfaces the tier as a refusal with a tier-specific reason:

| Tier | Gate result |
|---|---|
| `IMMEDIATE` | `ok = true` — the agent executes inline. |
| `DELAYED` | `ok = false`, reason `REQUIRES_DELAY` — route the intent to WardQueue and wait out `delaySeconds`. |
| `VETO_REQUIRED` | `ok = false`, reason `REQUIRES_VETO` — route the intent to WardQueue and wait for the policy owner. |

`ok = false` here is not "denied" in the sense of `VALUE_CAP` or `TARGET_NOT_ALLOWED`. It is "not authorized *inline* — coordinate first." The reason code tells the consumer which coordination path to take. Because the only path to `ok = true` is `IMMEDIATE`, an agent that naively executes on `ok = true` and reverts otherwise cannot accidentally run a `DELAYED` or `VETO_REQUIRED` call without going through the queue.

---

## 16. Integration models — modifier vs inline picker

Ward gives an agent contract two on-chain validators and two idiomatic ways to wire a policy gate into your code. **Pick by how many outbound calls a function makes.**

- **`checkSelector(policyId, target, selector, value, spentToday)`** — a selector-only check. The `wardGuarded` modifier uses it for the *entrypoint-policy* model: the policy's `target` is the **agent address itself** and its selector list enumerates the agent's **own entrypoints**.
- **`check(policyId, target, data, value, spentToday)` / `checkIntent(policyId, intent, spentToday)`** — per-call / full-intent checks against a **downstream** target, used by the inline `_wardCheck` + `_call` path for multi-outbound functions.

### TL;DR

| Model | When to use | Policy targets |
| --- | --- | --- |
| **`wardGuarded(selector, value)` modifier** | One outbound call per function; gate colocated with the signature. | The **agent's own** address + entrypoint selectors. |
| **Inline `_wardCheck` + `_call`** | Multiple outbound calls per function (`approve` + `swap`), per-call intent shapes, or you want to enqueue `REQUIRES_DELAY` on `WardQueue` instead of reverting. | The **downstream** contracts + their selectors. |

Both share the same `POLICY_ID` semantics, the same daily-spend tracker, and the same revert (`WardRejected(reason)`). You can mix them in one contract.

### Model 1 — `wardGuarded` modifier (the default)

**Use when**: one outbound call per function, and you want the gate on the function signature so a reviewer can't miss it.

The policy is authored against the **agent's own** entrypoint — its `target` is `address(this)` and its selectors are the agent's functions (the *entrypoint-policy* model), so the gate stays stable even as the body's downstream calls evolve.

What the modifier does (`WardAgentBase.sol`):

1. If `POLICY_ID == 0`, skip the gate entirely (ungated bootstrap / kill-switch mode).
2. Otherwise call `oracle.checkSelector(POLICY_ID, address(this), selector, value, _wardSpentToday())`. If `ok == false`, revert `WardRejected(reason)`. Non-immediate tiers surface as `WardRejected("REQUIRES_DELAY")` / `WardRejected("REQUIRES_VETO")`, so a caller can't slip a delayed/veto selector through.
3. Pre-reserve `value` against the daily-spend tally **before** running the body, so a reentrant call sees the in-flight spend against the cap.
4. Run the guarded function body.

> Call the downstream with a **high-level** call (`target.act(n)`) inside a `wardGuarded` body — not `_call(...)`. The modifier already pre-reserved the spend, so routing through `_call` would double-count.

#### Why a selector-only check is enough

`checkSelector` validates `policy.target ∋ address(this)`, `policy.selectors[address(this)] ∋ selector`, the tier, and the value/daily caps. Because the policy describes the **agent's own entrypoints**, not the downstream target's, the contract-vs-policy boundary is stable. **The tradeoff**: a selector-only check can't enforce per-argument constraints (e.g. "recipient must be allow-listed"). For that, use Model 2.

#### Bonus: dispatcher = policy owner for VETO_REQUIRED

`WardOracle.policyOwner(policyId)` returns the policy publisher (or the recipient of a completed `transferPolicyOwnership`). For `TIER_VETO_REQUIRED` selectors enqueued on `WardQueue`, **only this address can `dispatch`**. The modifier flags this case via `REQUIRES_VETO` and reverts; the caller is responsible for routing through `WardQueue` if they want the call to eventually land.

### Model 2 — inline `_wardCheck` + `_call` (multi-outbound)

**Use when**: one function fires multiple outbound calls (`approve` + `swap`, mint + transfer, settle + sweep), needs per-argument constraints, or you want to enqueue `REQUIRES_DELAY` on `WardQueue` instead of reverting.

Keep `WardAgentBase` for the spend tracker, drop the modifier, and gate each **downstream** call with `_wardCheck(target, data, value, spentToday)` before each `_call(target, data, value)`. Here the policy lists the downstream contracts as targets; `_wardCheck` calls `oracle.check(POLICY_ID, target, data, value, spentToday)` under the hood.

Three things to note:

1. **Order matters.** When the function fires both a permission (`approve`) and an action (`swap`), gate the riskier call **first** — view-only, no side effect. Approving before gating the swap would leave a live router allowance behind on a swap-side rejection, draining `tokenIn` to whoever can call `router.transferFrom(agent, ...)`. Gate first, mutate state only after every gate passes.
2. **`REQUIRES_DELAY` is still a revert.** `_wardCheck` reverts `WardRejected("REQUIRES_DELAY")` like the modifier. To enqueue on `WardQueue` instead, call `oracle.checkIntent(...)` directly and branch on the returned `reason` yourself — or use `QueueAgentBase`.
3. **`spentToday` is yours to manage.** `WardAgentBase` ships a per-UTC-day tracker (`_wardSpentToday()`); `_call` pre-reserves `value` before dispatching, so a reentrant call cannot observe the pre-spend budget. For elaborate accounting (tally-at-enqueue for queued intents, partial rollback on veto) drive the spend slot yourself.

### Mixing models

Gate single-call paths with the modifier, multi-call paths inline — same `POLICY_ID`, same inherited spend tracker, no duplication. The policy then lists both the agent's own entrypoint selectors (for the modifier paths) and the downstream targets + selectors (for the inline paths).

### What the modifier is **not**

- Not a replacement for `WardQueue` — it reverts on `REQUIRES_DELAY` / `REQUIRES_VETO`. Use `WardQueue.enqueue` (or `QueueAgentBase`) for those tiers.
- Not a reentrancy guard — add `ReentrancyGuard` separately if your target can call back.
- Not an authorization check — pair with `onlyOwner` (or your access modifier) ahead of `wardGuarded`. The canonical sample layers `onlyOperator` for this exact reason.

---


## 17. Integration guide — deploy + publish + bind walkthrough

Wire an existing or new Somnia agent to enforce a written policy before every outbound call.

This is a how-to: it assumes you already understand what Ward is and have `forge`, `node 20+`, and `pnpm` installed with STT in a deployer wallet. Ward holds no funds, owns no agents, and executes no calls — your agent stays in full custody and dispatch control. The oracle only answers "may this call execute under policy P?" synchronously, in the same transaction.

The recommended path for a single-outbound-call function is the **`wardGuarded` modifier** on `WardAgentBase`. Everything below leads with that; the multi-outbound inline path is covered in [step 6](#17-6-multi-outbound-paths-inline-_wardcheck--_call).

### What you'll build

A contract that inherits `WardAgentBase`, guards its entrypoints with `wardGuarded(selector, value)`, and binds a `POLICY_ID` published against the agent's own address (the **entrypoint-policy model**). The canonical worked example is `examples/ward-counter/`.

```
1. Choose or deploy a v2 WardOracle           → verify: have an oracle address
2. Inherit WardAgentBase, add wardGuarded   → verify: contract compiles
3. analyze:gate the contract                     → verify: "every dispatch is gated"
4. Author POLICY.md against the AGENT address    → verify: policy compiles
5. Publish + late-bind setPolicyId               → verify: POLICY_ID() returns your id
```

### 17.1 Choose or deploy a WardOracle (v2)

For new integrations use the canonical v2 oracle already live on Somnia Shannon (chain id `50312`):

```
WardOracle (v2) = 0x3C7bF90f243d670a01f512221d9546e09fEaCC9c
```

The `wardGuarded` modifier calls `oracle.checkSelector(...)`, which only exists on the v2 oracle — so the modifier path **requires v2**. The legacy v1 oracle (`0x68d4B045B24F8d1012974b9d34684cA5aeD11DDf`) is still live but reference it only as explicit legacy; bind there only if you are continuing a pre-v0.11.0 policy through the inline `checkIntent` path.

To deploy your own oracle instead, run the repo's deploy script and capture the printed address. The `--gas-estimate-multiplier 2000` is required because Shannon's RPC under-reports gas by roughly 15×.

```bash
cd contracts
cp .env.example .env   # fill DEPLOYER_PK at minimum
forge script script/Deploy.s.sol \
  --rpc-url https://dream-rpc.somnia.network \
  --broadcast --legacy --gas-estimate-multiplier 2000 \
  --private-key "$DEPLOYER_PK"
```

### 17.2 Inherit `WardAgentBase` and add the modifier

Import the base (and the oracle type) through the `ward/` remapping, which points at `contracts/src` via the `ward-src` symlink:

```toml
# foundry.toml
remappings = [
    "ward/=ward-src/",
]
```

`WardAgentBase` gives you, for free:

- `WardOracle public immutable oracle` — set once in the constructor.
- `bytes32 public POLICY_ID` — a **mutable** storage slot (defaults to `bytes32(0)` = ungated), for late-binding.
- `address public owner` with `onlyOwner`, `setPolicyId(bytes32)`, and `transferOwnership(address)`.
- A per-UTC-day spend tracker the modifier and `_call` write through.

The `wardGuarded(bytes4 selector, uint256 value)` modifier, in order: if `POLICY_ID != 0`, call `oracle.checkSelector(POLICY_ID, address(this), selector, value, _wardSpentToday())` and revert `WardRejected(reason)` if `ok == false`; then pre-reserve `value` against today's spend **before** running the body so a re-entrant call can't see a pre-spend budget; then run the body. When `POLICY_ID == 0` the modifier short-circuits and the agent runs ungated.

Here is the canonical `CounterAgent`, copied verbatim from `examples/ward-counter/src/CounterAgent.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "ward/WardOracle.sol";
import "ward/integration/WardAgentBase.sol";
import {Counter} from "./Counter.sol";

contract CounterAgent is WardAgentBase {
    Counter public immutable counter;

    constructor(WardOracle _oracle, Counter _counter, address _owner)
        WardAgentBase(_oracle, _owner)
    {
        counter = _counter;
    }

    /// Two normal functions, each gated by the modifier on the AGENT's own
    /// selector against POLICY_ID. The body calls the downstream counter
    /// directly — the modifier already reserved spend, so routing through
    /// `_call` would double-count. On a deny the modifier reverts
    /// `WardRejected(reason)` and the body never runs.
    function bump(uint256 by) external wardGuarded(this.bump.selector, 0) {
        counter.bump(by);
    }

    function reset() external wardGuarded(this.reset.selector, 0) {
        counter.reset();
    }
}
```

Two things to copy into your own agent:

- **Guard the agent's own selector.** `wardGuarded(this.bump.selector, 0)` passes the agent's *entrypoint* selector, not the downstream `counter.bump` selector. The policy is a stable contract-vs-policy boundary even as the agent's internal downstream calls evolve.
- **The body calls the downstream target directly.** The modifier already validated and reserved spend; routing the same value through `_call` would double-count it. Use `_call` only on paths the modifier did *not* guard (see [step 6](#17-6-multi-outbound-paths-inline-_wardcheck--_call)).

`wardGuarded` is not an authorization check and not a reentrancy guard. Put `onlyOwner` (or your access modifier) ahead of it, and add OpenZeppelin's `ReentrancyGuard` yourself if your outbound target can call back.

If your function moves native value, pass it as the second modifier argument so the daily cap is enforced and reserved — e.g. `wardGuarded(this.pay.selector, msg.value)`.

### 17.3 Verify every dispatch is gated

Before authoring a policy, statically confirm there is no ungated `target.call(...)` hiding in your contract. The CLI ships an analyzer that flags any dispatch not preceded by the modifier, `_gate(...)`, or `WardCall.check(...)`:

```bash
pnpm ward analyze:gate path/to/MyAgent.sol
# → # ward analyze:gate
# →   OK · every dispatch is gated
```

Add `--json` for machine-readable findings in CI. The analyzer flags low-level dispatches (`target.call(...)`, `sendValue(...)`, `safeTransferETH(...)`) that no gate precedes; high-level calls like `counter.bump(by)` aren't dispatches it tracks. `CounterAgent.sol` passes clean: both entrypoints carry the modifier, and the downstream calls into `Counter` are high-level, so there is nothing ungated to flag.

### 17.4 Author POLICY.md against the AGENT address

The entrypoint-policy model means the policy's `target` is the **agent contract** (the one inheriting `WardAgentBase`), and `selectors` enumerates the agent's own entrypoints — *not* the downstream target's selectors. Here is the counter sample's policy, from `examples/ward-counter/policy.md`:

````md
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

Replace the placeholder `target` with your deployed agent address. `reset()` is deliberately omitted from this policy, so a gated call to it reverts `WardRejected("SELECTOR_NOT_ALLOWED")` — the deny path proof. For the full field grammar (caps, tiers, expiry, value formats) see [§19 POLICY.md spec](#19-policymd-spec--authoritative-grammar). You can scaffold a starter from your ABI with `pnpm ward policy:init --abi <artifact> --target <addr>`.

Compile it as a dry run before publishing:

```bash
pnpm ward compile ./policy.md   # prints the canonical JSON; sends nothing
```

### 17.5 Publish, then late-bind `setPolicyId`

`WardAgentBase` ships `POLICY_ID` as a mutable slot defaulting to `bytes32(0)`. While unbound the modifier short-circuits and the agent runs ungated, so you can deploy to testnet and exercise the agent *before* a policy exists, then bind once you've settled the policy. This is the recommended flow for new agents.

Publish the policy. The `policyId` is `keccak256(abi.encode(publisher, label))` — stable across `updatePolicy` calls and namespaced by your wallet:

```bash
export WARD_ORACLE=0x3C7bF90f243d670a01f512221d9546e09fEaCC9c
export PRIVATE_KEY=0x…                       # publisher wallet
pnpm ward push ./policy.md --label counter-demo
# → publishPolicy tx: 0x…
# → OK · policyId = 0x…
export POLICY_ID=0x…                          # from the output
```

Bind it on the already-deployed agent (owner only):

```bash
cast send "$AGENT" "setPolicyId(bytes32)" "$POLICY_ID" \
  --private-key "$DEPLOYER_PK" --rpc-url "$SOMNIA_TESTNET_RPC" --legacy
```

From this transaction on, every guarded entrypoint is checked against the policy. Each bind emits `PolicyBound(newPolicyId, oldPolicyId, by)`. The operational primitives, all `owner`-gated:

| Action | Call |
|---|---|
| Bind / migrate a policy | `setPolicyId(0xNEW)` |
| Emergency kill-switch (re-ungate) | `setPolicyId(bytes32(0))` |
| Hand off control | `transferOwnership(newOwner)` |

Because `POLICY_ID` is mutable, the agent's behavior can change after users interact with it. External observers should subscribe to `PolicyBound` to detect rebinds.

### 17.6 Multi-outbound paths (inline `_wardCheck` + `_call`)

The modifier synthesizes a single `(address(this), selector, value)` check — it cannot represent one function that fires *multiple* outbound calls (`approve` + `swap`, mint + transfer, settle + sweep), nor enforce per-argument constraints. For those, keep `WardAgentBase` for the spend tracker but skip the modifier and gate each outbound separately with `_wardCheck(target, data, value, spentToday)` before each `_call(target, data, value)`:

```solidity
function triggerSwap(address tokenIn, address router, bytes calldata approveData, bytes calldata swapData)
    external
    onlyOwner
{
    uint256 spent = _wardSpentToday();

    // 1. Gate the riskier call (the swap) FIRST — view-only, no side effect.
    _wardCheck(router,  swapData,    0, spent);
    // 2. Then gate the approve.
    _wardCheck(tokenIn, approveData, 0, spent);

    // 3. Only after BOTH gates pass do we touch state.
    _call(tokenIn, approveData, 0);
    _call(router,  swapData,    0);
}
```

`_wardCheck` calls `oracle.check(...)` and reverts `WardRejected(reason)` on failure (it no-ops when `POLICY_ID == 0`). `_call` pre-reserves `value` against the daily tally before dispatching and reverts `WardCallFailed(returndata)` if the call fails. **Order matters**: approving before the swap gate would leave a live router allowance behind on any swap-side rejection. Gate the riskier call first, approve only after every gate passes. In this multi-outbound model the policy lists the *downstream* targets and their selectors, not the agent's entrypoint.

For per-argument intent shapes, or to branch on `REQUIRES_DELAY` / `REQUIRES_VETO` and route through `WardQueue` instead of reverting, drop to a direct `oracle.checkIntent(policyId, intent, spentToday)` call and inspect the returned `reason` yourself.

### A note on tiers

`checkSelector` (and `checkIntent`) is safe-by-default: `ok == true` only for `TIER_IMMEDIATE` selectors. A `TIER_DELAYED` or `TIER_VETO_REQUIRED` selector returns `(false, "REQUIRES_DELAY")` / `(false, "REQUIRES_VETO")`, so the modifier reverts `WardRejected("REQUIRES_DELAY" | "REQUIRES_VETO")` — a naive consumer cannot silently bypass the policy author's queue intent. To let those calls eventually land, route them through `WardQueue` (see [§23 Operating the queue](#23-operating-the-queue--tui--dashboard)). Use `oracle.tierAndDelay(policyId, target, selector)` to distinguish "denied" from "requires queueing" and to size your own wait window.

---


## 18. Scaffold a new agent (`pnpm create ward-agent`)

Generate a `WardAgentBase`-derived Foundry project with one command, then build and test it locally.

### Prerequisites

- **Node.js >= 20** — the monorepo's root `package.json` declares `"engines": { "node": ">=20" }` (and `.nvmrc` pins `20`).
- **pnpm** — the scaffolder is published as a `pnpm create` initializer.
- **Foundry** (`forge`, `cast`) — to build and test the generated project. Install via [getfoundry.sh](https://getfoundry.sh).
- **A funded Shannon key** — only needed later, when you deploy. Somnia Shannon testnet is chain id `50312`, RPC `https://dream-rpc.somnia.network` (from `contracts/src/constants/SomniaTestnet.sol`).

You do not need a funded key to complete this tutorial. The scaffold + build + test steps are fully local.

### 18.1 Run the scaffolder

One command creates the whole project:

```bash
pnpm create ward-agent my-agent
```

`my-agent` is the project name. The scaffolder uses it two ways:

- as the **directory** it creates (`my-agent/`, kebab-cased), and
- as the **Solidity contract name** (`MyAgent`, PascalCased).

The name must be a single path segment matching `[A-Za-z0-9_-]+` and must not start with a digit. Anything else is rejected with an explicit error (for example, `name "my/agent" must not contain path separators`).

If you omit the name, the scaffolder prompts `Agent name:` interactively.

The package exposes a `create-ward-agent` bin (`./dist/index.js`), so the equivalents work too:

```bash
npm create ward-agent <name>
yarn create ward-agent <name>
```

### 18.2 Templates

Two templates are available (`TemplateId = "greenfield" | "counter-fixture"`). Both emit the same `WardAgentBase` + `wardGuarded` shape, the same `foundry.toml`, and the same late-binding `Deploy`/`Bind` script pair as `examples/ward-counter/`.

#### `greenfield` (default)

A single `WardAgentBase`-derived agent plus a placeholder target. The agent's dispatch method is `tryDispatch`, and the target is `<Name>Target` exposing one `act(uint256)` selector. The generated agent gates that entrypoint with the modifier:

```solidity
function tryDispatch(uint256 reqId, uint256 amount)
    external
    wardGuarded(this.tryDispatch.selector, 0)
{
    <Name>Target(target).act(amount);
    emit Dispatched(reqId, amount);
}
```

The starter `POLICY.md` authorizes the agent's own `tryDispatch(uint256,uint256)` selector (entrypoint-policy model).

#### `counter-fixture`

The same shape as `examples/ward-counter`, renamed to your chosen contract name so you can grow it without renaming everything. The target is `Counter` (selectors `bump(uint256)` and `reset()`). The agent has two normal entrypoints that demonstrate both the allow and deny paths:

- `bump(uint256 by)` — gated with `wardGuarded(this.bump.selector, 0)`. On allow the body calls `counter.bump(by)`. On deny the modifier reverts with `WardRejected(reason)`.
- `reset()` — gated with `wardGuarded(this.reset.selector, 0)`. Same shape as `bump`; the body calls `counter.reset()`.

The starter `POLICY.md` authorizes `bump(uint256)` and deliberately omits `reset()`, so calling `reset()` reverts with `WardRejected("SELECTOR_NOT_ALLOWED")` — the revert IS the deny-path proof, no in-contract catch-and-emit needed.

```bash
pnpm create ward-agent my-agent --template counter-fixture
```

To see what would be written without touching disk, add `--dry-run`:

```bash
pnpm create ward-agent my-agent --dry-run
```

On success the CLI prints the created path and a next-steps block:

```text
Scaffolded my-agent/

Created /abs/path/to/my-agent

Next steps:
  cd my-agent
  forge install foundry-rs/forge-std
  # If you are inside the ward monorepo, link the contracts:
  #   ln -s ../../contracts/src ward-src
  forge build

  # Publish your policy and bind it:
  pnpm ward push ./POLICY.md --label my-agent
  forge script script/Deploy.s.sol --rpc-url "$SOMNIA_TESTNET_RPC" \
    --broadcast --legacy --gas-estimate-multiplier 2000
  # Then export AGENT + POLICY_ID and run script/Bind.s.sol.

See README.md inside the new directory for the full walkthrough.
```

### 18.3 What it emits

The `greenfield` template writes eight files into `my-agent/`:

```text
my-agent/
├── foundry.toml          # solc 0.8.26, via_ir, ward/ remapping
├── .gitignore
├── src/
│   ├── MyAgent.sol       # WardAgentBase-derived agent (wardGuarded)
│   └── MyAgentTarget.sol # downstream target, no Ward awareness
├── script/
│   ├── Deploy.s.sol      # deploys target + agent (late-binding)
│   └── Bind.s.sol        # binds an existing agent to a policy
├── POLICY.md             # starter policy (entrypoint-policy model)
└── README.md
```

The generated `foundry.toml` pins `solc_version = "0.8.26"`, `evm_version = "shanghai"`, `via_ir = true`, the remappings `ward/=ward-src/` and `forge-std/=lib/forge-std/src/`, and `fs_permissions` write access to `deployments/`.

`Deploy.s.sol` uses the late-binding pattern: `POLICY_ID` is read with `vm.envOr("POLICY_ID", bytes32(0))`. If set and non-zero it calls `setPolicyId` in the same broadcast; otherwise the agent ships ungated and you bind later with `script/Bind.s.sol`. It writes `deployments/agent.json` with the deployed addresses.

#### The agent: `WardAgentBase` + the `wardGuarded` modifier

`src/MyAgent.sol` inherits `WardAgentBase` and gates its single entrypoint with the `wardGuarded` modifier — the recommended path for single-outbound-call functions:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "ward/WardOracle.sol";
import "ward/integration/WardAgentBase.sol";
import {MyAgentTarget} from "./MyAgentTarget.sol";

contract MyAgent is WardAgentBase {
    address public immutable target;

    event Dispatched(uint256 indexed reqId, uint256 amount);

    constructor(WardOracle _oracle, address _target, address _owner)
        WardAgentBase(_oracle, _owner)
    {
        target = _target;
    }

    function tryDispatch(uint256 reqId, uint256 amount)
        external
        wardGuarded(this.tryDispatch.selector, 0)
    {
        MyAgentTarget(target).act(amount);
        emit Dispatched(reqId, amount);
    }
}
```

Inheriting `WardAgentBase` gives you:

- an immutable `oracle`,
- a mutable `POLICY_ID` storage slot (the late-binding pattern),
- `owner` + `onlyOwner` + `transferOwnership`,
- `wardGuarded` (the modifier that checks the oracle and reserves spend),
- `_wardCheck` (lower-level: reverts if the oracle denies), and
- `_call` (forwards a call and tracks daily spend).

The modifier takes `(this.tryDispatch.selector, 0)` — the agent's **own** selector and the `msg.value` for the call. This is the **entrypoint-policy model**: the policy targets the agent address itself with the agent's own selectors, not the downstream target's. The body is then free to call `MyAgentTarget(target).act(...)` without per-target policy entries.

**Late binding:** while `POLICY_ID == bytes32(0)` the modifier short-circuits and the agent runs ungated. That is the intended way to ship to testnet *before* you have authored a policy. `setPolicyId(0xNEW)` binds or migrates; `setPolicyId(bytes32(0))` is the emergency kill-switch.

#### The remapping

`foundry.toml` wires the `ward/` import prefix to a local `ward-src/` directory:

```toml
remappings = [
    "ward/=ward-src/",
    "forge-std/=lib/forge-std/src/",
]
```

That is why `import "ward/WardOracle.sol";` resolves. You supply `ward-src/` in the build step (a symlink in the monorepo, or a hand-copy if standalone).

#### The starter `POLICY.md`

`POLICY.md` ships a minimal policy in the entrypoint-policy model — its `target` is the **agent** address (a `0xdead…beef` placeholder you replace post-deploy), and its one selector is the agent's own entrypoint:

```policy
version: "0.1"
dailySpendWeiCap: "0"
expiresAt: "2026-12-31T23:59:59.000Z"
targets:
  - target: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    selectors:
      - selector: "tryDispatch(uint256,uint256)"
        valueCapPerCall: "0"
        tier: IMMEDIATE
        delaySeconds: 0
```

Note the selector is the full ABI signature `tryDispatch(uint256,uint256)` — the agent's own entrypoint, not `act(uint256)` on the downstream target. See [§19 POLICY.md spec](#19-policymd-spec--authoritative-grammar) for the full grammar.

### 18.4 Build the generated project

Enter the directory, install `forge-std`, and supply the Ward sources behind the `ward/` remapping:

```bash
cd my-agent
forge install foundry-rs/forge-std

# Inside the ward monorepo, symlink the contracts:
ln -s ../../contracts/src ward-src
# Standalone: copy the Ward sources into ./ward-src/ by hand instead.

forge build
```

`forge build` compiles the agent, the target, and both scripts. A clean build confirms the remapping and the `WardAgentBase` inheritance resolve.

### 18.5 Test it

The scaffolder does not generate a test file — the generated project is the integration surface, not a test fixture. To verify behavior, write a Foundry test under `test/` that deploys `MyAgent` against a `WardOracle` and asserts the ungated path. Use the canonical `examples/ward-counter` test as your model; it exercises both the allow path (a bound, authorized selector) and the deny path.

If you scaffolded `--template counter-fixture`, your agent already has the two-entrypoint allow/deny shape: `bump(uint256)` and `reset()`, each gated by the `wardGuarded` modifier. The bundled `POLICY.md` authorizes `bump` but omits `reset`, so the deny path surfaces as `WardRejected("SELECTOR_NOT_ALLOWED")` when you call `reset()` against the bound policy.

### 18.6 Build, deploy, bind (the full publish path)

Publish the policy (after replacing the placeholder `target` in `POLICY.md` with the **agent** address from `deployments/agent.json`):

```bash
pnpm ward push ./POLICY.md --label <name>
```

Deploy ungated, then bind once you trust the policy:

```bash
forge script script/Deploy.s.sol \
  --rpc-url "$SOMNIA_TESTNET_RPC" \
  --broadcast --legacy --gas-estimate-multiplier 2000

export AGENT=$(jq -r '.agent' deployments/agent.json)
export POLICY_ID=0x...
forge script script/Bind.s.sol \
  --rpc-url "$SOMNIA_TESTNET_RPC" \
  --broadcast --legacy --gas-estimate-multiplier 2000
```

`Deploy.s.sol` reads `DEPLOYER_PK` and `WARD_ORACLE` from the environment; `Bind.s.sol` reads `DEPLOYER_PK`, `AGENT`, and `POLICY_ID` (and requires `POLICY_ID != bytes32(0)`).

### 18.7 Develop the scaffolder itself

```bash
pnpm build   # tsc -p tsconfig.json && chmod +x dist/index.js
pnpm test    # vitest run
pnpm lint    # tsc --noEmit
```

---


## 19. POLICY.md spec — authoritative grammar

`POLICY.md` is the human-authoring surface for Ward. A document is a markdown wrapper around exactly one fenced code block — prefer ` ```policy `, with a fallback to a single untagged block. The block contents are YAML matching the schema below. The SDK's `compilePolicy` turns that YAML into a canonical `PolicyInput` struct, which is submitted to `WardOracle` via `publishPolicy(label, input)` (first publish under a `(publisher, label)` pair) or `updatePolicy(policyId, input)` (subsequent edits by the policy owner).

### Minimal example

````md
# Conservative Trading Policy

> Authored: alice — Ward POLICY.md v0.1

```policy
version: "0.1"
expiresAt: "2026-12-31T00:00:00Z"
dailySpendWeiCap: "1 ether"
maxSlippageBps: 50
paused: false

targets:
  - target: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"  # dreamDEX
    selectors:
      - selector: "placeOrder(address,address,uint256,uint256)"
        valueCapPerCall: "0.1 ether"
        tier: IMMEDIATE
      - selector: "cancelOrder(bytes32)"
        valueCapPerCall: "0"
        tier: IMMEDIATE

  - target: "0x0000000000000000000000000000000000000001"  # token
    selectors:
      - selector: "approve(address,uint256)"
        valueCapPerCall: "0"
        tier: IMMEDIATE
```
````

Worked, copy-pasteable policies live at [conservative-policy](#191-worked-example-conservative-trading-policy) below and in the sample at `examples/ward-counter/policy.md`.

### Schema (canonical)

The compiler validates the fenced YAML against a strict schema (`additionalProperties: false` at every level). Unknown top-level keys, unknown per-target keys, and unknown per-selector keys fail compilation rather than being silently dropped.

#### Top-level fields

| Field | Type | Required | On-chain type | Notes |
|---|---|---|---|---|
| `version` | string | yes | — (not stored) | Must be `"0.1"` for this release. The schema requires a string, so quote it: `version: "0.1"`. |
| `expiresAt` | string \| number | yes | `uint64` | ISO 8601 string (`"2026-12-31T00:00:00Z"`) or unix seconds. After this instant, every check fails with `EXPIRED`. |
| `dailySpendWeiCap` | string \| number | no | `uint256` | Per-UTC-day rolling sum of native `msg.value` (STT) across all calls. Accepts `"1 ether"` or a raw wei integer. Defaults to `0` — and `0` means **block all native spend**, not unlimited (see caveats). |
| `maxSlippageBps` | integer 0..10000 | no | `uint16` | Stored on-chain but **not enforced** by `PolicyLib.validate` today. Defaults to `0`. |
| `paused` | boolean | no | `bool` | When `true`, every check returns `(false, "PAUSED")`. Defaults to `false`. |
| `targets` | array | yes | — | At least one target. Max 20 (see limits). |

#### Per-target fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `target` | address | yes | 20-byte hex matching `^0x[0-9a-fA-F]{40}$`. All-lowercase, all-uppercase, or a correctly EIP-55-checksummed mixed-case address. A wrong mixed-case checksum is rejected. |
| `selectors` | array | yes | At least one selector. Max 10 per target. |

`targets[].name` is **not a field.** The on-chain `Policy` stores only `(target, selectors[])` per entry, so a per-target name has no home and would be lost. The compiler rejects `name` outright with `Target \`name\` is not stored on-chain. Use a description in the policy header instead.` Describe targets in the markdown narrative above the fenced block.

#### Per-selector fields

| Field | Type | Required | On-chain type | Notes |
|---|---|---|---|---|
| `selector` | string | yes | `bytes4` | Either a 4-byte hex (`"0xa9059cbb"`) or a function signature (`"transfer(address,uint256)"`). Signatures are ABI-validated by viem's `parseAbiItem`; a malformed type like `addresss` fails compilation. |
| `valueCapPerCall` | string \| number | **yes** | `uint256` | Per-`(target, selector)` cap on native `msg.value`. Accepts `"0.1 ether"` or a raw wei integer. Mandatory even as `"0"` — there is no implicit default (see caveats). |
| `tier` | enum | yes | `uint8` | `IMMEDIATE` \| `DELAYED` \| `VETO_REQUIRED`. |
| `delaySeconds` | integer | no | `uint32` | Defaults to `0`. **Required (`> 0`) for `DELAYED`; forbidden (must be `0`/omitted) for `IMMEDIATE` and `VETO_REQUIRED`.** |

#### Wei / ether values

`dailySpendWeiCap` and `valueCapPerCall` accept:

- The `ether` suffix: `"1 ether"`, `"0.5 ether"` (case-insensitive; `"0.5ether"` without a space also parses).
- A raw integer wei string: `"1000000000000000000"`.
- A hex wei string: `"0x..."`.

`ether` is the **only** supported unit. `gwei`, `eth`, `wei`, `finney`, and scientific notation are rejected. Near-miss typos get a hint — e.g. `"1 eth"` errors with `Unrecognized unit in "1 eth" — did you mean "1 ether"? (Supported: plain wei integer, or "N ether" for native STT.)`. Native STT (`msg.value`) is the only unit Ward meters; ERC-20 amounts encoded in calldata are never parsed as values.

### Tier semantics (recap)

`WardOracle.checkIntent` / `checkSelector` return `(bool ok, bytes32 reason)`. The tier determines what a *legal* intent resolves to:

- **`IMMEDIATE`** — returns `(true, 0)` when legality passes. The asking agent dispatches synchronously.
- **`DELAYED`** — returns `(false, "REQUIRES_DELAY")` even when legality passes. The agent routes through the opt-in `WardQueue` (enqueue → wait `delaySeconds` → dispatch from the asker), or reads `tierAndDelay(policyId, target, selector)` and runs its own waiting structure.
- **`VETO_REQUIRED`** — returns `(false, "REQUIRES_VETO")` even when legality passes. Routes through `WardQueue` with `policyOwner(policyId)` as the dispatcher (not the asker), or an equivalent owner-only flow. The owner can `veto(execId, reason)` during the commit window.

Safe-by-default: a naive integrator calling only `checkIntent` cannot bypass `DELAYED` / `VETO_REQUIRED` — both surface as `ok == false`. The worst outcome of misuse is "enforcement is overly strict", never "enforcement is silently skipped." See [§15 Tier model](#15-tier-model--immediate--delayed--veto_required).

### Load-bearing caveats

These are the cases where a policy compiles and publishes but behaves differently from a casual reading.

#### `valueCapPerCall` is mandatory — even as `"0"`

There is no implicit default. A selector with no `valueCapPerCall` fails compilation:

```
compilePolicy: Selector <signature>: valueCapPerCall is required. Use "0" to block all native value.
```

The compiler refuses to guess so the security posture (allow vs. block native value through that selector) is always an explicit choice. Write `valueCapPerCall: "0"` for any selector that should move no native value (the common case — approvals, cancels, agent entrypoints that take no value).

#### `dailySpendWeiCap: "0"` blocks all native spend

`0` is a **zero cap, not unlimited.** The on-chain check is:

```solidity
if (spentToday > p.dailySpendWeiCap || i.value > p.dailySpendWeiCap - spentToday) {
    return (false, bytes32("DAILY_CAP"));
}
```

With `dailySpendWeiCap == 0`, any intent carrying `value > 0` fails with `DAILY_CAP`. A policy whose selectors all have `valueCapPerCall: "0"` (no native value moves) can safely set `dailySpendWeiCap: "0"` — that is exactly what the ward-counter sample does. The cap meters native STT only; ERC-20 transfers do not count toward it. To bound token spend, add the token contract as a target and tier its `transfer` / `approve` selectors directly.

#### Past or zero `expiresAt` is blocked at compile time

On-chain, the gate is `block.timestamp > p.expiresAt → EXPIRED`, so a literal `0` is the sentinel for "already expired" and any past timestamp fails every call. The compiler refuses both before they reach the chain:

- `expiresAt: 0` → `Policy expiresAt cannot be 0 (Ward treats 0 as already-expired).`
- A timestamp at or before `now + 60s` (a 60-second clock-skew safety window) → rejected with the actual `now` and the window in the message.
- Above `uint64` range → rejected (the on-chain field is `uint64`).
- More than 5 years out → rejected (lifetime cap).

#### EIP-55 checksum is enforced on mixed-case addresses

`target` is validated with viem strict mode. All-lowercase and all-uppercase addresses pass (no checksum is claimed). A **mixed-case** address with a wrong EIP-55 checksum fails:

```
compilePolicy: target <addr> fails EIP-55 checksum (use all-lowercase or a correctly-checksummed mixed-case address).
```

The zero address is rejected first with a friendlier message (`Target cannot be the zero address (placeholder).`), as are the configured oracle/queue addresses and the EVM precompiles `0x01..0x0a` and `0x100` (`... is a reserved address ...`).

#### `DELAYED` requires `delaySeconds > 0`

A `DELAYED` selector with `delaySeconds: 0` collapses to `IMMEDIATE` semantics on-chain (the queue lets it through immediately), which is almost never intended. The compiler refuses it:

```
compilePolicy: DELAYED selector <sig> requires delaySeconds > 0 (otherwise it behaves as IMMEDIATE).
```

Conversely, setting `delaySeconds` on an `IMMEDIATE` or `VETO_REQUIRED` selector is an error (`... must not set delaySeconds`).

### Stored but not enforced: `maxSlippageBps`

The on-chain `Policy` struct carries a `maxSlippageBps` field (`uint16`, range `0..10000`), but `PolicyLib.validate` never reads it — no check path returns a slippage-related denial today. The field is reserved for future DEX-aware adapters that decode calldata and compare expected-vs-min amounts.

Operational implications today:

- The dashboard does not expose `maxSlippageBps` in the publish form; the SDK compiler emits `0` for fresh drafts. The edit modal preserves the existing on-chain value during a full-body replacement so an unrelated edit cannot silently zero it.
- Authoring directly via YAML (the CLI flow) can set any value in range, but nothing on-chain reads it.
- A non-zero `maxSlippageBps` is metadata, not enforcement. Reviewers should not treat its presence as a slippage guarantee.

### Compiler invariants and limits

- **Strict schema.** Unknown top-level keys or unknown selector fields fail compilation rather than being dropped.
- **One policy block.** Multiple untagged code blocks → error (ambiguous; tag one with ` ```policy `).
- **No duplicate targets.** Duplicate target addresses (case-insensitive) are rejected at compile time, mirroring the on-chain `DuplicateTarget(target)` revert in `publishPolicy` / `updatePolicy`.
- **No duplicate selectors within a target.** Two selectors that compute to the same `bytes4` are rejected, mirroring the on-chain `DuplicateSelector(target, selector)` revert.
- **Size limits.** Max 20 targets; max 10 selectors per target (the schema enforces `minItems: 1` on both).
- **ABI-width bounds.** `dailySpendWeiCap` / `valueCapPerCall` must fit `uint256`; `delaySeconds` must fit `uint32`; `expiresAt` must fit `uint64`. Each is rejected explicitly so the message names the bound rather than surfacing as a downstream encoder error.

### On-chain reason codes

`checkIntent` / `checkSelector` return one of these `bytes32` reasons. The first eight come from `PolicyLib.validate`; the tier reasons are layered on top by the oracle.

| Reason | Meaning |
|---|---|
| `PAUSED` | `policy.paused == true`. |
| `EXPIRED` | `block.timestamp > expiresAt`. |
| `BAD_CALLDATA` | Intent calldata shorter than 4 bytes (`checkIntent` path). |
| `SELECTOR_MISMATCH` | The leading 4 bytes of calldata do not match `intent.selector` (`checkIntent` path). |
| `TARGET_NOT_ALLOWED` | The target is not in the policy. |
| `SELECTOR_NOT_ALLOWED` | The selector is not authorized on that target. |
| `VALUE_CAP` | `value > valueCapPerCall[target][selector]`. |
| `DAILY_CAP` | The per-UTC-day native-spend cap would be exceeded. |
| `REQUIRES_DELAY` | Legal, but the selector's tier is `DELAYED`. |
| `REQUIRES_VETO` | Legal, but the selector's tier is `VETO_REQUIRED`. |

A successful immediate check returns `(true, bytes32(0))`. A reference to a `policyId` that was never published reverts with `PolicyNotFound` rather than returning a denial, so a misconfigured reference cannot be mistaken for "policy denied."

### Entrypoint-policy model

The recommended integration ([§16 Integration models](#16-integration-models--modifier-vs-inline-picker)) gates an agent's own entrypoints, not the downstream contracts it calls. In this model the policy `target` is the **agent contract address** (the one that inherits `WardAgentBase`), and `selectors` enumerates the agent's own entrypoint signatures — not the selectors of whatever the agent calls underneath.

The ward-counter sample is authored exactly this way: `target` is the agent address and the only authorized selector is the agent's own `bump(uint256)`. `reset()` is deliberately omitted so a gated call to it reverts `WardRejected("SELECTOR_NOT_ALLOWED")` — the typed revert is the deny-path proof, no in-contract catch-and-emit needed. No native value moves on either entrypoint, so every `valueCapPerCall` is `"0"` and `dailySpendWeiCap` is `"0"`:

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

Replace the placeholder `target` with the deployed agent address (the `agent` field in `deployments/agent.json` after running the sample's `DeployAgent.s.sol`) before publishing.

### Comparison to off-chain enforcer policies

Adopters coming from off-chain TypeScript SDKs will notice three structural differences:

1. **Per-selector granularity.** Ward policies key on `(target, selector)` pairs, not `target` alone, so you can authorize `approve(...)` without authorizing `transfer(...)` on the same token.
2. **Risk tiers replace allow/block/review flags.** `IMMEDIATE` ≈ allow, `DELAYED` ≈ review-with-timer, `VETO_REQUIRED` ≈ review-with-human-approval.
3. **On-chain policy registry.** Policies are published on-chain under `(publisher, label)` namespaces and referenced by a stable `policyId`. The on-chain `Policy` struct — not an off-chain audit log — is the durable artifact other Somnia apps consume.

### 19.1 Worked example: Conservative Trading Policy

> Audience: a user who wants their agent to swap on dreamDEX with strict caps.

```policy
version: "0.1"
dailySpendWeiCap: "1 ether"
maxSlippageBps: 50
expiresAt: "2026-12-31T00:00:00Z"
paused: false

targets:
  - target: "0x0000000000000000000000000000000000000000" # placeholder dreamDEX address
    selectors:
      - selector: "placeOrder(bytes)"
        valueCapPerCall: "0.1 ether"
        tier: IMMEDIATE
        delaySeconds: 0
      - selector: "cancelOrder(bytes32)"
        valueCapPerCall: "0"
        tier: IMMEDIATE
        delaySeconds: 0

  - target: "0x0000000000000000000000000000000000000000" # placeholder USDso address
    selectors:
      - selector: "approve(address,uint256)"
        valueCapPerCall: "0"
        tier: IMMEDIATE
        delaySeconds: 0
```

What this policy authorizes:

- The agent may place orders on dreamDEX, capped at 0.1 ether per call and 1 ether per UTC day.
- The agent may cancel its own orders freely (no value movement).
- The agent may approve USDso allowances (no native value movement; ERC-20 allowances bounded by the agent's other policy rules).
- Anything else is rejected with a specific reason code on-chain.

---


## 20. CLI reference — every command and flag

Exhaustive reference for every `ward` command, flag, and environment variable.

The `ward` CLI compiles `POLICY.md` files, publishes them to `WardOracle`, inspects intents, drives the `WardQueue` lifecycle, runs static checks on agent contracts, and opens the queue-monitor TUI. Commands are either **offline** (no RPC, no wallet) or **on-chain** (read or write against Somnia Shannon testnet, chain id `50312`).

### Invocation

From the repo root the CLI is run through the `ward` script, which launches the built `cli/dist/index.js` if present and otherwise falls back to running `cli/src/index.ts` under `tsx`:

```bash
pnpm ward <command> [args] [flags]
```

Running with **no arguments** opens the guided interactive menu instead of parsing a command:

```bash
pnpm ward
```

The menu prints a numbered list of actions and prompts for each input the command needs. It is a thin wrapper over the same command functions; every flag documented below still works for scripted (non-interactive) use. On-chain menu actions ask for an explicit `[y/N]` confirmation before sending a transaction. The menu's choices are:

| # | Menu action | Underlying command |
|---|---|---|
| 1 | Open full-screen monitor TUI | `tui` |
| 2 | Preflight | `preflight` |
| 3 | Compile POLICY.md | `compile` |
| 4 | Publish or update policy | `push` |
| 5 | Compute policy ID | `policyid` |
| 6 | Inspect intent JSON | `inspect` |
| 7 | Queue status | `queue:status` |
| 8 | Queue enqueue | `queue:enqueue` |
| 9 | Queue dispatch | `queue:dispatch` |
| 10 | Queue veto | `queue:veto` |
| 11 | Queue expire | `queue:expire` |
| 0 / q | Exit | — |

`pnpm ward --help` lists all commands; `pnpm ward --version` prints the CLI version read from `cli/package.json`.

### Environment

On startup the CLI auto-loads a `.env` file from the current working directory (simple `KEY=VALUE` lines; `#` comments and blanks ignored; no variable interpolation). Values already set in the shell environment take precedence. Copy `.env.example` to `.env` and fill in the slots.

| Variable | Used by | Default | Notes |
|---|---|---|---|
| `PRIVATE_KEY` | every write command (`push`, `queue:*`) and `preflight` | — | `0x`-prefixed 32-byte hex. The signing wallet. |
| `DEPLOYER_PK` | `preflight` only (fallback for `PRIVATE_KEY`) | — | Read only by `preflight`; if it differs from `PRIVATE_KEY` while both are set, `preflight` warns. |
| `WARD_ORACLE` | `push`, `queue:handoff` (for a `VETO_REQUIRED` record) | — | Deployed `WardOracle` address. Canonical (v2): `0x3C7bF90f243d670a01f512221d9546e09fEaCC9c`. `lint` reads the oracle from its own `--oracle` flag, not this variable. |
| `WARD_QUEUE` | `queue:status`, `queue:enqueue`, `queue:dispatch`, `queue:veto`, `queue:expire`, `queue:handoff` | — | Deployed `WardQueue` address. Canonical (v2): `0xFB715A37951Fc8dcc920120768e91f7C8bbA54c4`. |
| `SOMNIA_TESTNET_RPC` | every on-chain command | `https://dream-rpc.somnia.network` | RPC URL for chain id `50312`. |
| `SOMNIA_AGENT_PLATFORM` | `preflight` (sanity warning) | — | Compared against canonical platform `0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776`. |
| `LLM_INFERENCE_AGENT_ID` | `preflight` (sanity warning) | — | Compared against canonical id `12847293847561029384`. |

Commands that need a missing variable fail fast with an explicit error, e.g. `WARD_ORACLE env var required (the deployed oracle address)`, `WARD_QUEUE env var required (the deployed queue address)`, or `PRIVATE_KEY env var required`.

### Commands

Each entry lists the positional arguments, flags, what the command requires from the environment, and whether it runs offline or on-chain.

#### `compile <path>`

Compile a `POLICY.md` to canonical JSON and print it. **Offline.**

- **Argument:** `<path>` — the `POLICY.md` file.
- **Env:** reads optional `WARD_ORACLE` / `WARD_QUEUE` so the compiler can reject a policy whose `target` matches its own gatekeeper. No RPC, no wallet.
- **Output:** a `# compiled PolicyInput` heading followed by the serialized `PolicyInput` (BigInt fields rendered as decimal strings).

The label is not bound at compile time — it is only chosen at `push --label` time. See [§19 POLICY.md spec](#19-policymd-spec--authoritative-grammar) for the grammar this consumes.

```bash
pnpm ward compile examples/ward-counter/policy.md
```

#### `push <path>`

Compile and publish (or update) a `POLICY.md` to `WardOracle` under your wallet's namespace. **On-chain write.**

- **Argument:** `<path>` — the `POLICY.md` file.
- **Flag:** `--label <name>` — ASCII label (≤ 32 bytes) for your policy namespace (default `default`). Right-padded to `bytes32`.
- **Env:** requires `PRIVATE_KEY` and `WARD_ORACLE`; reads `SOMNIA_TESTNET_RPC` and optional `WARD_QUEUE`.

The command computes `policyId = policyIdFor(walletAddress, label)`, reads `policyOwner(policyId)` on-chain to auto-detect publish vs. update, and refuses to overwrite a policy owned by another wallet (error: `policyId … is owned by …, not your wallet …; pick a different --label`). It **simulates first**, so a revert surfaces as `publishPolicy would revert: <reason>` / `updatePolicy would revert: <reason>` before any gas is paid; only on a clean simulation does it submit. On success it prints `OK · policyId = <id>` — that id is stable across updates and is what you reference in the agent contract.

```bash
pnpm ward push examples/ward-counter/policy.md --label counter-v1
```

#### `policyid <label>`

Compute the `WardOracle` policyId for a `(publisher, label)` pair. **Offline** (pure; no RPC), unless `--publisher` is omitted.

- **Argument:** `<label>` — ASCII label (≤ 32 bytes).
- **Flag:** `--publisher <addr>` — publisher address. When omitted, the publisher defaults to the wallet derived from `PRIVATE_KEY` (so omitting it requires `PRIVATE_KEY` to be set).
- **Output:** the `publisher`, `label`, and computed `id`.

```bash
pnpm ward policyid counter-v1 --publisher 0xYourPublisher
```

#### `inspect <intent.json>`

Pretty-print an Intent JSON with its calldata decoded. **Offline.**

- **Argument:** `<intent.json>` — a JSON file with `agentId`, `requestId`, `target`, `selector`, `data`, `value`, `promptHash`, `taskClass`.
- **Output:** the intent fields, a calldata inspector that decodes the function when the selector is known, and a check that the first 4 bytes of `data` match the claimed `selector`. On mismatch it warns `intent.selector … does not match first 4 bytes of intent.data …. Ward will reject with SELECTOR_MISMATCH.`; on match it prints `selector / calldata first-4-bytes: ✓ match`.

```bash
pnpm ward inspect intent.json
```

#### `lint <path>`

Lint a `POLICY.md` for common Ward integration mistakes. **Offline by default**; on-chain rules activate only when `--oracle` + `--rpc` are supplied.

- **Argument:** `<path>` — the `POLICY.md` file.
- **Flags:**
  - `--abi <path>` — ABI JSON or Foundry artifact JSON, enabling selector and state-mutability rules.
  - `--oracle <addr>` — `WardOracle` address for on-chain rules.
  - `--rpc <url>` — RPC URL for on-chain rules.
  - `--policy-id <id>` — policy id used by the `vetoRequiredWithoutOwner` check.
  - `--fail-on <rules>` — comma-separated rule ids to promote from `warn` to `error`.
  - `--json` — print machine-readable diagnostics (`{ ok, diagnostics: [...] }`).
- **Output:** a `# ward lint` heading and one line per diagnostic (`file:line:col SEVERITY rule message`), or `OK · no diagnostics`.

Rules: `dailyCapZeroWithPayable`, `vetoRequiredWithoutOwner`, `targetHasNoCode`, `selectorNotInAbi`, `immediateWithDelay`, `delayedWithZeroDelay`, `viewFunctionGated`, `policyExpired`. The default-error rules are `immediateWithDelay`, `policyExpired`, and `vetoRequiredWithoutOwner`; everything else is a warning unless named in `--fail-on`. `targetHasNoCode` runs only when `--oracle` + `--rpc` are set; `vetoRequiredWithoutOwner` additionally needs `--policy-id`. **Exit code 1** if any diagnostic is an error.

```bash
pnpm ward lint examples/ward-counter/policy.md \
  --abi examples/ward-counter/out/CounterAgent.sol/CounterAgent.json
```

#### `analyze:gate <path>`

Static check that every dispatch in an agent contract is gated. **Offline.**

- **Argument:** `<path>` — a Solidity source file.
- **Flag:** `--json` — print machine-readable findings (`{ ok, findings: [...] }`).
- **Output:** a `# ward analyze:gate` heading and one `WARN` line per ungated dispatch, or `OK · every dispatch is gated`.

It strips comments and strings, extracts each function, skips `pure` / `view` functions and functions carrying an `onlyOwner` modifier, then flags any function that performs a dispatch (`<x>.call(...)` / `<x>.call{value: …}(...)`, `safeTransferETH(...)`, `sendValue(...)`) without first being gated. A dispatch is considered gated when preceded by `_gate(...)`, an `oracle.checkIntent(...)` call, or `WardCall.check(...)` / `WardCall.guardedCall(...)` — and a dispatch that *is* a `WardCall.check(...)` / `WardCall.guardedCall(...)` is treated as self-gated. Findings read `dispatch in <fn>(...) is not preceded by _gate(...) or WardCall.check(...)`.

This complements, but does not replace, the `wardGuarded(selector, value)` modifier on `WardAgentBase` and the inline `_wardCheck(...)` / `WardCall.check(...)` paths described in [§16 Integration models](#16-integration-models--modifier-vs-inline-picker): the modifier's gate is invisible to this textual analyzer, so a function whose only gate is `wardGuarded(...)` will not be flagged because the modifier injects the check ahead of the body. The analyzer's job is to catch the *inline* path — a hand-written `.call(...)` with no `_wardCheck(...)` / `WardCall.check(...)` in front of it.

- **Exit codes:** `1` if any finding is reported; `2` on file-not-found or read / parse error.

```bash
pnpm ward analyze:gate examples/ward-counter/src/CounterAgent.sol
```

#### `policy:init`

Generate a starter `POLICY.md` from a contract ABI and print it to stdout. **Offline.**

- **Flags:**
  - `--abi <path>` — ABI JSON or Foundry artifact JSON. **Required.**
  - `--target <addr>` — the contract address the policy should gate. **Required.**
  - `--profile <name>` — `strict`, `balanced`, or `aggressive` (default `balanced`).
  - `--expires <iso>` — policy expiry timestamp, e.g. `2026-12-31T23:59:59.000Z`. Defaults to 90 days out when omitted.
- **Output:** a complete starter policy block. View/pure ABI functions are skipped. Each profile picks tiers differently: `strict` makes everything `DELAYED` with an 86400s delay; `aggressive` makes everything `IMMEDIATE`; `balanced` uses `VETO_REQUIRED` for owner-sensitive names (`withdraw`/`transferOwnership`/`migrate`/`upgrade`/`destroy`), `IMMEDIATE` for `get`/`read`/`peek`-style names, and `DELAYED` (300s) otherwise. Generated caps and delays carry `# TODO` markers for you to confirm.

Errors fast on a missing `--abi`/`--target`, an invalid `--target`, an unknown `--profile`, or an ABI with no non-view/non-pure functions.

```bash
pnpm ward policy:init \
  --abi examples/ward-counter/out/CounterAgent.sol/CounterAgent.json \
  --target 0xYourAgent \
  --profile balanced > POLICY.md
```

#### `ai:init`

Generate Ward assistant context files from the repo's `SKILL.md`. **Offline.**

- **Flags:**
  - `--cursor` — write `.cursor/rules/ward.mdc`.
  - `--claude` — write `.claude/skills/ward-integration/SKILL.md`.
  - `--codex` — create or update the marked Ward section in `AGENTS.md`.
  - `--all` — write the Cursor, Claude, and Codex files.
  - `--force` — overwrite hand-edited generated destinations.
- **Behaviour:** with none of `--cursor` / `--claude` / `--codex` / `--all`, **all three** targets are written. Each generated file carries a `GENERATED — edit /SKILL.md and rerun \`ward ai:init\`` header; the command refuses to clobber a destination that does not look generated (or a hand-edited `AGENTS.md` Ward section) unless `--force` is passed. Reads `SKILL.md` from the current working directory.
- **Output:** a `# ward ai:init` heading and one `wrote <path>` line per file.

```bash
pnpm ward ai:init --all
```

#### `preflight`

Check env + wallet balance against Somnia testnet. **On-chain read** (RPC only, no transaction).

- **Flag:** `--min-balance <eth>` — minimum recommended balance in STT (default `0.5`).
- **Env:** reads `PRIVATE_KEY` (or `DEPLOYER_PK`), `SOMNIA_TESTNET_RPC`, and the optional `WARD_ORACLE` / `WARD_QUEUE` / `SOMNIA_AGENT_PLATFORM` / `LLM_INFERENCE_AGENT_ID` variables.
- **Output:** a `# ward preflight` report of rpc, chainId, wallet, balance, platform, agentId, and the two Ward addresses, followed by any `ERROR` / `WARN` lines, faucet links when the balance is low, and a final `preflight: OK` / `preflight: NOT READY`. It errors on a missing or malformed key, an invalid `WARD_ORACLE` / `WARD_QUEUE` address shape, or an unreachable RPC; it warns on a chainId other than `50312`, a low balance, or a non-canonical platform / agent id.
- **Exit code:** `1` when not ready (any error present).

```bash
pnpm ward preflight --min-balance 0.5
```

#### `queue:status <execId>`

Pretty-print a `WardQueue` record header (cheap; skips the unbounded `intent.data` field). **On-chain read.**

- **Argument:** `<execId>` — the queued execution id (decimal).
- **Env:** requires `WARD_QUEUE`; reads `SOMNIA_TESTNET_RPC`.
- **Output:** a `# queue record execId=<id>` block: `state` (`None`/`Pending`/`Committed`/`Vetoed`/`Expired`), `tier` (`IMMEDIATE`/`DELAYED`/`VETO_REQUIRED`), `policyId`, `asker`, `target`, `selector`, `value`, `requestId`, `enqueuedAt`, `earliestCommit`, `deadline`, and a `timing` line. The reader tolerates both the canonical and a legacy `RecordHeader` layout.

```bash
pnpm ward queue:status 7
```

#### `queue:enqueue <intent.json> <policyId>`

Submit an Intent to `WardQueue` under a `policyId` (for `DELAYED` / `VETO_REQUIRED` tiers only). **On-chain write.**

- **Arguments:** `<intent.json>` — Intent JSON file; `<policyId>` — 32-byte hex (`0x` + 64 hex chars).
- **Flag:** `--spent-today <wei>` — the caller's running spent-today in wei as a decimal string (default `0`). For accurate cap enforcement, pass your wallet's real daily-spent total.
- **Env:** requires `PRIVATE_KEY` and `WARD_QUEUE`; reads `SOMNIA_TESTNET_RPC`.
- **Behaviour:** validates the policyId shape, reshapes the JSON intent into the `enqueue` tuple, **simulates first** (surfacing oracle rejections like `REQUIRES_DELAY` as `enqueue would revert: <reason>`), then submits. The contract reverts `IMMEDIATE_NO_QUEUE_NEEDED` for tier `IMMEDIATE` intents — those are dispatched synchronously and must never touch the queue. On success it prints `enqueued OK` and a hint to read `queue:status <execId>` once the `Enqueued` event is indexed.

```bash
pnpm ward queue:enqueue intent.json 0x<64-hex> --spent-today 0
```

#### `queue:dispatch <execId>`

Mark a queued intent `Committed`; with `--execute` also send the intent's transaction in the same command. **On-chain write.**

- **Argument:** `<execId>` — the queued execution id (decimal).
- **Flag:** `--execute` — after `dispatch` succeeds, send the returned intent (`to=target`, `data`, `value`) from this wallet. Off by default, because `dispatch` alone is non-destructive (it only transitions state to `Committed`); the external call is what moves funds.
- **Env:** requires `PRIVATE_KEY` and `WARD_QUEUE`; reads `SOMNIA_TESTNET_RPC`.
- **Behaviour:** simulates `dispatch` first (capturing the returned Intent calldata and surfacing reverts as `dispatch would revert: <reason>`), submits the `dispatch` tx, and — only with `--execute` — sends the follow-up intent transaction. Without `--execute` it prints `dispatched OK — caller now executes the intent themselves`.

```bash
pnpm ward queue:dispatch 7 --execute
```

#### `queue:veto <execId> <reason>`

Veto a pending queued intent (policy owner only; ≤ 32-byte reason). **On-chain write.**

- **Arguments:** `<execId>` — the queued execution id (decimal); `<reason>` — an ASCII reason, at most 32 bytes (right-padded to `bytes32`).
- **Env:** requires `PRIVATE_KEY` and `WARD_QUEUE`; reads `SOMNIA_TESTNET_RPC`.
- **Behaviour:** rejects an over-long reason locally, then calls `veto(execId, reason)`. On a revert it notes the likely cause (`not policy owner, or already terminal`).

```bash
pnpm ward queue:veto 7 "policy changed"
```

#### `queue:expire <execId>`

Mark a stale pending queued intent `Expired` (anyone can call after the deadline). **On-chain write.**

- **Argument:** `<execId>` — the queued execution id (decimal).
- **Env:** requires `PRIVATE_KEY` and `WARD_QUEUE`; reads `SOMNIA_TESTNET_RPC`.
- **Behaviour:** calls `expireIfStale(execId)`. On a revert it notes the likely cause (`still in window, or already terminal`).

```bash
pnpm ward queue:expire 7
```

#### `queue:handoff <execId>` (alias: `handoff <execId>`)

Print operator handoff guidance for a queued execution. **On-chain read.**

- **Argument:** `<execId>` — the queued execution id (decimal).
- **Flags:**
  - `--agent <addr>` — integrator agent address; used when its ABI exposes `dispatchQueued(uint256)`.
  - `--abi <path>` — agent ABI JSON or Foundry artifact JSON, scanned for `dispatchQueued(uint256)`.
- **Env:** requires `WARD_QUEUE`; for a `VETO_REQUIRED` record it also reads `policyOwner` from `WARD_ORACLE`. Reads `SOMNIA_TESTNET_RPC`.
- **Output:** a `# queue handoff execId=<id>` block with state, tier, policyId, requester, target, optional policy owner / agent / ABI detection, a recommendation summary and detail, and — when applicable — a ready-to-run `cast` command for the dispatcher to execute.

`handoff` is a direct alias of `queue:handoff` with identical flags.

```bash
pnpm ward queue:handoff 7 \
  --agent 0xYourAgent \
  --abi examples/ward-counter/out/CounterAgent.sol/CounterAgent.json
```

#### `tui [...args]`

Open the full-screen Ink queue-monitor TUI. **On-chain read** (the TUI streams queue state).

- **Argument:** `[...args]` — forwarded verbatim to the TUI binary (unknown options are allowed).
- **Flag:** `--json` — stream queue events as NDJSON instead of opening the full-screen TUI.
- **Behaviour:** runs `tui/dist/index.js` under Node when built, otherwise `tui/src/index.tsx` under `tsx`; errors with `Ward TUI is not installed yet. Run \`pnpm install\` first.` if neither is available. Exit code mirrors the TUI process.

```bash
pnpm ward tui
pnpm ward tui --json
```

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success (or `lint` / `analyze:gate` with no errors). |
| `1` | A command failed: `lint` reported an error, `analyze:gate` reported a finding, `preflight` is `NOT READY`, or an unhandled error / rejection bubbled up. |
| `2` | `analyze:gate` could not read or parse the target file. |

---


## 21. Contracts reference — full on-chain surface

Exhaustive reference for Ward's on-chain surface: the three core contracts, their data types, the integration base contracts and library, and the network constants. Every signature, event, error, and constant below is copied from `contracts/src/`.

### Canonical addresses (Somnia Shannon, chain id 50312)

Use the canonical table in §1. Contract-specific ABI details start below; RPC and chain constants are defined in [`SomniaTestnet`](#somniatestnet-constants).

### Import paths & remapping

Integrators consume Ward sources through the `ward/` remapping, which points at `ward-src/` — a symlink to `contracts/src`. Integration base contracts live under the `integration/` subpath.

```toml
# foundry.toml remappings
ward/=ward-src/
```

```solidity
import "ward/WardOracle.sol";
import "ward/WardQueue.sol";
import "ward/WardAgentRegistry.sol";
import "ward/PolicyTypes.sol";          // Intent, Policy structs, tier constants
import "ward/integration/WardAgentBase.sol";
import "ward/integration/QueueAgentBase.sol";
import "ward/integration/WardCall.sol";
import "ward/constants/SomniaTestnet.sol";
```

All sources compile with `pragma solidity 0.8.26;`.

### Decision guide: `wardGuarded` modifier vs inline `checkIntent`

| Use | When | Mechanism |
|---|---|---|
| `wardGuarded(selector, value)` modifier | Single outbound call per function; entrypoint-policy model. The recommended default. | Inherit [`WardAgentBase`](#wardagentbase); the modifier calls `oracle.checkSelector(...)` against `(address(this), selector, value)`. v2-oracle-only. |
| Inline `oracle.checkIntent(...)` / `WardAgentBase._wardCheck` + `_call` | Multiple outbound calls in one function (e.g. approve+swap, mint+transfer), or per-argument constraints. | Call the oracle directly, or use the base's `_wardCheck`/`_call` pair. Works against v1 or v2 oracles. |

The modifier guards the agent's *own* selector under the entrypoint-policy model: the policy targets the agent address and enumerates the agent's own entrypoints. Full rationale and worked examples are in [§16 Integration models](#16-integration-models--modifier-vs-inline-picker).

### WardOracle

Pure on-chain policy registry. A publisher calls `publishPolicy` once and hard-codes the returned `policyId` in the consuming agent; the agent calls `checkIntent` / `checkSelector` synchronously before dispatching. No custody, no async, no Somnia agent-platform involvement.

`checkIntent` and `checkSelector` are safe-by-default: they return `ok == true` only for `TIER_IMMEDIATE` selectors. `TIER_DELAYED` and `TIER_VETO_REQUIRED` are surfaced as `ok == false` with reason `REQUIRES_DELAY` / `REQUIRES_VETO`, so a naive consumer cannot silently bypass the policy author's queue intent.

#### Public state

```solidity
mapping(bytes32 => address) public policyOwner;          // policyId => current owner (0 if never published)
mapping(bytes32 => address) public pendingPolicyOwner;   // policyId => nominee in a 2-step transfer
mapping(bytes32 => uint64)  public policyVersion;        // policyId => version (1 on publish, +1 each update)
```

The `Policy` struct itself is stored in a `private` mapping; read it through the view functions below.

#### Publish & update

```solidity
function publishPolicy(bytes32 label, PolicyInput calldata input) external returns (bytes32 policyId);
function updatePolicy(bytes32 policyId, PolicyInput calldata input) external;
```

- `publishPolicy` derives `policyId = keccak256(abi.encode(msg.sender, label))`, sets `policyOwner = msg.sender`, `policyVersion = 1`. Reverts `PolicyExists` if `(msg.sender, label)` already has a policy.
- `updatePolicy` replaces the policy in place and increments `policyVersion`. Only the current `policyOwner` may call (reverts `NotPolicyOwner`).
- Both normalize `input` through [`PolicyNormalizer`](#policynormalizer-input-validation), which may revert with structural errors before any state is written.

#### Synchronous checks

```solidity
function checkIntent(bytes32 policyId, Intent calldata intent, uint256 spentToday)
    external view returns (bool ok, bytes32 reason);

function checkSelector(bytes32 policyId, address target, bytes4 selector, uint256 value, uint256 spentToday)
    external view returns (bool ok, bytes32 reason);
```

Both run [`PolicyLib.validate`](#policylib-validation-rules) first; on a legality failure they return `(false, <PolicyLib reason>)`. On a legality pass they read the tier and return:

| Tier | Return |
|---|---|
| `TIER_IMMEDIATE` | `(true, bytes32(0))` |
| `TIER_DELAYED` | `(false, "REQUIRES_DELAY")` |
| `TIER_VETO_REQUIRED` | `(false, "REQUIRES_VETO")` |

Both **revert** `PolicyNotFound` if `policyId` was never published, so a misconfigured reference cannot be silently read as "policy denied". `checkSelector` synthesizes an `Intent` with `data = abi.encodePacked(selector)` and zeroed `agentId`/`requestId`/`promptHash`/`taskClass`; it is the calldata-less variant used by the `wardGuarded` modifier.

#### Tier, delay, health & helper views

```solidity
function tierAndDelay(bytes32 policyId, address target, bytes4 selector)
    external view returns (uint8 tier, uint32 delaySeconds);

function policyHealth(bytes32 policyId)
    external view returns (bool paused, uint64 expiresAt);

function policyIdFor(address publisher, bytes32 label) external pure returns (bytes32);
```

- `tierAndDelay` distinguishes "denied" from "must queue" and reports the delay window for `TIER_DELAYED`. Reverts `PolicyNotFound` if unpublished.
- `policyHealth` is a cheap read of the kill-switch fields (`paused`, `expiresAt`); `WardQueue.dispatch` uses it to re-validate without the asker's `spentToday`. Reverts `PolicyNotFound` if unpublished.
- `policyIdFor` is a pure precompute of the id a `(publisher, label)` pair would receive — no storage read, never reverts.

#### Two-step ownership

```solidity
function transferPolicyOwnership(bytes32 policyId, address newOwner) external;  // current owner nominates
function acceptPolicyOwnership(bytes32 policyId) external;                       // nominee accepts
function cancelPolicyOwnershipTransfer(bytes32 policyId) external;              // current owner cancels
```

Ownership does not change until the nominee calls `acceptPolicyOwnership`. After acceptance the previous owner can no longer update or transfer the policy. `transferPolicyOwnership` reverts `NotPolicyOwner` (caller is not owner) or `ZeroAddress` (nominee is zero); `acceptPolicyOwnership` reverts `NotPendingOwner` (caller is not the nominee); `cancelPolicyOwnershipTransfer` reverts `NotPolicyOwner` or `NoPendingTransfer`.

#### Events

```solidity
event PolicyPublished(bytes32 indexed policyId, address indexed owner, bytes32 label);
event PolicyUpdated(bytes32 indexed policyId, address indexed owner);
event PolicyOwnershipTransferStarted(bytes32 indexed policyId, address indexed currentOwner, address indexed pendingOwner);
event PolicyOwnershipTransferred(bytes32 indexed policyId, address indexed previousOwner, address indexed newOwner);
event PolicyOwnershipTransferCancelled(bytes32 indexed policyId, address indexed currentOwner, address indexed cancelledPendingOwner);
```

#### Custom errors

```solidity
error NotPolicyOwner();
error NotPendingOwner();
error NoPendingTransfer();
error PolicyExists();
error PolicyNotFound();
error ZeroAddress();
```

### WardQueue

Coordination layer for `TIER_DELAYED` and `TIER_VETO_REQUIRED` intents. An asking agent enqueues an intent whose `checkIntent` returned `REQUIRES_DELAY` / `REQUIRES_VETO`, waits the configured delay, then dispatches — the queue marks the intent committed and returns it so the **asker executes the call themselves**. WardQueue holds no funds, owns no agents, and executes no calls; it is a metadata + state-machine + audit-trail contract. The asker owns value-cap and daily-cap correctness (the queue cannot see the asker's spend state).

#### Constructor & constants

```solidity
WardOracle public immutable oracle;
uint32 public constant COMMIT_WINDOW_SECONDS = 7 days;
uint256 public nextExecId = 1;

constructor(WardOracle _oracle);
```

`deadline = earliestCommitAt + COMMIT_WINDOW_SECONDS`. `execId`s are assigned from `nextExecId` starting at 1.

#### State machine

```solidity
enum State { None, Pending, Committed, Vetoed, Expired }
```

`None` is the default for never-enqueued ids. `enqueue` → `Pending`; `dispatch` → `Committed`; `veto` → `Vetoed`; `expireIfStale` → `Expired`. All transitions out of `Pending` require `state == Pending`, else revert `NotPending`.

#### Records

```solidity
struct QueuedIntent {
    bytes32 policyId;
    uint64  policyVersion;
    Intent  intent;
    address asker;
    uint64  enqueuedAt;
    uint64  earliestCommitAt;
    uint64  deadline;
    uint8   tier;
    State   state;
}

struct RecordHeader {
    bytes32 policyId;
    uint64  policyVersion;
    address asker;
    uint64  enqueuedAt;
    uint64  earliestCommitAt;
    uint64  deadline;
    uint8   tier;
    State   state;
    address target;
    bytes4  selector;
    uint256 value;
    uint256 requestId;
}

function getRecord(uint256 execId) external view returns (QueuedIntent memory);
function getRecordHeader(uint256 execId) external view returns (RecordHeader memory);
```

`getRecordHeader` returns all fixed-size intent fields (`target`, `selector`, `value`, `requestId`) but skips the unbounded `Intent.data`, so integrators can filter without loading full calldata.

#### Lifecycle functions

```solidity
function enqueue(bytes32 policyId, Intent calldata intent, uint256 spentToday) external returns (uint256 execId);
function dispatch(uint256 execId) external returns (Intent memory intent);
function veto(uint256 execId, bytes32 reason) external;
function expireIfStale(uint256 execId) external;
```

- **`enqueue`** — calls `oracle.checkIntent`. If `ok == true` it reverts `NotQueueable("IMMEDIATE_NO_QUEUE_NEEDED")`; if the reason is neither `REQUIRES_DELAY` nor `REQUIRES_VETO` it reverts `NotQueueable(reason)`. Otherwise it pins `policyVersion` from the oracle, sets `earliestCommitAt = block.timestamp + delaySeconds` and `deadline = earliestCommitAt + COMMIT_WINDOW_SECONDS`, stores `asker = msg.sender`, and emits `Enqueued`.
- **`dispatch`** — authorization-checks, re-validates the policy is still active, sets `state = Committed`, returns the stored `Intent`, and emits `Dispatched`. It does **not** re-check value caps. Reverts: `NotPending`; `TooEarly` (before `earliestCommitAt`); `PastDeadline` (after `deadline`); plus the auth split below.
- **`veto`** — only `oracle.policyOwner(policyId)` may call; sets `state = Vetoed`, emits `Vetoed(execId, policyId, reason)`. Reverts `NotPending` or `NotPolicyOwner`.
- **`expireIfStale`** — anyone may call after `deadline`; sets `state = Expired`, emits `Expired`. Reverts `NotPending` or `TooEarly` (called at or before `deadline`).

#### Dispatch authorization split

`dispatch` enforces a tier-dependent authorization:

| Tier | Authorized dispatcher | Revert on mismatch |
|---|---|---|
| `TIER_DELAYED` (and any non-VETO) | the original `asker` | `NotAuthorizedDispatcher` |
| `TIER_VETO_REQUIRED` | the current `oracle.policyOwner(policyId)` | `NotPolicyOwner` |

DELAYED is timer-based confidence, so the asker dispatches once the delay elapses. VETO_REQUIRED requires the policy owner to *actively* dispatch — "no veto" alone is not enough to proceed.

#### Policy re-validation on dispatch

Before committing, `dispatch` re-reads the policy via `oracle.policyHealth` and `oracle.policyVersion`, reverting `PolicyChanged(reason)` with:

| reason | Cause |
|---|---|
| `"PAUSED"` | policy `paused` flag is set |
| `"EXPIRED"` | `block.timestamp > expiresAt` |
| `"UPDATED"` | `oracle.policyVersion(policyId)` no longer matches the version pinned at enqueue |

#### Events

```solidity
event Enqueued(uint256 indexed execId, bytes32 indexed policyId, address indexed asker, uint8 tier, uint64 earliestCommitAt, uint64 deadline, bytes32 calldataHash);
event Dispatched(uint256 indexed execId, address indexed dispatcher, bytes32 indexed policyId, bytes32 intentHash);
event Vetoed(uint256 indexed execId, bytes32 indexed policyId, bytes32 reason);
event Expired(uint256 indexed execId, bytes32 indexed policyId);
```

`Enqueued.calldataHash` is `keccak256(intent.data)`; `Dispatched.intentHash` is `keccak256(abi.encode(intent))`.

#### Custom errors

```solidity
error NotPending();
error TooEarly();
error PastDeadline();
error NotAuthorizedDispatcher();
error NotPolicyOwner();
error NotQueueable(bytes32 reason);
error PolicyChanged(bytes32 reason);
```

### Integration helpers

#### WardAgentBase

Minimal base for agents that synchronously gate target calls through `WardOracle`. Holds the oracle reference, the bound `POLICY_ID`, an `owner`, and per-UTC-day spend accounting.

```solidity
WardOracle public immutable oracle;
bytes32 public POLICY_ID;
address public owner;

constructor(WardOracle _oracle, address _owner);  // reverts ZeroOwner if _owner == 0
```

##### `wardGuarded` modifier

```solidity
modifier wardGuarded(bytes4 selector, uint256 value);
```

One-shot guard for the entrypoint-policy model. When `POLICY_ID != 0`, it calls `oracle.checkSelector(POLICY_ID, address(this), selector, value, _wardSpentToday())` and reverts `WardRejected(reason)` on `!ok`. It then reserves the spend (`wardSpentByDay[today] += value` when `value != 0`) **before** running the guarded body, so a reentrant call cannot observe a pre-spend daily budget. `POLICY_ID == 0` is an ungated kill-switch mode that skips the oracle call. The policy author publishes a policy whose `target` is the agent address and whose selectors are the agent's own entrypoints (e.g. `bump(uint256)`), not the downstream target's selectors.

##### Inline check + call (multi-outbound path)

```solidity
function _wardCheck(address target, bytes memory data, uint256 value, uint256 spentToday) internal;
function _call(address target, bytes memory data, uint256 value) internal returns (bytes memory returndata);
function _wardSpentToday() internal view returns (uint256);
```

- `_wardCheck` returns early when `POLICY_ID == 0`; otherwise it calls `oracle.check(...)` (the `WardCall` library) and reverts `WardRejected(reason)` on `!ok`. It does not reserve spend — pair it with `_call`.
- `_call` pre-reserves `value` into the day bucket **before** the external `target.call{value: value}(data)`, then reverts `WardCallFailed(returndata)` if the call fails (the failed-tx revert unwinds the reservation). Use one `_wardCheck` + `_call` pair per outbound call in a multi-call function.
- `_wardSpentToday` reads the current UTC-day bucket (`block.timestamp / 1 days`).

##### Owner & policy management

```solidity
function setPolicyId(bytes32 newPolicyId) external onlyOwner;       // bind / rebind / 0 = ungate; emits PolicyBound
function transferOwnership(address newOwner) external onlyOwner;    // reverts ZeroOwner; emits OwnershipTransferred
```

##### Events & errors

```solidity
event PolicyBound(bytes32 indexed newPolicyId, bytes32 indexed oldPolicyId, address indexed by);
event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

error NotOwner();
error ZeroOwner();
error WardRejected(bytes32 reason);
error WardCallFailed(bytes returndata);
```

#### QueueAgentBase

Extends `WardAgentBase` for agents that route `TIER_DELAYED` / `TIER_VETO_REQUIRED` intents through `WardQueue`. The queue stores metadata only — it never holds or refunds funds, and this base does not roll back local spend accounting on expiry.

```solidity
WardQueue public immutable queue;

constructor(WardOracle _oracle, WardQueue _queue, address _owner);  // chains WardAgentBase(_oracle, _owner)

function _wardEnqueueDelayed(address target, bytes memory data, uint256 value, uint256 reqId) internal returns (uint256 execId);
function _wardDispatchAndExecute(uint256 execId) internal returns (bytes memory);
function dispatchQueued(uint256 execId) external onlyOwner returns (bytes memory);
function _onQueueExpire(uint256 execId, address target, uint256 value) internal virtual;  // default no-op

error QueueDispatchDidNotCommit(uint256 execId);
```

- `_wardEnqueueDelayed` builds the `Intent` (extracting the selector from the first 4 bytes of `data`), prechecks it against `oracle.checkIntent` (bubbling any revert), then calls `queue.enqueue(POLICY_ID, intent, _wardSpentToday())`. It deliberately does not short-circuit IMMEDIATE results — `WardQueue.enqueue` remains the source of truth and passes through `NotQueueable("IMMEDIATE_NO_QUEUE_NEEDED")`.
- `_wardDispatchAndExecute` calls `queue.dispatch(execId)`; on a `PastDeadline` revert it invokes `_onQueueExpire` and returns `""`, otherwise it re-bubbles. After a successful dispatch it asserts `state == Committed` (else reverts `QueueDispatchDidNotCommit`) and executes the stored call via `_call`.
- Override `_onQueueExpire` to release reservations or refund custody on expiry; the default is intentionally empty because the base does not assume funds were reserved at enqueue time.

#### WardCall library

```solidity
library WardCall {
    function check(WardOracle oracle, bytes32 policyId, address target, bytes memory data, uint256 value, uint256 spentToday)
        internal returns (bool ok, bytes32 reason);
}
```

Selector-safe helper used by `WardAgentBase._wardCheck`. It extracts the selector from the first 4 bytes of `data` (empty selector if `data.length < 4`), builds an `Intent`, and calls `WardOracle.checkIntent` via a low-level `call` so a `PolicyNotFound` revert bubbles cleanly rather than corrupting decode. Returns the decoded `(ok, reason)`.

### Data types

#### Tier constants (`PolicyTypes.sol`)

```solidity
uint8 constant TIER_IMMEDIATE      = 0;
uint8 constant TIER_DELAYED        = 1;
uint8 constant TIER_VETO_REQUIRED  = 2;
```

#### Intent

```solidity
struct Intent {
    uint256 agentId;
    uint256 requestId;
    address target;
    bytes4  selector;
    bytes   data;
    uint256 value;
    bytes32 promptHash;
    uint8   taskClass;
}
```

`PolicyLib.validate` reads `target`, `selector`, `data`, and `value`; the other fields (`agentId`, `requestId`, `promptHash`, `taskClass`) are caller-provided metadata that the oracle does not constrain. The selector embedded in `data[0:4]` must equal `selector` or validation fails `SELECTOR_MISMATCH`.

#### Policy input & storage

`PolicyInput` is the public authoring shape passed to `publishPolicy` / `updatePolicy`; `Policy` is the storage shape the oracle keeps internally.

```solidity
struct SelectorRule {
    bytes4  selector;
    uint256 valueCapPerCall;
    uint8   tier;
    uint32  delaySeconds;     // only meaningful for TIER_DELAYED
}

struct TargetRule {
    address       target;
    SelectorRule[] selectors;
}

struct PolicyInput {
    TargetRule[] targets;
    uint256      dailySpendWeiCap;
    uint16       maxSlippageBps;
    uint64       expiresAt;
    bool         paused;
}
```

The `Policy` storage struct flattens these into per-`(target, selector)` mappings (`isTargetAllowed`, `isSelectorAllowed`, `valueCapPerCall`, `tier`, `delaySeconds`) plus the scalars `dailySpendWeiCap`, `maxSlippageBps`, `expiresAt`, `paused`. `maxSlippageBps` is stored but not enforced by `PolicyLib.validate` in this release.

#### PolicyLib validation rules

`PolicyLib.validate(Policy storage, Intent memory, uint256 spentToday)` runs these checks in order and returns the first failure reason:

| reason | Condition |
|---|---|
| `"PAUSED"` | `p.paused` is true |
| `"EXPIRED"` | `block.timestamp > p.expiresAt` |
| `"BAD_CALLDATA"` | `intent.data.length < 4` |
| `"SELECTOR_MISMATCH"` | first 4 bytes of `intent.data` ≠ `intent.selector` |
| `"TARGET_NOT_ALLOWED"` | `intent.target` not in policy |
| `"SELECTOR_NOT_ALLOWED"` | `intent.selector` not allowed for that target |
| `"VALUE_CAP"` | `intent.value > valueCapPerCall[target][selector]` |
| `"DAILY_CAP"` | `spentToday > dailySpendWeiCap` or `intent.value > dailySpendWeiCap - spentToday` |
| `bytes32(0)` | all checks pass |

#### Reason codes → integrator handling

These reasons reach your agent as the `reason` in `WardRejected(reason)` (from the base contracts) or as the second return value of a direct `checkIntent`/`checkSelector` call:

| reason | Meaning | Recommended handling |
|---|---|---|
| `"PAUSED"` | Policy kill-switch engaged | Abort; surface to operator |
| `"EXPIRED"` | Policy past `expiresAt` | Abort; operator must `updatePolicy` |
| `"BAD_CALLDATA"` / `"SELECTOR_MISMATCH"` | Malformed intent | Bug in caller — fix the call construction |
| `"TARGET_NOT_ALLOWED"` / `"SELECTOR_NOT_ALLOWED"` | Not permitted by policy | Abort; this action is out of policy |
| `"VALUE_CAP"` / `"DAILY_CAP"` | Within policy but over a spend limit | Abort or retry with a smaller value / next UTC day |
| `"REQUIRES_DELAY"` | Tier is `TIER_DELAYED` | Route through `WardQueue.enqueue`, wait, then `dispatch` |
| `"REQUIRES_VETO"` | Tier is `TIER_VETO_REQUIRED` | Enqueue; policy owner must actively `dispatch` |
| revert `PolicyNotFound` | `policyId` never published | Misconfiguration — fix the bound `POLICY_ID` |

#### PolicyNormalizer (input validation)

`publishPolicy` / `updatePolicy` copy `PolicyInput` into storage via `PolicyNormalizer.copy`, which enforces structural invariants and reverts loudly on violation:

```solidity
uint256 constant MAX_TARGETS = 20;
uint256 constant MAX_SELECTORS_PER_TARGET = 10;

error ZeroTarget();
error ZeroSelector(address target);
error DuplicateTarget(address target);
error DuplicateSelector(address target, bytes4 selector);
error InvalidTier(address target, bytes4 selector, uint8 tier);
error InvalidDelay(address target, bytes4 selector, uint8 tier, uint32 delaySeconds);
error TooManyTargets(uint256 count, uint256 max);
error TooManySelectors(address target, uint256 count, uint256 max);
```

Notably: `InvalidTier` reverts if `tier > TIER_VETO_REQUIRED`, and `InvalidDelay` reverts if `delaySeconds != 0` for any tier other than `TIER_DELAYED`.

### WardAgentRegistry

Permissionless, ownerless directory of Ward-gated agents for off-chain discovery. Each entry is owned by its registrar (first writer); only that address may update or deactivate it.

```solidity
struct Agent {
    address  agent;
    address  registrar;
    address  oracle;
    bytes32  policyId;
    string   name;
    string   metadataURI;
    string[] tags;
    uint64   updatedAt;
    bool     active;
}

mapping(address => Agent) public agents;
address[] public agentList;
```

#### Functions

```solidity
function register(address agent, address oracle, bytes32 policyId, string calldata name, string calldata metadataURI, string[] calldata tags) external;
function update(address agent, address oracle, bytes32 policyId, string calldata metadataURI, string[] calldata tags) external;
function setActive(address agent, bool active) external;

function getAgent(address agent) external view returns (Agent memory);
function agentCount() external view returns (uint256);
function agentsPaginated(uint256 offset, uint256 limit) external view returns (Agent[] memory page);
```

- `register` — first call for an `agent` records `msg.sender` as the permanent `registrar` and pushes onto `agentList`; subsequent calls by the same registrar overwrite the entry; a different caller reverts `NotRegistrar`. `agent == address(0)` reverts `InvalidAgent`. Always sets `active = true`.
- `update` / `setActive` — registrar-only mutations of an existing entry; revert `InvalidAgent` (never registered) or `NotRegistrar` (wrong caller). `update` does not change `name`.
- `agentsPaginated` returns an empty array when `offset >= agentCount()`, otherwise the slice `[offset, min(offset+limit, total))`.

#### Events & errors

```solidity
event AgentRegistered(address indexed agent, address indexed registrar, address indexed oracle, bytes32 policyId, string name, string metadataURI, string[] tags);
event AgentUpdated(address indexed agent, address indexed registrar, address oracle, bytes32 policyId, string metadataURI, string[] tags);
event AgentStatusChanged(address indexed agent, address indexed registrar, bool active);

error NotRegistrar();
error InvalidAgent();
```

### SomniaTestnet constants

Network and agent-platform constants used by deploy scripts and integration code (`contracts/src/constants/SomniaTestnet.sol`).

```solidity
library SomniaTestnet {
    uint256 internal constant CHAIN_ID = 50312;
    string  internal constant RPC_URL = "https://dream-rpc.somnia.network";

    address internal constant AGENT_PLATFORM = 0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776;

    uint256 internal constant LLM_INFERENCE_AGENT_ID = 12847293847561029384;
    uint256 internal constant JSON_API_AGENT_ID      = 13174292974160097713;

    uint256 internal constant DEFAULT_REQUEST_DEPOSIT = 0.12 ether;
}
```

`AGENT_PLATFORM` is the real Somnia Agents platform; its ABI is in `contracts/src/interfaces/ISomniaAgentPlatform.sol`. Ward's core contracts do not depend on the agent platform — the interface and these agent-id constants exist only for agents that additionally call the Somnia platform (the oracle gate is independent of it).

---


## 22. Operating policies — day-2 ops (update, pause, transfer)

Day-two operations for a live policy: update it, kill it, hand it off, and keep its queue clean.

This section assumes you have already published a policy and know its `policyId`. Every operation here is an owner-only write against the canonical v2 `WardOracle` or its `WardQueue` on Somnia Shannon (chain id `50312`, RPC `https://dream-rpc.somnia.network`). Use the addresses in §1; substitute v1 only if the policy was published against the v1 oracle.

### Which operations the SDK client covers

The `OracleClient` in `sdk/src/oracle-client.ts` exposes only four methods:

```ts
publishPolicy(label, input)   // write
updatePolicy(policyId, input) // write
checkIntent(policyId, intent, spentToday) // read
tierAndDelay(policyId, target, selector)  // read
```

Everything else here — pause/expire (done *through* `updatePolicy`), ownership transfer/accept/cancel, and all queue operations — has no typed client helper. Drive those with the `ward` CLI (queue ops) or a raw ABI call (`cast send`, or viem `writeContract` against `WARD_ORACLE_ABI` / `WARD_QUEUE_ABI`). Each section below states which path applies.

### Publish vs update a policy

A policy is identified by `policyId = keccak256(abi.encode(msg.sender, label))`. The publisher and the label together fix the id forever.

`publishPolicy(label, input)` creates a new policy and **reverts with `PolicyExists` if that `(msg.sender, label)` tuple already has one**:

```solidity
policyId = keccak256(abi.encode(msg.sender, label));
if (policyOwner[policyId] != address(0)) revert PolicyExists();
```

So you cannot "re-publish" to change a live policy — re-running `ward push my-policy.md --label my-bot-v1` against an existing label fails. To change a policy in place, call `updatePolicy(policyId, input)`:

```solidity
function updatePolicy(bytes32 policyId, PolicyInput calldata input) external {
    if (policyOwner[policyId] != msg.sender) revert NotPolicyOwner();
    policies[policyId].copy(input);
    policyVersion[policyId] += 1;
    emit PolicyUpdated(policyId, msg.sender);
}
```

`updatePolicy` is owner-only and **replaces the entire policy** — the new `PolicyInput` is copied over the old one wholesale; it is not a merge. Whatever targets, selectors, caps, `expiresAt`, and `paused` flag you send become the policy. Omit a target and it is gone.

There is no `update` subcommand in the CLI. Update via the SDK client:

```ts
const { txHash } = await oracle.updatePolicy(policyId, newInput);
```

or a raw ABI call against `updatePolicy(bytes32,(...))`.

> **In-place-update risk.** `updatePolicy` mutates a policy that running agents already depend on. Two consequences to plan for:
>
> 1. **It bumps `policyVersion`.** Every increment invalidates any intent already sitting in `WardQueue` under the old version. On `dispatch`, the queue re-checks the version and reverts with `PolicyChanged("UPDATED")`. Updating a policy with pending queued intents silently strands them — they can no longer be dispatched, only vetoed or expired.
> 2. **There is no staging or timelock.** The change is live the instant the tx confirms. An agent mid-dispatch in the next block sees the new rules. Tighten caps or remove a selector and in-flight `IMMEDIATE` calls that were legal a block ago now revert with the normal policy-denied reasons.
>
> For risky edits, prefer publishing a *new* policy under a new label and migrating the agent's hard-coded `policyId`, rather than mutating the one in production.

### Pause / expire as a kill switch

There is no standalone `pause()` or `expire()` entrypoint. Both are **fields on `PolicyInput`** that you set through `updatePolicy`:

```solidity
struct PolicyInput {
    TargetRule[] targets;
    uint256 dailySpendWeiCap;
    uint16 maxSlippageBps;
    uint64 expiresAt;
    bool paused;
}
```

To **pause** (the instant kill switch): call `updatePolicy` with the same `PolicyInput` you already have but `paused: true`. To **expire** (a time-bounded kill switch): set `expiresAt` to a past Unix timestamp, or set it once at publish time to a future cutoff and let it lapse on its own.

Either field flips the policy's health, readable cheaply via `policyHealth`:

```solidity
function policyHealth(bytes32 policyId) external view returns (bool paused, uint64 expiresAt) {
    if (policyOwner[policyId] == address(0)) revert PolicyNotFound();
    Policy storage p = policies[policyId];
    return (p.paused, p.expiresAt);
}
```

What pausing/expiring actually blocks depends on the consumer's check path, both of which run the policy's `validate` before returning. A paused or expired policy fails `validate`, so:

- `checkIntent` / `checkSelector` return `(false, reason)` for an inline agent guard — the agent's `wardGuarded` modifier or `_wardCheck` aborts the dispatch.
- `WardQueue.dispatch` re-runs `policyHealth` in `_checkPolicyStillActive` and reverts a pending intent's dispatch:

```solidity
(bool paused, uint64 expiresAt) = oracle.policyHealth(q.policyId);
if (paused) revert PolicyChanged(bytes32("PAUSED"));
if (block.timestamp > expiresAt) revert PolicyChanged(bytes32("EXPIRED"));
```

So pausing is a true global stop: it freezes both the synchronous IMMEDIATE path and any DELAYED/VETO intents already waiting in the queue. To un-pause, call `updatePolicy` again with `paused: false` — but remember it bumps `policyVersion`, so already-queued intents stay un-dispatchable (reason `UPDATED`) even after the un-pause.

This is owner-only and goes through `updatePolicy`, so it uses the SDK client or a raw ABI call — no dedicated CLI command.

### Two-step policy ownership transfer

Ownership moves in two steps so a typo'd address cannot strand a policy. The current owner *nominates*; the nominee must *accept*.

**Step 1 — nominate** (`transferPolicyOwnership`, owner only, rejects the zero address):

```solidity
function transferPolicyOwnership(bytes32 policyId, address newOwner) external {
    if (policyOwner[policyId] != msg.sender) revert NotPolicyOwner();
    if (newOwner == address(0)) revert ZeroAddress();
    pendingPolicyOwner[policyId] = newOwner;
    emit PolicyOwnershipTransferStarted(policyId, msg.sender, newOwner);
}
```

Ownership does **not** change here. The current owner keeps full control (can still `updatePolicy`, pause, re-nominate) until step 2. Calling again replaces any previously pending nominee.

**Step 2 — accept** (`acceptPolicyOwnership`, callable only by the nominated address):

```solidity
function acceptPolicyOwnership(bytes32 policyId) external {
    address pending = pendingPolicyOwner[policyId];
    if (pending != msg.sender) revert NotPendingOwner();
    address previous = policyOwner[policyId];
    policyOwner[policyId] = pending;
    delete pendingPolicyOwner[policyId];
    emit PolicyOwnershipTransferred(policyId, previous, pending);
}
```

After acceptance the previous owner can no longer update, pause, transfer, or veto for this policy — `policyOwner` now points at the new address.

**Cancel** a pending nomination before it is accepted (`cancelPolicyOwnershipTransfer`, owner only, requires a pending nominee or it reverts `NoPendingTransfer`):

```solidity
function cancelPolicyOwnershipTransfer(bytes32 policyId) external {
    if (policyOwner[policyId] != msg.sender) revert NotPolicyOwner();
    address cancelled = pendingPolicyOwner[policyId];
    if (cancelled == address(0)) revert NoPendingTransfer();
    delete pendingPolicyOwner[policyId];
    emit PolicyOwnershipTransferCancelled(policyId, msg.sender, cancelled);
}
```

None of these three has a CLI command or an SDK client method — drive them with raw ABI. From the old owner's wallet:

```bash
cast send 0x3C7bF90f243d670a01f512221d9546e09fEaCC9c \
  "transferPolicyOwnership(bytes32,address)" \
  0x<policyId> 0x<newOwner> \
  --rpc-url https://dream-rpc.somnia.network --private-key $PRIVATE_KEY
```

Then from the new owner's wallet:

```bash
cast send 0x3C7bF90f243d670a01f512221d9546e09fEaCC9c \
  "acceptPolicyOwnership(bytes32)" \
  0x<policyId> \
  --rpc-url https://dream-rpc.somnia.network --private-key $NEW_OWNER_PK
```

### Queue housekeeping

`WardQueue` holds no funds and runs no calls — it is a state machine over `Pending → Committed / Vetoed / Expired`. As policy owner you have two housekeeping actions: **veto** a pending intent you do not want dispatched, and **expire** stale records to clear them.

#### Veto a pending intent (owner only)

`veto(execId, reason)` is callable only by the current `oracle.policyOwner(policyId)`, only while the record is `Pending`:

```solidity
function veto(uint256 execId, bytes32 reason) external {
    QueuedIntent storage q = queued[execId];
    if (q.state != State.Pending) revert NotPending();
    if (msg.sender != oracle.policyOwner(q.policyId)) revert NotPolicyOwner();
    q.state = State.Vetoed;
    emit Vetoed(execId, q.policyId, reason);
}
```

Veto is the active reject for both DELAYED and VETO_REQUIRED records. (For DELAYED intents, dispatch is asker-driven on a timer, so veto is your react-in-time stop during the wait window; for VETO_REQUIRED, nothing dispatches unless *you* dispatch it, so veto just closes the record out.) The `reason` is a `bytes32` — the CLI packs your text right-padded (`padHex(..., { dir: "right" })`, the standard `bytes32` string layout) and rejects anything over 32 bytes:

```bash
ward queue:veto <execId> "too risky"
```

#### Expire stale records (anyone, after the deadline)

A queued intent gets `earliestCommitAt = enqueuedAt + delaySeconds` and `deadline = earliestCommitAt + COMMIT_WINDOW_SECONDS`, where `COMMIT_WINDOW_SECONDS = 7 days`. After `deadline`, a `Pending` record that was never dispatched is dead weight. Anyone may garbage-collect it:

```solidity
function expireIfStale(uint256 execId) external {
    QueuedIntent storage q = queued[execId];
    if (q.state != State.Pending) revert NotPending();
    if (block.timestamp <= q.deadline) revert TooEarly();
    q.state = State.Expired;
    emit Expired(execId, q.policyId);
}
```

```bash
ward queue:expire <execId>
```

Reverts before the deadline (`TooEarly`) or if the record is already terminal (`NotPending`). The TUI sweeps these in bulk — `ward tui`, then `[s]` to sweep all expirable records.

#### Inspect before acting

`ward queue:status <execId>` prints the record header (state, tier, asker, target, and the `earliestCommitAt` / `deadline` timing) without loading the unbounded `intent.data`. Use it to confirm a record is genuinely past its deadline (expirable) or still inside its window (veto-able) before you spend gas.

#### What a policy update does to the queue

`_checkPolicyStillActive` re-validates every dispatch against the live policy. A pending record is permanently un-dispatchable if, since enqueue, the policy was paused, expired, or updated:

```solidity
if (paused) revert PolicyChanged(bytes32("PAUSED"));
if (block.timestamp > expiresAt) revert PolicyChanged(bytes32("EXPIRED"));
if (oracle.policyVersion(q.policyId) != q.policyVersion) revert PolicyChanged(bytes32("UPDATED"));
```

`PAUSED` and `EXPIRED` are recoverable (un-pause, or the record was never going to outlive the policy). `UPDATED` is not: any `updatePolicy` bumps the version and strands every in-flight record. After a deliberate update, expect to either veto the stranded records or let them lapse to `expireIfStale`.

### Rotate the publisher key

Rotating the key that owns a policy *is* the two-step ownership transfer above — there is no separate rotation primitive. The flow:

1. The current (compromised or retiring) owner calls `transferPolicyOwnership(policyId, newOwner)` nominating the new key.
2. The new key calls `acceptPolicyOwnership(policyId)`.

After step 2, `policyOwner[policyId]` is the new key and the old key is fully locked out — it can no longer `updatePolicy`, pause, re-transfer, or `veto` queued intents for this policy.

Caveats specific to rotation:

- **Rotate per policy.** Ownership is keyed by `policyId`, not by account. If one key owns several policies, you must run the two-step transfer for each `policyId`.
- **The id does not change.** `policyId` is derived from the *original* publisher + label and is immutable. Agents that hard-coded `POLICY_ID` keep working unchanged after a key rotation — only the address allowed to administer the policy moves.
- **If the old key is compromised, pause first.** The old key keeps control until the new key accepts. Before starting the transfer, call `updatePolicy` with `paused: true` from the old key (if you still control it) to freeze the policy during the handover, then transfer, accept, and un-pause from the new key. Note that the un-pause bumps `policyVersion` and strands any then-pending queue records (reason `UPDATED`).

### Quick reference: op → tool

| Operation | Function | Tool |
|---|---|---|
| Create a policy | `publishPolicy(label, input)` | `ward push`, SDK `publishPolicy` |
| Change a policy | `updatePolicy(policyId, input)` | SDK `updatePolicy` or raw ABI |
| Pause / un-pause | `updatePolicy` with `paused` flag | SDK `updatePolicy` or raw ABI |
| Expire | `updatePolicy` with `expiresAt` | SDK `updatePolicy` or raw ABI |
| Nominate new owner | `transferPolicyOwnership(policyId, newOwner)` | raw ABI (`cast`) |
| Accept ownership | `acceptPolicyOwnership(policyId)` | raw ABI (`cast`) |
| Cancel nomination | `cancelPolicyOwnershipTransfer(policyId)` | raw ABI (`cast`) |
| Veto a queued intent | `veto(execId, reason)` | `ward queue:veto` |
| Expire a stale record | `expireIfStale(execId)` | `ward queue:expire`, TUI sweep |
| Inspect a record | `getRecordHeader(execId)` | `ward queue:status` |

---


## 23. Operating the queue — TUI + dashboard

Watch live `WardQueue` activity and fire `expireIfStale` on stale records from a terminal, or stream queue events as NDJSON. This section covers the `ward tui` operator console end-to-end (the same surface ships as `@ward/tui` with the `ward-tui` bin).

### Launch

From the repo root:

```bash
pnpm ward tui
```

`ward tui` spawns the Ink app in `tui/` (built `dist/index.js` if present, otherwise `tsx src/index.tsx`). Unknown flags are forwarded verbatim, so `pnpm ward tui --help` and `pnpm ward tui --json` reach the TUI binary.

Direct package invocations (private package — `ward-tui` bin → `./dist/index.js`):

```bash
# build, then run the compiled bin
pnpm --filter @ward/tui build
node tui/dist/index.js

# or run from source without building
pnpm --filter @ward/tui start
```

`build` runs `tsc -p tsconfig.json && chmod +x dist/index.js`; `start` runs `tsx src/index.tsx`.

The TUI runs against the canonical v2 deployment by default — no flags or config required:

| Setting | Default | Override env var |
| --- | --- | --- |
| Oracle | `0x3C7bF90f243d670a01f512221d9546e09fEaCC9c` | `WARD_ORACLE` |
| Queue | `0xFB715A37951Fc8dcc920120768e91f7C8bbA54c4` | `WARD_QUEUE` |
| RPC | `https://dream-rpc.somnia.network` (chain `50312`) | `SOMNIA_TESTNET_RPC` |
| Queue lookback | `50000` blocks | `WARD_QUEUE_LOOKBACK_BLOCKS` |

On launch the TUI backfills the recent queue window, then goes live. The header status reads `SYNCING` during backfill and `LIVE` once `store.init()` resolves.

`.env` in the working directory is auto-loaded (`KEY=VALUE` lines, `#` comments, shell env wins). `PRIVATE_KEY` is **optional**: without it the TUI runs read-only and the header wallet field shows `(read-only — set PRIVATE_KEY to enable writes)`. Expire actions need a signer.

```bash
pnpm ward tui --help     # usage + env vars
pnpm ward tui --version  # prints 0.9.0
```

> Deep history is off by default. The oracle policy backfill starts from the same bounded recent window as queue events. Set `WARD_TUI_ORACLE_DEPLOY_BLOCK=<block>`, or `WARD_TUI_DEEP_BACKFILL=1` to reuse the repo-wide `WARD_ORACLE_DEPLOY_BLOCK`, only when you explicitly want a full historical policy sweep.

### Panes

The screen is a single live surface, top to bottom. Layout switches to a two-column form when the terminal is at least 116 columns wide; otherwise panes stack.

#### Header + health scope

The double-bordered header carries the `WARD / SOMNIA` banner, the current block (`cursor()`), and the connected oracle/queue/wallet/RPC. Its raster "scope" animates from queue activity, and three meters track `pending`, `expired` (expirable), and `events`. The status label is derived, not cosmetic:

| Label | Condition |
| --- | --- |
| `SYNCING` | backfill in progress (`ready === false`) |
| `LIVE` | synced, nothing stale |
| `ACTION` | synced, ≥1 record past its deadline |
| `FAULT` | an init/store error is set |

Below the header, four `OverviewPane` metric cards summarize the same signal numerically:

- **health** — `SYNC` / `CLEAR` / `ACTION`.
- **pending** — count of `Pending` records in the lookback window.
- **expirable** — count where `now > deadline` (the queue's stale set).
- **dispatchable** — records inside their dispatch window (`now >= earliestCommitAt && now <= deadline`), with a `soon` (deadline < 1h) and `feed` (recent queue events) sub-line.

#### Queue monitor panes

- **EXPIRABLE NOW** (`ExpirablePane`) — the action surface. One row per `Pending` record whose `deadline` has passed, columns `exec / tier / overdue / selector / value / target / asker`. `exec` is the `execId` — the queue's primary key for `expireIfStale`; it is **not** the app-level `requestId`. The focused row is highlighted; the pane border is green when empty, yellow when rows are waiting. Hidden rows beyond the visible cap show as `+N more rows not shown`.
- **AGING PENDING** (`AgingPane`) — bucketed bars over all pending records by time-to-deadline: `overdue`, `<1h`, `<1d`, `<7d`. An at-a-glance pressure read, no actions.
- **LIVE EVENTS** (`LiveEventsPane`) — chronological tail (newest at bottom, last 200 retained). Each line is `marker · blockNumber · type · execId/policyId · detail`. Recognized event types and markers: `Enqueued ●`, `Dispatched ◆`, `Vetoed ×`, `Expired □`, `PolicyPublished +`, `PolicyUpdated ↻`, plus the `OwnershipTransfer*` set.

When a write fires, a **RECENT TX** panel appears below the panes showing the last 5 transactions as `exec #<id> <status> <hash> (<message>)`, where status is `submitting` → `sent` → `ok` | `revert`.

### Live filters and expirable actions

All interaction is single-key (footer: `[↑↓] move · [x] expire · [s] sweep · [c] catch-up · [a/e/d/v/r] filter · [q] quit`).

#### Filters

The filter applies to the LIVE EVENTS pane only:

| Key | Filter |
| --- | --- |
| `a` | all |
| `e` | enqueued |
| `d` | dispatched |
| `v` | vetoed |
| `r` | expired |

#### Expirable actions

These mutate on-chain state and require `PRIVATE_KEY`:

| Key | Action |
| --- | --- |
| `↑` / `↓` | move the focused row in EXPIRABLE NOW |
| `x` | call `expireIfStale(execId)` on the focused row |
| `s` | sweep — loop `expireIfStale` over every expirable row, one tx each, per-row revert reporting |
| `c` | catch-up — re-derive the visible lists from the live store cursor |
| `q` (or `Ctrl-C`) | quit |

Each action sends a real `writeContract` to `WardQueue.expireIfStale(uint256)` and waits for the receipt. A per-`execId` in-flight guard prevents a fast operator or an overlapping sweep from double-submitting the same record (which would burn gas and produce duplicate revert spam). If `PRIVATE_KEY` is unset, `x`/`s` surface `expireIfStale needs PRIVATE_KEY set in env; readonly mode.` and do nothing.

`expireIfStale` is the **only** write the TUI performs. There is no dispatch or veto action here — those belong to the policy owner and intent flow, not the operator surface.

### NDJSON mode (`--json`) for piping

`--json` skips the TUI entirely and streams one NDJSON line per queue event to stdout, forever, until `SIGINT`/`SIGTERM`. Each line is a `StoreEvent` JSON object with bigints serialized as strings.

```bash
pnpm ward tui --json
```

Behavior to rely on when piping:

- **stdout is data-only.** Backfill progress and the `[live]` marker go to **stderr**. Redirect with `2>/dev/null` to silence progress.
- **History first, then live.** After `init()`, the backfilled events are dumped (oldest known to newest), then live events stream as they arrive. A consumer that starts mid-stream still sees the historical window once.
- **No signer needed.** `--json` is read-only; it never touches `PRIVATE_KEY`.

Pipe into your own tooling:

```bash
# Stream only Vetoed events, drop progress noise
pnpm ward tui --json 2>/dev/null | jq -c 'select(.type == "Vetoed")'

# Alert on any record that expires
pnpm ward tui --json 2>/dev/null | jq -c 'select(.type == "Expired") | {execId, blockNumber}'
```

### Environment (TUI)

Loaded from `.env` in the current working directory (KEY=VALUE lines, `#` comments, no interpolation; shell env wins over file values).

| Variable                          | Default                                        | Purpose                                                              |
| --------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------- |
| `PRIVATE_KEY`                     | unset (read-only)                              | Enables `expireIfStale` writes.                                      |
| `WARD_ORACLE`                   | `0x3C7bF90f243d670a01f512221d9546e09fEaCC9c`   | Oracle address.                                                     |
| `WARD_QUEUE`                    | `0xFB715A37951Fc8dcc920120768e91f7C8bbA54c4`   | Queue address.                                                      |
| `SOMNIA_TESTNET_RPC`              | `https://dream-rpc.somnia.network`             | RPC endpoint (chain id `50312`, Somnia Testnet).                   |
| `WARD_QUEUE_LOOKBACK_BLOCKS`    | `50000`                                        | Queue event backfill window.                                        |
| `WARD_TUI_ORACLE_DEPLOY_BLOCK`  | unset                                          | Start block for a deep policy backfill.                             |
| `WARD_TUI_DEEP_BACKFILL`        | unset                                          | `1`/`true`/`yes` opts into the shared `WARD_ORACLE_DEPLOY_BLOCK`. |

The `--help` text additionally references `WARD_RPC` as an env hint; the resolver reads `SOMNIA_TESTNET_RPC` and falls back to the chain's default RPC.

### When to use the TUI vs the dashboard Queue tab

Both read the same on-chain `WardQueue` via the SDK event store; they differ in audience and capability.

| | TUI (`ward tui`) | Dashboard Queue tab |
| --- | --- | --- |
| Surface | terminal / Ink | browser / wagmi |
| Primary action | `expireIfStale` on stale records (`x`, `s`) | view pending requests, open a wallet to act per intent |
| Scope | global queue lookback window | global, with a "Mine only" toggle for policies your wallet owns |
| Automation | `--json` NDJSON for piping into your own alerting | none — interactive only |
| Best for | operators sweeping stale records, headless monitoring, scripted alerts | policy owners inspecting their pending intents in a UI |

Use the **TUI** when you are an operator sweeping stale records, running headless, or piping events into other tooling. Use the **dashboard Queue tab** when you want a browser view of pending requests filtered to the policies your connected wallet owns.

---


## 24. Using Ward with AI assistants — phased onboarding flow + `ai:init`

Ward ships one self-contained skill (this very `SKILL.md`) and one CLI command (`ward ai:init`) so an AI coding agent can do the work — discover your agent's call surface, draft a `POLICY.md`, publish it on Somnia, and apply the integration diff — without you reading the spec by hand.

### Install the skill

This document is the skill. The expected install paths per assistant:

- **Claude Code:** `cp SKILL.md ~/.claude/skills/ward-integration/SKILL.md` (or symlink the repo path), or run `pnpm ward ai:init --claude` to emit it.
- **Cursor:** `pnpm ward ai:init --cursor` writes `.cursor/rules/ward.mdc`.
- **Codex / generic AGENTS.md:** `pnpm ward ai:init --codex` updates the marked Ward stub in the repo's `AGENTS.md`.
- **All three at once:** `pnpm ward ai:init --all`.

Then, in any session opened in *your agent's* repo (not necessarily Ward's), invoke it:

> `/ward-integration` &nbsp;or&nbsp; "onboard this agent to ward"

The assistant reads this `SKILL.md`, discovers your agent's call surface, drafts a `POLICY.md`, compiles and publishes it on Somnia, and applies the Solidity diff.

The flow expects you to have:

1. The Ward repo cloned somewhere on disk (for the CLI).
2. `pnpm install` + `pnpm -C cli run build` run in the Ward repo.
3. A `.env` in the Ward repo with `PRIVATE_KEY` set to a Somnia testnet wallet with STT ([faucet](https://testnet.somnia.network/)).
4. Your agent contract source open in the workspace.

The skill handles everything else — including verifying the precomputed `policyId` matches the published one, surfacing label-encoding mistakes, and only running real on-chain transactions after explicit confirmation.

### `ward-integration` — the self-contained agent manual

This very document (`SKILL.md` at the repo root) is the full Ward usage manual. It is self-contained: every address, command, schema rule, selector, struct, and reason code an LLM needs to publish a policy, integrate it, and operate it is inline.

Reach for `ward-integration` for any Ward task end-to-end. The phased onboarding flow below describes the same orchestration the skill performs when invoked on a fresh agent.

### Phased onboarding flow

The orchestrated end-to-end CLI flow: discover your agent's call surface → draft `POLICY.md` → compile → publish on Somnia → wire the gate into the agent contract. It is structured as **five phases**, and the dev confirms before every on-chain action:

| Phase | Step | What happens |
|---|---|---|
| 1 | Discover the call surface | Read the agent contract; extract external targets, selectors, existing caps/rate-limits, and a risk classification per selector. |
| 2 | Draft `POLICY.md` | Generate the file with one `targets:` entry per external contract, selectors grouped by tier, and caps drawn from observed code (or marked `# TODO: confirm`). |
| 3 | Compile + precompute `policyId` | `pnpm ward compile <POLICY.md>`, then `pnpm ward policyid <label>` to record the deterministic id from `(your wallet address, label)`. |
| 4 | Publish on-chain | `pnpm ward preflight`, ask for explicit confirmation, then `pnpm ward push <POLICY.md> --label <label>` — and verify the returned `policyId` matches Phase 3. |
| 5 | Wire the integration | Apply the integration diff against the agent file, run the test suite, redeploy, and smoke a happy-path call. |

The skill encodes hard constraints that keep it honest:

- **Never publish on-chain without explicit confirmation** including the signing wallet address and the testnet/mainnet target. It shows the exact tx that will be sent.
- **Never invent caps from thin air** — pull them from the agent's code, ask, or mark `# TODO: confirm`.
- **Never refactor the agent beyond the integration diff** (3 lines + 2 imports + 1 storage slot).
- **Verify the precomputed `policyId` matches the published one.** If they differ, stop — label encoding is wrong.

Each phase returns a short structured YAML update (`phase`, `status`, `artifact`, `next_action`, `warnings`), and the run ends with a hand-off block carrying the `policyId`, `publishTxHash`, explorer link, and next steps.

### Trigger conditions

Invoke this skill when the user says any of:

- "onboard my agent to ward" / "wire ward into this contract" / "add ward to my agent"
- "write a POLICY.md for X"
- "publish my policy" / "register my policy on ward"
- pastes a Solidity agent contract and asks "what would the Ward policy look like?"
- mentions Somnia + agent + policy in the same breath

Do NOT auto-invoke if the user is asking conceptual questions about Ward ("how does it work?") — answer those directly.

### Background — what the skill knows

#### Ward contracts (live on Shannon testnet, chainId 50312)

Use the canonical table in §1. The v2 oracle is the default for new integrations because it adds `checkSelector`; v1 remains live for inline `checkIntent` callers. Neither contract holds funds, owns agents, or executes calls. The dev's agent remains the executor of `target.call(...)`.

#### The Ward CLI (`pnpm ward` from the Ward repo) — onboarding subset

| Command | Purpose |
|---|---|
| `preflight` | Check `.env` + wallet balance + RPC reachability before any tx |
| `compile <POLICY.md>` | Compile + validate POLICY.md → canonical PolicyInput JSON (no tx) |
| `policyid <label>` | Compute policyId off-chain from `(your wallet address, label)` |
| `push <POLICY.md> --label <label>` | `publishPolicy` on-chain; returns final policyId + tx hash |
| `inspect <intent.json>` | Pretty-print an Intent JSON with calldata decoded |
| `queue:status <execId>` | Read a WardQueue record header (operator-side, not needed for onboarding) |

The dev needs the Ward repo cloned + `pnpm install`'d + `pnpm -C cli run build`. Their `.env` needs `PRIVATE_KEY` (a Somnia testnet key with STT) and optionally `WARD_ORACLE` / `WARD_QUEUE` overrides (defaults match the addresses above). Use `pnpm ward` for the guided menu or `pnpm ward <command>` for direct commands.

#### POLICY.md format (v0.1) — short form

A POLICY.md is a markdown file wrapping **exactly one** fenced YAML block tagged `policy` (or untagged). The compiler is **strict** — unknown fields fail compilation.

```md
# My Agent Policy

> Optional narrative explaining what this agent does.

​```policy
version: 0.1
dailySpendWeiCap: "1 ether"
maxSlippageBps: 50
expiresAt: "2026-12-31T00:00:00Z"
paused: false

targets:
  - target: "0xAbCd..."         # the address being called
    selectors:
      - selector: "transfer(address,uint256)"
        valueCapPerCall: "0.1 ether"
        tier: IMMEDIATE
        delaySeconds: 0
      - selector: "withdraw(uint256)"
        valueCapPerCall: "0"
        tier: VETO_REQUIRED
        delaySeconds: 0
​```
```

Schema rules (short form — full reference in [§19](#19-policymd-spec--authoritative-grammar)):
- `tier` ∈ `{ IMMEDIATE, DELAYED, VETO_REQUIRED }` — no `TIER_` prefix in the YAML.
- `delaySeconds` MUST be 0 for `IMMEDIATE` and for `VETO_REQUIRED`. Only `DELAYED` uses it.
- `valueCapPerCall` is per `(target, selector)` pair, in wei. Accepts `"1 ether"` shorthand or raw integer strings.
- `dailySpendWeiCap` is the per-UTC-day rolling cap across ALL selectors.
- `maxSlippageBps` is a hint for slippage-sensitive selectors; the contract doesn't enforce it on every selector — your agent reads it.
- `expiresAt` is an ISO-8601 timestamp after which `checkIntent` returns `(false, "EXPIRED")`.

#### Reference Solidity integration (verbatim from the canonical sample)

The minimal integration is: **build an `Intent`, call `oracle.checkIntent`, branch on the answer.** Pattern below is the canonical entrypoint-policy shape — equivalent to `examples/ward-counter/src/CounterAgent.sol` and verified to work on Shannon:

```solidity
// Import paths follow YOUR foundry remappings. The reference repo remaps
// "ward/" → ward/contracts/src/, hence the short paths
// below. Use whatever path matches your `remappings.txt`.
import "ward/PolicyTypes.sol";
import "ward/WardOracle.sol";

contract MyAgent {
    WardOracle public immutable oracle;
    bytes32      public immutable POLICY_ID;          // filled in after publish

    bytes4 internal constant DO_THING_SELECTOR =
        bytes4(keccak256("doThing(uint256,string)"));

    constructor(WardOracle _oracle, bytes32 _policyId) {
        oracle    = _oracle;          // 0x3C7bF90f243d670a01f512221d9546e09fEaCC9c on Shannon (v2 — canonical for new integrations); 0x68d4B045B24F8d1012974b9d34684cA5aeD11DDf for pre-v0.11.0 v1-bound agents
        POLICY_ID = _policyId;
    }

    function dispatch(uint256 reqId, uint256 arg, string calldata verdict) external {
        bytes memory callData = abi.encodeWithSelector(DO_THING_SELECTOR, arg, verdict);

        // ============ WARD INTEGRATION ============
        Intent memory intent = Intent({
            agentId:    /* your Somnia agentId or 0 if non-LLM */ 0,
            requestId:  reqId,
            target:     address(targetContract),
            selector:   DO_THING_SELECTOR,
            data:       callData,
            value:      0,
            promptHash: bytes32(0),
            taskClass:  0
        });
        (bool ok, bytes32 reason) = oracle.checkIntent(POLICY_ID, intent, 0);
        if (!ok) revert(string(abi.encodePacked("ward: ", reason)));
        // ========== END WARD INTEGRATION ==========

        (bool success,) = address(targetContract).call(callData);
        require(success, "call failed");
    }
}
```

**`spentToday` patterns:**

- **Stateless (matches reference agent)**: pass `0`. Use this when `dailySpendWeiCap` in your POLICY.md is `"0"` (no daily cap) or when the agent only fires one call per day. Cheapest.
- **Stateful**: keep a `mapping(uint64 => uint256) _wardDailySpent;` keyed by `uint64(block.timestamp / 1 days)`, pass that value to `checkIntent`, and bump it by `intent.value` after a successful dispatch. Use this when your policy has a real `dailySpendWeiCap` you need to enforce.

Pick the pattern that matches the policy. **Do not add the stateful tracker if the policy doesn't have a daily cap** — it's dead code and dead gas.

### Workflow — the five phases in detail

#### Phase 1 — Discover the agent's call surface

Ask the dev for the agent contract (file path, repo, or pasted source). Read it. Extract:

| What to find | How |
|---|---|
| External targets | grep for `.call{`, `.call(`, `IERC20(`, `I<X>(`, hardcoded addresses in storage/constants |
| Selectors | grep for function signatures called on those targets — get the canonical `name(type1,type2)` form |
| Existing rate limits / caps | look for `require(amount <= MAX_…)`, daily-counter patterns, mutex modifiers |
| Risk classification | reads + small transfers → IMMEDIATE; admin / large transfers / external withdrawals → DELAYED or VETO_REQUIRED |

If the agent calls many things, group by risk. **Default to stricter tiers** — easier to relax later (relaxing = publishing a new policy + updating `POLICY_ID`; this is intentionally costly).

If you cannot determine a selector's risk class from the code alone, ask the dev one focused question per ambiguity.

#### Phase 2 — Draft POLICY.md

If the user is non-technical and would prefer to start from a template instead of having you draft from their code, point them at the dashboard's Publish tab — 4 starter templates ship (DEX swapper, NFT mint guard, Treasury bot, LLM dispatcher). They click one, swap the placeholder target for their real contract, and we skip Phase 1-3 of this skill entirely. Phase 4-5 still apply (publish + integration diff).

Generate a POLICY.md with:
- A header naming the agent + one-line description
- One `targets:` entry per external contract, with selectors grouped by tier
- Caps set from observed patterns OR explicitly marked `# TODO: confirm`
- `dailySpendWeiCap` ≈ 10× the largest single `valueCapPerCall`
- `expiresAt` 6–12 months out (publisher can always re-publish)
- `paused: false`

Show the full file. Ask: **"Is this faithful to what your agent actually does? Are the caps right? Any selector you'd move to a stricter tier?"**

#### Phase 3 — Compile + precompute policyId

Once the draft is approved, save it to a path the dev controls (typically next to their agent contract: `<agent-repo>/POLICY.md`). Then, from the Ward repo root:

```bash
pnpm ward compile <absolute-path-to-POLICY.md>
```

If it errors, fix the POLICY.md and re-run. Common errors: unknown fields (strict schema), `delaySeconds > 0` on IMMEDIATE/VETO_REQUIRED, malformed selector signatures, non-checksummed addresses.

Once clean, precompute the policyId:

```bash
pnpm ward policyid <label>
```

`<label>` is a short kebab-case handle (≤ 32 UTF-8 bytes) — e.g. `treasury-bot-v1`, `llm-dispatcher`. Show the resulting `policyId` (66-char hex) and the canonical PolicyInput JSON. The precomputed id is deterministic from `(your wallet address, label)` — record it; you'll verify the on-chain publish returns the same value.

#### Phase 4 — Publish on-chain

Run preflight first:

```bash
pnpm ward preflight
```

If wallet balance is low, point the dev at the [Somnia faucet](https://testnet.somnia.network/) and STOP. Do not try to publish a no-balance wallet.

If preflight is clean, ask explicitly:

> "Publish this policy with label `<label>` to WardOracle at `0x3C7b...` (v2, canonical for new integrations) using your wallet at `0x<dev-address>` on Somnia testnet? This is a real on-chain transaction (~0.001 STT)."

Wait for explicit confirmation. On "yes":

```bash
pnpm ward push <absolute-path-to-POLICY.md> --label <label>
```

Capture from the output:
- The final `policyId` — **verify it matches the precomputed one from Phase 3** (if not, stop and diagnose label encoding)
- The tx hash — show the dev the explorer link: `https://shannon-explorer.somnia.network/tx/<hash>`

#### Phase 5 — Wire the integration into the agent contract

Produce the integration diff against the dev's actual agent file, matching the canonical entrypoint-policy pattern from `examples/ward-counter/src/CounterAgent.sol`. Use the dev's existing remapping for the Ward imports (check their `remappings.txt` first; if Ward isn't remapped yet, also add the remapping):

```diff
+ import "ward/PolicyTypes.sol";   // adjust to your remapping
+ import "ward/WardOracle.sol";
+
  contract MyAgent {
+   WardOracle public immutable oracle;
+   bytes32      public immutable POLICY_ID;
+
+   bytes4 internal constant <SEL_NAME> =
+       bytes4(keccak256("<exact-signature>"));    // e.g. "transfer(address,uint256)"

    constructor(/* existing args, */ WardOracle _oracle, bytes32 _policyId) {
+     oracle    = _oracle;
+     POLICY_ID = _policyId;
      // ...existing init...
    }

    function dispatch(/* ... */) external {
+     bytes memory _callData = abi.encodeWithSelector(<SEL_NAME>, <args...>);
+
+     // ============ WARD INTEGRATION ============
+     Intent memory _intent = Intent({
+         agentId:    <somnia agentId or 0>,
+         requestId:  <unique-per-dispatch id>,
+         target:     <target-address>,
+         selector:   <SEL_NAME>,
+         data:       _callData,
+         value:      <value or 0>,
+         promptHash: bytes32(0),
+         taskClass:  0
+     });
+     (bool _ok, bytes32 _reason) = oracle.checkIntent(POLICY_ID, _intent, /*spentToday*/ 0);
+     if (!_ok) revert(string(abi.encodePacked("ward: ", _reason)));
+     // ========== END WARD INTEGRATION ==========
+
-     (bool success,) = <target>.call{value: <value>}(<existing-calldata>);
+     (bool success,) = <target>.call{value: <value>}(_callData);
      require(success, "call failed");
    }
  }
```

Notes when generating the diff:

- If the policy's `dailySpendWeiCap` is non-zero, also add `mapping(uint64 => uint256) internal _wardDailySpent;`, pass `_wardDailySpent[uint64(block.timestamp / 1 days)]` instead of `0` as the third arg, and bump it by `intent.value` after `require(success)`. **Don't add this if the policy has no daily cap** — dead gas.
- If the agent already wraps dispatch in something like an `Intent` of its own, reuse fields where the names line up — don't introduce parallel state.
- The constructor change is a deployment break; flag it.
- The oracle address constant could be hardcoded instead of constructor-injected if the dev prefers (`address(0x3C7bF90f243d670a01f512221d9546e09fEaCC9c)` for v2 — canonical for new integrations; `address(0x68d4B045B24F8d1012974b9d34684cA5aeD11DDf)` for pre-v0.11.0 v1-bound agents). Either works.

If the dev says "apply it", use Edit to land the diff in their actual file. Then:
1. Run their existing test suite. Fix any breakage (typically: tests that hit a now-blocked selector — those are now tests of the policy itself, which the dev should keep as expected-revert tests).
2. Re-deploy the agent contract (constructor changed).
3. Smoke a single happy-path call against the new agent on Shannon to confirm `checkIntent` passes for an allowed intent.

### Common pitfalls — call these out as you hit them

- **Label encoding.** Labels are encoded as `padHex({size:32, dir:"right"}, stringToBytes(label))` — i.e. the UTF-8 bytes right-padded with zeros to 32 bytes. **Never `keccak256(label)`.** The CLI handles this; if the dev rolls their own publish path and uses keccak, their `policyId` will not match what `policyid <label>` precomputed.
- **Deposit sizing for LLM agents.** If the agent uses Somnia's `inferString` / `inferToolsChat`, `getRequestDeposit()` returns ONLY the validator-reward budget — it does NOT include the LLM execution cost. Empirically 1 STT works for short prompts; 0.12 STT returns the validator response `"insufficient budget for execution cost"`. Document this in the agent.
- **DELAYED vs VETO_REQUIRED dispatcher mismatch.** `DELAYED` is dispatched by the **asker**; `VETO_REQUIRED` is dispatched by `oracle.policyOwner(policyId)`. If the policy owner is a multisig that doesn't have a path to call into the agent's execution surface, `VETO_REQUIRED` calls revert at dispatch even after the delay window. Use DELAYED unless the dev confirms the policy-owner address can actually execute.
- **`policyId` is stable for `(publisher, label)`, not content-addressed.** Editing POLICY.md and running `pnpm ward push` with the same wallet + label updates the existing policy under the same id. Changing the label or publisher wallet creates a new id. This is convenient for iteration, but a compromised policy owner can also update rules in place; use a multisig/timelock owner for production.
- **Caps in wei, not STT.** The markdown says `"1 ether"` — the compiler normalizes to `10^18` wei. Don't hand-write hex caps.
- **CLI tier check.** `compile` accepts `delaySeconds: 0` on IMMEDIATE/VETO_REQUIRED, and rejects `delaySeconds > 0` on those tiers with a clear error. If the dev writes `delaySeconds: 60` for an IMMEDIATE selector, surface that to them — they probably meant DELAYED.
- **Lost publisher key?** `transferPolicyOwnership(bytes32 policyId, address newOwner)` on WardOracle. Only the current policy owner can call it; reverts on zero address. If the user's wallet is compromised or migrated, this is the recovery path — no policy re-publish needed.

### Output format (per phase)

Each phase returns a short structured update:

```yaml
phase: 1
status: discovered | drafted | compiled | published | wired
artifact:                 # what changed this phase
  path: <file>
  preview: |
    ...
next_action: <"awaiting dev confirmation" | "run X" | "phase N">
warnings:                 # anything risky the dev should know
  - <text>
```

The final hand-off:

```yaml
policyId: 0x...
publishTxHash: 0x...
explorerLink: https://shannon-explorer.somnia.network/tx/...
agentFile: <path>
agentDiffApplied: true|false
nextSteps:
  - re-deploy the agent contract
  - run smoke test on Shannon
  - (optional) start `pnpm ward tui` to monitor live policy events
```

### What the onboarding flow refuses to do

- Publishing without explicit dev confirmation on the on-chain step.
- Drafting a policy without first reading the agent's actual code (no policies from imagination).
- Pretending to publish ("I would have run `ward push` for you") — either run it for real with confirmation, or hand the dev the exact command and stop.
- Setting caps from memory or templates — always justify each cap from observed code or a direct dev answer.
- Editing the agent beyond the integration diff. Bug fixes, refactors, gas optimizations — all out of scope.

### Generate assistant context with `ward ai:init`

`ward ai:init` regenerates AI-assistant context files from the canonical `SKILL.md`, so a coding agent working in your repo always has the Ward manual in scope. It writes three flavors:

| Flag | Output file | Format |
|---|---|---|
| `--cursor` | `.cursor/rules/ward.mdc` | Cursor rule, with the skill `description` as frontmatter |
| `--claude` | `.claude/skills/ward-integration/SKILL.md` | Claude Code skill |
| `--codex` | `AGENTS.md` | Codex `AGENTS.md` section |

```bash
# Generate every flavor:
ward ai:init --all --force

# Or just the AGENTS.md section for Codex:
ward ai:init --codex --force
```

With no flag (and without `--all`), all three targets are written. `--all` also writes all three.

Behavior worth knowing before you run it:

- Every generated file carries the header `<!-- GENERATED — edit /SKILL.md and rerun `ward ai:init` to update -->`. The source of truth is `/SKILL.md`; edit it and rerun, not the generated file.
- `AGENTS.md` is updated in place: the Ward block is delimited by `<!-- ward-ai-init:begin -->` / `<!-- ward-ai-init:end -->` markers, so a rerun replaces only that section and leaves the rest of your `AGENTS.md` untouched. If no marker block exists, the section is appended.
- The command refuses to clobber a file that exists but does not look generated (no `GENERATED` header), or an `AGENTS.md` whose Ward section was hand-edited. Pass `--force` to overwrite in those cases.

---


## 25. Gotchas appendix — failure modes lookup

Lookup table of the non-obvious failure modes that bite Ward integrators, with the exact symptom, cause, and the rule that avoids each. Every entry below is grounded in source: the onboarding skill and the canonical sample `examples/ward-counter/`. When in doubt, the contract is the source of truth — read `contracts/src/PolicyTypes.sol`, `contracts/src/PolicyNormalizer.sol`, and `contracts/src/WardOracle.sol`.

### Label encoding: never `keccak256` the label

**Symptom.** Your precomputed `policyId` does not match the one the on-chain publish returns, or two different labels collide on one `policyId`.

**Cause.** A `policyId` is derived from `(publisher wallet address, label)` where the label is encoded as the **UTF-8 bytes right-padded with zeros to 32 bytes** — not hashed:

```ts
padHex({ size: 32, dir: "right" }, stringToBytes(label))
```

If a hand-rolled publish path runs `keccak256(label)` instead, the resulting `policyId` will never match what `pnpm ward policyid <label>` precomputed. The CLI and dashboard handle the encoding correctly; the trap is only for code that bypasses them.

**Rules.**

- Let the CLI compute the id. Precompute with `pnpm ward policyid <label>`, publish with `pnpm ward push <POLICY.md> --label <label>`, and **verify the published `policyId` equals the precomputed one**. If they differ, stop — the label encoding is wrong.
- Keep `label` ≤ 32 UTF-8 bytes (e.g. `treasury-bot-v1`, `counter-demo`). Longer labels truncate during padding.
- **Reject control bytes in labels.** Because the label is right-padded with `\0`, a trailing null byte collides with the unpadded label: `"abc\0"` encodes identically to `"abc"`. Restrict labels to a printable ASCII slug (`^[a-z0-9._-]+$`) unless you genuinely need internationalization; reject any `\0`, any byte `< 0x20`, and `0x7f`.

### `wardGuarded` is v2-only: bind the v2 oracle

**Symptom.** A contract using the `wardGuarded(selector, value)` modifier reverts on every call, or fails to deploy/link against the configured oracle.

**Cause.** `WardAgentBase.wardGuarded` (v0.10.5+) calls `checkSelector` on the oracle. `checkSelector` exists **only on the v2 oracle**. The v1 oracle has no `checkSelector` — it supports inline `checkIntent` callers only.

Use the v2 oracle in §1 for `wardGuarded`; use v1 only for legacy inline `checkIntent` callers. RPC, explorer, queue, and registry addresses are also listed in §1.

**Rules.**

- If you use the `wardGuarded` modifier, bind the **v2 oracle** (`0x3C7bF90f243d670a01f512221d9546e09fEaCC9c`). This is the default for new integrations.
- If you must run against the v1 oracle (a pre-v0.11.0 v1-bound agent), do **not** use `wardGuarded` — call `oracle.checkIntent(...)` inline instead. The inline path works on both v1 and v2.
- The registry is oracle-agnostic, so registering an agent says nothing about which oracle gates it. Don't infer the oracle version from the registry.

### DELAYED vs VETO_REQUIRED: different dispatchers

**Symptom.** A `VETO_REQUIRED` intent's execution reverts at dispatch even after the delay/veto window has elapsed, while the equivalent `DELAYED` intent dispatches fine.

**Cause.** The two non-IMMEDIATE tiers are dispatched by **different parties**:

- `DELAYED` is dispatched by the **asker** (whoever queued the intent).
- `VETO_REQUIRED` is dispatched by `oracle.policyOwner(policyId)`.

If the policy owner is a multisig (or any address) that has no path to call into the agent's execution surface, `VETO_REQUIRED` calls revert at dispatch — the owner who is authorized to dispatch cannot actually reach the agent.

Note that `checkIntent` itself never silently passes a non-IMMEDIATE intent. `DELAYED` and `VETO_REQUIRED` both surface synchronously as `(ok = false, reason = REQUIRES_DELAY)` / `(ok = false, reason = REQUIRES_VETO)`, so a consumer cannot bypass the queue by ignoring the tier. The dispatcher mismatch only bites at the queue's dispatch step.

**Rules.**

- Prefer `DELAYED` over `VETO_REQUIRED` unless the dev confirms the `policyOwner` address can actually execute against the agent.
- Before publishing a `VETO_REQUIRED` selector, trace: can `oracle.policyOwner(policyId)` reach the agent's dispatch entrypoint? If not, the intent is undispatchable.
- In the POLICY.md YAML, `delaySeconds` MUST be `0` for both `IMMEDIATE` and `VETO_REQUIRED`; only `DELAYED` carries a nonzero delay. `compile` rejects `delaySeconds > 0` on `IMMEDIATE`/`VETO_REQUIRED` with a clear error — if you wrote `delaySeconds: 60` on an `IMMEDIATE` selector, you probably meant `DELAYED`.

### In-place policy updates: `policyId` is `(publisher, label)`, not content-addressed

**Symptom.** Users interacted with an agent under one set of rules; the rules silently changed without the `policyId` (or the agent's binding) changing.

**Cause.** A `policyId` is stable for the pair `(publisher wallet, label)` — it is **not** content-addressed. Re-running `pnpm ward push` with the **same wallet and same label** calls `updatePolicy` and overwrites the existing policy **under the same id**. Changing the label or the publisher wallet mints a new id. This is convenient for iteration, but it means whoever holds the policy-owner key can rewrite the rules in place at any time.

The agent side compounds this when it uses the late-binding pattern. In `examples/ward-counter`, `CounterAgent` holds `POLICY_ID` in a **mutable** storage slot (default `bytes32(0)` = ungated) that the owner can change with one transaction:

| Action | Call | Who |
|---|---|---|
| Bind / migrate policy | `setPolicyId(0xNEW)` | `owner` only |
| Emergency kill-switch (re-ungate) | `setPolicyId(bytes32(0))` | `owner` only |
| Hand off control | `transferOwnership(newOwner)` | current `owner` only |

Every binding change emits `PolicyBound(newPolicyId, oldPolicyId, by)`.

**Rules.**

- For production, own policies with a **multisig or timelock**, not a hot wallet. A compromised policy-owner key can rewrite rules under the same `policyId` with no warning.
- External observers should subscribe to the agent's `PolicyBound` event to detect rebinds and unbinds; the binding can change after users have already interacted with the agent.
- A `POLICY_ID` of `0x0` means the agent runs **ungated** — every gated call passes. Treat an unbind as a privileged, observable event, not a benign default.

### Ownership recovery: `transferPolicyOwnership`

**Symptom.** The publisher wallet is lost, migrated, or compromised, and you need the policy under a controllable owner without re-publishing.

**Cause / fix.** v0.9.0 adds `transferPolicyOwnership(bytes32 policyId, address newOwner)` on `WardOracle`. It is the recovery path — no re-publish, and the `policyId` is preserved.

```solidity
transferPolicyOwnership(bytes32 policyId, address newOwner)
```

**Rules.**

- Only the **current policy owner** can call `transferPolicyOwnership`; it reverts (`NotPolicyOwner`) for anyone else and reverts on the zero address (`ZeroAddress`).
- Transfer is a two-step handshake on v2: the new owner must `acceptPolicyOwnership(policyId)` (reverts `NotPendingOwner` if called by a non-pending account); the current owner can `cancelPolicyOwnershipTransfer(policyId)` while a transfer is pending (reverts `NoPendingTransfer` if none). Transferring to a contract that has no path to call `acceptPolicyOwnership` strands the policy — confirm the target can accept before transferring.

### Cap semantics: stored-not-enforced, zero-means-block, native-only

Three independent traps live in how POLICY.md caps map to on-chain behavior.

#### `maxSlippageBps` is stored, not enforced

`maxSlippageBps` is written to the policy but **`PolicyLib.validate` does not enforce it**. It is a hint for slippage-sensitive selectors — your agent must read it and apply it itself. Do not present `maxSlippageBps` as a protection the oracle enforces; treat it as adapter metadata. (The contract also accepts `maxSlippageBps > 10000` from direct callers, so the value is not even range-checked on-chain today.)

#### `dailySpendWeiCap: 0` and `valueCapPerCall: 0` BLOCK — they are not "unlimited"

This is the highest-trust trap. A cap of `0` is **not** "no limit". On chain, `PolicyLib` treats:

- `dailySpendWeiCap: "0"` → **zero native spend allowed per day** — any payable call is blocked.
- `valueCapPerCall: "0"` (or omitted, which defaults to `0`) → **zero native value allowed on that selector**.

The dashboard simulator historically displayed `0` as "no cap", which is the opposite of the contract's behavior — do not rely on a UI label here. If a selector moves native value, it needs a **positive** `valueCapPerCall`, and the day needs a **positive** `dailySpendWeiCap`. A `0` cap is correct only for selectors that move no value at all.

The canonical sample relies on exactly this: in `examples/ward-counter/policy.md`, `bump` moves no value, so `dailySpendWeiCap` is `"0"` and `valueCapPerCall` is `"0"` by design:

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

#### Metering is native-STT-only

Both `dailySpendWeiCap` and `valueCapPerCall` meter the **native token forwarded** (`intent.value`), denominated in **wei** — not STT, and not any ERC-20 the agent moves through calldata. The markdown shorthand `"1 ether"` normalizes to `10^18` wei; do not hand-write hex caps. An ERC-20 `transfer` carries `value = 0`, so it consumes **none** of the daily cap regardless of token amount. If you need to cap ERC-20 spend, the cap must live in your agent's logic, not in Ward's native metering.

**Rules.**

- Use a positive `valueCapPerCall` for any selector that forwards native value; reserve `0` for value-free selectors.
- Match `dailySpendWeiCap` to real native spend; only set it to `"0"` when the agent moves no native value (then pass `spentToday = 0` statelessly — adding a daily-spend tracker is dead gas, per the onboarding skill).
- Never assume Ward caps an ERC-20 transfer; native metering does not see token amounts in calldata.
- Treat `maxSlippageBps` as a value your agent reads, never as oracle-enforced.

### Entrypoint-policy: target the agent address with the agent's own selectors

**Symptom.** `checkIntent` / `checkSelector` returns `SELECTOR_NOT_ALLOWED` for a call you expected to pass, because the policy enumerates the wrong target/selectors.

**Cause.** In the entrypoint-policy model (the canonical shape), the policy's `target` is the **agent** address — the contract that inherits `WardAgentBase` — and `selectors` enumerates the **agent's own entrypoints**, *not* the downstream contract's selectors. From `examples/ward-counter/policy.md`:

> `target` is the **agent** address (the contract that inherits `WardAgentBase`), and `selectors` enumerates the agent's own entrypoints — NOT the downstream `Counter` selectors.

So the counter policy authorizes `bump(uint256)` — the agent's entrypoint — and points `target` at the agent, not at `Counter.bump`. The placeholder `0xdeadbeef...` in `policy.md` must be replaced with the `agent` field from `deployments/agent.json` after deploy, not with the counter address.

`reset()` is deliberately omitted from the policy so the e2e test exercises the deny path: a gated call to `reset()` reverts with `WardRejected("SELECTOR_NOT_ALLOWED")` — the typed revert is the deny-path proof.

**Rules.**

- Set the policy `target` to the **agent contract address** (the `WardAgentBase` subclass), and list the **agent's own function signatures** as `selectors` — get the canonical `name(type1,type2)` form (e.g. `bump(uint256)`).
- Do **not** list the downstream contract's selectors (e.g. `Counter.bump`) in an entrypoint policy; the gate runs at the agent's entrypoint, before the agent forwards the inner call.
- After deploying, replace any placeholder `target` in your POLICY.md with the real agent address before publishing, then re-verify the `policyId`.
- Omitting a selector from the policy is how you deny it. A denied selector reverts the agent's modifier-guarded entrypoint with `WardRejected("SELECTOR_NOT_ALLOWED")` — that revert is the expected deny-path proof, not a bug.

---

## Escape hatch

If this skill doesn't cover your case:

- **Source of truth:** `contracts/src/WardOracle.sol`, `WardQueue.sol`, `PolicyTypes.sol`, `PolicyLib.sol`
- **Worked reference:** `examples/ward-counter/src/CounterAgent.sol` (modifier-gated allow path + manual `oracle.checkSelector` deny path).
- **Security model:** full threat model + invariants in `SECURITY.md`.

---

## Provenance

- Ward contracts deployed on Somnia Shannon (chainId 50312), addresses verified on-chain — canonical addresses are listed in §1.
- Canonical sample: `examples/ward-counter/` (CounterAgent on WardAgentBase + the `wardGuarded` modifier).
- The `Intent` struct shape, integration template, CLI commands, and POLICY.md schema in this skill were validated against the canonical `examples/ward-counter` sample. If you suspect drift — e.g. `ward compile` errors that contradict this doc — read `contracts/src/PolicyTypes.sol` and `sdk/src/policy-compiler.ts` directly; those are the source of truth.
- Ward contracts are unaudited; integration patterns here mirror what runs on testnet.
