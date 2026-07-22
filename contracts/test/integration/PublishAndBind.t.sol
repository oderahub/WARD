// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "forge-std/Test.sol";
import "../../src/PolicyTypes.sol";
import "../../src/SentryOracle.sol";
import "../../src/integration/SentryAgentBase.sol";
import "../../script/PolicyJson.sol";
import "../mocks/MockTarget.sol";

/// @notice Test-only subclass — `SentryAgentBase` is abstract, so we need a
///         deployable concrete to exercise `setPolicyId` from the script path.
contract _BoundableAgent is SentryAgentBase {
    constructor(SentryOracle oracle_, address owner_) SentryAgentBase(oracle_, owner_) {}
}

contract PublishAndBindTest is Test {
    SentryOracle internal oracle;
    MockTarget internal target;
    _BoundableAgent internal agent;
    address internal broadcaster = address(0xCAFE);

    /// @dev `fs_permissions` in foundry.toml only allows writes under
    ///      `deployments/`. The fixture lands there with a tmp prefix and is
    ///      removed inline (foundry doesn't auto-call tearDown). Keeping the
    ///      path inside the existing whitelist avoids editing the toolchain
    ///      config from a test file.
    string internal constant FIXTURE_PATH = "deployments/tmp-publishandbind-policy.json";

    function setUp() public {
        oracle = new SentryOracle();
        target = new MockTarget();
        vm.prank(broadcaster);
        agent = new _BoundableAgent(oracle, broadcaster);
    }

    /// @notice Happy path: write the canonical CLI-shaped JSON to disk (mirrors
    ///         what `sentry compile > policy.json` produces), decode it via the
    ///         same library the script uses, then publish + bind in one
    ///         broadcast block. Asserts on-chain state matches what the
    ///         operator would see in production.
    /// @dev    foundry.toml's read-permission is `./`, which doesn't extend
    ///         into `deployments/`, so we write the fixture (allowed) and then
    ///         decode straight from the in-memory string we just serialized —
    ///         that's the same string `vm.readFile` would have returned, and
    ///         it keeps the test in the existing permission whitelist without
    ///         editing the toolchain config from a test file.
    function test_decodesCliJsonAndBindsPolicy() public {
        string memory json = _buildFixtureJson(address(target), MockTarget.ping.selector);
        vm.writeFile(FIXTURE_PATH, json);
        // Clean up immediately — foundry doesn't auto-call `tearDown`, so the
        // file would otherwise pollute deployments/ across runs. The write
        // itself is the part we want to prove works against fs_permissions.
        vm.removeFile(FIXTURE_PATH);

        PolicyInput memory input = PolicyJson.decode(json);

        // Sanity: the decoded struct matches what we wrote.
        assertEq(input.targets.length, 1, "one target decoded");
        assertEq(input.targets[0].target, address(target), "target address decoded");
        assertEq(input.targets[0].selectors.length, 1, "one selector decoded");
        assertEq(input.targets[0].selectors[0].selector, MockTarget.ping.selector, "selector decoded");
        assertEq(input.targets[0].selectors[0].valueCapPerCall, 1 ether, "valueCap decoded");
        assertEq(input.targets[0].selectors[0].tier, TIER_IMMEDIATE, "tier decoded");
        assertEq(input.targets[0].selectors[0].delaySeconds, 0, "delaySeconds decoded");
        assertEq(input.dailySpendWeiCap, 10 ether, "dailyCap decoded");
        assertEq(input.maxSlippageBps, 0, "slippage decoded");
        assertEq(input.expiresAt, uint64(block.timestamp + 30 days), "expiresAt decoded");
        assertEq(input.paused, false, "paused decoded");

        bytes32 label = bytes32("ci-label");

        // Simulate the script body: one broadcast block, two txs.
        vm.startBroadcast(broadcaster);
        bytes32 policyId = oracle.publishPolicy(label, input);
        agent.setPolicyId(policyId);
        vm.stopBroadcast();

        // Oracle registered the publisher correctly.
        assertEq(oracle.policyOwner(policyId), broadcaster, "broadcaster is policyOwner");
        assertEq(oracle.policyIdFor(broadcaster, label), policyId, "id matches policyIdFor");

        // Agent stored the bound policyId.
        assertEq(agent.POLICY_ID(), policyId, "agent POLICY_ID matches");
    }

    /// @notice Negative path: an agent owned by someone else cannot be bound
    ///         by the broadcaster. The script does a require() before the
    ///         broadcast, but the underlying revert from `setPolicyId` is what
    ///         we pin here — that's the on-chain truth the script's pre-check
    ///         is mirroring, and it must fire even if the operator skips the
    ///         pre-check in their own variant.
    function test_setPolicyIdRevertsWhenBroadcasterIsNotOwner() public {
        address otherOwner = address(0xBEEF);
        vm.prank(otherOwner);
        _BoundableAgent foreignAgent = new _BoundableAgent(oracle, otherOwner);

        // Publish as broadcaster — this part succeeds (anyone can publish).
        PolicyInput memory input = _buildInlinePolicy(address(target), MockTarget.ping.selector);
        vm.prank(broadcaster);
        bytes32 policyId = oracle.publishPolicy(bytes32("ci-label"), input);

        // But binding to an agent the broadcaster doesn't own reverts.
        vm.prank(broadcaster);
        vm.expectRevert(SentryAgentBase.NotOwner.selector);
        foreignAgent.setPolicyId(policyId);
    }

    /// @notice Confirms PolicyJson handles a realistic multi-target / multi-selector
    ///         shape — single-row coverage isn't enough for the nested-array
    ///         decoder because Foundry's `parseJson` ABI-decode path has had
    ///         historical edge cases on heterogeneous inner arrays.
    function test_decodesMultiTargetMultiSelectorPolicy() public {
        string memory json = _buildMultiFixtureJson();

        PolicyInput memory input = PolicyJson.decode(json);

        assertEq(input.targets.length, 2, "two targets decoded");
        assertEq(input.targets[0].target, address(0xAAAA), "target 0 address");
        assertEq(input.targets[1].target, address(0xBBBB), "target 1 address");
        assertEq(input.targets[0].selectors.length, 2, "two selectors on target 0");
        assertEq(input.targets[1].selectors.length, 1, "one selector on target 1");
        assertEq(input.targets[0].selectors[0].selector, MockTarget.ping.selector, "t0/s0 selector");
        assertEq(input.targets[0].selectors[1].selector, MockTarget.pong.selector, "t0/s1 selector");
        assertEq(input.targets[0].selectors[1].tier, TIER_DELAYED, "t0/s1 tier preserved");
        assertEq(input.targets[0].selectors[1].delaySeconds, 60, "t0/s1 delaySeconds preserved");
        assertEq(input.targets[1].selectors[0].selector, MockTarget.ping.selector, "t1/s0 selector");
        assertEq(input.targets[1].selectors[0].valueCapPerCall, 5 ether, "t1/s0 valueCap");
    }

    /// @notice Build the exact JSON shape `cli/src/cmd/policy.ts::serialize`
    ///         produces. Numeric scalars are decimal strings; `selector` is a
    ///         4-byte hex literal; bools are unquoted.
    function _buildFixtureJson(address tgt, bytes4 selector) private view returns (string memory) {
        return string.concat(
            "{",
            '"targets":[{',
            '"target":"', vm.toString(tgt), '",',
            '"selectors":[{',
            '"selector":"', vm.toString(abi.encodePacked(selector)), '",',
            '"valueCapPerCall":"1000000000000000000",',
            '"tier":0,',
            '"delaySeconds":0',
            "}]",
            "}],",
            '"dailySpendWeiCap":"10000000000000000000",',
            '"maxSlippageBps":0,',
            '"expiresAt":"', vm.toString(block.timestamp + 30 days), '",',
            '"paused":false',
            "}"
        );
    }

    function _buildMultiFixtureJson() private view returns (string memory) {
        // Two targets: one with two selectors (IMMEDIATE ping + DELAYED pong),
        // one with a single IMMEDIATE selector that has a non-zero value cap.
        return string.concat(
            "{",
            '"targets":[',
            "{",
            '"target":"', vm.toString(address(0xAAAA)), '",',
            '"selectors":[',
            "{",
            '"selector":"', vm.toString(abi.encodePacked(MockTarget.ping.selector)), '",',
            '"valueCapPerCall":"0","tier":0,"delaySeconds":0',
            "},{",
            '"selector":"', vm.toString(abi.encodePacked(MockTarget.pong.selector)), '",',
            '"valueCapPerCall":"0","tier":1,"delaySeconds":60',
            "}",
            "]",
            "},{",
            '"target":"', vm.toString(address(0xBBBB)), '",',
            '"selectors":[',
            "{",
            '"selector":"', vm.toString(abi.encodePacked(MockTarget.ping.selector)), '",',
            '"valueCapPerCall":"5000000000000000000","tier":0,"delaySeconds":0',
            "}",
            "]",
            "}",
            "],",
            '"dailySpendWeiCap":"100000000000000000000",',
            '"maxSlippageBps":50,',
            '"expiresAt":"', vm.toString(block.timestamp + 30 days), '",',
            '"paused":false',
            "}"
        );
    }

    function _buildInlinePolicy(address tgt, bytes4 selector) private view returns (PolicyInput memory input) {
        input.targets = new TargetRule[](1);
        input.targets[0].target = tgt;
        input.targets[0].selectors = new SelectorRule[](1);
        input.targets[0].selectors[0] = SelectorRule({
            selector: selector,
            valueCapPerCall: 1 ether,
            tier: TIER_IMMEDIATE,
            delaySeconds: 0
        });
        input.dailySpendWeiCap = 10 ether;
        input.maxSlippageBps = 0;
        input.expiresAt = uint64(block.timestamp + 30 days);
        input.paused = false;
    }
}
