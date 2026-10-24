// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {FinalityTest} from "./Finality.t.sol";
import {Addrs, C, IFinalityCommitteeSeats} from "../src/Base.sol";
import {FinalityCommittee} from "../src/FinalityCommittee.sol";
import {UpgradeRegistry} from "../src/UpgradeRegistry.sol";
import {Attestation} from "../src/Attestation.sol";
import {NGOElection} from "../src/NGOElection.sol";
import {EmergencyPause} from "../src/EmergencyPause.sol";
import {NGORewards} from "../src/NGORewards.sol";
import {Governor} from "../src/Governor.sol";

/// Bootstrap finality and the governance safety rules: committee NGO candidates, council node plans and sunset,
/// Normal-mode grace, challenge lapse, the voter-count floor, the streamed pre-election pot and the pause rules.
contract RulesTest is FinalityTest {
    bytes32 constant REASON = keccak256("exploit in a contract");

    function _retireCouncil() internal {
        vm.mockCall(Addrs.NGO_ELECTION, abi.encodeWithSelector(NGOElection.electedCount.selector), abi.encode(uint256(60)));
        vm.prank(Addrs.SYSTEM);
        council.advance();
        vm.clearMockedCalls();
    }

    // ---- bootstrap finality ----

    /// The genesis names the bootstrap signers; they count until the first committee is sealed, then never again.
    function test_bootstrapSignersUntilTheFirstSeal() public {
        assertTrue(fc.bootstrapActive());
        address[] memory b = fc.bootstrapSigners();
        assertEq(b.length, 1);
        assertEq(b[0], bootstrapSigner);
        assertTrue(fc.isBootstrapSigner(bootstrapSigner));
        assertEq(fc.BOOTSTRAP_EPOCH(), 2 ** 48 - 1);
        _setupNormal();
        skipTime(7 days);
        sealCommittee();
        assertTrue(fc.members(fc.currentEpoch()).length > 0);
        assertFalse(fc.bootstrapActive());
        assertEq(fc.bootstrapSigners().length, 0, "the bootstrap path ends with the first seal");
        assertEq(fc.genesisBootstrapSigners()[0], bootstrapSigner, "the genesis list stays readable");
        // a bootstrap certificate can still be recorded for rewards bookkeeping without harm
        uint256 boot = fc.BOOTSTRAP_EPOCH(); // read first: a view call would use up vm.prank
        vm.prank(Addrs.SYSTEM);
        fc.recordCheckpoint(boot, 999, keccak256("cp"), new address[](0));
        assertEq(fc.checkpointBlock(999), keccak256("cp"));
    }

    function test_bootstrapListMustBeValid() public {
        address[] memory none = new address[](0);
        vm.expectRevert(FinalityCommittee.NoBootstrapSigners.selector);
        new FinalityCommittee(none, 1);
        address[] memory dup = new address[](2);
        dup[0] = makeAddr("a");
        dup[1] = dup[0];
        vm.expectRevert(FinalityCommittee.NoBootstrapSigners.selector);
        new FinalityCommittee(dup, 1);
    }

    // ---- no committee without NGO signatures ----

    function test_noFreezeWithoutFourNgoCandidates() public {
        ngos = electFirst(60);
        _bondMiners(18); // 18 miner candidates, 0 NGO: enough for the quorum of 15
        skipTime(2 days); // past the one-day fallback
        advanceAll();
        (FinalityCommittee.EpochDraw memory d,) = fc.epochDraw(fc.currentEpoch());
        assertEq(d.freezeBlock, 0, "15+ miners alone cannot form a committee");
        for (uint256 i; i < 3; ++i) {
            vm.deal(ngos[i], 20_000 ether);
            vm.prank(ngos[i]);
            fc.bond{value: 10_000 ether}();
        }
        vm.roll(vm.getBlockNumber() + 31);
        advanceAll();
        (d,) = fc.epochDraw(fc.currentEpoch());
        assertEq(d.freezeBlock, 0, "3 NGO candidates are not enough");
        vm.deal(ngos[3], 20_000 ether);
        vm.prank(ngos[3]);
        fc.bond{value: 10_000 ether}();
        vm.roll(vm.getBlockNumber() + 31);
        advanceAll();
        (d,) = fc.epochDraw(fc.currentEpoch());
        assertEq(d.freezeBlock, block.number, "with 4 NGO candidates the draw freezes");
    }

    // ---- bounded council node plans, release named at submission, sunset ----

    function test_councilNodePlansMoveOneStep() public {
        assertTrue(upgrades.oneStep(10_000_001));
        assertTrue(upgrades.oneStep(10_001_000));
        assertFalse(upgrades.oneStep(10_000_002));
        assertFalse(upgrades.oneStep(10_001_001));
        assertFalse(upgrades.oneStep(11_000_000));
        assertFalse(upgrades.oneStep(999_999_999));
        // an absurd version cannot be approved by the council
        uint256 id = upgrades.submit(1, address(0), address(0), 999_999_999, bytes20(uint160(1)), keccak256("sums"), "halt");
        vm.prank(councilKeys[0]);
        uint256 a = council.propose(0, address(0), 0, id);
        vm.prank(councilKeys[1]);
        vm.expectRevert(UpgradeRegistry.BadVersion.selector);
        council.approve(a);
        // a node plan must name its commit when it is submitted
        vm.expectRevert(UpgradeRegistry.BadVersion.selector);
        upgrades.submit(1, address(0), address(0), 10_000_001, bytes20(0), keccak256("sums"), "no commit");
        // the next patch is fine
        uint256 ok = upgrades.submit(1, address(0), address(0), 10_000_001, bytes20(uint160(1)), keccak256("sums"), "10.0.1");
        vm.prank(councilKeys[0]);
        a = council.propose(0, address(0), 0, ok);
        vm.prank(councilKeys[1]);
        council.approve(a);
        assertEq(upgrades.getPlan(ok).state, 1);
    }

    function test_councilRetiresAfterTwelveMonthsWithoutNGOs() public {
        advanceAll();
        assertFalse(council.retired());
        warpTo(G + 365 days - 1);
        advanceAll();
        assertFalse(council.retired());
        warpTo(G + 365 days);
        advanceAll();
        assertTrue(council.retired(), "hard sunset");
        assertEq(el.electedCount(), 0);
    }

    // ---- Normal mode keeps a 30-day grace; removals cannot go below 60 ----

    function test_normalModeSurvivesAShortDipBelowSixty() public {
        warpTo(G + 91 days);
        vm.mockCall(Addrs.NGO_ELECTION, abi.encodeWithSelector(NGOElection.electedCount.selector), abi.encode(uint256(60)));
        advanceAll();
        assertEq(modeC.mode(), 1);
        assertTrue(modeC.normalReached());
        vm.mockCall(Addrs.NGO_ELECTION, abi.encodeWithSelector(NGOElection.electedCount.selector), abi.encode(uint256(59)));
        assertEq(modeC.mode(), 1, "the dip is not yet recorded: still Normal");
        advanceAll();
        assertEq(modeC.belowSince(), vm.getBlockTimestamp());
        skipTime(29 days);
        assertEq(modeC.mode(), 1, "29 days below 60: still Normal");
        skipTime(1 days);
        assertEq(modeC.mode(), 2, "30 days below 60: Interim");
        // back to 60: Normal again, and the dip counter resets
        vm.mockCall(Addrs.NGO_ELECTION, abi.encodeWithSelector(NGOElection.electedCount.selector), abi.encode(uint256(60)));
        advanceAll();
        assertEq(modeC.mode(), 1);
        assertEq(modeC.belowSince(), 0);
        vm.clearMockedCalls();
    }

    function test_removalCannotTakeTheCountBelowSixty() public {
        address[] memory sixty = electFirst(60);
        vm.prank(Addrs.GOVERNOR);
        vm.expectRevert(NGOElection.WouldLeaveTooFew.selector);
        el.remove(sixty[0], keccak256("fraud"));
    }

    // ---- undecided challenges lapse; a dismissed challenger cannot challenge again ----

    function _vouched(string memory name) internal returns (address ngo) {
        ngo = newMiner(name, 20);
        mintNGO(ngo);
        address[5] memory vs = nextVouchers();
        for (uint256 j; j < 5; ++j) {
            vm.prank(vs[j]);
            att.vouch{value: 1_000 ether}(ngo);
        }
    }

    function test_undecidedChallengeLapsesAndTheNgoCanBeFinalised() public {
        address ngo = _vouched("lapseNgo");
        address griefer = makeAddr("griefer");
        vm.deal(griefer, 10_000 ether);
        vm.prank(griefer);
        att.challenge{value: 1_000 ether}(ngo, keccak256("no reason"));
        skipTime(7 days);
        vm.expectRevert(Attestation.ChallengePending.selector);
        att.finalize(ngo);
        vm.expectRevert(Attestation.TooEarly.selector);
        att.lapse(ngo);
        skipTime(7 days); // 14 days after the challenge, nobody decided (no NGOs are elected yet)
        att.lapse(ngo);
        assertEq(griefer.balance, 10_000 ether, "the bond comes back");
        att.finalize(ngo); // the window had already ended
        assertEq(reg.status(ngo), 2);
    }

    function test_dismissedChallengerIsBarred() public {
        address ngo = _vouched("barNgo");
        address griefer = makeAddr("griefer2");
        vm.deal(griefer, 10_000 ether);
        vm.prank(griefer);
        att.challenge{value: 1_000 ether}(ngo, keccak256("no reason"));
        vm.prank(Addrs.GOVERNOR);
        att.governorDecide(ngo, false);
        assertTrue(att.challengeBarred(ngo, griefer));
        vm.prank(griefer);
        vm.expectRevert(Attestation.ChallengeBarred.selector);
        att.challenge{value: 1_000 ether}(ngo, keccak256("again"));
    }

    // ---- the voter-count path needs 1 % of the locked PSY ----

    function test_hundredSmallWalletsNoLongerPassAlone() public {
        voter("big", 1_000_000 ether);
        address p = voter("proposer", 10_000 ether);
        address[] memory small = new address[](100);
        for (uint256 i; i < 100; ++i) small[i] = voter(string(abi.encodePacked("w", vm.toString(i))), 100 ether);
        address[] memory t = new address[](1);
        t[0] = address(reg);
        uint256[] memory v = new uint256[](1);
        bytes[] memory d = new bytes[](1);
        vm.prank(p);
        uint256 id = gov.propose(0, t, v, d, "100 wallets of 100 PSY");
        vm.roll(vm.getBlockNumber() + 1);
        for (uint256 i; i < 100; ++i) {
            vm.prank(small[i]);
            gov.vote(id, 1);
        }
        assertEq(gov.lockedYesVoters(id), 100);
        assertFalse(gov.passes(id), "10,000 PSY yes is under 1 % of the locked PSY");
    }

    // ---- the pre-election NGO pot is streamed over one term ----

    function test_preElectionPotIsStreamed() public {
        vm.startPrank(Addrs.SYSTEM);
        vm.deal(address(rewards), 1_000_000 ether);
        rewards.notify(1_000_000 ether); // no NGO elected: held
        vm.stopPrank();
        assertEq(rewards.undistributed(), 1_000_000 ether);
        vm.mockCall(Addrs.NGO_ELECTION, abi.encodeWithSelector(NGOElection.electedCount.selector), abi.encode(uint256(10)));
        vm.mockCall(Addrs.NGO_ELECTION, abi.encodeWithSelector(NGOElection.currentTerm.selector), abi.encode(uint256(1)));
        vm.prank(Addrs.SYSTEM);
        rewards.notify(10 ether); // first NGOs elected: the pot starts streaming, nothing of it paid yet
        assertEq(rewards.streamPot(), 1_000_000 ether);
        assertEq(rewards.accPerNGO(1), 1 ether * 1e18, "only the new 10 PSY, 1 per NGO");
        skipTime(365 days / 4);
        vm.prank(Addrs.SYSTEM);
        rewards.notify(0);
        assertEq(rewards.streamed(), 250_000 ether, "a quarter after a quarter of the term");
        skipTime(365 days);
        vm.prank(Addrs.SYSTEM);
        rewards.notify(0);
        assertEq(rewards.streamed(), 1_000_000 ether, "all of it after the term, never more");
        vm.clearMockedCalls();
    }

    // ---- committee pause rules ----

    function _mockCommittee(uint256 e, address[] memory m) internal {
        vm.mockCall(Addrs.FINALITY_COMMITTEE, abi.encodeWithSelector(IFinalityCommitteeSeats.currentEpoch.selector), abi.encode(e));
        for (uint256 i; i < m.length; ++i) {
            vm.mockCall(Addrs.FINALITY_COMMITTEE, abi.encodeWithSelector(IFinalityCommitteeSeats.seatOf.selector, e, m[i]), abi.encode(uint8(i < 6 ? 1 : 2)));
            vm.mockCall(Addrs.FINALITY_COMMITTEE, abi.encodeWithSelector(IFinalityCommitteeSeats.slashed.selector, e, m[i]), abi.encode(false));
        }
    }

    function _members() internal returns (address[] memory m) {
        m = new address[](21);
        for (uint256 i; i < 21; ++i) m[i] = makeAddr(string(abi.encodePacked("pm", vm.toString(i))));
    }

    function test_committeePausesOnlyAfterTheHandoverAndTheCouncilLiftsOnlyItsOwn() public {
        address[] memory m = _members();
        _mockCommittee(7, m);
        vm.prank(m[0]);
        vm.expectRevert(EmergencyPause.CouncilStillActive.selector);
        pauser.committeeVote(address(0), REASON);
        // before the handover the council lifts only its own pauses, not a DAO pause
        vm.prank(Addrs.GOVERNOR);
        pauser.daoPause(Addrs.VOTE_ESCROW, REASON, 5 days);
        vm.prank(Addrs.DEV_COUNCIL);
        vm.expectRevert(EmergencyPause.NotTheCouncilsPause.selector);
        pauser.unpauseByCouncil(Addrs.VOTE_ESCROW);
        // a committee pause after the handover is not the council's to lift
        _retireCouncil();
        _mockCommittee(7, m);
        for (uint256 i; i < 14; ++i) {
            vm.prank(m[i]);
            pauser.committeeVote(Addrs.NGO_REWARDS, REASON);
        }
        assertTrue(pauser.blocked(Addrs.NGO_REWARDS));
        vm.prank(Addrs.DEV_COUNCIL);
        vm.expectRevert(EmergencyPause.OnlyCouncil.selector); // retired, and in any case not its pause
        pauser.unpauseByCouncil(Addrs.NGO_REWARDS);
    }

    function test_requestKeepsItsCommitteeAcrossAnEpochChangeAndOpeningIsLimited() public {
        _retireCouncil();
        address[] memory m = _members();
        _mockCommittee(7, m);
        for (uint256 i; i < 10; ++i) {
            vm.prank(m[i]);
            pauser.committeeVote(address(0), REASON);
        }
        // the epoch changes: the members seated at the first vote keep voting on the same request
        address[] memory nobody = new address[](0);
        _mockCommittee(8, nobody);
        for (uint256 i = 10; i < 14; ++i) {
            vm.prank(m[i]);
            pauser.committeeVote(address(0), REASON);
        }
        assertTrue(pauser.networkPaused(), "votes across the epoch change added up");
        assertEq(pauser.requestCount(), 1);
        // one member opens at most 3 requests per 6 hours
        _mockCommittee(9, m);
        for (uint256 i; i < 3; ++i) {
            vm.prank(m[20]);
            pauser.committeeVote(Addrs.MINER_REGISTRY, keccak256(abi.encode("reason", i)));
        }
        vm.prank(m[20]);
        vm.expectRevert(EmergencyPause.TooManyRequests.selector);
        pauser.committeeVote(Addrs.MINER_REGISTRY, keccak256("a fourth reason"));
        vm.clearMockedCalls();
    }

    // ---- the /register/ngo page: MinerRegistry.registerNgoMiner ----

    function test_registerNgoMinerRecordsTheNameOncePerNgo() public {
        address a = makeAddr("ngoMinerA");
        address b = makeAddr("ngoMinerB");
        vm.prank(a);
        vm.expectRevert(bytes4(keccak256("NeverMined()")));
        mr.registerNgoMiner("Clean Water Foundation", "");
        mine(a, 1);
        mine(b, 1);
        vm.prank(a);
        vm.expectRevert(bytes4(keccak256("BadName()")));
        mr.registerNgoMiner("", "no name");
        vm.prank(a);
        mr.registerNgoMiner("Clean Water Foundation", "Wells in two villages.");
        assertTrue(mr.isRegistered(a));
        assertEq(mr.ngoName(a), "Clean Water Foundation");
        assertEq(mr.ngoNameHolder(mr.nameKey("clean water foundation")), a);
        // one miner address per NGO: the same name in another case is taken
        vm.prank(b);
        vm.expectRevert(bytes4(keccak256("NameTaken()")));
        mr.registerNgoMiner("CLEAN WATER FOUNDATION", "");
        vm.prank(a);
        vm.expectRevert(bytes4(keccak256("AlreadyRegistered()")));
        mr.register(bytes32(0));
    }
}
