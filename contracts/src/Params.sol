// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Sys, Addrs, IDevCouncil} from "./Base.sol";

/// Governable amounts, each within fixed bounds. Only the Governor (after a vote and the timelock) can change them,
/// and only inside [min, max]: no vote can set a fee to zero or a bond to an absurd value. Until it retires, the dev
/// council can change two of them too (2 of 3 keys and 48 hours, same bounds): committeeBond and candidacyDeposit. The
/// others decide who becomes an NGO, who vouches and who votes, or pay from the Treasury; a council that could move
/// them could make the NGO election impossible (and keep its powers) or easy for NGOs of its own. DAG_SPEC.md section 17.2.
/// Each change is also bounded (RISK_REVIEW.md Part 3, as Conflux bounds its parameter votes): the new value is
/// between half and double the current one (rounded up, so a value never reaches zero by halving), and a key changes
/// at most once per 30 days, so proposals passed in parallel cannot be chained into a large jump.
contract Params is Sys {
    uint256 public constant MIN_CHANGE_INTERVAL = 30 days;

    struct P {
        uint256 value;
        uint256 min;
        uint256 max;
        uint64 changedAt;
    }

    mapping(bytes32 => P) private _p;
    bytes32[] public keys;

    error UnknownParam(bytes32 key);
    error OutOfBounds(bytes32 key, uint256 value);
    error StepTooLarge(bytes32 key, uint256 value);
    error ChangedTooRecently(bytes32 key, uint256 nextChange);
    error NotForCouncil(bytes32 key);

    event ParamChanged(bytes32 indexed key, uint256 value);

    constructor() {
        _def("ngoMintFee", 100 ether, 1 ether, 10_000 ether);
        _def("vouchBond", 1_000 ether, 10 ether, 100_000 ether);
        _def("vouchMinBlocks", 100, 1, 100_000);
        _def("challengeBond", 1_000 ether, 10 ether, 100_000 ether);
        _def("candidacyDeposit", 100 ether, 1 ether, 10_000 ether);
        _def("rolePayPer30Days", 2_000 ether, 0, 50_000 ether);
        _def("committeeBond", 10_000 ether, 100 ether, 1_000_000 ether);
        _def("maxActiveVouches", 10, 1, 100);
        _def("vouchMinEpochs", 4, 1, 52); // a voucher has mined in this many distinct 7-day epochs
        _def("maxBallotWeightBps", 100, 10, 10_000);
        _def("firstElectionMinVoters", 5, 1, 1_000); // distinct approvers a candidate needs in the first election
        _def("minCountedVoterLock", 100 ether, 1 ether, 100_000 ether); // locked PSY for a ballot to count as a voter // one NGO-election ballot weighs at most 1 % of locked PSY
    }

    function _def(bytes32 k, uint256 v, uint256 lo, uint256 hi) private {
        _p[k] = P(v, lo, hi, 0);
        keys.push(k);
    }

    function get(bytes32 k) external view returns (uint256) {
        P storage p = _p[k];
        if (p.max == 0) revert UnknownParam(k);
        return p.value;
    }

    function bounds(bytes32 k) external view returns (uint256 value, uint256 min, uint256 max) {
        P storage p = _p[k];
        if (p.max == 0) revert UnknownParam(k);
        return (p.value, p.min, p.max);
    }

    function set(bytes32 k, uint256 v) external {
        if (msg.sender != Addrs.GOVERNOR) {
            if (msg.sender != Addrs.DEV_COUNCIL || IDevCouncil(Addrs.DEV_COUNCIL).retired()) revert OnlyGovernor();
            if (k != "committeeBond" && k != "candidacyDeposit") revert NotForCouncil(k);
        }
        P storage p = _p[k];
        if (p.max == 0) revert UnknownParam(k);
        if (v < p.min || v > p.max) revert OutOfBounds(k, v);
        uint256 cur = p.value;
        if (v < (cur + 1) / 2 || v > cur * 2) revert StepTooLarge(k, v);
        if (p.changedAt != 0 && block.timestamp < p.changedAt + MIN_CHANGE_INTERVAL) {
            revert ChangedTooRecently(k, p.changedAt + MIN_CHANGE_INTERVAL);
        }
        p.value = v;
        p.changedAt = uint64(block.timestamp);
        emit ParamChanged(k, v);
    }

    function allKeys() external view returns (bytes32[] memory) {
        return keys;
    }
}
