// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Fixture} from "./Fixture.sol";
import {Addrs, Sys} from "../src/Base.sol";
import {MinerRegistry} from "../src/MinerRegistry.sol";
import {NGORegistry} from "../src/NGORegistry.sol";
import {Attestation} from "../src/Attestation.sol";
import {VoteEscrow} from "../src/VoteEscrow.sol";
import {DevVesting} from "../src/DevVesting.sol";
import {Params} from "../src/Params.sol";

/// Miners, NGO minting, attestation, vote escrow, vesting and parameters.
contract ParticipantsTest is Fixture {
    function test_registerNeedsAMinedBlock() public {
        address a = makeAddr("nobody");
        vm.prank(a);
        vm.expectRevert(MinerRegistry.NeverMined.selector);
        mr.register(bytes32(0));
        mine(a, 1);
        vm.prank(a);
        mr.register(bytes32(0));
        assertTrue(mr.isRegistered(a));
        vm.prank(a);
        vm.expectRevert(MinerRegistry.AlreadyRegistered.selector);
        mr.register(bytes32(0));
    }

    function test_recordBlocksOnlySystemAndCountsByEpoch() public {
        address[] memory a = new address[](1);
        uint256[] memory c = new uint256[](1);
        a[0] = makeAddr("m");
        c[0] = 3;
        vm.expectRevert(Sys.OnlySystem.selector);
        mr.recordBlocks(a, c);
        vm.prank(Addrs.SYSTEM);
        mr.recordBlocks(a, c);
        skipTime(7 days);
        vm.prank(Addrs.SYSTEM);
        mr.recordBlocks(a, c);
        assertEq(mr.minedTotal(a[0]), 6);
        assertEq(mr.minedIn(0, a[0]), 3);
        assertEq(mr.minedIn(1, a[0]), 3);
        assertEq(mr.epochBlocks(1), 3);
    }

    function test_mintFromMinerWalletBurnsFee() public {
        address ngo = newMiner("ngoA", 20);
        uint256 burnBefore = Addrs.BURN.balance;
        vm.prank(ngo);
        vm.expectRevert(abi.encodeWithSelector(NGORegistry.WrongFee.selector, 100 ether));
        reg.mint{value: 1 ether}("A", "NL", "r", "ipfs://x", bytes32(uint256(1)));
        mintNGO(ngo);
        assertEq(Addrs.BURN.balance - burnBefore, 100 ether);
        assertEq(reg.status(ngo), 1);
        vm.expectRevert(NGORegistry.AlreadyAnNGO.selector);
        mintNGO(ngo);
    }

    function test_mintNeedsRegisteredMiner() public {
        address x = makeAddr("x");
        vm.deal(x, 1_000 ether);
        vm.prank(x);
        vm.expectRevert(NGORegistry.NotARegisteredMiner.selector);
        reg.mint{value: 100 ether}("A", "NL", "r", "ipfs://x", bytes32(uint256(1)));
    }

    function test_attestationHappyPath() public {
        address ngo = newMiner("ngoB", 20);
        mintNGO(ngo);
        ensureVouchers();
        // ineligible vouchers: the NGO itself, a miner with too few blocks
        vm.deal(ngo, 10_000 ether);
        vm.prank(ngo);
        vm.expectRevert(Attestation.NotEligibleVoucher.selector);
        att.vouch{value: 1_000 ether}(ngo);
        address weak = newMiner("weak", 5);
        vm.deal(weak, 10_000 ether);
        vm.prank(weak);
        vm.expectRevert(Attestation.NotEligibleVoucher.selector);
        att.vouch{value: 1_000 ether}(ngo);
        for (uint256 i; i < 5; ++i) {
            vm.prank(vouchers[i]);
            att.vouch{value: 1_000 ether}(ngo);
        }
        vm.expectRevert(Attestation.WindowOpen.selector);
        att.finalize(ngo);
        skipTime(7 days);
        att.finalize(ngo);
        assertEq(reg.status(ngo), 2);
        // a voucher with an active vouch cannot become an NGO
        vm.prank(vouchers[0]);
        vm.expectRevert(NGORegistry.VoucherCannotBeNGO.selector);
        reg.mint{value: 100 ether}("V", "NL", "r", "ipfs://v", bytes32(uint256(2)));
        // bonds come back one term after the vouch
        vm.prank(vouchers[0]);
        vm.expectRevert(Attestation.TooEarly.selector);
        att.withdrawVouch(ngo);
        skipTime(365 days);
        uint256 b = vouchers[0].balance;
        vm.prank(vouchers[0]);
        att.withdrawVouch(ngo);
        assertEq(vouchers[0].balance - b, 1_000 ether);
    }

    function test_challengeUpheldByGovernorBurnsVouches() public {
        address ngo = newMiner("ngoC", 20);
        mintNGO(ngo);
        ensureVouchers();
        for (uint256 i; i < 5; ++i) {
            vm.prank(vouchers[i]);
            att.vouch{value: 1_000 ether}(ngo);
        }
        address ch = makeAddr("challenger");
        vm.deal(ch, 2_000 ether);
        vm.prank(ch);
        att.challenge{value: 1_000 ether}(ngo, keccak256("fake registration"));
        skipTime(8 days);
        vm.expectRevert(Attestation.ChallengePending.selector);
        att.finalize(ngo);
        // no elected NGOs yet: the NGO vote cannot reach 5 votes
        vm.expectRevert(Attestation.NotEnoughVotes.selector);
        att.resolve(ngo);
        uint256 burnBefore = Addrs.BURN.balance;
        vm.prank(Addrs.GOVERNOR);
        att.governorDecide(ngo, true);
        assertEq(reg.status(ngo), 3);
        assertEq(Addrs.BURN.balance - burnBefore, 5_000 ether);
        assertEq(ch.balance, 2_000 ether);
        assertFalse(att.hasActiveVouch(vouchers[0]));
    }

    function test_challengeDismissedPaysVouchersAndRestartsWindow() public {
        address ngo = newMiner("ngoD", 20);
        mintNGO(ngo);
        ensureVouchers();
        for (uint256 i; i < 5; ++i) {
            vm.prank(vouchers[i]);
            att.vouch{value: 1_000 ether}(ngo);
        }
        address ch = makeAddr("challenger");
        vm.deal(ch, 1_000 ether);
        vm.prank(ch);
        att.challenge{value: 1_000 ether}(ngo, keccak256("x"));
        uint256 b = vouchers[1].balance;
        vm.prank(Addrs.GOVERNOR);
        att.governorDecide(ngo, false);
        assertEq(vouchers[1].balance - b, 200 ether);
        vm.expectRevert(Attestation.WindowOpen.selector);
        att.finalize(ngo);
        skipTime(7 days);
        att.finalize(ngo);
        assertEq(reg.status(ngo), 2);
    }

    function test_voteEscrowSnapshotsAndHold() public {
        address v = makeAddr("v");
        vm.deal(v, 100 ether);
        vm.prank(v);
        ve.lock{value: 100 ether}();
        assertEq(ve.powerAt(v, block.number - 1), 0); // nothing before the lock block
        assertEq(ve.powerAt(v, block.number), 100 ether);
        vm.prank(Addrs.NGO_ELECTION);
        ve.holdUntil(v, block.timestamp + 1 days);
        vm.prank(v);
        vm.expectRevert(abi.encodeWithSelector(VoteEscrow.Held.selector, block.timestamp + 1 days));
        ve.unlock(1 ether);
        skipTime(1 days);
        vm.prank(v);
        ve.unlock(40 ether);
        assertEq(ve.locked(v), 60 ether);
        assertEq(ve.totalLocked(), 60 ether);
        assertEq(v.balance, 40 ether);
        vm.expectRevert(VoteEscrow.NotAVotingContract.selector);
        ve.holdUntil(v, block.timestamp + 10 days);
    }

    function test_devVestingCliffAndLinear() public {
        assertEq(address(dev).balance, 120_000_000 ether);
        vm.expectRevert(DevVesting.NothingVested.selector);
        dev.release();
        warpTo(G + 365 days);
        dev.release();
        assertEq(devBeneficiary.balance, 30_000_000 ether); // 1/4 at month 12
        warpTo(G + 4 * 365 days);
        dev.release();
        assertEq(devBeneficiary.balance, 120_000_000 ether);
        assertEq(address(dev).balance, 0);
    }

    function test_paramsOnlyGovernorWithinBounds() public {
        vm.expectRevert(Sys.OnlyGovernor.selector);
        params.set("ngoMintFee", 50 ether);
        vm.prank(Addrs.GOVERNOR);
        vm.expectRevert(abi.encodeWithSelector(Params.OutOfBounds.selector, bytes32("ngoMintFee"), 0));
        params.set("ngoMintFee", 0);
        vm.prank(Addrs.GOVERNOR);
        params.set("ngoMintFee", 50 ether);
        assertEq(params.get("ngoMintFee"), 50 ether);
    }
}
