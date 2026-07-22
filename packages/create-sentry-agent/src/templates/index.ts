export type TemplateId = "greenfield" | "counter-fixture";

export const TEMPLATES: TemplateId[] = ["greenfield", "counter-fixture"];

export interface MaterializedFile {
  path: string;
  contents: string;
}

export interface TemplateContext {
  contractName: string;
  dirName: string;
}

export function renderTemplate(template: TemplateId, ctx: TemplateContext): MaterializedFile[] {
  if (template === "greenfield") return renderGreenfield(ctx);
  if (template === "counter-fixture") return renderCounterFixture(ctx);
  // Exhaustiveness: keep the switch honest as the union grows.
  const exhaustive: never = template;
  throw new Error(`unknown template: ${exhaustive as string}`);
}

function foundryToml(): string {
  return `[profile.default]
src = "src"
out = "out"
test = "test"
script = "script"
libs = ["lib"]
solc_version = "0.8.26"
evm_version = "shanghai"
optimizer = true
optimizer_runs = 200
via_ir = true

# Once you run \`forge install foundry-rs/forge-std\` and symlink in the
# Sentry sources (\`ln -s ../../contracts/src sentry-src\` from inside this
# directory if you cloned the monorepo, OR drop them in by hand if you're
# standalone), these remappings let you \`import "sentry-somnia/SentryOracle.sol"\`.
remappings = [
    "sentry-somnia/=sentry-src/",
    "forge-std/=lib/forge-std/src/",
]

fs_permissions = [{ access = "write", path = "deployments/"}]
`;
}

function gitignore(): string {
  return `out/
cache/
broadcast/
.env
node_modules/
`;
}

function renderGreenfield(ctx: TemplateContext): MaterializedFile[] {
  const { contractName } = ctx;
  const targetName = `${contractName}Target`;

  const agentSol = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "sentry-somnia/SentryOracle.sol";
import "sentry-somnia/integration/SentryAgentBase.sol";
import {${targetName}} from "./${targetName}.sol";

/// @notice A starter Sentry-gated agent. Derives from \`SentryAgentBase\`,
///         which gives you:
///           - immutable \`oracle\`
///           - mutable \`POLICY_ID\` storage slot (late-binding pattern)
///           - \`owner\` + \`onlyOwner\` + \`transferOwnership\`
///           - \`sentryGuarded\`  (modifier — checks the oracle + reserves spend)
///           - \`_sentryCheck\`   (lower-level: reverts if the oracle denies)
///           - \`_call\`          (forwards the call + tracks daily spend)
///
///         Single-outbound entrypoints read best with the modifier: declare
///         what you're about to do, then do it. When \`POLICY_ID\` is unset
///         (== bytes32(0)) the modifier is a no-op — the agent runs ungated,
///         which is the recommended way to ship to testnet before you've
///         authored a policy. Multi-outbound entrypoints should drop down to
///         \`_sentryCheck\` + the call directly.
contract ${contractName} is SentryAgentBase {
    address public immutable target;

    event Dispatched(uint256 indexed reqId, uint256 amount);

    constructor(SentryOracle _oracle, address _target, address _owner)
        SentryAgentBase(_oracle, _owner)
    {
        target = _target;
    }

    /// @notice Replace this with your agent's real entrypoint.
    ///         Pattern (entrypoint-policy model): the modifier checks the AGENT's
    ///         OWN selector against \`POLICY_ID\` — declare the selector + msg.value
    ///         on the modifier, then execute the downstream call in the body. The
    ///         policy lives at \`target = address(this)\` (this contract) and lists
    ///         the agent's entrypoints (e.g. \`tryDispatch(uint256,uint256)\`),
    ///         NOT the downstream target's selectors. This keeps the contract↔policy
    ///         boundary stable as the body's downstream calls evolve. For per-argument
    ///         constraints, drop down to \`_sentryCheck\` with the full calldata.
    function tryDispatch(uint256 reqId, uint256 amount)
        external
        sentryGuarded(this.tryDispatch.selector, 0)
    {
        ${targetName}(target).act(amount);
        emit Dispatched(reqId, amount);
    }
}
`;

  const targetSol = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The downstream target the agent dispatches to. Has no Sentry
///         awareness — replace with whatever you already had.
contract ${targetName} {
    uint256 public last;
    event Acted(uint256 amount);

    function act(uint256 amount) external {
        last = amount;
        emit Acted(amount);
    }
}
`;

  const deploySol = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {${contractName}} from "../src/${contractName}.sol";
import {${targetName}} from "../src/${targetName}.sol";
import {SentryOracle} from "sentry-somnia/SentryOracle.sol";

/// @notice Deploys the target and the agent in one go using the late-binding
///         pattern: POLICY_ID is OPTIONAL. If the env var is set & non-zero
///         the script binds it via \`setPolicyId\` in the same broadcast;
///         otherwise the agent ships ungated and you bind later with
///         \`script/Bind.s.sol\` (or a one-off \`cast send\`).
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        SentryOracle oracle = SentryOracle(vm.envAddress("SENTRY_ORACLE"));
        address deployer = vm.addr(pk);
        bytes32 policyId = vm.envOr("POLICY_ID", bytes32(0));

        vm.startBroadcast(pk);
        ${targetName} target = new ${targetName}();
        ${contractName} agent = new ${contractName}(oracle, address(target), deployer);
        if (policyId != bytes32(0)) {
            agent.setPolicyId(policyId);
        }
        vm.stopBroadcast();

        // Ensure the deployments/ directory exists before vm.writeFile — first
        // deploys against a fresh checkout otherwise fail on the missing dir.
        vm.createDir("deployments", true);

        string memory line = string.concat(
            '{"target":"', vm.toString(address(target)),
            '","agent":"',  vm.toString(address(agent)),
            '","policyId":"', vm.toString(policyId),
            '","owner":"', vm.toString(deployer),
            '"}'
        );
        vm.writeFile("deployments/agent.json", line);

        console2.log("${contractName} deployed at", address(agent));
        if (policyId == bytes32(0)) {
            console2.log("Agent is UNGATED. Bind with script/Bind.s.sol once your policy is published.");
        }
    }
}
`;

  const bindSol = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {${contractName}} from "../src/${contractName}.sol";

/// @notice Binds an existing deployed agent to a policy. Kept separate from
///         \`Deploy.s.sol\` so the late-binding pattern is a first-class flow:
///         deploy ungated → exercise on testnet → publish POLICY.md → bind.
///         Required env: AGENT, POLICY_ID, DEPLOYER_PK.
contract Bind is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address agentAddr = vm.envAddress("AGENT");
        bytes32 policyId = vm.envBytes32("POLICY_ID");
        require(policyId != bytes32(0), "Bind: POLICY_ID is required (use bytes32(0) only via cast to UNbind)");

        vm.startBroadcast(pk);
        ${contractName}(agentAddr).setPolicyId(policyId);
        vm.stopBroadcast();

        console2.log("Bound agent", agentAddr);
        console2.log("to policyId", vm.toString(policyId));
    }
}
`;

  const policyMd = `# ${ctx.contractName} starter policy

Entrypoint-policy model: the \`sentryGuarded\` modifier on the agent checks
its OWN selector against the oracle. That means this policy's \`target\` is
the AGENT address (the contract that inherits \`SentryAgentBase\`), and the
\`selectors\` list enumerates the agent's own entrypoints — NOT the
downstream \`${targetName}\` selectors. The agent's body is free to call
\`${targetName}.act(...)\` (or anything else) without needing per-target
policy entries; the boundary is the agent's public surface area.

Customize:

  - Replace the \`target\` placeholder address with the \`agent\` field from
    \`deployments/agent.json\` after running \`script/Deploy.s.sol\`.
  - Add more \`selectors\` entries as you add more public entrypoints. Match
    the full ABI signature (e.g. \`tryDispatch(uint256,uint256)\`), not the
    downstream target's selector.
  - Set \`dailySpendWeiCap\` to a real number once any selector accepts native
    value; the base contract enforces it via \`_sentrySpentToday()\`.
  - Bump \`expiresAt\` further out than 6 months if you trust the binding.

\`\`\`policy
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
\`\`\`
`;

  const readme = `# ${ctx.contractName}

Scaffolded by \`create-sentry-agent\`. Three steps to a live, policy-gated
agent on Somnia Shannon:

## 1. Build

\`\`\`bash
forge install foundry-rs/forge-std
# If you're inside the sentry-somnia monorepo:
ln -s ../../contracts/src sentry-src
# Otherwise, copy the Sentry sources into ./sentry-src/ by hand.

forge build
\`\`\`

## 2. Publish your policy

Edit [\`POLICY.md\`](./POLICY.md) — at minimum, replace the placeholder
\`target\` address with the **agent** address printed after
\`script/Deploy.s.sol\` runs (entrypoint-policy model: the policy targets
the agent itself, not the downstream contract).

\`\`\`bash
pnpm sentry push ./POLICY.md --label ${ctx.dirName}
# → prints your POLICY_ID; copy it.
\`\`\`

## 3. Deploy + bind

The late-binding flow (recommended for new agents):

\`\`\`bash
# Deploy ungated first — POLICY_ID env unset.
forge script script/Deploy.s.sol \\
  --rpc-url "$SOMNIA_TESTNET_RPC" \\
  --broadcast --legacy --gas-estimate-multiplier 2000

# Bind once you trust the policy.
export AGENT=$(jq -r '.agent' deployments/agent.json)
export POLICY_ID=0x...
forge script script/Bind.s.sol \\
  --rpc-url "$SOMNIA_TESTNET_RPC" \\
  --broadcast --legacy --gas-estimate-multiplier 2000
\`\`\`

The agent runs ungated while \`POLICY_ID == bytes32(0)\`. After binding,
every \`tryDispatch\` consults SentryOracle and reverts with the rejection
reason if the policy says no. \`setPolicyId(bytes32(0))\` is the
emergency kill-switch.
`;

  return [
    { path: "foundry.toml", contents: foundryToml() },
    { path: ".gitignore", contents: gitignore() },
    { path: `src/${contractName}.sol`, contents: agentSol },
    { path: `src/${targetName}.sol`, contents: targetSol },
    { path: "script/Deploy.s.sol", contents: deploySol },
    { path: "script/Bind.s.sol", contents: bindSol },
    { path: "POLICY.md", contents: policyMd },
    { path: "README.md", contents: readme },
  ];
}

function renderCounterFixture(ctx: TemplateContext): MaterializedFile[] {
  const { contractName } = ctx;
  const targetName = "Counter";

  const agentSol = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "sentry-somnia/SentryOracle.sol";
import "sentry-somnia/integration/SentryAgentBase.sol";
import {${targetName}} from "./${targetName}.sol";

/// @notice Counter-shaped Sentry agent stacking TWO orthogonal access-control
///         layers (entrypoint-policy model):
///
///           1. \`onlyOperator\` — plain Solidity caller allow-list. Sentry has
///              no visibility into \`msg.sender\`; caller ACLs live at the
///              Solidity layer. Owner-managed; operators are an OPERATIONAL
///              role and do NOT auto-rotate on \`transferOwnership\`.
///           2. \`sentryGuarded\` — the Sentry policy gate. Asks the oracle
///              whether the agent's own \`(address(this), selector, value)\` is
///              allowed under \`POLICY_ID\`. While \`POLICY_ID == 0x0\` this
///              layer short-circuits (ungated mode).
///
///         Modifier order is deliberate: \`onlyOperator sentryGuarded(...)\`.
///         Solidity executes modifiers left-to-right, so the caller check
///         runs FIRST — non-operators revert with \`NotOperator\` BEFORE the
///         agent makes the external oracle call, saving gas on doomed calls.
///
///         The shipped POLICY.md authorizes \`bump\` and omits \`reset\`, so
///         once bound the deny path reverts with
///         \`SentryRejected("SELECTOR_NOT_ALLOWED")\` from the Sentry layer; an
///         unauthorized caller (regardless of binding) reverts with
///         \`NotOperator\` from the Solidity layer. The two distinct revert
///         reasons are the proof each layer is doing exactly one job.
contract ${contractName} is SentryAgentBase {
    Counter public immutable counter;

    /// @notice Caller allow-list. Owner-managed; independent of \`owner\`.
    mapping(address => bool) public isOperator;

    event OperatorAdded(address indexed operator, address indexed by);
    event OperatorRemoved(address indexed operator, address indexed by);

    error NotOperator();

    modifier onlyOperator() {
        if (!isOperator[msg.sender]) revert NotOperator();
        _;
    }

    constructor(SentryOracle _oracle, Counter _counter, address _owner)
        SentryAgentBase(_oracle, _owner)
    {
        counter = _counter;
        // Bootstrap: deploy-time owner is the initial operator so the
        // deployer can bump immediately without a separate addOperator tx.
        isOperator[_owner] = true;
        emit OperatorAdded(_owner, address(0));
    }

    function addOperator(address op) external onlyOwner {
        if (!isOperator[op]) {
            isOperator[op] = true;
            emit OperatorAdded(op, msg.sender);
        }
    }

    function removeOperator(address op) external onlyOwner {
        if (isOperator[op]) {
            isOperator[op] = false;
            emit OperatorRemoved(op, msg.sender);
        }
    }

    function bump(uint256 by) external onlyOperator sentryGuarded(this.bump.selector, 0) {
        counter.bump(by);
    }

    function reset() external onlyOperator sentryGuarded(this.reset.selector, 0) {
        counter.reset();
    }
}
`;

  const targetSol = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal counter target — two selectors, no Sentry awareness.
contract ${targetName} {
    uint256 public value;
    event Bumped(uint256 by, uint256 newValue);
    event Reset();

    function bump(uint256 by) external {
        value += by;
        emit Bumped(by, value);
    }

    function reset() external {
        value = 0;
        emit Reset();
    }
}
`;

  const deploySol = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {${contractName}} from "../src/${contractName}.sol";
import {${targetName}} from "../src/${targetName}.sol";
import {SentryOracle} from "sentry-somnia/SentryOracle.sol";

contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        SentryOracle oracle = SentryOracle(vm.envAddress("SENTRY_ORACLE"));
        address deployer = vm.addr(pk);
        bytes32 policyId = vm.envOr("POLICY_ID", bytes32(0));

        vm.startBroadcast(pk);
        ${targetName} counter = new ${targetName}();
        ${contractName} agent = new ${contractName}(oracle, counter, deployer);
        if (policyId != bytes32(0)) {
            agent.setPolicyId(policyId);
        }
        vm.stopBroadcast();

        // Ensure the deployments/ directory exists before vm.writeFile — first
        // deploys against a fresh checkout otherwise fail on the missing dir.
        vm.createDir("deployments", true);

        string memory line = string.concat(
            '{"counter":"', vm.toString(address(counter)),
            '","agent":"',  vm.toString(address(agent)),
            '","policyId":"', vm.toString(policyId),
            '","owner":"', vm.toString(deployer),
            '"}'
        );
        vm.writeFile("deployments/agent.json", line);

        console2.log("${contractName} deployed at", address(agent));
        if (policyId == bytes32(0)) {
            console2.log("Agent is UNGATED. Bind with script/Bind.s.sol once your policy is published.");
        }
    }
}
`;

  const bindSol = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {${contractName}} from "../src/${contractName}.sol";

contract Bind is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address agentAddr = vm.envAddress("AGENT");
        bytes32 policyId = vm.envBytes32("POLICY_ID");
        require(policyId != bytes32(0), "Bind: POLICY_ID is required");

        vm.startBroadcast(pk);
        ${contractName}(agentAddr).setPolicyId(policyId);
        vm.stopBroadcast();

        console2.log("Bound agent", agentAddr);
        console2.log("to policyId", vm.toString(policyId));
    }
}
`;

  const policyMd = `# ${contractName} starter policy

Entrypoint-policy model: the \`target\` is the AGENT address (the contract
that inherits \`SentryAgentBase\`), and the \`selectors\` list enumerates the
agent's own entrypoints. \`bump\` is authorized; \`reset\` is omitted so the
deny path reverts with \`SentryRejected("SELECTOR_NOT_ALLOWED")\` — the
sentryGuarded modifier surfaces the oracle denial as the typed revert; no
in-contract catch-and-emit needed.

The agent also stacks a Solidity-layer \`onlyOperator\` caller allow-list on
top of this policy (see \`src/${contractName}.sol\`). The caller restriction
is independent of the Sentry policy — Sentry has no visibility into
\`msg.sender\`. Unauthorized callers revert with \`NotOperator\` before the
oracle is ever consulted.

Replace the \`target\` placeholder with the \`agent\` field from
\`deployments/agent.json\`.

\`\`\`policy
version: "0.1"
dailySpendWeiCap: "0"
expiresAt: "2026-12-31T23:59:59.000Z"
targets:
  - target: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    selectors:
      - selector: "bump(uint256)"
        valueCapPerCall: "0"
        tier: IMMEDIATE
        delaySeconds: 0
\`\`\`
`;

  const readme = `# ${contractName}

Counter-fixture variant scaffolded by \`create-sentry-agent\`. Same shape
as \`examples/sentry-counter\`: stacks two orthogonal access-control layers
on \`SentryAgentBase\`:

1. \`onlyOperator\` — plain Solidity caller allow-list. Owner-managed; the
   deployer is bootstrapped as the initial operator so you can call
   \`bump\` immediately after deploy. Use \`addOperator(addr)\` /
   \`removeOperator(addr)\` to manage the set.
2. \`sentryGuarded\` — the Sentry policy gate. Asks the oracle whether the
   call is allowed under \`POLICY_ID\`. Short-circuits while \`POLICY_ID\`
   is unbound (late-binding pattern + spend tracking inherited from
   \`SentryAgentBase\`).

Modifier order is \`onlyOperator sentryGuarded(...)\` so the cheap caller
check rejects non-operators BEFORE the oracle call, saving gas.

## 1. Build

\`\`\`bash
forge install foundry-rs/forge-std
ln -s ../../contracts/src sentry-src   # monorepo users only
forge build
\`\`\`

## 2. Publish your policy

Replace the placeholder \`target\` address in [\`POLICY.md\`](./POLICY.md)
with the **agent** address printed by \`script/Deploy.s.sol\`
(entrypoint-policy model: the policy targets the agent itself with the
agent's own entrypoint selectors, not the downstream \`Counter\`), then:

\`\`\`bash
pnpm sentry push ./POLICY.md --label ${ctx.dirName}
\`\`\`

## 3. Deploy + bind

\`\`\`bash
forge script script/Deploy.s.sol --rpc-url "$SOMNIA_TESTNET_RPC" \\
  --broadcast --legacy --gas-estimate-multiplier 2000

export AGENT=$(jq -r '.agent' deployments/agent.json)
export POLICY_ID=0x...
forge script script/Bind.s.sol --rpc-url "$SOMNIA_TESTNET_RPC" \\
  --broadcast --legacy --gas-estimate-multiplier 2000
\`\`\`
`;

  return [
    { path: "foundry.toml", contents: foundryToml() },
    { path: ".gitignore", contents: gitignore() },
    { path: `src/${contractName}.sol`, contents: agentSol },
    { path: `src/${targetName}.sol`, contents: targetSol },
    { path: "script/Deploy.s.sol", contents: deploySol },
    { path: "script/Bind.s.sol", contents: bindSol },
    { path: "POLICY.md", contents: policyMd },
    { path: "README.md", contents: readme },
  ];
}
