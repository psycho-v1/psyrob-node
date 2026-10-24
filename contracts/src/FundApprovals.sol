// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Sys, Addrs, C, INGOElection} from "./Base.sol";

/// Record of volunteer-fund transfers approved by a Fund proposal (DAG_SPEC.md section 12). Committee members' nodes
/// read these records and sign `digest(id)`; VolunteerFund on BNB Chain checks 15 of those signatures.
contract FundApprovals is Sys {
    struct Approval {
        address token; // address(0) = native BNB
        address to;
        uint256 amount;
        uint256 bnbChainId;
        address fund;
        uint64 approvedAt;
    }

    Approval[] private _approvals;

    error RecipientIsRoleHolder();
    error NotEnoughNGOs(uint256 elected);
    error ZeroAmount();
    error UnknownApproval();

    event Approved(uint256 indexed id, address token, address to, uint256 amount, uint256 bnbChainId, address fund);

    function approve(address token, address to, uint256 amount, uint256 bnbChainId, address fund)
        external
        onlyGovernor
        returns (uint256 id)
    {
        if (amount == 0) revert ZeroAmount();
        if (_isRoleHolder(to)) revert RecipientIsRoleHolder();
        uint256 e = INGOElection(Addrs.NGO_ELECTION).electedCount();
        if (e < C.MIN_NGOS_NORMAL) revert NotEnoughNGOs(e);
        id = _approvals.length;
        _approvals.push(Approval(token, to, amount, bnbChainId, fund, uint64(block.timestamp)));
        emit Approved(id, token, to, amount, bnbChainId, fund);
    }

    /// The message committee members sign; VolunteerFund recomputes it identically.
    function digest(uint256 id) external view returns (bytes32) {
        if (id >= _approvals.length) revert UnknownApproval();
        Approval storage a = _approvals[id];
        return keccak256(
            abi.encode(keccak256("PSYROB-fund"), block.chainid, _genesis(), a.bnbChainId, a.fund, id, a.token, a.to, a.amount)
        );
    }

    function get(uint256 id) external view returns (Approval memory) {
        if (id >= _approvals.length) revert UnknownApproval();
        return _approvals[id];
    }

    function count() external view returns (uint256) {
        return _approvals.length;
    }
}
