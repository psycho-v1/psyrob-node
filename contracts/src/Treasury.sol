// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Sys, Addrs} from "./Base.sol";

/// Community/Treasury allocation: 160,000,000 PSY at genesis (DAG_SPEC.md section 7.1). It is spent only by a Treasury
/// proposal through the Governor, and streams role pay through RoleElection. Role pay never comes from the volunteer
/// fund, which is on another chain.
contract Treasury is Sys {
    uint256 public totalRolePay;
    uint256 public totalSpent;

    error OnlyRoleElection();
    error Insufficient();

    event Spent(address indexed to, uint256 amount, string memo);
    event RolePaid(address indexed to, uint256 amount);
    event Received(address indexed from, uint256 amount);

    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    function spend(address to, uint256 amount, string calldata memo) external onlyGovernor {
        if (amount > address(this).balance) revert Insufficient();
        totalSpent += amount;
        emit Spent(to, amount, memo);
        _send(to, amount);
    }

    function payRole(address to, uint256 amount) external whenActive {
        if (msg.sender != Addrs.ROLE_ELECTION) revert OnlyRoleElection();
        if (amount > address(this).balance) revert Insufficient();
        totalRolePay += amount;
        emit RolePaid(to, amount);
        _sendOrCredit(to, amount);
    }
}
