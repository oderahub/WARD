# Ward Counter e2e policy

Entrypoint-policy model: `target` is the **agent** address (the contract that
inherits `WardAgentBase`), and `selectors` enumerates the agent's own
entrypoints — NOT the downstream `Counter` selectors. `bump` is authorized;
`reset` is omitted so the e2e test verifies the deny path — a call to
`reset()` reverts with `WardRejected("SELECTOR_NOT_ALLOWED")`.

Replace the placeholder `target` address with the `agent` field from
`deployments/agent.json` after running `script/DeployAgent.s.sol`.

No value moves on either selector, so there is no `dailySpendWeiCap` and
`valueCapPerCall` is 0. Expires 6 months out.

Note on caller identity: this policy does NOT restrict `msg.sender` — Ward
policies have no visibility into the caller. The `CounterAgent` enforces a
separate operator allow-list at the Solidity layer (`onlyOperator` modifier
+ `isOperator` mapping, owner-managed). Read the two layers as orthogonal:
the policy says *what the agent can do*; the operator registry says *who
can ask it to act*.

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
