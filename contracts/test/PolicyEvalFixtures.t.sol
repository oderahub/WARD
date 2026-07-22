// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "forge-std/Test.sol";
import "../src/PolicyTypes.sol";
import "../src/SentryOracle.sol";

/// @notice Generates the parity-test fixture file consumed by the SDK's
///         `policy-eval.parity.test.ts`. Each case publishes a fresh policy
///         against a clean SentryOracle, calls `checkIntent` at a controlled
///         `block.timestamp`, captures `(ok, reason)`, and writes the full
///         tuple — policy + intent + spentToday + nowSec + expected result —
///         to `sdk/tests/fixtures/policy-eval-fixtures.json`.
///
///         CI gate: any change to PolicyLib or SentryOracle that shifts a
///         result for an existing fixture rewrites the JSON, and the SDK
///         parity test breaks until the TS port is updated to match. That
///         drift detector is the whole point of this file.
contract PolicyEvalFixturesTest is Test {
    SentryOracle internal oracle;

    address internal constant TARGET_A = address(0xA000);
    address internal constant TARGET_B = address(0xB000);
    address internal constant TARGET_C = address(0xC000);

    bytes4 internal constant SEL_PING = bytes4(keccak256("ping()"));
    bytes4 internal constant SEL_PONG = bytes4(keccak256("pong()"));
    bytes4 internal constant SEL_SWAP = bytes4(keccak256("swap(uint256,uint256)"));

    string internal constant OUT_PATH = "../sdk/tests/fixtures/policy-eval-fixtures.json";

    // Accumulated JSON entries; serialized on the final test that runs.
    string[] internal entries;

    function setUp() public {
        oracle = new SentryOracle();
    }

    // ------------------------------------------------------------------
    // Fixture builders
    // ------------------------------------------------------------------

    function _selRule(bytes4 sel, uint256 cap, uint8 tier_, uint32 delay)
        internal
        pure
        returns (SelectorRule memory)
    {
        return SelectorRule({selector: sel, valueCapPerCall: cap, tier: tier_, delaySeconds: delay});
    }

    function _intent(address target, bytes4 sel, uint256 value) internal pure returns (Intent memory) {
        return Intent({
            agentId: 1,
            requestId: 1,
            target: target,
            selector: sel,
            data: abi.encodeWithSelector(sel),
            value: value,
            promptHash: bytes32(0),
            taskClass: 0
        });
    }

    function _intentWithData(address target, bytes4 sel, uint256 value, bytes memory data)
        internal
        pure
        returns (Intent memory)
    {
        return Intent({
            agentId: 1,
            requestId: 1,
            target: target,
            selector: sel,
            data: data,
            value: value,
            promptHash: bytes32(0),
            taskClass: 0
        });
    }

    // Single-target single-selector helper.
    function _simplePolicy(
        address target,
        bytes4 sel,
        uint256 valueCap,
        uint256 dailyCap,
        uint8 tier_,
        uint32 delay,
        uint64 expiresAt,
        bool paused
    ) internal pure returns (PolicyInput memory) {
        TargetRule[] memory targets = new TargetRule[](1);
        SelectorRule[] memory sels = new SelectorRule[](1);
        sels[0] = _selRule(sel, valueCap, tier_, delay);
        targets[0] = TargetRule({target: target, selectors: sels});
        return PolicyInput({
            targets: targets,
            dailySpendWeiCap: dailyCap,
            maxSlippageBps: 0,
            expiresAt: expiresAt,
            paused: paused
        });
    }

    // ------------------------------------------------------------------
    // Execution + capture
    // ------------------------------------------------------------------

    /// @dev Publish a fresh policy under a unique label so successive cases
    ///      don't collide, then call checkIntent at `nowSec` and record JSON.
    function _runCase(
        string memory name,
        PolicyInput memory input,
        Intent memory intent,
        uint256 spentToday,
        uint64 nowSec
    ) internal {
        // Each case uses a per-name label so publishes don't collide across cases.
        bytes32 label = keccak256(bytes(name));
        address publisher = address(uint160(uint256(label)));
        vm.prank(publisher);
        bytes32 policyId = oracle.publishPolicy(label, input);

        vm.warp(nowSec);
        (bool ok, bytes32 reason) = oracle.checkIntent(policyId, intent, spentToday);

        entries.push(_serializeCase(name, input, intent, spentToday, nowSec, ok, reason));
    }

    // ------------------------------------------------------------------
    // JSON serialization (manual — vm.serializeXxx is keyed and clobbers
    // when reusing object ids inside an array, so we hand-build each entry)
    // ------------------------------------------------------------------

    function _serializeCase(
        string memory name,
        PolicyInput memory input,
        Intent memory intent,
        uint256 spentToday,
        uint64 nowSec,
        bool ok,
        bytes32 reason
    ) internal pure returns (string memory) {
        return string.concat(
            "{",
            "\"name\":\"",
            name,
            "\",",
            "\"policy\":",
            _serializePolicy(input),
            ",",
            "\"intent\":",
            _serializeIntent(intent),
            ",",
            "\"spentTodayWei\":\"",
            vm.toString(spentToday),
            "\",",
            "\"nowSec\":\"",
            vm.toString(uint256(nowSec)),
            "\",",
            "\"expected\":{\"ok\":",
            ok ? "true" : "false",
            ",\"reason\":\"",
            vm.toString(reason),
            "\"}",
            "}"
        );
    }

    function _serializePolicy(PolicyInput memory input) internal pure returns (string memory) {
        string memory targetsJson = "[";
        for (uint256 i; i < input.targets.length; ++i) {
            if (i > 0) targetsJson = string.concat(targetsJson, ",");
            targetsJson = string.concat(targetsJson, _serializeTarget(input.targets[i]));
        }
        targetsJson = string.concat(targetsJson, "]");
        return string.concat(
            "{",
            "\"targets\":",
            targetsJson,
            ",",
            "\"dailySpendWeiCap\":\"",
            vm.toString(input.dailySpendWeiCap),
            "\",",
            "\"maxSlippageBps\":",
            vm.toString(uint256(input.maxSlippageBps)),
            ",",
            "\"expiresAt\":\"",
            vm.toString(uint256(input.expiresAt)),
            "\",",
            "\"paused\":",
            input.paused ? "true" : "false",
            "}"
        );
    }

    function _serializeTarget(TargetRule memory t) internal pure returns (string memory) {
        string memory selsJson = "[";
        for (uint256 i; i < t.selectors.length; ++i) {
            if (i > 0) selsJson = string.concat(selsJson, ",");
            selsJson = string.concat(selsJson, _serializeSelector(t.selectors[i]));
        }
        selsJson = string.concat(selsJson, "]");
        return string.concat(
            "{\"target\":\"", vm.toString(t.target), "\",\"selectors\":", selsJson, "}"
        );
    }

    function _serializeSelector(SelectorRule memory s) internal pure returns (string memory) {
        return string.concat(
            "{",
            "\"selector\":\"",
            vm.toString(s.selector),
            "\",",
            "\"valueCapPerCall\":\"",
            vm.toString(s.valueCapPerCall),
            "\",",
            "\"tier\":",
            vm.toString(uint256(s.tier)),
            ",",
            "\"delaySeconds\":",
            vm.toString(uint256(s.delaySeconds)),
            "}"
        );
    }

    function _serializeIntent(Intent memory i) internal pure returns (string memory) {
        return string.concat(
            "{",
            "\"agentId\":\"",
            vm.toString(i.agentId),
            "\",",
            "\"requestId\":\"",
            vm.toString(i.requestId),
            "\",",
            "\"target\":\"",
            vm.toString(i.target),
            "\",",
            "\"selector\":\"",
            vm.toString(i.selector),
            "\",",
            "\"data\":\"",
            vm.toString(i.data),
            "\",",
            "\"value\":\"",
            vm.toString(i.value),
            "\",",
            "\"promptHash\":\"",
            vm.toString(i.promptHash),
            "\",",
            "\"taskClass\":",
            vm.toString(uint256(i.taskClass)),
            "}"
        );
    }

    // ------------------------------------------------------------------
    // The single test entrypoint: builds every fixture in a fixed order
    // and writes the JSON file. One test = one deterministic dump.
    // ------------------------------------------------------------------

    function test_generateFixtures() public {
        uint64 baseTime = 1_700_000_000;
        uint64 future = baseTime + 1 days;

        // ---------- happy paths ----------
        _runCase(
            "happy-path-immediate-zero-value",
            _simplePolicy(TARGET_A, SEL_PING, 1 ether, 10 ether, TIER_IMMEDIATE, 0, future, false),
            _intent(TARGET_A, SEL_PING, 0),
            0,
            baseTime
        );
        _runCase(
            "happy-path-immediate-under-value-cap",
            _simplePolicy(TARGET_A, SEL_PING, 1 ether, 10 ether, TIER_IMMEDIATE, 0, future, false),
            _intent(TARGET_A, SEL_PING, 0.5 ether),
            0,
            baseTime
        );
        _runCase(
            "happy-path-immediate-exactly-at-value-cap",
            _simplePolicy(TARGET_A, SEL_PING, 1 ether, 10 ether, TIER_IMMEDIATE, 0, future, false),
            _intent(TARGET_A, SEL_PING, 1 ether),
            0,
            baseTime
        );
        _runCase(
            "happy-path-spent-plus-value-equals-cap",
            _simplePolicy(TARGET_A, SEL_PING, 10 ether, 10 ether, TIER_IMMEDIATE, 0, future, false),
            _intent(TARGET_A, SEL_PING, 4 ether),
            6 ether,
            baseTime
        );
        _runCase(
            "happy-path-zero-cap-zero-value",
            _simplePolicy(TARGET_A, SEL_PING, 0, 0, TIER_IMMEDIATE, 0, future, false),
            _intent(TARGET_A, SEL_PING, 0),
            0,
            baseTime
        );
        _runCase(
            "happy-path-now-equals-expiresAt",
            _simplePolicy(TARGET_A, SEL_PING, 1 ether, 10 ether, TIER_IMMEDIATE, 0, baseTime, false),
            _intent(TARGET_A, SEL_PING, 0),
            0,
            baseTime
        );

        // ---------- PAUSED ----------
        _runCase(
            "paused-blocks-otherwise-valid-call",
            _simplePolicy(TARGET_A, SEL_PING, 1 ether, 10 ether, TIER_IMMEDIATE, 0, future, true),
            _intent(TARGET_A, SEL_PING, 0),
            0,
            baseTime
        );
        // paused takes precedence over expired
        _runCase(
            "paused-takes-precedence-over-expired",
            _simplePolicy(TARGET_A, SEL_PING, 1 ether, 10 ether, TIER_IMMEDIATE, 0, baseTime - 1, true),
            _intent(TARGET_A, SEL_PING, 0),
            0,
            baseTime
        );

        // ---------- EXPIRED ----------
        _runCase(
            "expired-now-strictly-greater-than-expiresAt",
            _simplePolicy(TARGET_A, SEL_PING, 1 ether, 10 ether, TIER_IMMEDIATE, 0, baseTime, false),
            _intent(TARGET_A, SEL_PING, 0),
            0,
            baseTime + 1
        );
        _runCase(
            "expired-far-past",
            _simplePolicy(TARGET_A, SEL_PING, 1 ether, 10 ether, TIER_IMMEDIATE, 0, baseTime - 1 days, false),
            _intent(TARGET_A, SEL_PING, 0),
            0,
            baseTime
        );

        // ---------- BAD_CALLDATA ----------
        _runCase(
            "bad-calldata-empty",
            _simplePolicy(TARGET_A, SEL_PING, 1 ether, 10 ether, TIER_IMMEDIATE, 0, future, false),
            _intentWithData(TARGET_A, SEL_PING, 0, hex""),
            0,
            baseTime
        );
        _runCase(
            "bad-calldata-three-bytes",
            _simplePolicy(TARGET_A, SEL_PING, 1 ether, 10 ether, TIER_IMMEDIATE, 0, future, false),
            _intentWithData(TARGET_A, SEL_PING, 0, hex"aabbcc"),
            0,
            baseTime
        );

        // ---------- SELECTOR_MISMATCH ----------
        _runCase(
            "selector-mismatch-field-vs-calldata",
            _simplePolicy(TARGET_A, SEL_PING, 1 ether, 10 ether, TIER_IMMEDIATE, 0, future, false),
            _intentWithData(TARGET_A, SEL_PING, 0, abi.encodeWithSelector(SEL_PONG)),
            0,
            baseTime
        );

        // ---------- TARGET_NOT_ALLOWED ----------
        _runCase(
            "target-not-allowed-unknown-target",
            _simplePolicy(TARGET_A, SEL_PING, 1 ether, 10 ether, TIER_IMMEDIATE, 0, future, false),
            _intent(TARGET_B, SEL_PING, 0),
            0,
            baseTime
        );

        // ---------- SELECTOR_NOT_ALLOWED ----------
        _runCase(
            "selector-not-allowed-known-target",
            _simplePolicy(TARGET_A, SEL_PING, 1 ether, 10 ether, TIER_IMMEDIATE, 0, future, false),
            _intent(TARGET_A, SEL_PONG, 0),
            0,
            baseTime
        );

        // ---------- VALUE_CAP ----------
        _runCase(
            "value-cap-one-wei-over",
            _simplePolicy(TARGET_A, SEL_PING, 1 ether, 10 ether, TIER_IMMEDIATE, 0, future, false),
            _intent(TARGET_A, SEL_PING, 1 ether + 1),
            0,
            baseTime
        );
        _runCase(
            "value-cap-zero-cap-positive-value-hits-value-cap-first",
            _simplePolicy(TARGET_A, SEL_PING, 0, 10 ether, TIER_IMMEDIATE, 0, future, false),
            _intent(TARGET_A, SEL_PING, 1),
            0,
            baseTime
        );

        // ---------- DAILY_CAP ----------
        _runCase(
            "daily-cap-spent-equals-cap-positive-value",
            _simplePolicy(TARGET_A, SEL_PING, 10 ether, 10 ether, TIER_IMMEDIATE, 0, future, false),
            _intent(TARGET_A, SEL_PING, 1),
            10 ether,
            baseTime
        );
        _runCase(
            "daily-cap-spent-exceeds-cap",
            _simplePolicy(TARGET_A, SEL_PING, 10 ether, 10 ether, TIER_IMMEDIATE, 0, future, false),
            _intent(TARGET_A, SEL_PING, 0),
            10 ether + 1,
            baseTime
        );
        _runCase(
            "daily-cap-value-pushes-over",
            _simplePolicy(TARGET_A, SEL_PING, 10 ether, 10 ether, TIER_IMMEDIATE, 0, future, false),
            _intent(TARGET_A, SEL_PING, 0.5 ether),
            9.6 ether,
            baseTime
        );
        _runCase(
            "daily-cap-zero-cap-zero-spent-positive-value",
            _simplePolicy(TARGET_A, SEL_PING, 1 ether, 0, TIER_IMMEDIATE, 0, future, false),
            _intent(TARGET_A, SEL_PING, 1),
            0,
            baseTime
        );

        // ---------- REQUIRES_DELAY ----------
        _runCase(
            "requires-delay-tier-delayed-otherwise-valid",
            _simplePolicy(TARGET_A, SEL_PING, 1 ether, 10 ether, TIER_DELAYED, 60, future, false),
            _intent(TARGET_A, SEL_PING, 0),
            0,
            baseTime
        );
        _runCase(
            "requires-delay-tier-delayed-with-value",
            _simplePolicy(TARGET_A, SEL_PING, 1 ether, 10 ether, TIER_DELAYED, 3600, future, false),
            _intent(TARGET_A, SEL_PING, 0.5 ether),
            0,
            baseTime
        );

        // ---------- REQUIRES_VETO ----------
        _runCase(
            "requires-veto-tier-veto-required",
            _simplePolicy(TARGET_A, SEL_PING, 1 ether, 10 ether, TIER_VETO_REQUIRED, 0, future, false),
            _intent(TARGET_A, SEL_PING, 0),
            0,
            baseTime
        );

        // ---------- precedence: VALUE_CAP before DAILY_CAP ----------
        _runCase(
            "precedence-value-cap-fires-before-daily-cap",
            _simplePolicy(TARGET_A, SEL_PING, 1 ether, 10 ether, TIER_IMMEDIATE, 0, future, false),
            _intent(TARGET_A, SEL_PING, 2 ether),
            9.5 ether,
            baseTime
        );

        // ---------- multi-target + multi-selector policies ----------
        {
            TargetRule[] memory targets = new TargetRule[](2);
            SelectorRule[] memory selsA = new SelectorRule[](2);
            selsA[0] = _selRule(SEL_PING, 1 ether, TIER_IMMEDIATE, 0);
            selsA[1] = _selRule(SEL_PONG, 2 ether, TIER_DELAYED, 30);
            targets[0] = TargetRule({target: TARGET_A, selectors: selsA});
            SelectorRule[] memory selsB = new SelectorRule[](1);
            selsB[0] = _selRule(SEL_SWAP, 5 ether, TIER_VETO_REQUIRED, 0);
            targets[1] = TargetRule({target: TARGET_B, selectors: selsB});
            PolicyInput memory multi = PolicyInput({
                targets: targets,
                dailySpendWeiCap: 100 ether,
                maxSlippageBps: 0,
                expiresAt: future,
                paused: false
            });
            _runCase(
                "multi-target-A-ping-immediate-allowed",
                multi,
                _intent(TARGET_A, SEL_PING, 0.1 ether),
                0,
                baseTime
            );
            _runCase(
                "multi-target-A-pong-requires-delay",
                multi,
                _intent(TARGET_A, SEL_PONG, 0.1 ether),
                0,
                baseTime
            );
            _runCase(
                "multi-target-B-swap-requires-veto",
                multi,
                _intent(TARGET_B, SEL_SWAP, 0),
                0,
                baseTime
            );
            _runCase(
                "multi-target-C-target-not-allowed",
                multi,
                _intent(TARGET_C, SEL_PING, 0),
                0,
                baseTime
            );
        }

        // ---------- one-wei boundaries ----------
        _runCase(
            "boundary-value-equals-cap-exactly",
            _simplePolicy(TARGET_A, SEL_PING, 1 ether, 10 ether, TIER_IMMEDIATE, 0, future, false),
            _intent(TARGET_A, SEL_PING, 1 ether),
            0,
            baseTime
        );
        _runCase(
            "boundary-daily-cap-spent-plus-value-exactly-equals-cap",
            _simplePolicy(TARGET_A, SEL_PING, 10 ether, 10 ether, TIER_IMMEDIATE, 0, future, false),
            _intent(TARGET_A, SEL_PING, 1 wei),
            10 ether - 1,
            baseTime
        );

        // ---------- write the file ----------
        string memory body = "[";
        for (uint256 i; i < entries.length; ++i) {
            if (i > 0) body = string.concat(body, ",\n  ");
            else body = string.concat(body, "\n  ");
            body = string.concat(body, entries[i]);
        }
        body = string.concat(body, "\n]\n");
        vm.writeFile(OUT_PATH, body);

        // sanity check
        assertGe(entries.length, 30, "must emit >= 30 fixtures");
    }
}
