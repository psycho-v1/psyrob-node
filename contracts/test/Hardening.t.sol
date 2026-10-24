// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {FinalityTest} from "./Finality.t.sol";
import {Addrs} from "../src/Base.sol";
import {FinalityCommittee} from "../src/FinalityCommittee.sol";
import {RoleElection} from "../src/RoleElection.sol";
import {Attestation} from "../src/Attestation.sol";
import {NGOElection} from "../src/NGOElection.sol";
import {Sys} from "../src/Base.sol";
import {VolunteerFund} from "../src/bnb/VolunteerFund.sol";
import {stdStorage, StdStorage} from "forge-std/Test.sol";

/// Proof-of-concept exploits against committee reward settlement and bond withdrawal, and the other committee, role
/// and fund hardening rules, as regression tests.
contract HardeningTest is FinalityTest {
    using stdStorage for StdStorage;

    function _signers(address[] memory m, uint256 from, uint256 to) internal pure returns (address[] memory s) {
        s = new address[](to - from);
        for (uint256 i = from; i < to; ++i) s[i - from] = m[i];
    }

    function _epochWithPool(uint256 pool) internal returns (uint256 e, address[] memory m) {
        _setupNormal();
        skipTime(7 days);
        sealCommittee();
        e = fc.currentEpoch();
        m = fc.members(e);
        assertEq(m.length, 21);
        vm.deal(Addrs.FINALITY_COMMITTEE, address(fc).balance + pool);
        vm.prank(Addrs.SYSTEM);
        fc.notify(pool);
    }

    function _claimAll(uint256 e, address[] memory m) internal returns (uint256 paid) {
        for (uint256 i; i < m.length; ++i) {
            uint256 b = m[i].balance;
            vm.prank(m[i]);
            try fc.claimReward(e) {} catch {}
            paid += m[i].balance - b;
        }
    }

    /// PoC: settle(e) while committee e still signs, then more checkpoints for e signed by all 21. Without the
    /// settlement rule a 210 PSY pool would pay 294 PSY out of members' bonds.
    function test_cannotSettleWhileCommitteeStillSigns() public {
        (uint256 e, address[] memory m) = _epochWithPool(210 ether);
        vm.startPrank(Addrs.SYSTEM);
        for (uint256 n = 1; n <= 3; ++n) fc.recordCheckpoint(e, n, bytes32(n), _signers(m, 0, 15));
        vm.stopPrank();

        // epoch e+1 begins but its committee is not sealed: committee e still signs, so e cannot be settled
        skipTime(7 days);
        assertEq(fc.currentEpoch(), e + 1);
        vm.expectRevert(FinalityCommittee.NotSettleable.selector);
        fc.settle(e);
        vm.prank(m[0]);
        vm.expectRevert(FinalityCommittee.NotSettleable.selector);
        fc.claimReward(e);

        // committee e keeps signing: all 21 sign six more checkpoints, which count
        vm.startPrank(Addrs.SYSTEM);
        for (uint256 n = 4; n <= 9; ++n) fc.recordCheckpoint(e, n, bytes32(n), _signers(m, 0, 21));
        vm.stopPrank();

        // the next committee is sealed; settlement waits SETTLE_DELAY more
        sealCommittee();
        assertTrue(fc.retiredAt(e) != 0);
        vm.expectRevert(FinalityCommittee.NotSettleable.selector);
        fc.settle(e);
        skipTime(1 days);
        fc.settle(e);
        assertEq(fc.eligibleCount(e), 22); // all 21 signed at least half

        uint256 bondsHeld = 28 * 10_000 ether;
        uint256 paid = _claimAll(e, m);
        assertEq(paid, 210 ether);
        assertEq(fc.rewardPaid(e), 210 ether);
        assertGe(address(fc).balance, bondsHeld);
    }

    /// checkpoints recorded for an epoch after it is settled no longer change who earned a share.
    function test_lateCheckpointsAfterSettleDoNotCount() public {
        (uint256 e, address[] memory m) = _epochWithPool(210 ether);
        vm.startPrank(Addrs.SYSTEM);
        for (uint256 n = 1; n <= 3; ++n) fc.recordCheckpoint(e, n, bytes32(n), _signers(m, 0, 15));
        vm.stopPrank();
        skipTime(7 days);
        sealCommittee();
        skipTime(1 days);
        fc.settle(e);
        assertEq(fc.eligibleCount(e), 16);
        uint256 cps = fc.checkpointCount(e);

        // a late certificate for an old checkpoint of e, signed by everybody, is recorded but not counted
        vm.prank(Addrs.SYSTEM);
        fc.recordCheckpoint(e, 50, bytes32(uint256(50)), _signers(m, 0, 21));
        assertTrue(fc.checkpointRecorded(50));
        assertEq(fc.checkpointCount(e), cps);
        assertEq(fc.signedCount(e, m[20]), 0);

        uint256 paid = _claimAll(e, m);
        assertEq(paid, 15 * 14 ether);
        assertLe(paid, 210 ether);
    }

    /// nobody eligible at settlement: the pool goes to the Treasury and later claims revert instead of dividing
    /// by zero.
    function test_noEligibleMemberPoolToTreasury() public {
        (uint256 e, address[] memory m) = _epochWithPool(210 ether);
        skipTime(7 days);
        sealCommittee();
        skipTime(1 days);
        uint256 t = Addrs.TREASURY.balance;
        fc.settle(e);
        assertEq(Addrs.TREASURY.balance - t, 210 ether);
        vm.prank(m[0]);
        vm.expectRevert(FinalityCommittee.NotEligible.selector);
        fc.claimReward(e);
    }

    /// if no later committee is ever sealed, the epoch can still be settled two epochs later.
    function test_settleFallbackWithoutReplacement() public {
        (uint256 e, address[] memory m) = _epochWithPool(210 ether);
        vm.startPrank(Addrs.SYSTEM);
        for (uint256 n = 1; n <= 2; ++n) fc.recordCheckpoint(e, n, bytes32(n), _signers(m, 0, 21));
        vm.stopPrank();
        skipTime(7 days);
        assertFalse(fc.settleable(e));
        skipTime(7 days);
        assertTrue(fc.settleable(e));
        assertEq(_claimAll(e, m), 210 ether);
    }

    function _memberKey(uint256 e) internal view returns (address who, uint256 key) {
        for (uint256 i; i < miners.length; ++i) {
            if (fc.seatOf(e, miners[i]) != 0) return (miners[i], minerKeys[i]);
        }
        revert("no miner member");
    }

    function _equivocate(uint256 key)
        internal
        view
        returns (bytes memory a, bytes memory b)
    {
        (uint8 va, bytes32 ra, bytes32 sa) = vm.sign(key, fc.checkpointDigest(7, bytes32(uint256(1)), bytes32(uint256(11))));
        (uint8 vb, bytes32 rb, bytes32 sb) = vm.sign(key, fc.checkpointDigest(7, bytes32(uint256(2)), bytes32(uint256(22))));
        a = abi.encodePacked(ra, sa, va);
        b = abi.encodePacked(rb, sb, vb);
    }

    /// PoC: a member that equivocated requests unbonding at once and tries to withdraw after UNBOND_DELAY,
    /// before anyone reports it. The bond now stays locked until UNBOND_DELAY after its committee was replaced, and the
    /// report still slashes it.
    function test_equivocatorCannotWithdrawBeforeEvidenceWindowCloses() public {
        _setupNormal();
        skipTime(7 days);
        sealCommittee();
        uint256 e = fc.currentEpoch();
        (address who, uint256 key) = _memberKey(e);
        (bytes memory sigA, bytes memory sigB) = _equivocate(key);
        vm.prank(who);
        fc.requestUnbond();

        skipTime(7 days);
        sealCommittee(); // committee e replaced now
        uint256 replaced = fc.retiredAt(e);
        assertTrue(replaced != 0);
        skipTime(7 days);
        sealCommittee();
        // 14 days after requestUnbond (the old exploit): still inside the evidence window
        vm.prank(who);
        vm.expectRevert(FinalityCommittee.TooEarly.selector);
        fc.withdrawBond();

        address reporter = makeAddr("reporter");
        vm.prank(reporter);
        fc.reportEquivocation(e, 7, bytes32(uint256(1)), bytes32(uint256(11)), sigA, bytes32(uint256(2)), bytes32(uint256(22)), sigB);
        assertEq(reporter.balance, 1_000 ether);
        assertTrue(fc.slashed(e, who));
        vm.prank(who);
        vm.expectRevert(FinalityCommittee.NotBonded.selector);
        fc.withdrawBond();
    }

    /// an honest member gets its bond back once the evidence window after its last committee has closed.
    function test_honestMemberWithdrawsAfterEvidenceWindow() public {
        _setupNormal();
        skipTime(7 days);
        sealCommittee();
        uint256 e = fc.currentEpoch();
        (address who,) = _memberKey(e);
        vm.prank(who);
        fc.requestUnbond();
        // UNBOND_DELAY passes but no later committee has been sealed: committee e still signs, so StillServing
        skipTime(14 days);
        vm.prank(who);
        vm.expectRevert(FinalityCommittee.StillServing.selector);
        fc.withdrawBond();
        sealCommittee();
        uint256 r = fc.retiredAt(e);
        warpTo(r + 14 days - 1);
        vm.prank(who);
        vm.expectRevert(FinalityCommittee.TooEarly.selector);
        fc.withdrawBond();
        warpTo(r + 14 days);
        uint256 b = who.balance;
        vm.prank(who);
        fc.withdrawBond();
        assertEq(who.balance - b, 10_000 ether);
    }

    /// a bonded address that never sat on a committee leaves after the plain UNBOND_DELAY.
    function test_nonMemberWithdrawsAfterUnbondDelay() public {
        _setupNormal();
        skipTime(7 days);
        sealCommittee();
        uint256 e = fc.currentEpoch();
        address idle;
        for (uint256 i; i < miners.length; ++i) {
            if (fc.seatOf(e, miners[i]) == 0) { idle = miners[i]; break; }
        }
        assertTrue(idle != address(0));
        assertEq(fc.lastServed(idle), 0);
        vm.prank(idle);
        fc.requestUnbond();
        skipTime(14 days);
        uint256 b = idle.balance;
        vm.prank(idle);
        fc.withdrawBond();
        assertEq(idle.balance - b, 10_000 ether);
    }

    /// the scan over every bonded address no longer runs on every block: running totals reject early, and the
    /// full check runs at most once per 30 blocks, so the freeze still happens, just up to 30 blocks later.
    function test_freezeScanThrottled() public {
        ngos = electFirst(60);
        uint256 e1 = fc.currentEpoch() + 1;
        warpTo(G + e1 * 7 days + 1 hours); // under a day into the epoch: 15 candidates are not enough yet
        for (uint256 i; i < 6; ++i) {
            vm.deal(ngos[i], 20_000 ether);
            vm.prank(ngos[i]);
            fc.bond{value: 10_000 ether}();
        }
        _bondMiners(9);
        assertEq(fc.ngoCandidates(), 6);
        assertEq(fc.minerCandidates(), 9);
        advanceAll();
        uint256 checked = fc.lastFreezeCheck();
        assertEq(checked, block.number);
        (FinalityCommittee.EpochDraw memory d,) = fc.epochDraw(e1);
        assertEq(d.freezeBlock, 0);
        vm.roll(block.number + 1);
        advanceAll();
        assertEq(fc.lastFreezeCheck(), checked); // no scan in the next block
        skipTime(1 days); // now ready, but still inside the 30-block window
        advanceAll();
        (d,) = fc.epochDraw(e1);
        assertEq(d.freezeBlock, 0);
        vm.roll(checked + 30);
        advanceAll();
        (d,) = fc.epochDraw(e1);
        assertEq(d.freezeBlock, block.number);
    }

    /// the running totals follow bonds that leave or are slashed.
    function test_runningTotalsFollowUnbond() public {
        _setupNormal();
        assertEq(fc.ngoCandidates(), 8);
        assertEq(fc.minerCandidates(), 20);
        vm.prank(ngos[0]);
        fc.requestUnbond();
        vm.prank(miners[0]);
        fc.requestUnbond();
        assertEq(fc.ngoCandidates(), 7);
        assertEq(fc.minerCandidates(), 19);
    }

    function _electRole(address[] memory voters, address who) internal {
        uint256 id = roles.open(0); // opened by advance() already, or now
        vm.deal(who, who.balance + 100 ether);
        vm.prank(who);
        roles.stand{value: 100 ether}(id);
        skipTime(14 days);
        for (uint256 i; i < 5; ++i) {
            vm.prank(voters[i]);
            roles.vote(id, who);
        }
        skipTime(14 days);
    }

    /// a Treasury short of PSY no longer blocks the handover to a newly elected role holder; the outgoing
    /// holder's final pay is deferred and claimable once the Treasury is refilled. Due rounds open by themselves.
    function test_installSucceedsWhenTreasuryShort() public {
        address[] memory voters = electFirst(60);
        address a = makeAddr("roleA");
        address b = makeAddr("roleB");
        _electRole(voters, a);
        advanceAll();
        assertTrue(roles.isRoleHolder(a));
        assertEq(roles.openRoundOf(0), 0);

        // 28 days before A's term ends the next round opens without anyone calling open(). (That moment falls right
        // after the first NGO term ends, before the next NGO election is final; the NGO election is not under test
        // here, so it is mocked as still having 60 elected NGOs.)
        skipTime(365 days - 28 days);
        vm.mockCall(Addrs.NGO_ELECTION, abi.encodeWithSignature("electedCount()"), abi.encode(uint256(60)));
        vm.mockCall(Addrs.NGO_ELECTION, abi.encodeWithSignature("isElected(address)"), abi.encode(true));
        advanceAll();
        assertTrue(roles.openRoundOf(0) != 0);
        _electRole(voters, b);
        vm.deal(Addrs.TREASURY, 0); // the Treasury cannot pay A's final pay
        advanceAll();
        assertTrue(roles.isRoleHolder(b));
        assertFalse(roles.isRoleHolder(a));
        uint256 owedA = roles.deferredPay(a);
        assertEq(owedA, uint256(2_000 ether) * 365 days / 30 days);

        vm.expectRevert(); // still short
        roles.claimDeferredPay(a);
        vm.deal(Addrs.TREASURY, 1_000_000 ether);
        uint256 before = a.balance;
        roles.claimDeferredPay(a);
        assertEq(a.balance - before, owedA);
        assertEq(roles.deferredPay(a), 0);
        vm.expectRevert(RoleElection.NothingToClaim.selector);
        roles.claimDeferredPay(a);
    }

    /// an attested NGO that is not elected can have its attestation revoked by governance; it can then no longer
    /// stand. An elected NGO must go through the Removal path.
    function test_governorRevokesAttestedNotElectedNGO() public {
        address[] memory elected = electFirst(60);
        address extra = attestedNGO("extra");
        assertEq(reg.status(extra), 2);
        vm.expectRevert(Sys.OnlyGovernor.selector);
        att.revoke(extra, keccak256("stale"));
        vm.prank(Addrs.GOVERNOR);
        vm.expectRevert(Attestation.ElectedUseRemoval.selector);
        att.revoke(elected[0], keccak256("x"));
        vm.prank(Addrs.GOVERNOR);
        att.revoke(extra, keccak256("stale"));
        assertEq(reg.status(extra), 3);
        vm.prank(Addrs.GOVERNOR);
        vm.expectRevert(Attestation.NotAttested.selector);
        att.revoke(extra, keccak256("stale"));
        (, uint256 roundId) = _openNGORound();
        vm.prank(extra);
        vm.expectRevert(NGOElection.NotAttested.selector);
        el.stand(roundId);
    }

    function _openNGORound() internal view returns (bool, uint256) {
        uint256 n = el.roundCount();
        return (n > 0, n - 1);
    }

    /// a Governor proposal calling revoke needs the high floor, like any proposal targeting Attestation.
    function test_revokeProposalNeedsHighFloor() public {
        electFirst(60);
        address extra = attestedNGO("extra2");
        address p = voter("proposer", 10_000 ether);
        address[] memory t = new address[](1);
        t[0] = Addrs.ATTESTATION;
        uint256[] memory v = new uint256[](1);
        bytes[] memory d = new bytes[](1);
        d[0] = abi.encodeCall(Attestation.revoke, (extra, keccak256("stale")));
        vm.prank(p);
        uint256 id = gov.propose(0, t, v, d, "revoke a stale attestation");
        assertTrue(gov.highFloor(id));
        (,, uint256 minVoters) = gov.quorumOf(id);
        assertEq(minVoters, 100);
    }

    /// an approval by a signer that a committee handover replaced no longer counts.
    function test_replacedSignerApprovalDoesNotCount() public {
        uint256[] memory keys = _keys();
        address[5] memory sg = _signers();
        (VolunteerFund f, address[] memory committee) = _fund(keys, sg, makeAddr("lead"), new address[](0));
        address school = makeAddr("school");
        f.queue(0, address(0), school, 1 ether, _sigs(keys, 15, f.fundDigest(0, address(0), school, 1 ether)));
        for (uint256 i; i < 3; ++i) {
            vm.prank(sg[i]);
            f.approve(0);
        }
        assertEq(f.approvalsOf(0), 3);
        // signer 0 is replaced
        address[5] memory next = sg;
        next[0] = makeAddr("newSigner");
        _handover(f, keys, _ho(2, 2, committee, next, makeAddr("lead"), new address[](0)));
        assertEq(f.approvalsOf(0), 2);
        skip(48 hours);
        vm.expectRevert(VolunteerFund.NotEnoughApprovals.selector);
        f.execute(0);
        vm.prank(next[3]);
        f.approve(0);
        f.execute(0);
        assertEq(school.balance, 1 ether);
    }

    /// a deposit just before queuing does not turn a large transfer into a 48-hour one, and queued transfers
    /// count as already spent.
    function test_depositBeforeQueueDoesNotShortenTimelock() public {
        uint256[] memory keys = _keys();
        (VolunteerFund f,) = _fund(keys, _signers(), makeAddr("lead"), new address[](0)); // 100 ether
        address a = makeAddr("a");
        address b = makeAddr("b");
        // first transfer records the mark: 100 free
        f.queue(0, address(0), a, 1 ether, _sigs(keys, 15, f.fundDigest(0, address(0), a, 1 ether)));
        (,,, uint64 eta,,,,) = f.transfers(0);
        assertEq(eta, block.timestamp + 48 hours);
        assertEq(f.pending(address(0)), 1 ether);
        // someone deposits 1,000 ether, then a 10 ether transfer is queued: 10 is 1 % of the new balance but 10 % of
        // the earlier free balance, so it gets 72 hours
        vm.deal(address(this), 1_000 ether);
        (bool ok,) = address(f).call{value: 1_000 ether}("");
        assertTrue(ok);
        skip(1 hours);
        f.queue(1, address(0), b, 10 ether, _sigs(keys, 15, f.fundDigest(1, address(0), b, 10 ether)));
        (,,, eta,,,,) = f.transfers(1);
        assertEq(eta, block.timestamp + 72 hours);
        // canceling releases the pending amount
        vm.prank(makeAddr("lead"));
        f.cancel(1);
        assertEq(f.pending(address(0)), 1 ether);
    }

    // ---- commit-reveal beacon ----

    function _layer(bytes32 secret, uint256 i) internal pure returns (bytes32 x) {
        x = secret;
        for (uint256 k; k < i; ++k) x = keccak256(abi.encode(x));
    }

    function _secret(address a) internal pure returns (bytes32) {
        return keccak256(abi.encode("onion", a));
    }

    /// All members of committee e commit to a 3-layer onion now.
    function _commitAll(uint256 e) internal returns (address[] memory m) {
        m = fc.members(e);
        for (uint256 i; i < m.length; ++i) {
            vm.prank(m[i]);
            fc.commitBeacon(_layer(_secret(m[i]), 3));
        }
        vm.roll(block.number + 1);
    }

    function _rotationWithBeacon() internal returns (uint256 e0, uint256 e1, address[] memory m, uint256 round) {
        _setupNormal();
        skipTime(7 days);
        sealCommittee(); // first committee: block source (no committee exists to reveal)
        e0 = fc.currentEpoch();
        m = _commitAll(e0);
        skipTime(7 days);
        advanceAll(); // freeze: opens a beacon round revealed by committee e0
        e1 = fc.currentEpoch();
        round = fc.beaconCount() - 1;
        FinalityCommittee.BeaconRound memory b = fc.beacon(round);
        assertEq(b.epoch, e0);
        assertEq(b.requestBlock, block.number);
    }

    /// the next committee is seeded by the committee's beacon, which no miner can influence.
    function test_rotationSeededByBeacon() public {
        (, uint256 e1, address[] memory m, uint256 round) = _rotationWithBeacon();
        bytes32 mix = fc.beacon(round).mix;
        for (uint256 i; i < m.length; ++i) {
            bytes32 layer = _layer(_secret(m[i]), 2);
            vm.prank(m[i]);
            fc.revealBeacon(round, layer);
            mix = keccak256(abi.encode(mix, m[i], layer));
        }
        advanceAll();
        assertEq(fc.members(e1).length, 0); // window still open
        vm.roll(uint256(fc.beacon(round).requestBlock) + fc.BEACON_WINDOW() + 1);
        advanceAll();
        assertTrue(fc.beacon(round).closed);
        assertEq(fc.beacon(round).mix, mix);
        assertEq(fc.members(e1).length, 21);
        (FinalityCommittee.EpochDraw memory d,) = fc.epochDraw(e1);
        assertEq(d.sourceKind, fc.SOURCE_BEACON());
        assertEq(d.sourceRef, round);
        assertEq(fc.seedOf(e1), keccak256(abi.encode(mix, e1)));
    }

    /// reveal rules: only the next layer, only members of the revealing committee, only commitments made before
    /// the round opened, only inside the window.
    function test_revealRules() public {
        (,, address[] memory m, uint256 round) = _rotationWithBeacon();
        vm.prank(m[0]);
        vm.expectRevert(FinalityCommittee.WrongLayer.selector);
        fc.revealBeacon(round, _layer(_secret(m[0]), 1)); // skips a layer
        vm.prank(makeAddr("outsider"));
        vm.expectRevert(FinalityCommittee.NotABeaconMember.selector);
        fc.revealBeacon(round, bytes32(uint256(1)));
        // a member that commits again after the round opened cannot take part in it, and is counted as silent
        assertFalse(fc.missedReveal(fc.beacon(round).epoch, m[1]));
        vm.prank(m[1]);
        fc.commitBeacon(_layer(keccak256("new"), 3));
        assertTrue(fc.missedReveal(fc.beacon(round).epoch, m[1]));
        vm.prank(m[1]);
        vm.expectRevert(FinalityCommittee.NoCommitment.selector);
        fc.revealBeacon(round, _layer(keccak256("new"), 2));
        vm.prank(m[2]);
        fc.revealBeacon(round, _layer(_secret(m[2]), 2));
        vm.prank(m[2]);
        vm.expectRevert(FinalityCommittee.AlreadyRevealed.selector);
        fc.revealBeacon(round, _layer(_secret(m[2]), 1));
        vm.roll(block.number + fc.BEACON_WINDOW() + 1);
        vm.prank(m[3]);
        vm.expectRevert(FinalityCommittee.RevealClosed.selector);
        fc.revealBeacon(round, _layer(_secret(m[3]), 2));
    }

    /// a member that committed and stayed silent forfeits the epoch's committee reward; nobody revealing makes the
    /// draw fall back to the checkpoint source.
    function test_silentMemberForfeitsRewardAndDrawFallsBack() public {
        (uint256 e0, uint256 e1, address[] memory m, uint256 round) = _rotationWithBeacon();
        vm.roll(block.number + fc.BEACON_WINDOW() + 1);
        advanceAll();
        assertTrue(fc.beacon(round).closed);
        assertEq(fc.beacon(round).reveals, 0);
        for (uint256 i; i < m.length; ++i) assertTrue(fc.missedReveal(e0, m[i]));
        (FinalityCommittee.EpochDraw memory d,) = fc.epochDraw(e1);
        assertEq(d.sealBlock, 0);
        assertEq(d.seedBlock, block.number + fc.SEED_DELAY()); // fell back
        // committee e0 signed every checkpoint but stayed silent: no reward
        vm.prank(Addrs.SYSTEM);
        fc.recordCheckpoint(e0, 900, bytes32(uint256(900)), m);
        sealCommittee();
        skipTime(1 days);
        vm.prank(m[0]);
        vm.expectRevert(FinalityCommittee.NotEligible.selector);
        fc.claimReward(e0);
    }

    // ---- NGO signatures and the weight window ----

    function test_ngoSignaturesRequired() public {
        _setupNormal();
        skipTime(7 days);
        sealCommittee();
        uint256 e = fc.currentEpoch();
        assertEq(fc.activeNgoMembers(e).length, 6);
        assertEq(fc.ngoSignaturesRequired(e), 4);
        assertEq(fc.MIN_NGO_SIGNATURES(), 4);
        // with only 3 NGO members active, all 3 must sign
        address[] memory ngoM = fc.activeNgoMembers(e);
        for (uint256 i; i < 3; ++i) _slash(e, ngoM[i]);
        assertEq(fc.activeNgoMembers(e).length, 3);
        assertEq(fc.ngoSignaturesRequired(e), 3);
    }

    function _slash(uint256 e, address who) internal {
        // NGO members' keys are not held by the fixture: mark them slashed in storage (slashed[e][who] = true)
        stdstore.target(address(fc)).sig("slashed(uint256,address)").with_key(e).with_key(who).checked_write(true);
        assertTrue(fc.slashed(e, who));
    }

    /// a miner's seat weight counts blue blocks over the last 4 epochs, so a burst in one week buys a quarter of
    /// what steady mining over the window does, and work from before the window counts nothing.
    function test_weightOverFourEpochs() public {
        _setupNormal(); // 20 miners, 50 blocks each, in the current epoch (outside the window below)
        uint256 e0 = fc.currentEpoch();
        address steady = miners[0];
        address burst = makeAddr("burst");
        for (uint256 w; w < 4; ++w) {
            skipTime(7 days);
            for (uint256 i = 1; i < miners.length; ++i) mine(miners[i], 20); // 380 blocks a week from the others
            if (w < 3) mine(steady, 10);
        }
        mine(burst, 400); // rented in the last week only
        vm.prank(burst);
        mr.register(bytes32(0));
        vm.deal(burst, 20_000 ether);
        vm.prank(burst);
        fc.bond{value: 10_000 ether}();
        skipTime(7 days);
        uint256 e = fc.currentEpoch();
        assertEq(e, e0 + 5);
        advanceAll(); // freeze
        (, FinalityCommittee.Frozen[] memory f) = fc.epochDraw(e);
        uint256 total;
        for (uint256 x = e - 4; x < e; ++x) total += mr.epochBlocks(x);
        assertEq(total, 4 * 380 + 30 + 400); // epoch e0's blocks are outside the window
        uint256 cap = total * fc.MINER_WEIGHT_CAP_BPS() / 10_000; // 97
        bool seenSteady;
        bool seenBurst;
        for (uint256 i; i < f.length; ++i) {
            if (f[i].who == steady) { assertEq(f[i].weight, 30); seenSteady = true; }
            if (f[i].who == burst) { assertEq(f[i].weight, cap); seenBurst = true; }
        }
        assertTrue(seenSteady && seenBurst);
    }
}
