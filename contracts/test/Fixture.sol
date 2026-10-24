// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Addrs, C} from "../src/Base.sol";
import {MinerRegistry} from "../src/MinerRegistry.sol";
import {NGORegistry} from "../src/NGORegistry.sol";
import {Attestation} from "../src/Attestation.sol";
import {VoteEscrow} from "../src/VoteEscrow.sol";
import {NGOElection} from "../src/NGOElection.sol";
import {RoleElection} from "../src/RoleElection.sol";
import {Governor} from "../src/Governor.sol";
import {Treasury} from "../src/Treasury.sol";
import {DevVesting} from "../src/DevVesting.sol";
import {NGORewards} from "../src/NGORewards.sol";
import {FinalityCommittee} from "../src/FinalityCommittee.sol";
import {GovernanceMode} from "../src/GovernanceMode.sol";
import {FundApprovals} from "../src/FundApprovals.sol";
import {Params} from "../src/Params.sol";
import {DevCouncil} from "../src/DevCouncil.sol";
import {UpgradeRegistry} from "../src/UpgradeRegistry.sol";
import {EmergencyPause} from "../src/EmergencyPause.sol";

/// All system contracts at their genesis addresses, as genesis/build.js creates them, plus helpers that play the node
/// (system calls) and the participants.
abstract contract Fixture is Test {
    MinerRegistry mr = MinerRegistry(Addrs.MINER_REGISTRY);
    NGORegistry reg = NGORegistry(Addrs.NGO_REGISTRY);
    Attestation att = Attestation(Addrs.ATTESTATION);
    VoteEscrow ve = VoteEscrow(Addrs.VOTE_ESCROW);
    NGOElection el = NGOElection(Addrs.NGO_ELECTION);
    RoleElection roles = RoleElection(Addrs.ROLE_ELECTION);
    Governor gov = Governor(payable(Addrs.GOVERNOR));
    Treasury treasury = Treasury(payable(Addrs.TREASURY));
    DevVesting dev = DevVesting(Addrs.DEV_VESTING);
    NGORewards rewards = NGORewards(Addrs.NGO_REWARDS);
    FinalityCommittee fc = FinalityCommittee(Addrs.FINALITY_COMMITTEE);
    GovernanceMode modeC = GovernanceMode(Addrs.GOVERNANCE_MODE);
    FundApprovals fa = FundApprovals(Addrs.FUND_APPROVALS);
    Params params = Params(Addrs.PARAMS);
    DevCouncil council = DevCouncil(Addrs.DEV_COUNCIL);
    UpgradeRegistry upgrades = UpgradeRegistry(Addrs.UPGRADE_REGISTRY);
    EmergencyPause pauser = EmergencyPause(Addrs.EMERGENCY_PAUSE);

    uint256 G;
    address devBeneficiary = makeAddr("devBeneficiary");
    // the three Dev Account wallets and their council keys (launch ceremony)
    address[3] devAccounts = [makeAddr("devAccount1"), makeAddr("devAccount2"), makeAddr("devAccount3")];
    address[3] councilKeys = [makeAddr("councilKey1"), makeAddr("councilKey2"), makeAddr("councilKey3")];
    address bootstrapSigner = makeAddr("bootstrapSigner"); // the dev miner that may sign bootstrap checkpoints
    address[] vouchers;
    uint256 nonceSeq;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        vm.roll(100);
        G = block.timestamp;
        deployCodeTo("GovernanceMode.sol:GovernanceMode", abi.encode(G), Addrs.GOVERNANCE_MODE);
        deployCodeTo("Params.sol:Params", Addrs.PARAMS);
        deployCodeTo("MinerRegistry.sol:MinerRegistry", Addrs.MINER_REGISTRY);
        deployCodeTo("NGORegistry.sol:NGORegistry", Addrs.NGO_REGISTRY);
        deployCodeTo("Attestation.sol:Attestation", Addrs.ATTESTATION);
        deployCodeTo("VoteEscrow.sol:VoteEscrow", Addrs.VOTE_ESCROW);
        deployCodeTo("NGOElection.sol:NGOElection", Addrs.NGO_ELECTION);
        deployCodeTo("RoleElection.sol:RoleElection", Addrs.ROLE_ELECTION);
        deployCodeTo("Governor.sol:Governor", Addrs.GOVERNOR);
        deployCodeTo("Treasury.sol:Treasury", Addrs.TREASURY);
        deployCodeTo("NGORewards.sol:NGORewards", Addrs.NGO_REWARDS);
        address[] memory boot = new address[](1);
        boot[0] = bootstrapSigner;
        deployCodeTo("FinalityCommittee.sol:FinalityCommittee", abi.encode(boot, uint256(1)), Addrs.FINALITY_COMMITTEE);
        deployCodeTo("FundApprovals.sol:FundApprovals", Addrs.FUND_APPROVALS);
        deployCodeTo(
            "DevVesting.sol:DevVesting", abi.encode(devBeneficiary, G, 120_000_000 ether), 120_000_000 ether, Addrs.DEV_VESTING
        );
        deployCodeTo("DevCouncil.sol:DevCouncil", abi.encode(devAccounts, councilKeys), Addrs.DEV_COUNCIL);
        deployCodeTo("UpgradeRegistry.sol:UpgradeRegistry", Addrs.UPGRADE_REGISTRY);
        deployCodeTo("EmergencyPause.sol:EmergencyPause", Addrs.EMERGENCY_PAUSE);
        vm.deal(Addrs.TREASURY, 160_000_000 ether);
    }

    // ---- node actions ----

    function mine(address miner, uint256 blocks) internal {
        address[] memory a = new address[](1);
        uint256[] memory c = new uint256[](1);
        a[0] = miner;
        c[0] = blocks;
        vm.prank(Addrs.SYSTEM);
        mr.recordBlocks(a, c);
        vm.deal(miner, miner.balance + blocks * 10 ether); // the subsidy the node would credit
    }

    function advanceAll() internal {
        vm.startPrank(Addrs.SYSTEM);
        el.advance();
        modeC.advance(); // Normal-mode grace, after the election as in the node
        roles.advance();
        fc.advance();
        council.advance(); // after the election, as the node orders its system calls
        upgrades.advance();
        vm.stopPrank();
    }

    /// Run the committee draw of the current epoch the way the node would: freeze, produce the seed, seal.
    /// Rotations after the first take their seed from a finalised checkpoint (recorded here with `cpHash`).
    function sealCommittee(bytes32 cpHash) internal {
        advanceAll(); // freeze
        uint256 e = fc.currentEpoch();
        (FinalityCommittee.EpochDraw memory d,) = fc.epochDraw(e);
        if (d.sealBlock != 0) return;
        // a rotation opens a beacon round at the freeze; nobody reveals here, so let it close (the draw then falls back
        // to the checkpoint source). Tests of the beacon itself reveal in the window instead.
        uint256 nb = fc.beaconCount();
        if (nb > 0) {
            FinalityCommittee.BeaconRound memory b = fc.beacon(nb - 1);
            if (!b.closed && b.requestBlock == d.freezeBlock) {
                vm.roll(uint256(b.requestBlock) + fc.BEACON_WINDOW() + 1);
                advanceAll();
                (d,) = fc.epochDraw(e);
                if (d.sealBlock != 0) return;
            }
        }
        if (d.useCheckpoint) {
            uint256 c = (uint256(d.seedBlock) + 29) / 30;
            vm.roll(c * 30 + 1);
            uint256 signer = fc.lastSealedEpoch(); // read first: a view call would use up vm.prank
            vm.prank(Addrs.SYSTEM);
            fc.recordCheckpoint(signer, c, cpHash, new address[](0));
        } else {
            vm.roll(uint256(d.seedBlock) + 1);
            vm.setBlockhash(d.seedBlock, keccak256(abi.encode("block", e)));
        }
        advanceAll(); // seal
    }

    function sealCommittee() internal {
        sealCommittee(keccak256(abi.encode("checkpoint", fc.currentEpoch())));
    }

    function warpTo(uint256 t) internal {
        vm.warp(t);
        vm.roll(vm.getBlockNumber() + 1);
    }

    function skipTime(uint256 dt) internal {
        warpTo(block.timestamp + dt);
    }

    // ---- participants ----

    function newMiner(string memory name, uint256 blocks) internal returns (address a) {
        a = makeAddr(name);
        mine(a, blocks);
        vm.prank(a);
        mr.register(bytes32(0));
    }

    uint256 vouchedNGOs; // NGOs vouched so far; each group of 5 vouchers backs at most 10 (maxActiveVouches)

    function ensureVouchers() internal {
        uint256 need = (vouchedNGOs / 10 + 1) * 5;
        for (uint256 i = vouchers.length; i < need; ++i) {
            address v = newVoucher(string(abi.encodePacked("voucher", vm.toString(i))));
            vm.deal(v, 1_000_000 ether);
            vouchers.push(v);
        }
    }

    /// A registered miner eligible to vouch: 100 blue blocks spread over epochs 0 to 3 (vouchMinEpochs = 4). The clock
    /// is moved to each epoch to record the blocks and then restored, so the test's own timeline does not change.
    function newVoucher(string memory name) internal returns (address a) {
        a = makeAddr(name);
        uint256 t = vm.getBlockTimestamp(); // not block.timestamp: via_ir can reuse a value read before a vm.warp
        for (uint256 k; k < 4; ++k) {
            vm.warp(G + k * C.EPOCH + 1);
            mine(a, 25);
        }
        vm.warp(t);
        vm.prank(a);
        mr.register(bytes32(0));
    }

    /// The five vouchers for the next NGO.
    function nextVouchers() internal returns (address[5] memory vs) {
        ensureVouchers();
        uint256 g = vouchedNGOs / 10;
        for (uint256 j; j < 5; ++j) vs[j] = vouchers[g * 5 + j];
        ++vouchedNGOs;
    }

    function mintNGO(address ngo) internal {
        vm.prank(ngo);
        reg.mint{value: 100 ether}("NGO", "NL", "KvK 1", "ipfs://dossier", keccak256(abi.encode(ngo)));
    }

    /// Miner wallets that become attested NGOs (vouched together, one 7-day window).
    function attestedNGOs(string memory prefix, uint256 n) internal returns (address[] memory ngos) {
        ngos = new address[](n);
        for (uint256 i; i < n; ++i) {
            ngos[i] = newMiner(string(abi.encodePacked(prefix, vm.toString(i))), 20);
            mintNGO(ngos[i]);
            address[5] memory vs = nextVouchers();
            for (uint256 j; j < 5; ++j) {
                vm.prank(vs[j]);
                att.vouch{value: 1_000 ether}(ngos[i]);
            }
        }
        skipTime(7 days);
        for (uint256 i; i < n; ++i) att.finalize(ngos[i]);
    }

    function attestedNGO(string memory name) internal returns (address) {
        return attestedNGOs(name, 1)[0];
    }

    function sorted(address[] memory a) internal pure returns (address[] memory) {
        for (uint256 i = 1; i < a.length; ++i) {
            address x = a[i];
            uint256 j = i;
            while (j > 0 && a[j - 1] > x) { a[j] = a[j - 1]; --j; }
            a[j] = x;
        }
        return a;
    }

    function voter(string memory name, uint256 amount) internal returns (address v) {
        v = makeAddr(name);
        vm.deal(v, amount);
        vm.prank(v);
        ve.lock{value: amount}();
        vm.roll(vm.getBlockNumber() + 1);
    }

    /// Elect `n` NGOs in the first election (closes at G + 90 days); returns them.
    function electFirst(uint256 n) internal returns (address[] memory ngos) {
        advanceAll(); // opens round 0
        ngos = attestedNGOs("ngo", n);
        for (uint256 i; i < n; ++i) {
            vm.prank(ngos[i]);
            el.stand(0);
        }
        // the first election needs 5 distinct approvers with at least 100 PSY locked each (firstElectionMinVoters)
        address[] memory ballot = sorted(ngos);
        for (uint256 i; i < 5; ++i) {
            address v = voter(string(abi.encodePacked("electionVoter", vm.toString(i))), 1_000 ether);
            vm.prank(v);
            el.vote(0, ballot);
        }
        warpTo(G + 90 days);
        advanceAll(); // finalises round 0, opens the first supplementary round
    }
}
