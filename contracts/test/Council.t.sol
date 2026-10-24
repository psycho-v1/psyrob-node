// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Fixture} from "./Fixture.sol";
import {Addrs, Sys, IFinalityCommitteeSeats} from "../src/Base.sol";
import {DevCouncil} from "../src/DevCouncil.sol";
import {UpgradeRegistry} from "../src/UpgradeRegistry.sol";
import {EmergencyPause} from "../src/EmergencyPause.sol";
import {Governor} from "../src/Governor.sol";
import {Params} from "../src/Params.sol";
import {NGOElection} from "../src/NGOElection.sol";

/// New code for a contract update (any code will do: the registry only records its hash).
contract NewCode {
    function version() external pure returns (uint256) {
        return 2;
    }
}

/// Dev council, handover at the 60th NGO, upgrade registry, emergency pause, Upgrade and Emergency
/// proposals (DAG_SPEC.md section 17).
contract CouncilTest is Fixture {
    bytes32 constant REASON = keccak256("exploit in a contract");

    // ---- helpers ----

    function act(uint8 kind, address target, bytes32 key, uint256 arg) internal returns (uint256 id) {
        vm.prank(councilKeys[0]);
        id = council.propose(kind, target, key, arg);
        vm.prank(councilKeys[1]);
        council.approve(id);
    }

    function retire() internal {
        vm.mockCall(Addrs.NGO_ELECTION, abi.encodeWithSelector(NGOElection.electedCount.selector), abi.encode(uint256(60)));
        vm.prank(Addrs.SYSTEM);
        council.advance();
        vm.clearMockedCalls();
        assertTrue(council.retired());
    }

    function submitContract(address target) internal returns (uint256) {
        NewCode impl = new NewCode();
        return upgrades.submit(0, target, address(impl), 0, bytes20(uint160(0xabc)), 0, "replace");
    }

    // ---- council: 2 of 3, timelock, keys ----

    function test_councilNeedsTwoOfThreeAndParamTimelock() public {
        bytes32 k = "committeeBond";
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(DevCouncil.NotCouncil.selector);
        council.propose(2, address(0), k, 15_000 ether);
        // the Dev Account wallet itself cannot act: only its separate council key
        vm.prank(devAccounts[0]);
        vm.expectRevert(DevCouncil.NotCouncil.selector);
        council.propose(2, address(0), k, 15_000 ether);

        vm.prank(councilKeys[0]);
        uint256 id = council.propose(2, address(0), k, 15_000 ether);
        vm.prank(councilKeys[0]);
        vm.expectRevert(DevCouncil.AlreadyApproved.selector);
        council.approve(id);
        assertEq(params.get(k), 10_000 ether);
        vm.prank(councilKeys[2]);
        council.approve(id);
        DevCouncil.Action memory a = council.getAction(id);
        assertEq(a.state, 1); // queued
        assertEq(a.eta, block.timestamp + 48 hours);
        vm.expectRevert(abi.encodeWithSelector(DevCouncil.Timelocked.selector, block.timestamp + 48 hours));
        council.execute(id);
        skipTime(48 hours);
        council.execute(id);
        assertEq(params.get(k), 15_000 ether);
        // the step limits of Params still hold for the council
        id = act(2, address(0), "candidacyDeposit", 500 ether);
        skipTime(48 hours);
        vm.expectRevert(abi.encodeWithSelector(Params.StepTooLarge.selector, bytes32("candidacyDeposit"), 500 ether));
        council.execute(id);
        // the rules of the NGO pipeline and the election, and role pay, are not the council's
        bytes32[10] memory notCouncil = [bytes32("ngoMintFee"), "vouchBond", "vouchMinBlocks", "challengeBond", "rolePayPer30Days", "maxActiveVouches",
            "vouchMinEpochs", "maxBallotWeightBps", "firstElectionMinVoters", "minCountedVoterLock"];
        for (uint256 i; i < notCouncil.length; ++i) {
            vm.prank(Addrs.DEV_COUNCIL);
            vm.expectRevert(abi.encodeWithSelector(Params.NotForCouncil.selector, notCouncil[i]));
            params.set(notCouncil[i], 1 ether);
        }
    }

    function test_actionsExpireAndCanBeCancelled() public {
        vm.prank(councilKeys[0]);
        uint256 id = council.propose(2, address(0), "committeeBond", 15_000 ether);
        skipTime(3 days + 1);
        vm.prank(councilKeys[1]);
        vm.expectRevert(DevCouncil.Expired.selector);
        council.approve(id);

        uint256 q = act(2, address(0), "committeeBond", 15_000 ether);
        act(5, address(0), 0, q); // cancel the queued change
        assertEq(council.getAction(q).state, 3);
        skipTime(48 hours);
        vm.expectRevert(DevCouncil.NotQueued.selector);
        council.execute(q);
        assertEq(params.get("committeeBond"), 10_000 ether);
    }

    function test_keyReplacementByDevAccountWallet() public {
        address newKey = makeAddr("newKey1");
        // a thief with only the council key cannot replace it
        vm.prank(councilKeys[0]);
        vm.expectRevert(DevCouncil.NotDevAccount.selector);
        council.requestKeyChange(0, newKey);
        // keys stay distinct from the Dev Account wallets and from each other
        vm.startPrank(devAccounts[0]);
        vm.expectRevert(DevCouncil.BadKey.selector);
        council.requestKeyChange(0, devAccounts[1]);
        vm.expectRevert(DevCouncil.BadKey.selector);
        council.requestKeyChange(0, councilKeys[1]);
        council.requestKeyChange(0, newKey);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(DevCouncil.Timelocked.selector, block.timestamp + 48 hours));
        council.applyKeyChange(0);
        // the seat itself cannot cancel; both other seats together can (a stolen Dev Account wallet)
        vm.prank(councilKeys[0]);
        vm.expectRevert(DevCouncil.NotCouncil.selector);
        council.cancelKeyChange(0);
        // one other seat alone does not cancel (a single stolen council key cannot block a recovery)
        vm.prank(councilKeys[1]);
        council.cancelKeyChange(0);
        assertEq(council.pendingKey(0), newKey);
        vm.prank(councilKeys[2]);
        council.cancelKeyChange(0);
        skipTime(48 hours);
        vm.expectRevert(DevCouncil.NoPendingKey.selector);
        council.applyKeyChange(0);
        // a single cancel vote does not stop a new request from taking effect
        vm.prank(devAccounts[0]);
        council.requestKeyChange(0, newKey);
        vm.prank(councilKeys[1]);
        council.cancelKeyChange(0);
        skipTime(48 hours);
        council.applyKeyChange(0);
        assertEq(council.councilKey(0), newKey);
        vm.prank(devAccounts[0]);
        council.requestKeyChange(0, councilKeys[0]);
        skipTime(48 hours);
        council.applyKeyChange(0);
        // again, not cancelled
        vm.prank(devAccounts[0]);
        council.requestKeyChange(0, newKey);
        skipTime(48 hours);
        council.applyKeyChange(0);
        assertEq(council.councilKey(0), newKey);
        vm.prank(councilKeys[0]);
        vm.expectRevert(DevCouncil.NotCouncil.selector);
        council.propose(3, address(0), REASON, 0);
        vm.prank(newKey);
        council.propose(3, address(0), REASON, 0);
    }

    // ---- handover ----

    function test_handoverAtSixtyNGOsIsOneWay() public {
        uint256 q = act(2, address(0), "committeeBond", 15_000 ether); // queued before the handover
        electFirst(60); // the node's system calls run council.advance() after the election
        assertTrue(council.retired());
        assertEq(council.retiredAt(), block.timestamp);
        // the queued change dies; nothing but a pause can be proposed
        vm.expectRevert(DevCouncil.Retired.selector);
        council.execute(q);
        vm.prank(councilKeys[0]);
        vm.expectRevert(DevCouncil.Retired.selector);
        council.propose(2, address(0), "committeeBond", 15_000 ether);
        vm.prank(councilKeys[0]);
        vm.expectRevert(DevCouncil.Retired.selector);
        council.propose(0, address(0), 0, 0);
        // the NGO count dropping later does not bring the powers back
        vm.mockCall(Addrs.NGO_ELECTION, abi.encodeWithSelector(NGOElection.electedCount.selector), abi.encode(uint256(10)));
        vm.prank(Addrs.SYSTEM);
        council.advance();
        assertTrue(council.retired());
        vm.clearMockedCalls();
        // the council can no longer set parameters directly either
        vm.prank(Addrs.DEV_COUNCIL);
        vm.expectRevert(Sys.OnlyGovernor.selector);
        params.set("committeeBond", 15_000 ether);
    }

    // ---- upgrades ----

    function test_councilApprovesNoContractUpdate() public {
        // every system contract either holds PSY or feeds the election, the Treasury or the fund: the council replaces
        // none of them; contract updates are the DAO's
        address[4] memory feeders = [Addrs.MINER_REGISTRY, Addrs.NGO_REGISTRY, Addrs.PARAMS, Addrs.FUND_APPROVALS];
        for (uint256 i; i < feeders.length; ++i) {
            uint256 id = submitContract(feeders[i]);
            vm.prank(councilKeys[0]);
            uint256 a = council.propose(0, address(0), 0, id);
            vm.prank(councilKeys[1]);
            vm.expectRevert(abi.encodeWithSelector(UpgradeRegistry.Protected.selector, feeders[i]));
            council.approve(a);
            assertEq(upgrades.getPlan(id).state, 0);
        }
        // nor can the Governor before the handover
        uint256 p = submitContract(Addrs.MINER_REGISTRY);
        vm.prank(Addrs.GOVERNOR);
        vm.expectRevert(UpgradeRegistry.NotAllowed.selector);
        upgrades.approve(p);
    }

    function test_councilNodePlanWaitsFourteenDaysAfterHandover() public {
        uint256 id = upgrades.submit(1, address(0), address(0), 10_001_000, bytes20(uint160(1)), keccak256("sums"), "10.1.0");
        act(0, address(0), 0, id);
        uint256 eta = upgrades.getPlan(id).eta;
        skipTime(6 days);
        retire(); // the handover comes one day before the plan would take effect
        assertEq(upgrades.effectiveEta(id), vm.getBlockTimestamp() + 14 days);
        warpTo(eta);
        advanceAll();
        assertEq(upgrades.requiredVersion(), 0); // still waiting: the DAO can cancel it
        vm.prank(Addrs.GOVERNOR);
        upgrades.cancel(id);
        assertEq(upgrades.getPlan(id).state, 3);
        skipTime(14 days);
        advanceAll();
        assertEq(upgrades.requiredVersion(), 0);
    }

    function test_councilCannotReplaceProtectedContracts() public {
        // never: the 12 % and the handover rule (not even submitted)
        address[4] memory never = [Addrs.DEV_VESTING, Addrs.DEV_VESTING_2, Addrs.DEV_VESTING_3, Addrs.DEV_COUNCIL];
        for (uint256 i; i < never.length; ++i) {
            NewCode impl = new NewCode();
            vm.expectRevert(abi.encodeWithSelector(UpgradeRegistry.Protected.selector, never[i]));
            upgrades.submit(0, never[i], address(impl), 0, 0, 0, "x");
        }
        address code = address(new NewCode());
        vm.expectRevert(abi.encodeWithSelector(UpgradeRegistry.NotSystemContract.selector, address(this)));
        upgrades.submit(0, address(this), code, 0, 0, 0, "x");
        // not by the council: PSY holders, the Governor, the NGO election, the modes, the pause and the registry
        address[11] memory guarded = [Addrs.TREASURY, Addrs.VOTE_ESCROW, Addrs.ATTESTATION, Addrs.NGO_REWARDS, Addrs.FINALITY_COMMITTEE,
            Addrs.ROLE_ELECTION, Addrs.GOVERNOR, Addrs.NGO_ELECTION, Addrs.GOVERNANCE_MODE, Addrs.EMERGENCY_PAUSE, Addrs.UPGRADE_REGISTRY];
        for (uint256 i; i < guarded.length; ++i) {
            uint256 id = submitContract(guarded[i]);
            vm.prank(councilKeys[0]);
            uint256 a = council.propose(0, address(0), 0, id);
            vm.prank(councilKeys[1]);
            vm.expectRevert(abi.encodeWithSelector(UpgradeRegistry.Protected.selector, guarded[i]));
            council.approve(a);
        }
        // the council has no way to pause the 12 %
        vm.prank(councilKeys[0]);
        uint256 b = council.propose(3, Addrs.DEV_VESTING_2, REASON, 0);
        vm.prank(councilKeys[1]);
        vm.expectRevert(abi.encodeWithSelector(EmergencyPause.NotPausable.selector, Addrs.DEV_VESTING_2));
        council.approve(b);
    }

    function test_nodeUpgradeRaisesRequiredVersionAfter7Days() public {
        uint256 id = upgrades.submit(1, address(0), address(0), 10_001_000, bytes20(uint160(1)), keccak256("SHA256SUMS"), "10.1.0");
        act(0, address(0), 0, id);
        assertEq(upgrades.getPlan(id).eta, block.timestamp + 7 days);
        skipTime(7 days - 1);
        advanceAll();
        assertEq(upgrades.requiredVersion(), 0);
        skipTime(1);
        advanceAll();
        assertEq(upgrades.requiredVersion(), 10_001_000);
        assertEq(upgrades.getPlan(id).state, 2);
        vm.expectRevert(UpgradeRegistry.BadVersion.selector);
        upgrades.submit(1, address(0), address(0), 10_000_500, bytes20(uint160(1)), keccak256("x"), "older");
        // the council can cancel a plan before it is in force
        uint256 id2 = upgrades.submit(1, address(0), address(0), 10_002_000, bytes20(uint160(1)), keccak256("y"), "10.2.0");
        act(0, address(0), 0, id2);
        act(1, address(0), 0, id2);
        assertEq(upgrades.getPlan(id2).state, 3);
        skipTime(7 days);
        advanceAll();
        assertEq(upgrades.requiredVersion(), 10_001_000);
    }

    // ---- DAO after the handover: Upgrade and Emergency proposals ----

    function daoSetup() internal returns (address[] memory ngos, address whale) {
        ngos = electFirst(60);
        assertTrue(council.retired());
        assertEq(modeC.mode(), 1);
        for (uint256 i; i < 31; ++i) {
            vm.deal(ngos[i], 100 ether);
            vm.prank(ngos[i]);
            ve.lock{value: 100 ether}();
        }
        whale = voter("whale", 100_000 ether);
    }

    function proposeAndPass(address whale, address[] memory ngos, uint256 ngoYes, uint8 kind, address target, bytes memory data)
        internal
        returns (uint256 id, bool ok)
    {
        address[] memory t = new address[](1);
        uint256[] memory v = new uint256[](1);
        bytes[] memory d = new bytes[](1);
        t[0] = target;
        d[0] = data;
        vm.prank(whale);
        id = gov.propose(kind, t, v, d, "council test");
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(whale);
        gov.vote(id, 1);
        for (uint256 i; i < ngoYes; ++i) {
            vm.prank(ngos[i]);
            gov.vote(id, 1);
        }
        skipTime(kind == 6 ? 2 days : 5 days);
        gov.decide(id);
        ok = gov.getProposal(id).state == 2;
    }

    function test_daoUpgradeNeedsMajorityOfElectedNGOs() public {
        (address[] memory ngos, address whale) = daoSetup();
        uint256 plan = submitContract(Addrs.VOTE_ESCROW); // the DAO may replace contracts the council may not
        bytes memory data = abi.encodeWithSelector(UpgradeRegistry.approve.selector, plan);
        // the council is retired: it cannot approve
        vm.prank(councilKeys[0]);
        vm.expectRevert(DevCouncil.Retired.selector);
        council.propose(0, address(0), 0, plan);
        // 30 of 60 NGOs is not a majority
        (, bool ok) = proposeAndPass(whale, ngos, 30, 5, Addrs.UPGRADE_REGISTRY, data);
        assertFalse(ok);
        uint256 id;
        (id, ok) = proposeAndPass(whale, ngos, 31, 5, Addrs.UPGRADE_REGISTRY, data);
        assertTrue(ok);
        skipTime(48 hours);
        gov.execute(id);
        UpgradeRegistry.Plan memory p = upgrades.getPlan(plan);
        assertEq(p.state, 1);
        assertTrue(p.byDao);
        assertEq(p.eta, block.timestamp + 7 days);
        // the DAO can never replace the 12 % or the handover rule either
        address code = address(new NewCode());
        vm.expectRevert(abi.encodeWithSelector(UpgradeRegistry.Protected.selector, Addrs.DEV_VESTING));
        upgrades.submit(0, Addrs.DEV_VESTING, code, 0, 0, 0, "x");
    }

    function test_emergencyProposalTwoDaysNoTimelockAndPauseGuard() public {
        (address[] memory ngos, address whale) = daoSetup();
        // Ordinary proposals cannot reach the new contracts
        address[] memory t = new address[](1);
        bytes[] memory d = new bytes[](1);
        t[0] = Addrs.EMERGENCY_PAUSE;
        vm.prank(whale);
        vm.expectRevert(abi.encodeWithSelector(Governor.TargetNotAllowed.selector, uint8(0), Addrs.EMERGENCY_PAUSE));
        gov.propose(0, t, new uint256[](1), d, "x");
        t[0] = Addrs.DEV_COUNCIL;
        vm.prank(whale);
        vm.expectRevert(abi.encodeWithSelector(Governor.TargetNotAllowed.selector, uint8(0), Addrs.DEV_COUNCIL));
        gov.propose(0, t, new uint256[](1), d, "x");
        // a Treasury proposal passed before the pause
        (uint256 spend, bool ok) = proposeAndPass(whale, ngos, 0, 1, Addrs.TREASURY,
            abi.encodeWithSignature("spend(address,uint256,string)", whale, 1 ether, "x"));
        assertTrue(ok);
        // the DAO pauses the network for 10 days: 2 days of voting, executable at once
        uint256 id;
        (id, ok) = proposeAndPass(whale, ngos, 0, 6, Addrs.EMERGENCY_PAUSE,
            abi.encodeWithSelector(EmergencyPause.daoPause.selector, address(0), REASON, 10 days));
        assertTrue(ok);
        gov.execute(id);
        assertTrue(pauser.networkPaused());
        // while the network is paused, only Upgrade and Emergency proposals execute
        vm.expectRevert(Governor.NetworkPaused.selector);
        gov.execute(spend);
        (id, ok) = proposeAndPass(whale, ngos, 0, 6, Addrs.EMERGENCY_PAUSE, abi.encodeWithSelector(EmergencyPause.daoUnpause.selector, address(0)));
        gov.execute(id);
        assertFalse(pauser.networkPaused());
        gov.execute(spend);
    }

    // ---- emergency pause ----

    function test_councilPauseNetworkAndContract72h() public {
        act(3, address(0), REASON, 0);
        assertTrue(pauser.networkPaused());
        (uint8 by, uint64 at, uint64 until, bytes32 reason,) = pauser.pauses(address(0));
        assertEq(by, 1);
        assertEq(until, at + 72 hours);
        assertEq(reason, REASON);
        skipTime(72 hours);
        assertFalse(pauser.networkPaused());
        // the run is over: no new council pause for 7 days
        vm.prank(councilKeys[0]);
        uint256 early = council.propose(3, Addrs.VOTE_ESCROW, REASON, 0);
        vm.prank(councilKeys[1]);
        vm.expectRevert(abi.encodeWithSelector(EmergencyPause.CouncilCooldown.selector, uint256(until) + 7 days));
        council.approve(early);
        skipTime(7 days);

        // a contract pause stops its user entry points; system calls and the Governor pass
        act(3, Addrs.VOTE_ESCROW, REASON, 0);
        address u = makeAddr("user");
        vm.deal(u, 10 ether);
        vm.prank(u);
        vm.expectRevert(Sys.Paused.selector);
        ve.lock{value: 1 ether}();
        vm.deal(Addrs.GOVERNOR, 1 ether);
        vm.prank(Addrs.GOVERNOR);
        ve.lock{value: 1 ether}();
        // before the handover the council can renew and end its pause
        skipTime(24 hours);
        act(3, Addrs.VOTE_ESCROW, REASON, 0);
        (,, until,,) = pauser.pauses(Addrs.VOTE_ESCROW);
        assertEq(until, block.timestamp + 72 hours);
        act(4, Addrs.VOTE_ESCROW, 0, 0);
        vm.prank(u);
        ve.lock{value: 1 ether}();
        assertEq(pauser.historyCount(), 3);
        assertTrue(pauser.history(2).endedEarly);
        // never pausable
        address[5] memory never = [Addrs.DEV_VESTING, Addrs.GOVERNOR, Addrs.DEV_COUNCIL, Addrs.UPGRADE_REGISTRY, Addrs.PARAMS];
        for (uint256 i; i < never.length; ++i) {
            vm.prank(councilKeys[0]);
            uint256 a = council.propose(3, never[i], REASON, 0);
            vm.prank(councilKeys[1]);
            vm.expectRevert(abi.encodeWithSelector(EmergencyPause.NotPausable.selector, never[i]));
            council.approve(a);
        }
    }

    function test_councilPauseRunsAreCappedBeforeHandover() public {
        uint256 t0 = vm.getBlockTimestamp();
        act(3, address(0), REASON, 0);
        // renewals extend the run, but never past 7 days from its start
        skipTime(48 hours);
        act(3, address(0), REASON, 0); // until t0 + 5 days
        skipTime(48 hours);
        act(3, address(0), REASON, 0); // capped: until t0 + 7 days
        skipTime(48 hours);
        vm.prank(councilKeys[0]);
        uint256 more = council.propose(3, address(0), REASON, 0);
        vm.prank(councilKeys[1]);
        vm.expectRevert(abi.encodeWithSelector(EmergencyPause.AlreadyPaused.selector, t0 + 7 days));
        council.approve(more);
        (,, uint64 until,,) = pauser.pauses(address(0));
        assertEq(until, t0 + 7 days);
        assertEq(pauser.councilRunEnd(), t0 + 7 days);
        // a second target joins the run with the same cap
        act(3, Addrs.NGO_ELECTION, REASON, 0);
        (,, until,,) = pauser.pauses(Addrs.NGO_ELECTION);
        assertEq(until, t0 + 7 days);
        // then 7 days without any council pause
        warpTo(t0 + 7 days);
        assertFalse(pauser.networkPaused());
        vm.prank(councilKeys[0]);
        uint256 a = council.propose(3, address(0), REASON, 0);
        vm.prank(councilKeys[1]);
        vm.expectRevert(abi.encodeWithSelector(EmergencyPause.CouncilCooldown.selector, t0 + 14 days));
        council.approve(a);
        warpTo(t0 + 14 days);
        act(3, address(0), REASON, 0);
        assertTrue(pauser.networkPaused());
    }

    function test_councilPauseAfterHandoverCooldownAndLockout() public {
        retire();
        act(3, address(0), REASON, 0);
        assertTrue(pauser.networkPaused());
        // the council can no longer end or renew it
        vm.prank(councilKeys[0]);
        vm.expectRevert(DevCouncil.Retired.selector);
        council.propose(4, address(0), 0, 0);
        // once every 7 days
        skipTime(3 days);
        vm.prank(councilKeys[0]);
        uint256 a = council.propose(3, Addrs.NGO_REWARDS, REASON, 0);
        vm.prank(councilKeys[1]);
        vm.expectRevert(abi.encodeWithSelector(EmergencyPause.CouncilCooldown.selector, block.timestamp + 4 days));
        council.approve(a);
        skipTime(4 days);
        act(3, Addrs.NGO_REWARDS, REASON, 0);
        // the DAO ends it early: no council pause for 30 days
        vm.prank(Addrs.GOVERNOR);
        pauser.daoUnpause(Addrs.NGO_REWARDS);
        uint256 lockout = vm.getBlockTimestamp() + 30 days; // not block.timestamp: via_ir may reuse an older read
        assertEq(pauser.councilLockoutUntil(), lockout);
        skipTime(8 days);
        vm.prank(councilKeys[0]);
        a = council.propose(3, Addrs.NGO_REWARDS, REASON, 0);
        vm.prank(councilKeys[1]);
        vm.expectRevert(abi.encodeWithSelector(EmergencyPause.CouncilCooldown.selector, lockout));
        council.approve(a);
        warpTo(lockout);
        act(3, Addrs.NGO_REWARDS, REASON, 0);
        // only the DAO goes past 72 hours, and at most 30 days at a time
        vm.prank(Addrs.GOVERNOR);
        vm.expectRevert(EmergencyPause.TooLong.selector);
        pauser.daoPause(address(0), REASON, 31 days);
        vm.prank(Addrs.GOVERNOR);
        pauser.daoPause(Addrs.NGO_REWARDS, REASON, 30 days);
        (uint8 by,, uint64 until,,) = pauser.pauses(Addrs.NGO_REWARDS);
        assertEq(by, 3);
        assertEq(until, vm.getBlockTimestamp() + 30 days);
    }

    function test_committeePauseNeeds14WithFourNGOs() public {
        retire();
        uint256 e = 7;
        vm.mockCall(Addrs.FINALITY_COMMITTEE, abi.encodeWithSelector(IFinalityCommitteeSeats.currentEpoch.selector), abi.encode(e));
        address[] memory m = new address[](21);
        for (uint256 i; i < 21; ++i) {
            m[i] = makeAddr(string(abi.encodePacked("member", vm.toString(i))));
            vm.mockCall(Addrs.FINALITY_COMMITTEE, abi.encodeWithSelector(IFinalityCommitteeSeats.seatOf.selector, e, m[i]), abi.encode(uint8(i < 6 ? 1 : 2)));
            vm.mockCall(Addrs.FINALITY_COMMITTEE, abi.encodeWithSelector(IFinalityCommitteeSeats.slashed.selector, e, m[i]), abi.encode(false));
        }
        address outsider = makeAddr("outsider");
        vm.mockCall(Addrs.FINALITY_COMMITTEE, abi.encodeWithSelector(IFinalityCommitteeSeats.seatOf.selector, e, outsider), abi.encode(uint8(0)));
        vm.prank(outsider);
        vm.expectRevert(EmergencyPause.NotACommitteeMember.selector);
        pauser.committeeVote(address(0), REASON);
        // 14 votes but only 3 NGOs: no pause
        for (uint256 i = 3; i < 17; ++i) {
            vm.prank(m[i]);
            pauser.committeeVote(address(0), REASON);
        }
        assertFalse(pauser.networkPaused());
        vm.prank(m[3]);
        vm.expectRevert(EmergencyPause.AlreadyVoted.selector);
        pauser.committeeVote(address(0), REASON);
        // the 4th NGO
        vm.prank(m[0]);
        pauser.committeeVote(address(0), REASON);
        assertTrue(pauser.networkPaused());
        (uint8 by,,,,) = pauser.pauses(address(0));
        assertEq(by, 2);
        skipTime(72 hours);
        assertFalse(pauser.networkPaused());
        // the committee cannot pause the same target again within 7 days
        vm.prank(m[0]);
        vm.expectRevert(abi.encodeWithSelector(EmergencyPause.CommitteeCooldown.selector, block.timestamp - 72 hours + 7 days));
        pauser.committeeVote(address(0), REASON);
        // votes expire after 6 hours: 13 early votes and 1 late vote do not add up
        for (uint256 i; i < 13; ++i) {
            vm.prank(m[i]);
            pauser.committeeVote(Addrs.NGO_REWARDS, REASON);
        }
        skipTime(6 hours + 1);
        vm.prank(m[13]);
        pauser.committeeVote(Addrs.NGO_REWARDS, REASON);
        assertFalse(pauser.blocked(Addrs.NGO_REWARDS));
        assertEq(pauser.requestCount(), 3);
    }
}
