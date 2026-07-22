// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "forge-std/Test.sol";
import "../../src/PolicyTypes.sol";
import "../../src/PolicyLib.sol";

/// @notice Storage-owning harness for property fuzzing PolicyLib.validate.
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
}

/// @notice Property-fuzz tests for PolicyLib precedence and reason codes.
contract PolicyLibPropertiesTest is Test {
    PolicyHarness internal h;

    address internal constant TARGET_A = address(0xA000);
    address internal constant TARGET_B = address(0xB000);
    bytes4 internal constant SEL_OK = bytes4(keccak256("ok()"));
    bytes4 internal constant SEL_OTHER = bytes4(keccak256("other()"));

    uint64 internal constant FUTURE_EXPIRY = type(uint64).max;
    uint256 internal constant VALUE_CAP = 1 ether;
    uint256 internal constant DAILY_CAP = 10 ether;

    function setUp() public {
        h = new PolicyHarness();
        h.setExpiresAt(FUTURE_EXPIRY);
        h.setDailySpendWeiCap(DAILY_CAP);
        h.addTarget(TARGET_A);
        h.addSelector(TARGET_A, SEL_OK, VALUE_CAP, TIER_IMMEDIATE, 0);
    }

    // ---------- helpers ----------

    function _validIntent() internal pure returns (Intent memory) {
        return Intent({
            agentId: 1,
            requestId: 1,
            target: TARGET_A,
            selector: SEL_OK,
            data: abi.encodeWithSelector(SEL_OK),
            value: 0,
            promptHash: bytes32(0),
            taskClass: 0
        });
    }

    function _intentWith(address t, bytes4 s, bytes memory data, uint256 value) internal pure returns (Intent memory) {
        return Intent({
            agentId: 1,
            requestId: 1,
            target: t,
            selector: s,
            data: data,
            value: value,
            promptHash: bytes32(0),
            taskClass: 0
        });
    }

    // ---------- Property 1: PAUSED dominates ----------

    /// PAUSED always wins over any other invalid condition.
    function testProperty_paused_returns_PAUSED_regardless_of_other_fields(
        address t,
        bytes4 s,
        uint256 value,
        uint256 spent,
        bytes calldata data
    ) public {
        h.setPaused(true);
        Intent memory i = _intentWith(t, s, data, value);
        (bool ok, bytes32 reason) = h.validate(i, spent);
        assertFalse(ok, "paused must reject");
        assertEq(reason, bytes32("PAUSED"));
    }

    // ---------- Property 2: EXPIRED dominates when not paused ----------

    function testProperty_expired_returns_EXPIRED_when_not_paused(
        address t,
        bytes4 s,
        uint256 value,
        uint256 spent,
        bytes calldata data,
        uint64 nowSeed
    ) public {
        // Force current time strictly past expiry. expiresAt = 1, warp to >=2.
        uint64 warpTo = uint64(bound(uint256(nowSeed), 2, type(uint64).max));
        vm.warp(warpTo);
        h.setExpiresAt(warpTo - 1);
        // PAUSED is left false from setUp
        Intent memory i = _intentWith(t, s, data, value);
        (bool ok, bytes32 reason) = h.validate(i, spent);
        assertFalse(ok, "expired must reject");
        assertEq(reason, bytes32("EXPIRED"));
    }

    // ---------- Property 3: Precedence pairs ----------

    /// PAUSED > EXPIRED: if both true, PAUSED wins.
    function testProperty_precedence_PAUSED_over_EXPIRED(uint64 nowSeed) public {
        uint64 warpTo = uint64(bound(uint256(nowSeed), 2, type(uint64).max));
        vm.warp(warpTo);
        h.setExpiresAt(warpTo - 1); // expired
        h.setPaused(true);
        Intent memory i = _validIntent();
        (bool ok, bytes32 reason) = h.validate(i, 0);
        assertFalse(ok);
        assertEq(reason, bytes32("PAUSED"));
    }

    /// EXPIRED > BAD_CALLDATA: data too short AND expired → EXPIRED.
    function testProperty_precedence_EXPIRED_over_BAD_CALLDATA(uint64 nowSeed) public {
        uint64 warpTo = uint64(bound(uint256(nowSeed), 2, type(uint64).max));
        vm.warp(warpTo);
        h.setExpiresAt(warpTo - 1);
        // bad calldata: short
        Intent memory i = _intentWith(TARGET_A, SEL_OK, hex"aa", 0);
        (bool ok, bytes32 reason) = h.validate(i, 0);
        assertFalse(ok);
        assertEq(reason, bytes32("EXPIRED"));
    }

    /// BAD_CALLDATA > SELECTOR_MISMATCH: data too short. With short data the selector
    /// cannot be derived, so BAD_CALLDATA must win.
    function testProperty_precedence_BAD_CALLDATA_over_SELECTOR_MISMATCH() public view {
        // Selector field says SEL_OK but data is empty (would also mismatch).
        Intent memory i = _intentWith(TARGET_A, SEL_OK, hex"", 0);
        (bool ok, bytes32 reason) = h.validate(i, 0);
        assertFalse(ok);
        assertEq(reason, bytes32("BAD_CALLDATA"));
    }

    /// SELECTOR_MISMATCH > TARGET_NOT_ALLOWED: even when target unknown, selector mismatch fires first.
    function testProperty_precedence_SELECTOR_MISMATCH_over_TARGET_NOT_ALLOWED() public view {
        // data encodes SEL_OTHER but selector field says SEL_OK. Target is unknown TARGET_B.
        Intent memory i = _intentWith(TARGET_B, SEL_OK, abi.encodeWithSelector(SEL_OTHER), 0);
        (bool ok, bytes32 reason) = h.validate(i, 0);
        assertFalse(ok);
        assertEq(reason, bytes32("SELECTOR_MISMATCH"));
    }

    /// TARGET_NOT_ALLOWED > SELECTOR_NOT_ALLOWED: unknown target, even though selector would be unknown too.
    function testProperty_precedence_TARGET_NOT_ALLOWED_over_SELECTOR_NOT_ALLOWED() public view {
        Intent memory i = _intentWith(TARGET_B, SEL_OTHER, abi.encodeWithSelector(SEL_OTHER), 0);
        (bool ok, bytes32 reason) = h.validate(i, 0);
        assertFalse(ok);
        assertEq(reason, bytes32("TARGET_NOT_ALLOWED"));
    }

    /// SELECTOR_NOT_ALLOWED > VALUE_CAP: target ok, selector unknown, value would also breach a cap (if it existed).
    function testProperty_precedence_SELECTOR_NOT_ALLOWED_over_VALUE_CAP() public view {
        Intent memory i = _intentWith(TARGET_A, SEL_OTHER, abi.encodeWithSelector(SEL_OTHER), 100 ether);
        (bool ok, bytes32 reason) = h.validate(i, 0);
        assertFalse(ok);
        assertEq(reason, bytes32("SELECTOR_NOT_ALLOWED"));
    }

    /// VALUE_CAP > DAILY_CAP: per-call cap blown AND daily cap blown → VALUE_CAP first.
    function testProperty_precedence_VALUE_CAP_over_DAILY_CAP() public view {
        // value = VALUE_CAP + 1, spentToday = DAILY_CAP (also exceeds, but value-cap fires first)
        Intent memory i = _intentWith(TARGET_A, SEL_OK, abi.encodeWithSelector(SEL_OK), VALUE_CAP + 1);
        (bool ok, bytes32 reason) = h.validate(i, DAILY_CAP);
        assertFalse(ok);
        assertEq(reason, bytes32("VALUE_CAP"));
    }

    // ---------- Property 4: VALUE_CAP boundary ----------

    function testProperty_value_above_per_call_cap_returns_VALUE_CAP(uint256 over) public view {
        // Bound to anything strictly greater than cap but within sane range to avoid daily-cap interference
        over = bound(over, VALUE_CAP + 1, type(uint128).max);
        Intent memory i = _intentWith(TARGET_A, SEL_OK, abi.encodeWithSelector(SEL_OK), over);
        (bool ok, bytes32 reason) = h.validate(i, 0);
        assertFalse(ok);
        assertEq(reason, bytes32("VALUE_CAP"));
    }

    // ---------- Property 5: DAILY_CAP boundary fuzz ----------

    function testProperty_spentToday_plus_value_exceeds_dailyCap_returns_DAILY_CAP(uint256 spent, uint256 value)
        public
        view
    {
        // value must be in [0, VALUE_CAP] so we don't trip VALUE_CAP first.
        value = bound(value, 0, VALUE_CAP);
        // We want the sum to exceed DAILY_CAP. Bound spent so spent + value > DAILY_CAP.
        // Pick spent in [DAILY_CAP - value + 1, ...]; if value=0 then spent must be > DAILY_CAP.
        uint256 minSpent = (DAILY_CAP > value) ? (DAILY_CAP - value) + 1 : 1;
        spent = bound(spent, minSpent, type(uint128).max);
        Intent memory i = _intentWith(TARGET_A, SEL_OK, abi.encodeWithSelector(SEL_OK), value);
        (bool ok, bytes32 reason) = h.validate(i, spent);
        assertFalse(ok);
        assertEq(reason, bytes32("DAILY_CAP"));
    }

    /// Exact-equality at the daily cap boundary must be accepted (no off-by-one rejection).
    function testProperty_spent_plus_value_eq_dailyCap_accepted(uint256 value) public view {
        value = bound(value, 0, VALUE_CAP);
        uint256 spent = DAILY_CAP - value;
        Intent memory i = _intentWith(TARGET_A, SEL_OK, abi.encodeWithSelector(SEL_OK), value);
        (bool ok, bytes32 reason) = h.validate(i, spent);
        assertTrue(ok, "exact-equality at cap must be accepted");
        assertEq(reason, bytes32(0));
    }

    // ---------- Property 6: valid intent within bounds ----------

    function testProperty_valid_intent_within_all_bounds_accepted(uint256 value, uint256 spent) public view {
        value = bound(value, 0, VALUE_CAP);
        // Ensure spent + value <= dailyCap and spent <= dailyCap
        spent = bound(spent, 0, DAILY_CAP - value);
        Intent memory i = _intentWith(TARGET_A, SEL_OK, abi.encodeWithSelector(SEL_OK), value);
        (bool ok, bytes32 reason) = h.validate(i, spent);
        assertTrue(ok, "valid intent in bounds must accept");
        assertEq(reason, bytes32(0));
    }
}
