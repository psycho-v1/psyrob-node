// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Fixture} from "./Fixture.sol";
import {Addrs} from "../src/Base.sol";
import {FinalityCommittee} from "../src/FinalityCommittee.sol";
import {VolunteerFund} from "../src/bnb/VolunteerFund.sol";

/// Finality committee draw, caps, rewards and slashing; the BNB volunteer fund.
contract FinalityTest is Fixture {
    address[] ngos;
    uint256[] minerKeys;
    address[] miners;

    function _bondMiners(uint256 n) internal {
        for (uint256 i; i < n; ++i) {
            (address a, uint256 k) = makeAddrAndKey(string(abi.encodePacked("cm", vm.toString(i))));
            mine(a, 50);
            vm.prank(a);
            mr.register(bytes32(0));
            vm.deal(a, 20_000 ether);
            vm.prank(a);
            fc.bond{value: 10_000 ether}();
            miners.push(a);
            minerKeys.push(k);
        }
    }

    function _setupNormal() internal {
        ngos = electFirst(60);
        for (uint256 i; i < 8; ++i) {
            vm.deal(ngos[i], 20_000 ether);
            vm.prank(ngos[i]);
            fc.bond{value: 10_000 ether}();
        }
        _bondMiners(20);
    }

    function test_noCommitteeBeforeNormalMode() public {
        _bondMiners(16);
        sealCommittee();
        assertEq(fc.members(fc.currentEpoch()).length, 0);
    }

    function test_noFreezeUntilCandidatesCanFormACommittee() public {
        ngos = electFirst(60); // Normal mode begins in this block; nobody has bonded yet
        advanceAll();
        (FinalityCommittee.EpochDraw memory d,) = fc.epochDraw(fc.currentEpoch());
        assertEq(d.freezeBlock, 0);
        for (uint256 i; i < 6; ++i) {
            vm.deal(ngos[i], 20_000 ether);
            vm.prank(ngos[i]);
            fc.bond{value: 10_000 ether}();
        }
        _bondMiners(8);
        advanceAll();
        (d,) = fc.epochDraw(fc.currentEpoch());
        assertEq(d.freezeBlock, 0); // 14 candidates cannot reach the quorum of 15: not yet
        vm.deal(ngos[6], 20_000 ether);
        vm.prank(ngos[6]);
        fc.bond{value: 10_000 ether}(); // 15 candidates, more than a day into the epoch
        advanceAll();
        (d,) = fc.epochDraw(fc.currentEpoch());
        assertEq(d.freezeBlock, block.number);
    }

    function test_drawSixNGOAndFifteenMinerSeats() public {
        _setupNormal();
        skipTime(7 days);
        sealCommittee();
        uint256 e = fc.currentEpoch();
        address[] memory m = fc.members(e);
        assertEq(m.length, 21);
        uint256 ngoSeats;
        for (uint256 i; i < m.length; ++i) {
            if (el.isElected(m[i])) ++ngoSeats;
            for (uint256 j; j < i; ++j) assertTrue(m[i] != m[j]);
        }
        assertEq(ngoSeats, 6);
        // the next epoch rotates: with 20 miner candidates and 15 seats, at most 5 repeat... previous members skipped only
        // while enough fresh candidates exist (here 5 fresh < 15), so repetition is allowed but the draw stays valid
        skipTime(7 days);
        sealCommittee();
        assertEq(fc.members(e + 1).length, 21);
    }

    function test_operatorCapThreeSeats() public {
        ngos = electFirst(60);
        for (uint256 i; i < 6; ++i) {
            vm.deal(ngos[i], 20_000 ether);
            vm.prank(ngos[i]);
            fc.bond{value: 10_000 ether}();
        }
        // 20 miners, all declaring the same operator: only 3 miner seats
        for (uint256 i; i < 20; ++i) {
            address a = makeAddr(string(abi.encodePacked("op", vm.toString(i))));
            mine(a, 50);
            vm.prank(a);
            mr.register(keccak256("one operator"));
            vm.deal(a, 20_000 ether);
            vm.prank(a);
            fc.bond{value: 10_000 ether}();
        }
        skipTime(7 days);
        sealCommittee();
        assertEq(fc.members(fc.currentEpoch()).length, 6 + 3);
    }

    function test_rewardsNeedHalfTheCheckpoints() public {
        _setupNormal();
        skipTime(7 days);
        sealCommittee();
        uint256 e = fc.currentEpoch();
        address[] memory m = fc.members(e);
        vm.deal(Addrs.FINALITY_COMMITTEE, address(fc).balance + 210 ether);
        vm.prank(Addrs.SYSTEM);
        fc.notify(210 ether);
        address[] memory signers = new address[](15);
        for (uint256 i; i < 15; ++i) signers[i] = m[i];
        vm.startPrank(Addrs.SYSTEM);
        fc.recordCheckpoint(e, 1, bytes32(uint256(1)), signers);
        fc.recordCheckpoint(e, 2, bytes32(uint256(2)), signers);
        fc.recordCheckpoint(e, 2, bytes32(uint256(2)), signers); // duplicates ignored
        vm.stopPrank();
        assertEq(fc.checkpointCount(e), 2);
        skipTime(7 days);
        sealCommittee(); // committee e replaced (its seed checkpoint counts for e too; nobody signed it)
        skipTime(1 days); // SETTLE_DELAY
        assertEq(fc.checkpointCount(e), 3);
        uint256 b = m[0].balance;
        vm.prank(m[0]);
        fc.claimReward(e);
        assertEq(m[0].balance - b, 14 ether); // 210 / 15 eligible (2 of 3 signed)
        vm.prank(m[20]);
        vm.expectRevert(FinalityCommittee.NotEligible.selector);
        fc.claimReward(e);
    }

    function test_equivocationSlashed() public {
        _setupNormal();
        skipTime(7 days);
        sealCommittee();
        uint256 e = fc.currentEpoch();
        // find a member whose key we hold
        uint256 key;
        address who;
        for (uint256 i; i < miners.length; ++i) {
            if (fc.seatOf(e, miners[i]) != 0) {
                key = minerKeys[i];
                who = miners[i];
                break;
            }
        }
        assertTrue(who != address(0));
        bytes memory sa = _sig(key, fc.checkpointDigest(7, bytes32(uint256(1)), bytes32(uint256(5))));
        bytes memory sb = _sig(key, fc.checkpointDigest(7, bytes32(uint256(2)), bytes32(uint256(5))));
        address reporter = makeAddr("reporter");
        uint256 burnBefore = Addrs.BURN.balance;
        vm.prank(reporter);
        fc.reportEquivocation(e, 7, bytes32(uint256(1)), bytes32(uint256(5)), sa, bytes32(uint256(2)), bytes32(uint256(5)), sb);
        assertEq(reporter.balance, 1_000 ether);
        assertEq(Addrs.BURN.balance - burnBefore, 9_000 ether);
        assertTrue(fc.slashed(e, who));
        assertEq(fc.activeMembers(e).length, 20);
        vm.expectRevert(FinalityCommittee.AlreadySlashed.selector);
        fc.reportEquivocation(e, 7, bytes32(uint256(1)), bytes32(uint256(5)), sa, bytes32(uint256(2)), bytes32(uint256(5)), sb);
    }

    // ---- BNB volunteer fund ----

    function _fund(uint256[] memory keys, address[5] memory signers, address lead, address[] memory roleHolders)
        internal
        returns (VolunteerFund f, address[] memory committee)
    {
        committee = new address[](21);
        for (uint256 i; i < 21; ++i) committee[i] = vm.addr(keys[i]);
        f = new VolunteerFund(87870, G, _ho(1, 1, committee, signers, lead, roleHolders));
        vm.deal(address(f), 100 ether);
    }

    /// A handover: the first 6 members are NGO seats, the rest miner seats (keys 0..5 are the NGOs).
    function _ho(uint256 epoch, uint256 psyrobEpoch, address[] memory committee, address[5] memory signers, address lead, address[] memory roleHolders)
        internal
        pure
        returns (VolunteerFund.Handover memory h)
    {
        uint8[] memory seats = new uint8[](committee.length);
        for (uint256 i; i < committee.length; ++i) seats[i] = i < 6 ? 1 : 2;
        h = VolunteerFund.Handover(epoch, psyrobEpoch, keccak256(abi.encode("psyrob block", psyrobEpoch)), committee, seats, signers, lead, roleHolders);
    }

    /// Propose a handover signed by the first 15 keys, wait out the timelock, apply it.
    function _handover(VolunteerFund f, uint256[] memory keys, VolunteerFund.Handover memory h) internal {
        f.proposeCommittee(h, _sigs(keys, 15, f.committeeDigest(h)));
        skip(48 hours);
        f.applyCommittee(h);
    }

    function _keys() internal pure returns (uint256[] memory k) {
        k = new uint256[](21);
        for (uint256 i; i < 21; ++i) k[i] = 1000 + i;
    }

    function _sigs(uint256[] memory keys, uint256 n, bytes32 d) internal pure returns (bytes[] memory s) {
        s = new bytes[](n);
        for (uint256 i; i < n; ++i) s[i] = _sig(keys[i], d);
    }

    function _signers() internal returns (address[5] memory s) {
        for (uint256 i; i < 5; ++i) s[i] = makeAddr(string(abi.encodePacked("signer", vm.toString(i))));
    }

    function test_fundTransferNeedsCommitteeMultisigAndTimelock() public {
        uint256[] memory keys = _keys();
        address[5] memory sg = _signers();
        (VolunteerFund f,) = _fund(keys, sg, makeAddr("lead"), new address[](0));
        address school = makeAddr("school");
        bytes32 d = f.fundDigest(0, address(0), school, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(VolunteerFund.NotEnoughSignatures.selector, 14));
        f.queue(0, address(0), school, 1 ether, _sigs(keys, 14, d));
        // duplicated signatures do not count twice
        bytes[] memory dup = _sigs(keys, 15, d);
        dup[14] = dup[0];
        vm.expectRevert(abi.encodeWithSelector(VolunteerFund.NotEnoughSignatures.selector, 14));
        f.queue(0, address(0), school, 1 ether, dup);
        f.queue(0, address(0), school, 1 ether, _sigs(keys, 15, d));
        vm.prank(sg[0]);
        f.approve(0);
        vm.prank(sg[1]);
        f.approve(0);
        vm.prank(sg[2]);
        f.approve(0);
        vm.expectRevert();
        f.execute(0); // 48 h timelock (1 of 100 is small)
        skip(48 hours);
        f.execute(0);
        assertEq(school.balance, 1 ether);
    }

    function test_fundLargeTransferHas72hAndCanBeCanceled() public {
        uint256[] memory keys = _keys();
        address[5] memory sg = _signers();
        address lead = makeAddr("lead");
        (VolunteerFund f,) = _fund(keys, sg, lead, new address[](0));
        address to = makeAddr("big");
        f.queue(1, address(0), to, 10 ether, _sigs(keys, 15, f.fundDigest(1, address(0), to, 10 ether)));
        (,,, uint64 eta,,,,) = f.transfers(1);
        assertEq(eta, block.timestamp + 72 hours);
        vm.prank(lead);
        f.cancel(1);
        for (uint256 i; i < 3; ++i) {
            vm.prank(sg[i]);
            vm.expectRevert(VolunteerFund.Canceled.selector);
            f.approve(1);
        }
    }

    function test_fundRefusesRoleHolderRecipient() public {
        uint256[] memory keys = _keys();
        address treasurer = makeAddr("treasurer");
        address[] memory rh = new address[](1);
        rh[0] = treasurer;
        (VolunteerFund f,) = _fund(keys, _signers(), makeAddr("lead"), rh);
        bytes32 d = f.fundDigest(2, address(0), treasurer, 1 ether);
        vm.expectRevert(VolunteerFund.RecipientIsRoleHolder.selector);
        f.queue(2, address(0), treasurer, 1 ether, _sigs(keys, 15, d));
    }

    function test_fundCommitteeHandover() public {
        uint256[] memory keys = _keys();
        address[5] memory sg = _signers();
        (VolunteerFund f,) = _fund(keys, sg, makeAddr("lead"), new address[](0));
        address[] memory next = new address[](21);
        uint256[] memory nextKeys = new uint256[](21);
        for (uint256 i; i < 21; ++i) {
            nextKeys[i] = 5000 + i;
            next[i] = vm.addr(nextKeys[i]);
        }
        VolunteerFund.Handover memory h = _ho(2, 3, next, sg, makeAddr("lead2"), new address[](0));
        // handovers are numbered one by one
        VolunteerFund.Handover memory skipAhead = _ho(3, 3, next, sg, makeAddr("lead2"), new address[](0));
        bytes[] memory skipSigs = _sigs(keys, 15, f.committeeDigest(skipAhead));
        vm.expectRevert(VolunteerFund.StaleEpoch.selector);
        f.proposeCommittee(skipAhead, skipSigs);
        f.proposeCommittee(h, _sigs(keys, 15, f.committeeDigest(h)));
        // nothing changes before the 48-hour timelock
        vm.expectRevert(abi.encodeWithSelector(VolunteerFund.Timelocked.selector, block.timestamp + 48 hours));
        f.applyCommittee(h);
        skip(48 hours);
        // only the handover that was signed can be installed
        VolunteerFund.Handover memory other = _ho(2, 3, next, sg, makeAddr("someoneElse"), new address[](0));
        vm.expectRevert(VolunteerFund.WrongHandover.selector);
        f.applyCommittee(other);
        f.applyCommittee(h);
        assertEq(f.epoch(), 2);
        assertEq(f.psyrobEpoch(), 3);
        assertTrue(f.isCommittee(next[0]));
        assertTrue(f.isNgoMember(next[0]));
        assertFalse(f.isNgoMember(next[10]));
        assertFalse(f.isCommittee(vm.addr(keys[0])));
        bytes[] memory again = _sigs(nextKeys, 15, f.committeeDigest(h));
        vm.expectRevert(VolunteerFund.StaleEpoch.selector);
        f.proposeCommittee(h, again);
    }

    /// 15 signatures without 4 NGO members move nothing; a committee with fewer than 4 NGO seats is refused;
    /// a pending handover can be canceled by the Security Lead or by 2 signers.
    function test_fundNeedsNgoSignaturesAndHandoverCanBeCanceled() public {
        uint256[] memory keys = _keys();
        address[5] memory sg = _signers();
        address lead = makeAddr("lead");
        (VolunteerFund f, address[] memory committee) = _fund(keys, sg, lead, new address[](0));
        // signatures of the 15 miner seats (keys 6..20) only
        uint256[] memory miners = new uint256[](15);
        for (uint256 i; i < 15; ++i) miners[i] = keys[6 + i];
        address school = makeAddr("school");
        bytes32 d0 = f.fundDigest(0, address(0), school, 1 ether);
        bytes[] memory minerSigs = _sigs(miners, 15, d0);
        vm.expectRevert(abi.encodeWithSelector(VolunteerFund.NotEnoughNgoSignatures.selector, 0));
        f.queue(0, address(0), school, 1 ether, minerSigs);
        // 3 NGO + 12 miner signatures: still refused
        uint256[] memory three = new uint256[](15);
        for (uint256 i; i < 15; ++i) three[i] = i < 3 ? keys[i] : keys[6 + i - 3];
        bytes[] memory threeSigs = _sigs(three, 15, d0);
        vm.expectRevert(abi.encodeWithSelector(VolunteerFund.NotEnoughNgoSignatures.selector, 3));
        f.queue(0, address(0), school, 1 ether, threeSigs);
        // a committee with only 3 NGO seats cannot be installed
        VolunteerFund.Handover memory weak = _ho(2, 2, committee, sg, lead, new address[](0));
        for (uint256 i = 3; i < 6; ++i) weak.seats[i] = 2;
        f.proposeCommittee(weak, _sigs(keys, 15, f.committeeDigest(weak)));
        skip(48 hours);
        vm.expectRevert(VolunteerFund.BadCommittee.selector);
        f.applyCommittee(weak);
        // cancel by two signers
        vm.prank(sg[0]);
        f.cancelCommittee();
        assertTrue(f.pendingHandover() != bytes32(0));
        vm.prank(sg[1]);
        f.cancelCommittee();
        assertEq(f.pendingHandover(), bytes32(0));
        // cancel by the Security Lead alone
        VolunteerFund.Handover memory h = _ho(2, 2, committee, sg, lead, new address[](0));
        f.proposeCommittee(h, _sigs(keys, 15, f.committeeDigest(h)));
        vm.prank(lead);
        f.cancelCommittee();
        vm.expectRevert(VolunteerFund.NoPendingHandover.selector);
        f.applyCommittee(h);
    }

    function _sig(uint256 key, bytes32 d) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, d);
        return abi.encodePacked(r, s, v);
    }
}
