// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Fixture} from "./Fixture.sol";
import {Attestation} from "../src/Attestation.sol";

/// Owner-approved safeguards of 11 October 2026 (RISK_REVIEW.md 3.8): P1 (attestation decisions by token vote need
/// the 10 % tier), P3 (five vouchers, five declared operators) and (b) distinct approvers in the first election.
contract SafeguardsTest is Fixture {
    function test_P1_attestationDecisionByTokenVoteNeedsTheHigherFloor() public {
        voter("big", 1_000_000 ether);
        address p = voter("proposer", 10_000 ether);
        address[] memory smalls = new address[](50);
        for (uint256 i; i < 50; ++i) smalls[i] = voter(string(abi.encodePacked("s", vm.toString(i))), 1 ether);
        address[] memory t = new address[](1);
        t[0] = address(att);
        uint256[] memory v = new uint256[](1);
        bytes[] memory d = new bytes[](1);
        d[0] = abi.encodeCall(Attestation.governorDecide, (makeAddr("someNgo"), false));
        vm.prank(p);
        uint256 id = gov.propose(0, t, v, d, "dismiss a challenge");
        assertTrue(gov.highFloor(id));
        (, uint256 floorWeight, uint256 minVoters) = gov.quorumOf(id);
        assertEq(floorWeight, gov.getProposal(id).totalPower / 10);
        assertEq(minVoters, 100);
        vm.roll(vm.getBlockNumber() + 1);
        for (uint256 i; i < 50; ++i) {
            vm.prank(smalls[i]);
            gov.vote(id, 1);
        }
        // 50 small yes voters meet the Ordinary minimum (50) but not the attestation-decision minimum (100)
        assertFalse(gov.passes(id));
    }

    /// The 100-voter path counts only voters whose ballot weighs at least 100 PSY (minCountedVoterLock).
    function test_P1_hundredVoterPathNeedsHundredPSYPerVoter() public {
        voter("big", 1_000_000 ether); // keeps the 10 % floor out of reach
        address p = voter("proposer", 10_000 ether);
        address[] memory dust = new address[](100);
        address[] memory real = new address[](100);
        for (uint256 i; i < 100; ++i) {
            dust[i] = voter(string(abi.encodePacked("dust", vm.toString(i))), 1 ether);
            real[i] = voter(string(abi.encodePacked("real", vm.toString(i))), 110 ether); // 11,000 PSY yes: over 1 %
        }
        address[] memory t = new address[](1);
        t[0] = address(att);
        uint256[] memory v = new uint256[](1);
        bytes[] memory d = new bytes[](1);
        d[0] = abi.encodeCall(Attestation.governorDecide, (makeAddr("someNgo"), true));
        vm.prank(p);
        uint256 a = gov.propose(0, t, v, d, "uphold with dust voters");
        vm.prank(p);
        uint256 b = gov.propose(0, t, v, d, "uphold with real voters");
        vm.roll(vm.getBlockNumber() + 1);
        for (uint256 i; i < 100; ++i) {
            vm.prank(dust[i]);
            gov.vote(a, 1);
            vm.prank(real[i]);
            gov.vote(b, 1);
        }
        assertEq(gov.getProposal(a).yesVoters, 100);
        assertEq(gov.lockedYesVoters(a), 0);
        assertFalse(gov.passes(a)); // 100 yes voters, but none with 100 PSY
        assertEq(gov.lockedYesVoters(b), 100);
        assertTrue(gov.passes(b)); // 11,000 PSY yes: far below the 10 % floor, but 100 counted voters and over 1 %
    }

    function test_P3_fiveVouchersMustDeclareFiveOperators() public {
        address ngo = newMiner("opNgo", 20);
        mintNGO(ngo);
        address v1 = newVoucher("opV1");
        address v2 = newVoucher("opV2");
        vm.deal(v1, 10_000 ether);
        vm.deal(v2, 10_000 ether);
        bytes32 farm = keccak256("one farm");
        vm.prank(v1);
        mr.declareOperator(farm);
        vm.prank(v2);
        mr.declareOperator(farm);
        vm.prank(v1);
        att.vouch{value: 1_000 ether}(ngo);
        vm.prank(v2);
        vm.expectRevert(abi.encodeWithSelector(Attestation.SameOperator.selector, v1));
        att.vouch{value: 1_000 ether}(ngo);
        // its own default operator (its address) is distinct
        vm.prank(v2);
        mr.declareOperator(bytes32(0));
        vm.prank(v2);
        att.vouch{value: 1_000 ether}(ngo);
        assertEq(att.vouchesOf(ngo).length, 2);
    }

    function test_b_firstElectionNeedsFiveDistinctApproversWithALock() public {
        advanceAll(); // round 0
        address[] memory ngos = attestedNGOs("fe", 3);
        for (uint256 i; i < 3; ++i) {
            vm.prank(ngos[i]);
            el.stand(0);
        }
        address[] memory s = sorted(ngos);
        address[] memory one = new address[](1);
        // s[0]: 5 counted voters; s[1]: 4 counted voters plus one large whale; s[2]: 5 voters below 100 PSY locked
        for (uint256 i; i < 5; ++i) {
            address a = voter(string(abi.encodePacked("ok", vm.toString(i))), 100 ether);
            one[0] = s[0];
            vm.prank(a);
            el.vote(0, one);
        }
        for (uint256 i; i < 4; ++i) {
            address a = voter(string(abi.encodePacked("four", vm.toString(i))), 100 ether);
            one[0] = s[1];
            vm.prank(a);
            el.vote(0, one);
        }
        address whale = voter("whale", 1_000_000 ether);
        vm.roll(vm.getBlockNumber() + el.LOCK_WINDOW());
        one[0] = s[1];
        vm.prank(whale);
        el.vote(0, one);
        for (uint256 i; i < 5; ++i) {
            address a = voter(string(abi.encodePacked("tiny", vm.toString(i))), 99 ether);
            one[0] = s[2];
            vm.prank(a);
            el.vote(0, one);
        }
        assertEq(el.approvers(0, s[0]), 5);
        assertEq(el.approvers(0, s[1]), 5); // the whale counts as one voter
        assertEq(el.approvers(0, s[2]), 0); // below 100 PSY locked: not counted
        assertGt(el.approvals(0, s[2]), 0); // ... although their weight is counted
        warpTo(G + 90 days);
        advanceAll();
        assertTrue(el.isElectedIn(1, s[0]));
        assertTrue(el.isElectedIn(1, s[1]));
        assertFalse(el.isElectedIn(1, s[2]));
    }

    function test_b_fourCountedApproversAreNotEnough() public {
        advanceAll();
        address ngo = attestedNGO("four");
        vm.prank(ngo);
        el.stand(0);
        address[] memory one = new address[](1);
        one[0] = ngo;
        for (uint256 i; i < 4; ++i) {
            address a = voter(string(abi.encodePacked("v", vm.toString(i))), 50_000 ether);
            vm.prank(a);
            el.vote(0, one);
        }
        warpTo(G + 90 days);
        advanceAll();
        assertFalse(el.isElectedIn(1, ngo)); // heavy weight, but only 4 distinct voters
    }
}
