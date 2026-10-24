// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Fixture} from "./Fixture.sol";
import {Addrs, Sys} from "../src/Base.sol";
import {NGOElection} from "../src/NGOElection.sol";
import {RoleElection} from "../src/RoleElection.sol";
import {Governor} from "../src/Governor.sol";
import {FundApprovals} from "../src/FundApprovals.sol";
import {NGORewards} from "../src/NGORewards.sol";

/// Elections, modes, roles, the Governor, NGO rewards and fund approvals.
contract GovernanceTest is Fixture {
    function test_modesBootstrapInterimNormal() public {
        assertEq(modeC.mode(), 0); // Bootstrap
        electFirst(10);
        assertEq(el.electedCount(), 10);
        assertEq(modeC.mode(), 2); // Interim: fewer than 60 after 3 months
        assertTrue(modeC.isInterimCouncil(el.electedList()[0]));
        assertFalse(modeC.finalityActive());
    }

    function test_normalModeWithSixtyNGOs() public {
        electFirst(60);
        assertEq(el.currentTerm(), 1);
        assertEq(el.electedCount(), 60);
        assertEq(modeC.mode(), 1);
        assertTrue(modeC.finalityActive());
    }

    function test_electionTopApprovalsAndSupplementaryRound() public {
        advanceAll();
        address[] memory ngos = attestedNGOs("n", 3);
        for (uint256 i; i < 3; ++i) {
            vm.prank(ngos[i]);
            el.stand(0);
        }
        address a = voter("a", 300 ether);
        address b = voter("b", 100 ether);
        address[] memory pick = new address[](1);
        pick[0] = ngos[0];
        vm.prank(a);
        el.vote(0, pick);
        vm.prank(a);
        vm.expectRevert(NGOElection.AlreadyVoted.selector);
        el.vote(0, pick);
        pick[0] = ngos[1];
        vm.prank(b);
        el.vote(0, pick);
        // the first election needs 5 distinct approvers (100 PSY locked each) per winning candidate
        address[] memory both = new address[](2);
        (both[0], both[1]) = ngos[0] < ngos[1] ? (ngos[0], ngos[1]) : (ngos[1], ngos[0]);
        for (uint256 i; i < 5; ++i) {
            address crowd = voter(string(abi.encodePacked("crowd", vm.toString(i))), 100 ether);
            vm.prank(crowd);
            el.vote(0, both);
        }
        address c = voter("c", 50 ether); // locked before supplementary round 1 opens (its snapshot)
        // a voter cannot unlock while the round is open
        vm.prank(a);
        vm.expectRevert();
        ve.unlock(1 ether);
        warpTo(G + 90 days);
        advanceAll();
        assertTrue(el.isElected(ngos[0]));
        assertTrue(el.isElected(ngos[1]));
        assertFalse(el.isElected(ngos[2])); // no approvals: not elected
        // supplementary round 1 of term 1 is open with 98 seats
        assertEq(el.roundCount(), 2);
        NGOElection.Round memory r = el.getRound(1);
        assertEq(r.term, 1);
        assertEq(r.slot, 1);
        assertEq(r.seats, 98);
        vm.prank(ngos[2]);
        el.stand(1);
        pick[0] = ngos[2];
        vm.prank(c);
        el.vote(1, pick);
        skipTime(30 days);
        advanceAll();
        assertTrue(el.isElected(ngos[2]));
        assertEq(el.electedCount(), 3);
    }

    function test_flashLockedPowerCannotVote() public {
        advanceAll();
        address ngo = attestedNGO("f");
        vm.prank(ngo);
        el.stand(0);
        address v = makeAddr("flash");
        vm.deal(v, 1_000 ether);
        address[] memory pick = new address[](1);
        pick[0] = ngo;
        vm.startPrank(v);
        ve.lock{value: 1_000 ether}();
        vm.expectRevert(NGOElection.NoVotingPower.selector);
        el.vote(0, pick);
        vm.stopPrank();
    }

    function test_rolesElectedByNGOsCannotVoteAndArePaidFromTreasury() public {
        address[] memory ngos = electFirst(60);
        vm.expectRevert(RoleElection.BadRole.selector);
        roles.open(9);
        uint256 id = roles.open(2); // Treasurer
        // an NGO cannot stand
        vm.deal(ngos[0], 1_000 ether);
        vm.prank(ngos[0]);
        vm.expectRevert(RoleElection.NotEligible.selector);
        roles.stand{value: 100 ether}(id);
        address alice = makeAddr("alice");
        vm.deal(alice, 1_000 ether);
        vm.prank(alice);
        roles.stand{value: 100 ether}(id);
        skipTime(14 days);
        for (uint256 i; i < 10; ++i) {
            vm.prank(ngos[i]);
            roles.vote(id, alice);
        }
        address notNgo = makeAddr("notNgo");
        vm.prank(notNgo);
        vm.expectRevert(RoleElection.NotAnElectedNGO.selector);
        roles.vote(id, alice);
        skipTime(14 days);
        advanceAll();
        assertTrue(roles.isRoleHolder(alice));
        // the role holder cannot vote or propose
        vm.prank(alice);
        ve.lock{value: 100 ether}();
        vm.roll(block.number + 1);
        vm.prank(alice);
        vm.expectRevert(Sys.RoleHolderCannotVote.selector);
        gov.propose(0, _one(address(att)), _zero(), _data(""), "x");
        // pay: 2,000 PSY per 30 days from the Treasury
        uint256 tBefore = address(treasury).balance;
        uint256 aBefore = alice.balance;
        skipTime(30 days);
        roles.claimPay(2);
        assertEq(alice.balance - aBefore, 2_000 ether);
        assertEq(tBefore - address(treasury).balance, 2_000 ether);
        // deposit refund
        vm.prank(alice);
        roles.withdrawDeposit(id);
    }

    function test_governorTreasurySpendWithFloorAndTimelock() public {
        electFirst(60);
        address p = voter("proposer", 1_000 ether);
        address w = voter("whale", 9_000 ether);
        uint256 id;
        // an Ordinary proposal cannot target the Treasury
        vm.prank(p);
        vm.expectRevert(abi.encodeWithSelector(Governor.TargetNotAllowed.selector, uint8(0), Addrs.TREASURY));
        gov.propose(0, _one(Addrs.TREASURY), _zero(), _data(_spend()), "x");
        vm.prank(p);
        id = gov.propose(1, _one(Addrs.TREASURY), _zero(), _data(_spend()), "pay the auditors");
        vm.roll(block.number + 1);
        vm.prank(w);
        gov.vote(id, 1);
        skipTime(5 days);
        gov.decide(id);
        vm.expectRevert();
        gov.execute(id);
        skipTime(48 hours);
        address auditor = makeAddr("auditor");
        gov.execute(id);
        assertEq(auditor.balance, 5_000 ether);
    }

    function test_governorFloorFailsWithoutEnoughYes() public {
        electFirst(60);
        address p = voter("proposer", 1_000 ether);
        voter("sleeper", 99_000 ether); // total 100,000 locked; 10 % floor = 10,000
        vm.prank(p);
        uint256 id = gov.propose(1, _one(Addrs.TREASURY), _zero(), _data(_spend()), "x");
        vm.roll(block.number + 1);
        vm.prank(p);
        gov.vote(id, 1); // 1,000 yes < 10,000 floor and 1 < 100 voters
        skipTime(5 days);
        assertFalse(gov.passes(id));
        gov.decide(id);
        assertEq(gov.getProposal(id).state, 1);
    }

    function test_governorUniqueVoterMinimumMeetsFloor() public {
        electFirst(60);
        voter("big", 1_000_000 ether);
        address p = voter("proposer", 10_000 ether); // 0.5 % threshold of ~1.01M = 5,050
        address[] memory smalls = new address[](50);
        // 250 PSY each: 12,500 PSY yes is just over 1 % of the locked PSY, the minimum yes weight of the voter path
        for (uint256 i; i < 50; ++i) smalls[i] = voter(string(abi.encodePacked("small", vm.toString(i))), 250 ether);
        address[] memory dust = new address[](50);
        for (uint256 i; i < 50; ++i) dust[i] = voter(string(abi.encodePacked("dust", vm.toString(i))), 1 ether);
        vm.startPrank(p);
        // (a target other than Attestation: attestation decisions need the 10 % / 100-voter tier, P1)
        uint256 id = gov.propose(0, _one(address(reg)), _zero(), _data(""), "ordinary");
        uint256 idDust = gov.propose(0, _one(address(reg)), _zero(), _data("x"), "ordinary, dust voters");
        vm.stopPrank();
        vm.roll(block.number + 1);
        for (uint256 i; i < 50; ++i) {
            vm.prank(smalls[i]);
            gov.vote(id, 1);
            vm.prank(dust[i]);
            gov.vote(idDust, 1);
        }
        // 50 yes voters with 250 PSY each (12,500 PSY): the 5 % floor (~51,000) is not met, the voter minimum (50) is
        assertTrue(gov.passes(id));
        // 50 dust voters (1 PSY each) no longer meet the voter minimum
        assertFalse(gov.passes(idDust));
    }

    /// proposals nobody votes on do not pull the participation baseline toward zero.
    function test_governorBaselineIgnoresEmptyProposals() public {
        electFirst(60);
        address big = voter("big", 1_000_000 ether);
        address p = voter("proposer", 10_000 ether);
        vm.prank(p);
        uint256 id = gov.propose(0, _one(address(reg)), _zero(), _data(""), "real");
        vm.roll(block.number + 1);
        vm.prank(big);
        gov.vote(id, 1);
        skipTime(5 days);
        gov.decide(id);
        uint256 b = gov.baseline();
        assertEq(b, 1_000_000 ether);
        for (uint256 i; i < 5; ++i) {
            vm.prank(p);
            uint256 spam = gov.propose(0, _one(address(reg)), _zero(), _data(bytes(vm.toString(i))), "spam");
            vm.roll(block.number + 1);
            skipTime(5 days);
            gov.decide(spam);
        }
        assertEq(gov.baseline(), b);
    }

    function test_fundProposalNeedsSixtyNGOs() public {
        electFirst(10);
        address p = voter("p", 1_000 ether);
        vm.prank(p);
        vm.expectRevert(Governor.ModeForbids.selector);
        gov.propose(3, _one(Addrs.FUND_APPROVALS), _zero(), _data(_fund()), "fund");
    }

    function test_fundApprovalRecordAndDigest() public {
        electFirst(60);
        vm.prank(Addrs.GOVERNOR);
        uint256 id = fa.approve(address(0), makeAddr("school"), 5 ether, 56, makeAddr("fund"));
        assertEq(fa.count(), 1);
        assertTrue(fa.digest(id) != bytes32(0));
        vm.expectRevert(Sys.OnlyGovernor.selector);
        fa.approve(address(0), makeAddr("school"), 5 ether, 56, makeAddr("fund"));
    }

    function test_ngoRewardsHeldUntilElectedThenShared() public {
        vm.deal(Addrs.NGO_REWARDS, 100 ether);
        vm.prank(Addrs.SYSTEM);
        rewards.notify(100 ether);
        assertEq(rewards.undistributed(), 100 ether);
        address[] memory ngos = electFirst(4);
        vm.deal(Addrs.NGO_REWARDS, 200 ether);
        vm.prank(Addrs.SYSTEM);
        rewards.notify(100 ether);
        // the 100 PSY held before the election is streamed over one term, not paid at once
        assertEq(rewards.claimable(1, ngos[0]), 25 ether);
        skipTime(365 days / 2); // half a term later half of the held 100 PSY has streamed in: 12.5 more each
        vm.prank(Addrs.SYSTEM);
        rewards.notify(0);
        assertEq(rewards.claimable(1, ngos[0]), 37.5 ether);
        uint256 b = ngos[0].balance;
        vm.prank(ngos[0]);
        rewards.claim(1);
        assertEq(ngos[0].balance - b, 37.5 ether);
        vm.prank(ngos[0]);
        vm.expectRevert(NGORewards.NothingToClaim.selector);
        rewards.claim(1);
    }

    // ---- helpers ----

    function _spend() private returns (bytes memory) {
        return abi.encodeWithSignature("spend(address,uint256,string)", makeAddr("auditor"), 5_000 ether, "audit");
    }

    function _fund() private returns (bytes memory) {
        return abi.encodeWithSignature(
            "approve(address,address,uint256,uint256,address)", address(0), makeAddr("school"), 1 ether, 56, address(9)
        );
    }

    function _one(address a) private pure returns (address[] memory x) {
        x = new address[](1);
        x[0] = a;
    }

    function _zero() private pure returns (uint256[] memory x) {
        x = new uint256[](1);
    }

    function _data(bytes memory d) private pure returns (bytes[] memory x) {
        x = new bytes[](1);
        x[0] = d;
    }
}
