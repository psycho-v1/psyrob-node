// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Fixture} from "./Fixture.sol";
import {NGOElection} from "../src/NGOElection.sol";
import {Attestation} from "../src/Attestation.sol";

/// Owner decisions of 11 October 2026 (RISK_REVIEW.md 3.7): lock-time weight and a per-wallet cap for NGO-election
/// ballots, a limit of two consecutive NGO terms, and a mining history for vouchers.
contract ElectionCaptureTest is Fixture {
    function _lockAt(string memory name, uint256 amount) private returns (address a) {
        a = makeAddr(name);
        vm.deal(a, amount);
        vm.prank(a);
        ve.lock{value: amount}();
    }

    function test_lockTimeWeight_lateLockCountsInProportionToItsAge() public {
        advanceAll(); // round 0 (term 1 main round): no snapshot, ballot-time weight
        _lockAt("pool", 10_000_000 ether); // keeps the 1 % cap out of the way
        address early = _lockAt("early", 1_000 ether);
        uint256 W = el.LOCK_WINDOW();
        vm.roll(block.number + W / 2);
        address half = _lockAt("half", 1_000 ether);
        vm.roll(block.number + W / 2);
        address late = _lockAt("late", 1_000 ether);
        vm.roll(block.number + 1);
        assertEq(el.ballotWeight(0, early), 1_000 ether); // locked for the whole window
        assertApproxEqRel(el.ballotWeight(0, half), 500 ether, 1e14); // half the window
        assertEq(el.ballotWeight(0, late), uint256(1_000 ether) / W); // one block of the window
        // the same holds in a ballot
        address ngo = attestedNGO("cap");
        vm.prank(ngo);
        el.stand(0);
        address[] memory pick = new address[](1);
        pick[0] = ngo;
        uint256 wl = el.ballotWeight(0, late);
        vm.prank(late);
        el.vote(0, pick);
        assertEq(el.approvals(0, ngo), wl);
    }

    function test_ballotWeightCappedPerWallet_splittingIsTheKnownLimit() public {
        advanceAll();
        address whale = _lockAt("whale", 900_000 ether);
        _lockAt("others", 100_000 ether);
        vm.roll(block.number + el.LOCK_WINDOW() + 1);
        // 1 % of the 1,000,000 PSY locked, although the whale holds 90 %
        assertEq(el.ballotWeight(0, whale), 10_000 ether);
        // the cap is per wallet: the same PSY split over two wallets gets twice the weight (documented limit)
        vm.prank(whale);
        ve.unlock(900_000 ether);
        address w1 = _lockAt("w1", 450_000 ether);
        address w2 = _lockAt("w2", 450_000 ether);
        vm.roll(block.number + el.LOCK_WINDOW() + 1);
        assertEq(el.ballotWeight(0, w1) + el.ballotWeight(0, w2), 20_000 ether);
    }

    function test_termLimit_twoConsecutiveTermsThenOneTermOut() public {
        address v = voter("longVoter", 1_000 ether);
        address ngo = electFirst(1)[0]; // term 1
        assertTrue(el.isElectedIn(1, ngo));
        address[] memory pick = new address[](1);
        pick[0] = ngo;

        // term 2: re-elected in the main round
        warpTo(el.termStart(2) - 30 days);
        advanceAll();
        uint256 r2 = el.roundCount() - 1;
        assertEq(el.getRound(r2).term, 2);
        vm.prank(ngo);
        el.stand(r2);
        vm.prank(v);
        el.vote(r2, pick);
        warpTo(el.termStart(2));
        advanceAll();
        assertTrue(el.isElectedIn(2, ngo));

        // term 3: two consecutive terms served, it cannot stand
        warpTo(el.termStart(3) - 30 days);
        advanceAll();
        uint256 r3 = el.roundCount() - 1;
        assertEq(el.getRound(r3).term, 3);
        assertTrue(el.termLimited(3, ngo));
        vm.prank(ngo);
        vm.expectRevert(NGOElection.TermLimit.selector);
        el.stand(r3);
        warpTo(el.termStart(3));
        advanceAll();
        assertFalse(el.isElectedIn(3, ngo));

        // term 4: after one full term without a seat it may stand and be elected again
        warpTo(el.termStart(4) - 30 days);
        advanceAll();
        uint256 r4 = el.roundCount() - 1;
        assertFalse(el.termLimited(4, ngo));
        vm.prank(ngo);
        el.stand(r4);
        vm.prank(v);
        el.vote(r4, pick);
        warpTo(el.termStart(4));
        advanceAll();
        assertTrue(el.isElectedIn(4, ngo));
    }

    function test_voucherNeedsMiningInFourDistinctEpochs() public {
        address ngo = newMiner("histNgo", 20);
        mintNGO(ngo);
        // 100 blue blocks, all in one week: not eligible however many blocks it has
        address burst = newMiner("burst", 400);
        vm.deal(burst, 10_000 ether);
        assertEq(mr.activeEpochs(burst), 1);
        vm.prank(burst);
        vm.expectRevert(Attestation.NotEligibleVoucher.selector);
        att.vouch{value: 1_000 ether}(ngo);
        // the same wallet after mining in three more weeks
        for (uint256 k = 1; k < 4; ++k) {
            warpTo(G + k * 7 days + 1);
            mine(burst, 1);
        }
        assertEq(mr.activeEpochs(burst), 4);
        vm.prank(burst);
        att.vouch{value: 1_000 ether}(ngo);
        assertTrue(att.hasVouched(ngo, burst));
    }
}
