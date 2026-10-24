// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Fixture} from "./Fixture.sol";
import {Addrs} from "../src/Base.sol";
import {FinalityCommittee} from "../src/FinalityCommittee.sol";

/// The committee draw: freeze, seed produced after the freeze, seal.
contract CommitteeDrawTest is Fixture {
    address[] ngos;
    address[] miners;

    function setUp() public override {
        super.setUp();
        ngos = electFirst(60);
        for (uint256 i; i < 8; ++i) {
            vm.deal(ngos[i], 20_000 ether);
            vm.prank(ngos[i]);
            fc.bond{value: 10_000 ether}();
        }
        for (uint256 i; i < 20; ++i) {
            address a = makeAddr(string(abi.encodePacked("dm", vm.toString(i))));
            mine(a, 50);
            vm.prank(a);
            mr.register(bytes32(0));
            vm.deal(a, 20_000 ether);
            vm.prank(a);
            fc.bond{value: 10_000 ether}();
            miners.push(a);
        }
    }

    function _draw(uint256 e) internal view returns (FinalityCommittee.EpochDraw memory d) {
        (d,) = fc.epochDraw(e);
    }

    /// A rotation first waits for the committee's beacon round; with no reveals it closes and the draw falls back to
    /// the checkpoint source, with a seed block SEED_DELAY after the close.
    function _expireBeacon(uint256 e) internal {
        FinalityCommittee.EpochDraw memory d = _draw(e);
        vm.roll(uint256(d.freezeBlock) + fc.BEACON_WINDOW() + 1);
        advanceAll();
        assertEq(fc.members(e).length, 0);
    }

    function test_firstCommitteeSeededByAChainBlockAfterTheFreeze() public {
        advanceAll(); // freeze
        uint256 e = fc.currentEpoch();
        FinalityCommittee.EpochDraw memory d = _draw(e);
        assertEq(d.freezeBlock, block.number);
        assertEq(d.seedBlock, block.number + 30);
        assertFalse(d.useCheckpoint); // no checkpoint can exist before the first committee
        vm.roll(d.seedBlock); // the seed block itself is not available yet (it is the current block)
        advanceAll();
        assertEq(fc.members(e).length, 0);
        vm.roll(d.seedBlock + 1);
        bytes32 h = keccak256("seed block hash");
        vm.setBlockhash(d.seedBlock, h);
        advanceAll();
        assertEq(fc.members(e).length, 21);
        d = _draw(e);
        assertEq(d.sourceKind, 2);
        assertEq(d.sourceRef, d.seedBlock);
        assertEq(d.sourceHash, h);
        assertEq(fc.seedOf(e), keccak256(abi.encode(h, e)));
        assertEq(fc.lastSealedEpoch(), e);
    }

    function test_rotationSeededByFinalisedCheckpoint_previousCommitteeSignsMeanwhile() public {
        sealCommittee(); // first committee (block source)
        uint256 e0 = fc.currentEpoch();
        vm.prank(Addrs.SYSTEM);
        fc.recordCheckpoint(e0, 1, keccak256("cp1"), new address[](0)); // finality is running
        skipTime(7 days);
        advanceAll(); // freeze the next epoch
        uint256 e1 = fc.currentEpoch();
        _expireBeacon(e1);
        FinalityCommittee.EpochDraw memory d = _draw(e1);
        assertTrue(d.useCheckpoint);
        // no seal until the seed checkpoint is final, however many blocks pass (below the wait)
        vm.roll(block.number + 1_000);
        advanceAll();
        assertEq(fc.members(e1).length, 0);
        // meanwhile checkpoints are signed by the previous committee
        assertEq(fc.signerEpoch(block.timestamp, block.number), e0);
        uint256 c = (uint256(d.seedBlock) + 29) / 30;
        bytes32 h = keccak256("final checkpoint block");
        vm.prank(Addrs.SYSTEM);
        fc.recordCheckpoint(e0, c, h, new address[](0));
        advanceAll();
        d = _draw(e1);
        assertEq(fc.members(e1).length, 21);
        assertEq(d.sourceKind, 1);
        assertEq(d.sourceRef, c);
        assertEq(d.sourceHash, h);
        assertEq(fc.seedOf(e1), keccak256(abi.encode(h, e1)));
        // checkpoints after the seal are signed by the new committee
        vm.roll(block.number + 1);
        assertEq(fc.signerEpoch(block.timestamp, block.number), e1);
    }

    function test_candidatesFrozenBeforeTheSeedExists() public {
        advanceAll(); // freeze: 8 NGOs + 20 miners
        uint256 e = fc.currentEpoch();
        (, FinalityCommittee.Frozen[] memory f) = fc.epochDraw(e);
        assertEq(f.length, 28);
        // a candidate bonding after the freeze is not in this draw
        address late = makeAddr("late");
        mine(late, 500);
        vm.prank(late);
        mr.register(bytes32(0));
        vm.deal(late, 20_000 ether);
        vm.prank(late);
        fc.bond{value: 10_000 ether}();
        // a frozen candidate leaving after the freeze stays in the draw and keeps its bond locked if drawn
        vm.prank(miners[0]);
        fc.requestUnbond();
        FinalityCommittee.EpochDraw memory d = _draw(e);
        vm.roll(d.seedBlock + 1);
        vm.setBlockhash(d.seedBlock, keccak256("x"));
        advanceAll();
        assertEq(fc.seatOf(e, late), 0);
        (, f) = fc.epochDraw(e);
        assertEq(f.length, 28);
        if (fc.seatOf(e, miners[0]) != 0) {
            skipTime(14 days + 1);
            vm.prank(miners[0]);
            vm.expectRevert(FinalityCommittee.StillServing.selector);
            fc.withdrawBond();
        }
    }

    function test_seedFallbackWhenCheckpointNeverFinalised() public {
        sealCommittee();
        uint256 e0 = fc.currentEpoch();
        vm.prank(Addrs.SYSTEM);
        fc.recordCheckpoint(e0, 1, keccak256("cp1"), new address[](0));
        skipTime(7 days);
        advanceAll();
        uint256 e1 = fc.currentEpoch();
        _expireBeacon(e1);
        FinalityCommittee.EpochDraw memory d = _draw(e1);
        uint256 cpHeight = ((uint256(d.seedBlock) + 29) / 30) * 30;
        vm.roll(cpHeight + 2_880);
        advanceAll();
        assertTrue(_draw(e1).useCheckpoint); // still waiting
        vm.roll(cpHeight + 2_881);
        advanceAll(); // falls back once, to a block 30 later
        d = _draw(e1);
        assertFalse(d.useCheckpoint);
        assertEq(d.seedBlock, cpHeight + 2_881 + 30);
        vm.roll(d.seedBlock + 1);
        vm.setBlockhash(d.seedBlock, keccak256("fallback"));
        advanceAll();
        assertEq(fc.members(e1).length, 21);
        assertEq(_draw(e1).sourceKind, 2);
    }

    function test_sameSeedSameCommittee() public {
        uint256 snap = vm.snapshotState();
        sealCommittee();
        address[] memory a = fc.members(fc.currentEpoch());
        vm.revertToState(snap);
        sealCommittee();
        address[] memory b = fc.members(fc.currentEpoch());
        assertEq(a.length, b.length);
        for (uint256 i; i < a.length; ++i) assertEq(a[i], b[i]);
    }
}
