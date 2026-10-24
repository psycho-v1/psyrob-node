// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Sys, Addrs, INGOElection} from "./Base.sol";

/// The NGO emission pool (36 %), shared equally by the NGOs elected in the current term (DAG_SPEC.md section 7.1).
/// The node mints each chain block's NGO emission into this contract and calls `notify`. Each NGO claims with its own
/// (miner) wallet.
/// Before the first NGO is elected the emission is held (`undistributed`). When the first NGOs are
/// elected, that pre-election pot is not paid out at once to the first cohort; it is streamed over one term (365
/// days), shared each block by the NGOs elected at that moment, like the ongoing emission.
contract NGORewards is Sys {
    uint256 private constant SCALE = 1e18;

    mapping(uint256 => uint256) public accPerNGO; // term => cumulative PSY per elected NGO (scaled)
    mapping(uint256 => mapping(address => uint256)) public claimedScaled; // term => ngo => scaled amount claimed
    uint256 public undistributed;
    uint256 public totalNotified;
    uint256 public totalClaimed;
    /// The pre-election pot streamed over the first term.
    uint256 public streamPot;
    uint256 public streamStart; // 0 until the first NGO is elected
    uint256 public streamed;
    uint256 public constant STREAM_PERIOD = 365 days;

    error NotElected();
    error OnlyElection();
    error NothingToClaim();

    event Notified(uint256 indexed term, uint256 amount, uint256 ngos);
    event Claimed(uint256 indexed term, address indexed ngo, uint256 amount);
    event Forfeited(uint256 indexed term, address indexed ngo, uint256 amount);

    /// System call after the node credits `amount` to this contract.
    function notify(uint256 amount) external onlySystem {
        totalNotified += amount;
        INGOElection el = INGOElection(Addrs.NGO_ELECTION);
        uint256 term = el.currentTerm();
        uint256 n = el.electedCount();
        if (n == 0) {
            undistributed += amount;
            return;
        }
        if (streamStart == 0) {
            // first NGOs elected: the pot held so far is streamed over one term instead of paid at once
            streamStart = block.timestamp;
            streamPot = undistributed;
            undistributed = 0;
        }
        uint256 elapsed = block.timestamp - streamStart;
        uint256 due = (elapsed >= STREAM_PERIOD ? streamPot : streamPot * elapsed / STREAM_PERIOD) - streamed;
        streamed += due;
        uint256 pool = amount + undistributed + due;
        uint256 per = pool * SCALE / n;
        accPerNGO[term] += per;
        undistributed = pool - per * n / SCALE;
        emit Notified(term, amount, n);
    }

    /// Called by NGOElection when an NGO is elected: it earns only what is distributed from then on.
    function onElected(uint256 term, address ngo) external {
        if (msg.sender != Addrs.NGO_ELECTION) revert OnlyElection();
        claimedScaled[term][ngo] = accPerNGO[term];
    }

    /// Called by NGOElection when an elected NGO is removed: what it has not claimed this term goes back to the pool and
    /// is shared by the NGOs still elected (it can no longer claim; `claimable` checks the seat).
    function onRemoved(uint256 term, address ngo) external {
        if (msg.sender != Addrs.NGO_ELECTION) revert OnlyElection();
        uint256 forfeit = (accPerNGO[term] - claimedScaled[term][ngo]) / SCALE;
        claimedScaled[term][ngo] = accPerNGO[term];
        undistributed += forfeit;
        emit Forfeited(term, ngo, forfeit);
    }

    function claimable(uint256 term, address ngo) public view returns (uint256) {
        if (!INGOElection(Addrs.NGO_ELECTION).isElectedIn(term, ngo)) return 0;
        return (accPerNGO[term] - claimedScaled[term][ngo]) / SCALE;
    }

    function claim(uint256 term) external whenActive {
        if (!INGOElection(Addrs.NGO_ELECTION).isElectedIn(term, msg.sender)) revert NotElected();
        uint256 owedScaled = accPerNGO[term] - claimedScaled[term][msg.sender];
        uint256 amount = owedScaled / SCALE;
        if (amount == 0) revert NothingToClaim();
        claimedScaled[term][msg.sender] += amount * SCALE;
        totalClaimed += amount;
        emit Claimed(term, msg.sender, amount);
        _send(msg.sender, amount);
    }
}
