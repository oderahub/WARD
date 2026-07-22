// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "forge-std/Script.sol";
import "../src/SentryOracle.sol";
import "../src/PolicyTypes.sol";
import "./PolicyJson.sol";

/// @notice Minimal external view of the SentryAgentBase surface we touch.
///         Re-declared inline so the script doesn't carry the full SentryAgentBase
///         dependency just to look up two selectors.
interface ISentryAgent {
    function setPolicyId(bytes32 newPolicyId) external;
    function POLICY_ID() external view returns (bytes32);
    function owner() external view returns (address);
}

/// @notice One-shot operator script that collapses the existing two-step
///         `sentry push POLICY.md` + `cast send <agent> setPolicyId(bytes32)`
///         dance into a single broadcast block.
///
///         === Inputs (env) ===
///         POLICY_JSON_PATH  — path to a JSON produced by `sentry compile POLICY.md`.
///                             Required UNLESS POLICY_JSON is set. The path must
///                             sit inside foundry.toml's `fs_permissions` read
///                             whitelist (`./` relative to contracts/), so
///                             putting `policy.json` in the repo root and
///                             passing `../policy.json` is the standard recipe.
///         POLICY_JSON       — inline JSON string fallback when path-based
///                             reads are awkward (e.g. running from a sandbox
///                             that can't grant fs_permissions). When set,
///                             POLICY_JSON_PATH is ignored.
///         AGENT_ADDR        — deployed SentryAgentBase-derived agent to bind
///                             (required; must be owned by the broadcaster).
///         LABEL             — ASCII label (≤32 bytes); padded to bytes32
///                             (default: "default").
///         ORACLE_ADDR       — SentryOracle deployment (default:
///                             0x3C7bF90f243d670a01f512221d9546e09fEaCC9c, the
///                             v2 (modifier-compatible) Shannon testnet oracle
///                             from contracts/deployments/50312.json. v1
///                             (0x68d4B045…) stays live and can still be
///                             targeted by overriding ORACLE_ADDR — it lacks
///                             `checkSelector` and so cannot back the
///                             `sentryGuarded` modifier, but `checkIntent` is
///                             unchanged).
///         DEPLOYER_PK       — broadcaster's private key (required).
///
///         === Usage ===
///         1. `sentry compile examples/sentry-counter/policy.md > policy.json`
///         2. `POLICY_JSON_PATH=./policy.json AGENT_ADDR=0xMyAgent \
///             forge script contracts/script/PublishAndBind.s.sol \
///             --rpc-url $SENTRY_RPC --broadcast --legacy \
///             --gas-estimate-multiplier 2000 --private-key $DEPLOYER_PK`
///
///         The script signs two back-to-back txs in one broadcast block —
///         `publishPolicy` + `setPolicyId`. They can't be atomic on-chain
///         (different contracts, no shared dispatcher), but the operator
///         only signs once and the second tx auto-fires on success.
contract PublishAndBind is Script {
    /// @notice Live Shannon testnet v2 oracle from `contracts/deployments/50312.json`.
    ///         v2 carries `checkSelector` so it can back `sentryGuarded` modifier
    ///         policies as well as the original `checkIntent` flow. Override
    ///         ORACLE_ADDR to target the v1 oracle (0x68d4B045…) for legacy
    ///         `checkIntent`-only publishes against pre-v0.11.0 agents.
    address internal constant DEFAULT_ORACLE = 0x3C7bF90f243d670a01f512221d9546e09fEaCC9c;

    function run() external returns (bytes32 policyId) {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address oracleAddr = vm.envOr("ORACLE_ADDR", DEFAULT_ORACLE);
        address agentAddr = vm.envAddress("AGENT_ADDR");
        bytes32 label = _readLabel();
        PolicyInput memory input = _readPolicy();

        address broadcaster = vm.addr(pk);
        console2.log("Broadcaster:", broadcaster);
        console2.log("Oracle:     ", oracleAddr);
        console2.log("Agent:      ", agentAddr);

        SentryOracle oracle = SentryOracle(oracleAddr);
        ISentryAgent agent = ISentryAgent(agentAddr);

        // Verify the broadcaster owns the agent BEFORE broadcasting so the
        // operator sees a clean require-revert during simulation rather than
        // burning gas on a `NotOwner` revert in the second tx.
        address agentOwner = agent.owner();
        require(agentOwner == broadcaster, "PublishAndBind: broadcaster does not own AGENT_ADDR");

        vm.startBroadcast(pk);
        policyId = oracle.publishPolicy(label, input);
        agent.setPolicyId(policyId);
        vm.stopBroadcast();

        console2.log("policyId:   ");
        console2.logBytes32(policyId);
        console2.log("Bound on agent. Done.");
    }

    function _readLabel() private view returns (bytes32) {
        string memory raw = vm.envOr("LABEL", string("default"));
        bytes memory b = bytes(raw);
        require(b.length <= 32, "PublishAndBind: LABEL > 32 bytes");
        // Right-pad ASCII into bytes32 — same encoding the CLI uses
        // (`stringToHex(label, { size: 32 })`). Build byte-by-byte so we don't
        // rely on the memory layout of `string` past the declared length.
        bytes32 out;
        for (uint256 i = 0; i < b.length; i++) {
            out |= bytes32(uint256(uint8(b[i])) << (8 * (31 - i)));
        }
        return out;
    }

    function _readPolicy() private view returns (PolicyInput memory) {
        // Prefer inline JSON when present — it sidesteps the `fs_permissions`
        // dance that bites operators running outside contracts/. Fall back to
        // the file path, which is the documented happy path.
        string memory inline_ = vm.envOr("POLICY_JSON", string(""));
        if (bytes(inline_).length > 0) {
            return PolicyJson.decode(inline_);
        }
        string memory path = vm.envString("POLICY_JSON_PATH");
        return PolicyJson.decode(vm.readFile(path));
    }
}
