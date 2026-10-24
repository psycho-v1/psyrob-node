// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CouncilTest} from "./Council.t.sol";
import {Addrs, INGORegistry} from "../src/Base.sol";
import {FinalityCommittee} from "../src/FinalityCommittee.sol";
import {MinerRegistry} from "../src/MinerRegistry.sol";
import {DevCouncil} from "../src/DevCouncil.sol";
import {Governor} from "../src/Governor.sol";
import {NGOElection} from "../src/NGOElection.sol";

/// Bootstrap finality with a quorum, a deadline and a DAO-only replacement;
/// NGO name rules; what the council keeps after the 12-month sunset with few NGOs.
contract BootstrapTest is CouncilTest {
    function _three() internal returns (address[] memory l) {
        l = new address[](3);
        l[0] = makeAddr("boot1");
        l[1] = makeAddr("boot2");
        l[2] = makeAddr("boot3");
    }

    // ---- bootstrap finality ----

    function test_bootstrapQuorumMustBeAMajority() public {
        address[] memory l = _three();
        vm.expectRevert(FinalityCommittee.BadBootstrapQuorum.selector);
        new FinalityCommittee(l, 1); // 1 of 3: two conflicting certificates need not share a signer
        vm.expectRevert(FinalityCommittee.BadBootstrapQuorum.selector);
        new FinalityCommittee(l, 4);
        vm.expectRevert(FinalityCommittee.BadBootstrapQuorum.selector);
        new FinalityCommittee(l, 0);
        FinalityCommittee two = new FinalityCommittee(l, 2);
        assertEq(two.bootstrapQuorum(), 2);
        assertEq(two.bootstrapSigners().length, 3);
        address[] memory pair = new address[](2);
        pair[0] = l[0];
        pair[1] = l[1];
        vm.expectRevert(FinalityCommittee.BadBootstrapQuorum.selector);
        new FinalityCommittee(pair, 1);
        assertEq(new FinalityCommittee(pair, 2).bootstrapQuorum(), 2);
    }

    function test_bootstrapEndsTwelveMonthsAfterGenesis() public {
        assertTrue(fc.bootstrapActive());
        assertEq(fc.bootstrapDeadline(), G + 365 days);
        warpTo(G + 365 days - 1);
        assertTrue(fc.bootstrapActive());
        assertEq(fc.bootstrapSigners().length, 1);
        warpTo(G + 365 days);
        assertFalse(fc.bootstrapActive(), "after the deadline only a committee finalises");
        assertEq(fc.bootstrapSigners().length, 0);
        assertEq(fc.genesisBootstrapSigners().length, 1, "the genesis list stays readable");
    }

    function test_onlyTheDaoReplacesTheBootstrapList() public {
        address[] memory l = _three();
        uint256 end = vm.getBlockTimestamp() + 180 days;
        vm.expectRevert(bytes4(keccak256("OnlyGovernor()")));
        fc.replaceBootstrap(l, 2, end);
        vm.prank(councilKeys[0]);
        vm.expectRevert(bytes4(keccak256("OnlyGovernor()")));
        fc.replaceBootstrap(l, 2, end);
        vm.startPrank(Addrs.GOVERNOR);
        vm.expectRevert(FinalityCommittee.BadBootstrapQuorum.selector);
        fc.replaceBootstrap(l, 1, end);
        vm.expectRevert(FinalityCommittee.BadBootstrapEnd.selector);
        fc.replaceBootstrap(l, 2, vm.getBlockTimestamp() + 366 days);
        vm.expectRevert(FinalityCommittee.BadBootstrapEnd.selector);
        fc.replaceBootstrap(l, 2, vm.getBlockTimestamp());
        fc.replaceBootstrap(l, 2, end);
        vm.stopPrank();
        assertEq(fc.bootstrapQuorum(), 2);
        assertEq(fc.bootstrapSigners().length, 3);
        assertFalse(fc.isBootstrapSigner(bootstrapSigner), "the old signer no longer counts");
        assertTrue(fc.isBootstrapSigner(l[1]));
        assertEq(fc.bootstrapDeadline(), end);
        assertEq(fc.genesisBootstrapSigners()[0], bootstrapSigner);
        // once the end set by the DAO has passed, bootstrap is over and cannot be renewed
        warpTo(end);
        vm.prank(Addrs.GOVERNOR);
        vm.expectRevert(FinalityCommittee.BootstrapOver.selector);
        fc.replaceBootstrap(l, 2, vm.getBlockTimestamp() + 30 days);
    }

    function test_bootstrapNeverRunsPastTwentyFourMonths() public {
        address[] memory l = _three();
        // month 10: extend to month 22 (12 months from the vote is the most)
        warpTo(G + 300 days);
        vm.prank(Addrs.GOVERNOR);
        fc.replaceBootstrap(l, 2, G + 660 days);
        // month 21: 12 more months would pass genesis + 24 months
        warpTo(G + 650 days);
        vm.startPrank(Addrs.GOVERNOR);
        vm.expectRevert(FinalityCommittee.BadBootstrapEnd.selector);
        fc.replaceBootstrap(l, 2, G + 2 * 365 days + 1);
        fc.replaceBootstrap(l, 2, G + 2 * 365 days);
        vm.stopPrank();
        assertEq(fc.bootstrapDeadline(), G + 2 * 365 days);
        warpTo(G + 2 * 365 days);
        assertFalse(fc.bootstrapActive(), "never past genesis + 24 months");
    }

    function test_onlyAnUpgradeProposalMayTargetTheFinalityCommittee() public {
        address[] memory t = new address[](1);
        t[0] = Addrs.FINALITY_COMMITTEE;
        uint256[] memory v = new uint256[](1);
        bytes[] memory d = new bytes[](1);
        d[0] = abi.encodeCall(FinalityCommittee.replaceBootstrap, (_three(), 2, vm.getBlockTimestamp() + 30 days));
        vm.expectRevert(abi.encodeWithSelector(Governor.TargetNotAllowed.selector, uint8(0), Addrs.FINALITY_COMMITTEE));
        gov.propose(0, t, v, d, "ordinary vote on finality");
    }

    // ---- NGO names ----

    function test_ngoNamesFollowTheRulesAndLookAlikesShareAKey() public view {
        assertTrue(mr.validName("Oxfam"));
        assertTrue(mr.validName("Doctors Without Borders (MSF)"));
        assertTrue(mr.validName("St. John's Aid & Care - Male'"));
        assertFalse(mr.validName(""));
        assertFalse(mr.validName("Oxfam "), "trailing space");
        assertFalse(mr.validName(" Oxfam"), "leading space");
        assertFalse(mr.validName("Ox  fam"), "two spaces");
        assertFalse(mr.validName("-Oxfam"), "starts with punctuation");
        assertFalse(mr.validName(unicode"Оxfam"), "Cyrillic O");
        assertFalse(mr.validName("Oxfam<script>"), "markup");
        assertFalse(mr.validName("Ox_fam"), "underscore");
        bytes32 k = mr.nameKey("Oxfam");
        assertEq(mr.nameKey("oxfam"), k);
        assertEq(mr.nameKey("OXFAM."), k);
        assertEq(mr.nameKey("Ox-fam"), k);
        assertEq(mr.nameKey("0xfam"), k, "digit 0 reads as o");
        assertEq(mr.nameKey("Save the Chi1dren"), mr.nameKey("Save the Children"), "digit 1 reads as l");
        assertTrue(mr.nameKey("Oxfam International") != k);
    }

    function test_lookAlikeNamesAreTakenAndNamesAreUnverifiedUntilAttested() public {
        address a = makeAddr("realNgoMiner");
        address b = makeAddr("squatter");
        mine(a, 1);
        mine(b, 1);
        vm.prank(b);
        vm.expectRevert(MinerRegistry.BadName.selector);
        mr.registerNgoMiner(unicode"Оxfam", "");
        vm.prank(b);
        vm.expectRevert(MinerRegistry.BadName.selector);
        mr.registerNgoMiner("Oxfam ", "");
        vm.prank(a);
        mr.registerNgoMiner("Oxfam", "");
        for (uint256 i; i < 3; ++i) {
            string[3] memory alike = ["0xfam", "OX-FAM", "oxfam."];
            vm.prank(b);
            vm.expectRevert(MinerRegistry.NameTaken.selector);
            mr.registerNgoMiner(alike[i], "");
        }
        assertFalse(mr.ngoNameVerified(a), "unverified until the NGO record is attested");
        vm.mockCall(Addrs.NGO_REGISTRY, abi.encodeWithSelector(INGORegistry.status.selector, a), abi.encode(uint8(2)));
        assertTrue(mr.ngoNameVerified(a));
        vm.clearMockedCalls();
    }

    function test_nameOfARejectedNgoCanBeReleased() public {
        address a = makeAddr("rejectedNgoMiner");
        address b = makeAddr("realNgo");
        mine(a, 1);
        mine(b, 1);
        vm.prank(a);
        mr.registerNgoMiner("Clean Water Trust", "");
        vm.expectRevert(MinerRegistry.BadName.selector);
        mr.releaseNgoName(a); // not rejected
        vm.mockCall(Addrs.NGO_REGISTRY, abi.encodeWithSelector(INGORegistry.status.selector, a), abi.encode(uint8(3)));
        mr.releaseNgoName(a);
        vm.clearMockedCalls();
        assertEq(mr.ngoName(a), "");
        assertEq(mr.ngoNameHolder(mr.nameKey("Clean Water Trust")), address(0));
        assertTrue(mr.isRegistered(a), "still a registered miner");
        // the real NGO can now register under that name
        vm.prank(b);
        mr.registerNgoMiner("Clean Water Trust", "");
        assertEq(mr.ngoNameHolder(mr.nameKey("Clean Water Trust")), b);
    }

    // ---- the 12-month sunset with few NGOs ----

    /// Decision (docs/DECISIONS.md): at the sunset the council keeps only the rate-limited emergency pause.
    function test_afterTheSunsetWithTenNgosTheCouncilKeepsOnlyThePause() public {
        vm.mockCall(Addrs.NGO_ELECTION, abi.encodeWithSelector(NGOElection.electedCount.selector), abi.encode(uint256(10)));
        warpTo(G + 366 days);
        vm.prank(Addrs.SYSTEM);
        council.advance();
        vm.clearMockedCalls();
        assertTrue(council.retired());
        // node plans and parameters: no longer
        vm.prank(councilKeys[0]);
        vm.expectRevert(DevCouncil.Retired.selector);
        council.propose(0, address(0), 0, 0);
        // the emergency pause: still, with its limits
        act(3, address(0), REASON, 0);
        assertTrue(pauser.networkPaused());
    }
}
