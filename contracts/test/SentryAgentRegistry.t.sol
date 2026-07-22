// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "forge-std/Test.sol";
import "../src/SentryAgentRegistry.sol";

contract OwnableStub {
    address public owner;
    constructor(address o) { owner = o; }
}

contract SentryAgentRegistryTest is Test {
    SentryAgentRegistry reg;
    address squatter = address(0x5);
    address realOwner = address(0x6);

    function setUp() public { reg = new SentryAgentRegistry(); }

    function _register(address agent, address who) internal {
        vm.prank(who);
        reg.register(agent, address(0), bytes32(0), "name", "uri", new string[](0));
    }

    function test_thirdParty_register_isUnverified() public {
        address agent = address(new OwnableStub(realOwner));
        _register(agent, squatter);
        assertEq(reg.getAgent(agent).registrar, squatter);
        assertFalse(reg.agentVerified(agent));
    }

    function test_owner_canClaim_reclaimsRegistrar_andVerifies() public {
        address agent = address(new OwnableStub(realOwner));
        _register(agent, squatter);
        vm.prank(realOwner);
        reg.claimAgent(agent);
        assertEq(reg.getAgent(agent).registrar, realOwner, "registrar reclaimed");
        assertTrue(reg.agentVerified(agent));
    }

    function test_agent_itself_canClaim() public {
        address agent = address(new OwnableStub(realOwner));
        _register(agent, squatter);
        vm.prank(agent);
        reg.claimAgent(agent);
        assertEq(reg.getAgent(agent).registrar, agent);
        assertTrue(reg.agentVerified(agent));
    }

    function test_claim_rejects_non_controller() public {
        address agent = address(new OwnableStub(realOwner));
        _register(agent, squatter);
        vm.prank(squatter);
        vm.expectRevert(SentryAgentRegistry.NotAgentController.selector);
        reg.claimAgent(agent);
    }

    function test_claim_reverts_for_unregistered_agent() public {
        vm.prank(realOwner);
        vm.expectRevert(SentryAgentRegistry.InvalidAgent.selector);
        reg.claimAgent(address(0x999));
    }
}
