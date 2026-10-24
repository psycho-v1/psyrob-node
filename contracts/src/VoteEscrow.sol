// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Sys, Addrs} from "./Base.sol";

/// Voting power = PSY locked here (DAG_SPEC.md sections 8.4 and 11).
/// Power is read at the block before the vote (`block.number - 1`), so PSY borrowed and locked inside one transaction
/// (a flash loan) has no power. A vote holds the voter's lock until the vote's end, so the same PSY cannot be unlocked,
/// moved and voted again in the same ballot. Role holders have no voting power while in office (checked by the
/// voting contracts).
contract VoteEscrow is Sys {
    struct Checkpoint {
        uint64 fromBlock;
        uint192 amount;
    }

    mapping(address => Checkpoint[]) private _cp;
    Checkpoint[] private _total;
    mapping(address => uint256) public locked;
    mapping(address => uint256) public heldUntil;

    error ZeroAmount();
    error Held(uint256 until);
    error NotEnoughLocked();
    error NotAVotingContract();

    event Locked(address indexed who, uint256 amount, uint256 total);
    event Unlocked(address indexed who, uint256 amount, uint256 total);

    function lock() external payable whenActive {
        if (msg.value == 0) revert ZeroAmount();
        locked[msg.sender] += msg.value;
        _write(_cp[msg.sender], locked[msg.sender]);
        _write(_total, _latest(_total) + msg.value);
        emit Locked(msg.sender, msg.value, locked[msg.sender]);
    }

    function unlock(uint256 amount) external whenActive {
        if (amount == 0) revert ZeroAmount();
        if (block.timestamp < heldUntil[msg.sender]) revert Held(heldUntil[msg.sender]);
        if (locked[msg.sender] < amount) revert NotEnoughLocked();
        locked[msg.sender] -= amount;
        _write(_cp[msg.sender], locked[msg.sender]);
        _write(_total, _latest(_total) - amount);
        emit Unlocked(msg.sender, amount, locked[msg.sender]);
        _send(msg.sender, amount);
    }

    /// Called by the voting contracts when `a` votes: the lock is held until the vote ends.
    function holdUntil(address a, uint256 until) external {
        if (msg.sender != Addrs.GOVERNOR && msg.sender != Addrs.NGO_ELECTION) revert NotAVotingContract();
        if (until > heldUntil[a]) heldUntil[a] = until;
    }

    function powerAt(address a, uint256 blockNumber) external view returns (uint256) {
        return _at(_cp[a], blockNumber);
    }

    function totalAt(uint256 blockNumber) external view returns (uint256) {
        return _at(_total, blockNumber);
    }

    /// Average locked amount of `a` over the blocks (fromBlock, toBlock], each block weighted equally (the lock-time
    /// weight of NGO election ballots). Iterates only over `a`'s own checkpoints in the window.
    function averageOver(address a, uint256 fromBlock, uint256 toBlock) external view returns (uint256) {
        if (toBlock <= fromBlock) return 0;
        Checkpoint[] storage c = _cp[a];
        uint256 i = _upper(c, fromBlock);
        uint256 amt = i == 0 ? 0 : c[i - 1].amount; // locked at the end of block `fromBlock`
        uint256 cur = fromBlock;
        uint256 acc;
        for (; i < c.length && c[i].fromBlock <= toBlock; ++i) {
            acc += amt * (c[i].fromBlock - 1 - cur); // blocks cur+1 .. fromBlock-1 held `amt`
            cur = c[i].fromBlock - 1;
            amt = c[i].amount;
        }
        acc += amt * (toBlock - cur);
        return acc / (toBlock - fromBlock);
    }

    function totalLocked() external view returns (uint256) {
        return _latest(_total);
    }

    function _latest(Checkpoint[] storage c) private view returns (uint256) {
        return c.length == 0 ? 0 : c[c.length - 1].amount;
    }

    function _write(Checkpoint[] storage c, uint256 amount) private {
        if (c.length > 0 && c[c.length - 1].fromBlock == block.number) c[c.length - 1].amount = uint192(amount);
        else c.push(Checkpoint(uint64(block.number), uint192(amount)));
    }

    /// Amount at the end of `blockNumber` (binary search).
    function _at(Checkpoint[] storage c, uint256 blockNumber) private view returns (uint256) {
        uint256 lo = _upper(c, blockNumber);
        return lo == 0 ? 0 : c[lo - 1].amount;
    }

    /// Index of the first checkpoint written after `blockNumber` (binary search).
    function _upper(Checkpoint[] storage c, uint256 blockNumber) private view returns (uint256 lo) {
        uint256 hi = c.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (c[mid].fromBlock > blockNumber) hi = mid;
            else lo = mid + 1;
        }
    }
}
