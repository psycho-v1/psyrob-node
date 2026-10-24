// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Fixture} from "./Fixture.sol";
import {Addrs} from "../src/Base.sol";
import {RoleElection} from "../src/RoleElection.sol";

/// Tie-break of role elections by a verifiable random draw among the tied candidates.
contract RoleDrawTest is Fixture {
    address[] ngos;
    uint256 nextVoter;

    function setUp() public override {
        super.setUp();
        ngos = electFirst(60); // Normal mode: finality active, so draws are seeded by finalised checkpoints
    }

    /// Open a round for `role` with `counts.length` candidates getting counts[i] NGO votes each. Returns round and
    /// the candidates in address order.
    function _round(uint8 role, uint256[] memory counts) internal returns (uint256 id, address[] memory cands) {
        id = roles.open(role);
        cands = new address[](counts.length);
        for (uint256 i; i < counts.length; ++i) {
            cands[i] = makeAddr(string(abi.encodePacked("cand", vm.toString(id), "-", vm.toString(i))));
            vm.deal(cands[i], 1_000 ether);
            vm.prank(cands[i]);
            roles.stand{value: 100 ether}(id);
        }
        skipTime(14 days);
        for (uint256 i; i < counts.length; ++i) {
            for (uint256 j; j < counts[i]; ++j) {
                vm.prank(ngos[nextVoter % 60]);
                roles.vote(id, cands[i]);
                ++nextVoter;
            }
        }
        nextVoter = 0;
        skipTime(14 days);
        cands = sorted(cands);
    }

    function _record(uint256 number, bytes32 h) internal {
        uint256 e = fc.currentEpoch();
        vm.prank(Addrs.SYSTEM);
        fc.recordCheckpoint(e, number, h, new address[](0));
    }

    function _seedCheckpoint(uint256 id) internal view returns (uint256) {
        (RoleElection.Draw memory d,) = roles.getDraw(id);
        return (d.seedBlock + 29) / 30;
    }

    function _counts(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory x) {
        x = new uint256[](c == type(uint256).max ? 2 : 3);
        x[0] = a;
        x[1] = b;
        if (x.length == 3) x[2] = c;
    }

    function test_twoWayTie_drawnBySeedFromCheckpoint() public {
        (uint256 id, address[] memory c) = _round(0, _counts(3, 3, type(uint256).max));
        roles.finalize(id);
        assertFalse(roles.isRoleHolder(c[0]) || roles.isRoleHolder(c[1]));
        // before the seed exists: refused
        vm.expectRevert(abi.encodeWithSelector(RoleElection.SeedNotReady.selector, block.number + 30));
        roles.draw(id);
        vm.roll(block.number + 31);
        vm.expectRevert(); // the checkpoint is not recorded yet
        roles.draw(id);
        bytes32 h = keccak256("checkpoint block A");
        _record(_seedCheckpoint(id), h);
        address expected = c[roles.pick(h, id, 0, 2)];
        vm.expectEmit(true, true, false, true, Addrs.ROLE_ELECTION);
        emit RoleElection.RoleDrawn(id, 0, c, 3, 1, _seedCheckpoint(id), h, keccak256(abi.encode(h, id, uint8(0))), expected);
        roles.draw(id);
        assertTrue(roles.isRoleHolder(expected));
        (RoleElection.Draw memory d, address[] memory tied) = roles.getDraw(id);
        assertEq(d.status, 2);
        assertEq(d.sourceKind, 1);
        assertEq(d.sourceRef, _seedCheckpoint(id));
        assertEq(d.sourceHash, h);
        assertEq(d.seed, keccak256(abi.encode(h, id, uint8(0))));
        assertEq(d.winner, expected);
        assertEq(d.votes, 3);
        assertEq(tied.length, 2);
        assertEq(tied[0], c[0]);
        // one-shot: no second draw, no re-roll
        vm.expectRevert(RoleElection.AlreadyDrawn.selector);
        roles.draw(id);
        vm.expectRevert(RoleElection.AlreadyFinalized.selector);
        roles.finalize(id);
    }

    function test_threeWayTie_runByTheNodeSystemCall() public {
        (uint256 id, address[] memory c) = _round(1, _counts(2, 5, 5));
        advanceAll(); // records the tie between the two candidates with 5 votes... (c sorted; check below)
        (RoleElection.Draw memory d0, address[] memory tied0) = roles.getDraw(id);
        assertEq(d0.status, 1);
        assertEq(tied0.length, 2);
        (uint256 id3, address[] memory c3) = _round(2, _counts(4, 4, 4));
        advanceAll();
        (, address[] memory tied3) = roles.getDraw(id3);
        assertEq(tied3.length, 3);
        for (uint256 i; i < 3; ++i) assertEq(tied3[i], c3[i]);
        vm.roll(block.number + 40);
        bytes32 h = keccak256("checkpoint block B");
        _record(_seedCheckpoint(id3), h);
        if (_seedCheckpoint(id) != _seedCheckpoint(id3)) _record(_seedCheckpoint(id), keccak256("other"));
        advanceAll(); // the node runs every ready draw
        (RoleElection.Draw memory d3,) = roles.getDraw(id3);
        assertEq(d3.status, 2);
        assertEq(d3.winner, c3[roles.pick(h, id3, 2, 3)]);
        assertTrue(roles.isRoleHolder(d3.winner));
        (RoleElection.Draw memory d1,) = roles.getDraw(id);
        assertEq(d1.status, 2);
        // different roles drawn from the same checkpoint get independent seeds
        if (_seedCheckpoint(id) == _seedCheckpoint(id3)) assertTrue(d1.seed != d3.seed);
        c; // silence
    }

    function test_sameSeedSameWinner() public {
        (uint256 id, address[] memory c) = _round(3, _counts(1, 1, 1));
        roles.finalize(id);
        vm.roll(block.number + 31);
        bytes32 h = keccak256("fixed");
        uint256 i1 = roles.pick(h, id, 3, 3);
        uint256 i2 = roles.pick(h, id, 3, 3);
        assertEq(i1, i2);
        _record(_seedCheckpoint(id), h);
        roles.draw(id);
        (RoleElection.Draw memory d,) = roles.getDraw(id);
        assertEq(d.winner, c[i1]);
        // recomputing from the published fields gives the same winner
        assertEq(uint256(d.seed) % 3, i1);
    }

    function test_distributionRoughlyEqual() public view {
        uint256[3] memory hits3;
        uint256[2] memory hits2;
        for (uint256 s; s < 3000; ++s) {
            bytes32 h = keccak256(abi.encode("seed", s));
            hits3[roles.pick(h, 7, 1, 3)]++;
            hits2[roles.pick(h, 9, 4, 2)]++;
        }
        for (uint256 i; i < 3; ++i) assertApproxEqRel(hits3[i], 1000, 0.1e18); // within 10 %
        for (uint256 i; i < 2; ++i) assertApproxEqRel(hits2[i], 1500, 0.1e18);
    }

    function test_zeroVotesNotDrawnRoleVacantAndRerun() public {
        (uint256 id,) = _round(4, _counts(0, 0, type(uint256).max));
        roles.finalize(id);
        (RoleElection.Draw memory d,) = roles.getDraw(id);
        assertEq(d.status, 0); // no draw
        assertEq(roles.holder(4).who, address(0));
        assertEq(roles.openRoundOf(4), 0);
        roles.open(4); // re-run
        vm.expectRevert(RoleElection.NoDraw.selector);
        roles.draw(id);
    }

    function test_withdrawnTiedCandidateRemovedFirst() public {
        // 3-way tie, one withdraws: draw between the other two
        (uint256 id, address[] memory c) = _round(0, _counts(2, 2, 2));
        roles.finalize(id);
        vm.prank(c[1]);
        roles.withdrawCandidacy(id);
        vm.roll(block.number + 31);
        bytes32 h = keccak256("w");
        _record(_seedCheckpoint(id), h);
        roles.draw(id);
        (RoleElection.Draw memory d,) = roles.getDraw(id);
        address[2] memory left = [c[0], c[2]];
        assertEq(d.winner, left[roles.pick(h, id, 0, 2)]);
    }

    function test_oneTiedCandidateLeftWinsWithoutDraw() public {
        (uint256 id, address[] memory c) = _round(1, _counts(4, 4, type(uint256).max));
        roles.finalize(id);
        vm.prank(c[0]);
        roles.withdrawCandidacy(id);
        roles.draw(id); // no seed needed
        (RoleElection.Draw memory d,) = roles.getDraw(id);
        assertEq(d.sourceKind, 0);
        assertEq(d.winner, c[1]);
        assertTrue(roles.isRoleHolder(c[1]));
    }

    function test_fallbackToBlockHashWhenCheckpointNeverFinalised() public {
        (uint256 id, address[] memory c) = _round(2, _counts(1, 1, type(uint256).max));
        roles.finalize(id);
        (RoleElection.Draw memory d0,) = roles.getDraw(id);
        uint256 cpHeight = ((d0.seedBlock + 29) / 30) * 30;
        vm.roll(cpHeight + 8_640);
        vm.expectRevert(); // still waiting for the committee
        roles.draw(id);
        vm.roll(cpHeight + 8_641);
        roles.draw(id); // switches to the block fallback, once
        (RoleElection.Draw memory d1,) = roles.getDraw(id);
        assertFalse(d1.useCheckpoint);
        assertEq(d1.seedBlock, cpHeight + 8_641 + 30);
        vm.expectRevert(abi.encodeWithSelector(RoleElection.SeedNotReady.selector, d1.seedBlock));
        roles.draw(id);
        bytes32 h = keccak256("block hash");
        vm.roll(d1.seedBlock + 1);
        vm.setBlockhash(d1.seedBlock, h);
        roles.draw(id);
        (RoleElection.Draw memory d2,) = roles.getDraw(id);
        assertEq(d2.sourceKind, 2);
        assertEq(d2.sourceRef, d1.seedBlock);
        assertEq(d2.winner, c[roles.pick(h, id, 2, 2)]);
    }
}
