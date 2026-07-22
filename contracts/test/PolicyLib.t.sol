// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "forge-std/Test.sol";
import "../src/PolicyTypes.sol";
import "../src/PolicyLib.sol";

/// @notice Test harness that owns a Policy in storage so the storage-only PolicyLib can read it.
contract PolicyHarness {
    Policy internal policy;

    function setPaused(bool v) external {
        policy.paused = v;
    }

    function setExpiresAt(uint64 v) external {
        policy.expiresAt = v;
    }

    function setDailySpendWeiCap(uint256 v) external {
        policy.dailySpendWeiCap = v;
    }

    function setMaxSlippageBps(uint16 v) external {
        policy.maxSlippageBps = v;
    }

    function addTarget(address t) external {
        if (policy.isTargetAllowed[t]) return;
        policy.isTargetAllowed[t] = true;
        policy.targets.push(t);
    }

    function addSelector(address t, bytes4 s, uint256 cap, uint8 tier_, uint32 delay) external {
        if (!policy.isSelectorAllowed[t][s]) {
            policy.isSelectorAllowed[t][s] = true;
            policy.selectors[t].push(s);
        }
        policy.valueCapPerCall[t][s] = cap;
        policy.tier[t][s] = tier_;
        policy.delaySeconds[t][s] = delay;
    }

    function validate(Intent memory i, uint256 spentToday) external view returns (bool, bytes32) {
        return PolicyLib.validate(policy, i, spentToday);
    }

    function tierOf(address t, bytes4 s) external view returns (uint8) {
        return PolicyLib.tierOf(policy, t, s);
    }

    function delayFor(address t, bytes4 s) external view returns (uint32) {
        return PolicyLib.delayFor(policy, t, s);
    }
}

contract PolicyLibTest is Test {
    PolicyHarness internal h;

    address internal constant TARGET_A = address(0xA000);
    address internal constant TARGET_B = address(0xB000);
    bytes4 internal constant SEL_PING = bytes4(keccak256("ping()"));
    bytes4 internal constant SEL_PONG = bytes4(keccak256("pong()"));

    function setUp() public {
        h = new PolicyHarness();
        h.setExpiresAt(uint64(block.timestamp + 1 days));
        h.setDailySpendWeiCap(10 ether);
        h.addTarget(TARGET_A);
        h.addSelector(TARGET_A, SEL_PING, 1 ether, TIER_IMMEDIATE, 0);
    }

    function _intent(address t, bytes4 s, uint256 v) internal pure returns (Intent memory) {
        return Intent({
            agentId: 13174292974160097713,
            requestId: 1,
            target: t,
            selector: s,
            data: abi.encodeWithSelector(s),
            value: v,
            promptHash: keccak256("prompt"),
            taskClass: 0
        });
    }

    // 1. happy path
    function test_accepts_allowlisted_target_selector_within_caps() public view {
        Intent memory i = _intent(TARGET_A, SEL_PING, 0);
        (bool ok, bytes32 reason) = h.validate(i, 0);
        assertTrue(ok, "should accept");
        assertEq(reason, bytes32(0), "no reason");
    }

    // 2. paused
    function test_rejects_paused() public {
        h.setPaused(true);
        Intent memory i = _intent(TARGET_A, SEL_PING, 0);
        (bool ok, bytes32 reason) = h.validate(i, 0);
        assertFalse(ok);
        assertEq(reason, bytes32("PAUSED"));
    }

    // 3. expired
    function test_rejects_expired() public {
        h.setExpiresAt(uint64(block.timestamp - 1));
        Intent memory i = _intent(TARGET_A, SEL_PING, 0);
        (bool ok, bytes32 reason) = h.validate(i, 0);
        assertFalse(ok);
        assertEq(reason, bytes32("EXPIRED"));
    }

    // 4. target not allowed
    function test_rejects_target_not_allowed() public view {
        Intent memory i = _intent(TARGET_B, SEL_PING, 0);
        (bool ok, bytes32 reason) = h.validate(i, 0);
        assertFalse(ok);
        assertEq(reason, bytes32("TARGET_NOT_ALLOWED"));
    }

    // 5. selector not allowed (target ok)
    function test_rejects_selector_not_allowed() public view {
        Intent memory i = _intent(TARGET_A, SEL_PONG, 0);
        (bool ok, bytes32 reason) = h.validate(i, 0);
        assertFalse(ok);
        assertEq(reason, bytes32("SELECTOR_NOT_ALLOWED"));
    }

    // 6. value cap
    function test_rejects_value_cap() public view {
        Intent memory i = _intent(TARGET_A, SEL_PING, 1 ether + 1);
        (bool ok, bytes32 reason) = h.validate(i, 0);
        assertFalse(ok);
        assertEq(reason, bytes32("VALUE_CAP"));
    }

    // 7. daily cap (spent today + value would exceed)
    function test_rejects_daily_cap_when_spent_today_plus_value_exceeds_cap() public view {
        Intent memory i = _intent(TARGET_A, SEL_PING, 0.5 ether);
        // dailySpendWeiCap = 10 ether; spentToday = 9.6 ether; this call wants 0.5 ether → 10.1 > 10
        (bool ok, bytes32 reason) = h.validate(i, 9.6 ether);
        assertFalse(ok);
        assertEq(reason, bytes32("DAILY_CAP"));
    }

    // 8. zero value with zero caps accepted
    function test_zero_value_passes_when_caps_zero() public {
        // configure a new selector with valueCap=0
        h.addSelector(TARGET_A, bytes4(keccak256("noop()")), 0, TIER_IMMEDIATE, 0);
        Intent memory i = _intent(TARGET_A, bytes4(keccak256("noop()")), 0);
        (bool ok,) = h.validate(i, 0);
        assertTrue(ok);
    }

    // 9. tier lookup
    function test_tier_lookup_returns_configured_tier() public {
        h.addSelector(TARGET_A, SEL_PONG, 5 ether, TIER_VETO_REQUIRED, 60);
        assertEq(h.tierOf(TARGET_A, SEL_PONG), TIER_VETO_REQUIRED);
    }

    // 10. delay lookup
    function test_delay_lookup_returns_configured_delay() public {
        h.addSelector(TARGET_A, SEL_PONG, 5 ether, TIER_DELAYED, 30);
        assertEq(h.delayFor(TARGET_A, SEL_PONG), 30);
    }

    // 11. short calldata
    function test_rejects_short_calldata() public view {
        Intent memory i = Intent({
            agentId: 1,
            requestId: 1,
            target: TARGET_A,
            selector: SEL_PING,
            data: hex"aa",
            value: 0,
            promptHash: bytes32(0),
            taskClass: 0
        });
        (bool ok, bytes32 reason) = h.validate(i, 0);
        assertFalse(ok);
        assertEq(reason, bytes32("BAD_CALLDATA"));
    }

    // 12. selector field mismatches calldata's first 4 bytes
    function test_rejects_selector_mismatch_between_field_and_calldata() public view {
        Intent memory i = Intent({
            agentId: 1,
            requestId: 1,
            target: TARGET_A,
            selector: SEL_PING,
            data: abi.encodeWithSelector(SEL_PONG), // calldata for PONG, but field says PING
            value: 0,
            promptHash: bytes32(0),
            taskClass: 0
        });
        (bool ok, bytes32 reason) = h.validate(i, 0);
        assertFalse(ok);
        assertEq(reason, bytes32("SELECTOR_MISMATCH"));
    }

    // 13. per-selector value cap isolation
    function test_selector_specific_caps_do_not_bleed_between_selectors() public {
        // SEL_PING cap = 1 ether (from setUp); add SEL_PONG with 5 ether cap
        h.addSelector(TARGET_A, SEL_PONG, 5 ether, TIER_IMMEDIATE, 0);

        // 3 ether is > SEL_PING cap (1 ether) but < SEL_PONG cap (5 ether)
        Intent memory iPong = _intent(TARGET_A, SEL_PONG, 3 ether);
        (bool okPong,) = h.validate(iPong, 0);
        assertTrue(okPong, "pong with 3 ether should pass its 5 ether cap");

        Intent memory iPing = _intent(TARGET_A, SEL_PING, 3 ether);
        (bool okPing, bytes32 reason) = h.validate(iPing, 0);
        assertFalse(okPing, "ping with 3 ether should fail its 1 ether cap");
        assertEq(reason, bytes32("VALUE_CAP"));
    }
}
