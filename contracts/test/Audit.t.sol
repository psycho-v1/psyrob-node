// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Fixture} from "./Fixture.sol";
import {Addrs} from "../src/Base.sol";
import {NGOElection} from "../src/NGOElection.sol";

/// A contract that refuses PSY (reverts in receive).
contract Refuser {
    receive() external payable {
        revert("no");
    }

    function call(address to, bytes calldata data, uint256 value) external returns (bool ok) {
        (ok,) = to.call{value: value}(data);
        require(ok, "call failed");
    }
}

/// Regression tests for security findings.
contract AuditTest is Fixture {
    // A1: a role holder that refuses PSY cannot block the next role election
    function test_A1_refusingRoleHolderCannotBlockSuccession() public {
        address[] memory ngos = electFirst(60);
        Refuser r = new Refuser();
        vm.deal(address(r), 1_000 ether);
        uint256 id = roles.open(0);
        r.call(Addrs.ROLE_ELECTION, abi.encodeWithSignature("stand(uint256)", id), 100 ether);
        skipTime(14 days);
        for (uint256 i; i < 5; ++i) {
            vm.prank(ngos[i]);
            roles.vote(id, address(r));
        }
        skipTime(14 days);
        advanceAll();
        assertTrue(roles.isRoleHolder(address(r)));
        // paying the holder used to revert when it refused PSY, and the same payment runs when its successor is
        // elected (RoleElection.finalize -> _payOut); now the pay is recorded as owed and nothing reverts
        skipTime(30 days);
        roles.claimPay(0);
        assertEq(treasury.owed(address(r)), 2_000 ether);
        assertEq(address(r).balance, 1_000 ether - 100 ether); // only the deposit left it
    }

    // A2: a challenger that refuses its refund cannot block an upheld decision
    function test_A2_refusingChallengerCannotBlockDecision() public {
        address ngo = newMiner("ngoX", 20);
        mintNGO(ngo);
        ensureVouchers();
        for (uint256 i; i < 5; ++i) {
            vm.prank(vouchers[i]);
            att.vouch{value: 1_000 ether}(ngo);
        }
        Refuser r = new Refuser();
        vm.deal(address(r), 1_000 ether);
        r.call(Addrs.ATTESTATION, abi.encodeWithSignature("challenge(address,bytes32)", ngo, keccak256("fake")), 1_000 ether);
        vm.prank(Addrs.GOVERNOR);
        att.governorDecide(ngo, true);
        assertEq(reg.status(ngo), 3);
        assertEq(att.owed(address(r)), 1_000 ether);
    }

    // A3: ballots must list candidates in increasing order (no duplicates, linear cost)
    function test_A3_unsortedOrDuplicateBallotRefused() public {
        advanceAll();
        address[] memory ngos = attestedNGOs("s", 3);
        for (uint256 i; i < 3; ++i) {
            vm.prank(ngos[i]);
            el.stand(0);
        }
        address v = voter("v", 10 ether);
        address[] memory s = sorted(ngos);
        address[] memory bad = new address[](2);
        bad[0] = s[1];
        bad[1] = s[0];
        vm.prank(v);
        vm.expectRevert(NGOElection.ApprovalsNotSorted.selector);
        el.vote(0, bad);
        bad[1] = s[1];
        vm.prank(v);
        vm.expectRevert(NGOElection.ApprovalsNotSorted.selector);
        el.vote(0, bad);
        uint256 w = el.ballotWeight(0, v);
        assertGt(w, 0);
        vm.prank(v);
        el.vote(0, s);
        assertEq(el.approvals(0, s[2]), w); // each approval counts the ballot's weight once
    }
}
