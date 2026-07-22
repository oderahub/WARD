// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "forge-std/Vm.sol";
import "../src/PolicyTypes.sol";

/// @notice Decodes the canonical `ward compile POLICY.md` JSON output into a
///         `PolicyInput` suitable for `WardOracle.publishPolicy`. Kept in a
///         library (not inlined into the script) so the test suite can call it
///         directly without an `vm.startBroadcast` block. The JSON shape is the
///         one produced by `cli/src/cmd/policy.ts::serialize` — numeric scalars
///         (`valueCapPerCall`, `dailySpendWeiCap`, `expiresAt`) are decimal
///         strings, `selector` is a 4-byte hex literal (`0x12345678`).
library PolicyJson {
    /// @dev Single forge-std Vm handle, mirrors the `forge-std/Script.sol`
    ///      convention so the library compiles cleanly under via_ir + scripts.
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev Intermediate JSON-shape struct. Foundry's `parseJson` matches
    ///      struct fields to JSON keys ALPHABETICALLY by field name (regardless
    ///      of the JSON's key order), so these declarations are intentionally
    ///      ordered `delaySeconds < selector < tier < valueCapPerCall`.
    ///      `selector` is `bytes` (not `bytes4`) because foundry's JSON
    ///      decoder handles dynamic `bytes` for `0x…`-prefixed hex literals
    ///      cleanly; we narrow to `bytes4` after decoding.
    struct _RawSelector {
        uint32 delaySeconds;
        bytes selector;
        uint8 tier;
        string valueCapPerCall;
    }

    /// @dev Same alphabetical-fields rule — `selectors` precedes `target`.
    struct _RawTarget {
        _RawSelector[] selectors;
        address target;
    }

    function decode(string memory json) internal pure returns (PolicyInput memory input) {
        // Pull the whole `targets` array in one shot. `parseJson(json, key)`
        // returns abi-encoded bytes that decode straight into our raw struct
        // array — that handles the unknown-length nested-array problem
        // without iterating with indexed keys.
        bytes memory targetsAbi = vm.parseJson(json, ".targets");
        _RawTarget[] memory rawTargets = abi.decode(targetsAbi, (_RawTarget[]));

        input.targets = new TargetRule[](rawTargets.length);
        for (uint256 i = 0; i < rawTargets.length; i++) {
            _copyTarget(rawTargets[i], input.targets[i]);
        }

        input.dailySpendWeiCap = vm.parseUint(vm.parseJsonString(json, ".dailySpendWeiCap"));
        input.maxSlippageBps = uint16(vm.parseJsonUint(json, ".maxSlippageBps"));
        input.expiresAt = uint64(vm.parseUint(vm.parseJsonString(json, ".expiresAt")));
        input.paused = vm.parseJsonBool(json, ".paused");
    }

    /// @dev Splitting target copy into its own function keeps stack frames
    ///      small enough that via_ir doesn't blow the stack-depth limit on a
    ///      policy with many selectors per target.
    function _copyTarget(_RawTarget memory raw, TargetRule memory out) private pure {
        out.target = raw.target;
        out.selectors = new SelectorRule[](raw.selectors.length);
        for (uint256 j = 0; j < raw.selectors.length; j++) {
            out.selectors[j] = SelectorRule({
                selector: bytes4(raw.selectors[j].selector),
                valueCapPerCall: vm.parseUint(raw.selectors[j].valueCapPerCall),
                tier: raw.selectors[j].tier,
                delaySeconds: raw.selectors[j].delaySeconds
            });
        }
    }
}
