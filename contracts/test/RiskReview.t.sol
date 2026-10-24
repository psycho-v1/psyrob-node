// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Fixture} from "./Fixture.sol";
import {Addrs, Sys} from "../src/Base.sol";
import {NGOElection} from "../src/NGOElection.sol";
import {Governor} from "../src/Governor.sol";
import {Params} from "../src/Params.sol";
import {Attestation} from "../src/Attestation.sol";
import {NGORewards} from "../src/NGORewards.sol";

/// Fixes from the Part 3 risk review (docs/RISK_REVIEW.md): snapshot ballots, bounded parameter changes, the
/// voucher cap and the removal procedure for elected NGOs.
contract RiskReviewTest is Fixture {
    bytes32 constant FEE = "ngoMintFee";

    // ---- snapshot ballots (Governor) ----

    function test_governorBallotIgnoresPSYLockedAfterTheProposal() public {
        address p = voter("proposer", 1_000 ether);
        address late = makeAddr("late");
        vm.prank(p);
        uint256 id = gov.propose(0, _one(address(att)), _zero(), _data(""), "x");
        vm.roll(block.number + 1);
        vm.deal(late, 1_000_000 ether);
        vm.prank(late);
        ve.lock{value: 1_000_000 ether}(); // bought or borrowed after the proposal appeared
        vm.roll(block.number + 1);
        assertEq(gov.ballotWeight(id, late), 0);
        vm.prank(late);
        vm.expectRevert(Governor.NoVotingPower.selector);
        gov.vote(id, 0);
    }

    function test_governorBallotWeighsTheSmallerOfSnapshotAndNow() public {
        address p = voter("proposer", 1_000 ether);
        address a = voter("a", 300 ether);
        vm.prank(p);
        uint256 id = gov.propose(0, _one(address(att)), _zero(), _data(""), "x");
        vm.roll(block.number + 1);
        // more PSY locked after the snapshot does not count ...
        vm.deal(a, 500 ether);
        vm.prank(a);
        ve.lock{value: 500 ether}();
        vm.roll(block.number + 1);
        assertEq(gov.ballotWeight(id, a), 300 ether);
        // ... and PSY unlocked since the snapshot does not count either
        vm.prank(a);
        ve.unlock(700 ether);
        vm.roll(block.number + 1);
        assertEq(gov.ballotWeight(id, a), 100 ether);
        vm.prank(a);
        gov.vote(id, 1);
        assertEq(gov.getProposal(id).yes, 100 ether);
    }

    // ---- snapshot ballots (NGO election, rounds after the main round of term 1) ----

    function test_supplementaryRoundUsesItsOpeningSnapshot() public {
        address early = voter("early", 100 ether); // locked before round 1 opens
        electFirst(3); // round 0 closes, supplementary round 1 opens
        assertEq(el.snapshotOf(0), 0); // term 1 main round: ballot-time weight
        assertTrue(el.snapshotOf(1) != 0);
        address[] memory ngos = attestedNGOs("late", 1);
        vm.prank(ngos[0]);
        el.stand(1);
        address late = voter("lateVoter", 10_000 ether);
        assertEq(el.ballotWeight(1, late), 0);
        address[] memory pick = new address[](1);
        pick[0] = ngos[0];
        vm.prank(late);
        vm.expectRevert(NGOElection.NoVotingPower.selector);
        el.vote(1, pick);
        // the weight is the lock-time average (locked long before), capped at 1 % of the PSY locked at the snapshot
        uint256 w = el.ballotWeight(1, early);
        assertGt(w, 0);
        assertLe(w, ve.totalAt(el.snapshotOf(1)) / 100);
        vm.prank(early);
        el.vote(1, pick);
        assertEq(el.approvals(1, ngos[0]), w);
    }

    // ---- bounded parameter changes ----

    function test_parameterChangeAtMostDoubleOrHalfOncePer30Days() public {
        vm.startPrank(Addrs.GOVERNOR);
        vm.expectRevert(abi.encodeWithSelector(Params.StepTooLarge.selector, FEE, 201 ether));
        params.set(FEE, 201 ether);
        vm.expectRevert(abi.encodeWithSelector(Params.StepTooLarge.selector, FEE, 49 ether));
        params.set(FEE, 49 ether);
        params.set(FEE, 200 ether);
        assertEq(params.get(FEE), 200 ether);
        uint256 next = block.timestamp + 30 days;
        vm.expectRevert(abi.encodeWithSelector(Params.ChangedTooRecently.selector, FEE, next));
        params.set(FEE, 150 ether);
        vm.stopPrank();
        warpTo(next);
        vm.prank(Addrs.GOVERNOR);
        params.set(FEE, 100 ether);
        // the absolute bounds still apply on top of the step rule
        bytes32 mb = "vouchMinBlocks";
        vm.prank(Addrs.GOVERNOR);
        vm.expectRevert(abi.encodeWithSelector(Params.OutOfBounds.selector, mb, 0));
        params.set(mb, 0);
    }

    // ---- voucher cap ----

    function test_voucherBacksAtMostTenNGOsAtATime() public {
        address v = newVoucher("capVoucher");
        vm.deal(v, 100_000 ether);
        address[] memory ngos = new address[](11);
        for (uint256 i; i < 11; ++i) {
            ngos[i] = newMiner(string(abi.encodePacked("capNgo", vm.toString(i))), 20);
            mintNGO(ngos[i]);
        }
        for (uint256 i; i < 10; ++i) {
            vm.prank(v);
            att.vouch{value: 1_000 ether}(ngos[i]);
        }
        vm.prank(v);
        vm.expectRevert(abi.encodeWithSelector(Attestation.TooManyActiveVouches.selector, 10));
        att.vouch{value: 1_000 ether}(ngos[10]);
        // a bond taken back one term later frees a place
        skipTime(365 days);
        vm.prank(v);
        att.withdrawVouch(ngos[0]);
        vm.prank(v);
        att.vouch{value: 1_000 ether}(ngos[10]);
        assertEq(att.activeVouches(v), 10);
    }

    // ---- removal of an elected NGO ----

    function test_removalProposalRemovesAnElectedNGO() public {
        address big = voter("big", 1_000_000 ether);
        address[] memory ngos = electFirst(61);
        assertEq(modeC.mode(), 1);
        address bad = ngos[7];
        // NGO rewards: 10 PSY each, then the removed NGO's unclaimed share goes back to the pool
        vm.deal(Addrs.NGO_REWARDS, 610 ether);
        vm.prank(Addrs.SYSTEM);
        rewards.notify(610 ether);
        assertEq(rewards.claimable(1, bad), 10 ether);

        bytes memory call = abi.encodeCall(NGOElection.remove, (bad, keccak256("dossier was forged")));
        // an Ordinary proposal (5 % floor) cannot remove an NGO; nobody but the Governor can call remove
        vm.prank(big);
        vm.expectRevert(abi.encodeWithSelector(Governor.TargetNotAllowed.selector, uint8(0), Addrs.NGO_ELECTION));
        gov.propose(0, _one(Addrs.NGO_ELECTION), _zero(), _data(call), "remove");
        vm.expectRevert(Sys.OnlyGovernor.selector);
        el.remove(bad, bytes32(0));

        vm.prank(big);
        uint256 id = gov.propose(4, _one(Addrs.NGO_ELECTION), _zero(), _data(call), "remove NGO 7");
        vm.roll(block.number + 1);
        vm.prank(big);
        gov.vote(id, 1);
        (, uint256 floorWeight, uint256 minVoters) = gov.quorumOf(id);
        assertEq(floorWeight, gov.getProposal(id).totalPower / 10); // the 10 % floor
        assertEq(minVoters, 100);
        skipTime(5 days);
        gov.decide(id);
        vm.expectRevert();
        gov.execute(id); // 48-hour timelock
        skipTime(48 hours);
        gov.execute(id);

        assertFalse(el.isElected(bad));
        assertTrue(el.removedIn(1, bad));
        assertEq(el.electedCount(), 60);
        assertEq(modeC.mode(), 1);
        assertEq(reg.status(bad), 3); // attestation revoked
        assertEq(rewards.claimable(1, bad), 0);
        assertEq(rewards.undistributed(), 10 ether);
        vm.prank(bad);
        vm.expectRevert(NGORewards.NotElected.selector);
        rewards.claim(1);
        // it cannot stand again; its seat is open in the supplementary rounds
        uint256 rid = el.roundCount() - 1;
        vm.prank(bad);
        vm.expectRevert(NGOElection.NotAttested.selector);
        el.stand(rid);
    }

    function test_removalNeedsNormalMode() public {
        address big = voter("big", 1_000_000 ether);
        address[] memory ngos = electFirst(10); // Interim
        bytes memory call = abi.encodeCall(NGOElection.remove, (ngos[0], bytes32(0)));
        vm.prank(big);
        vm.expectRevert(Governor.ModeForbids.selector);
        gov.propose(4, _one(Addrs.NGO_ELECTION), _zero(), _data(call), "remove");
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
