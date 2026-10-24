// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Sys, Addrs, C, IVoteEscrow, INGOElection, IEmergencyPause} from "./Base.sol";

/// On-chain governance of the native chain (DAG_SPEC.md section 11).
///   Power: PSY locked in VoteEscrow at the block before the proposal (proposer). A ballot weighs
///          min(locked PSY at the proposal's snapshot block, locked PSY at the block before the ballot): PSY locked after
///          the proposal appeared (bought or borrowed for the vote) adds nothing, PSY unlocked since then does not count,
///          and the order of ballots in the DAG cannot change the result (RISK_REVIEW.md Part 3).
///   Threshold: 0.5 % of total locked power.
///   Kinds: 0 Ordinary, 1 Treasury, 2 Parameter, 3 Fund (volunteer fund), 4 Removal (of an elected NGO, through
///          NGOElection.remove), 5 Upgrade (UpgradeRegistry: approve or cancel a contract or node update), 6 Emergency
///          (EmergencyPause: pause up to 30 days or end a pause). Kinds 1-6 need Normal mode; Fund also needs at least
///          60 elected NGOs when proposed. Upgrade also needs yes votes from a majority of the NGOs elected when it is
///          decided . Emergency votes for 2 days and has no timelock, so the DAO can
///          end or extend a 72-hour pause in time (section 17.4).
///   While the whole network is paused, only Upgrade and Emergency proposals can be executed.
///   Passing: yes > no, and yes >= 50 % of the active-participation baseline (average turnout of the last 10 decided
///          proposals), and the floor: yes >= 5 % (Ordinary) or 10 % (other kinds) of total locked power at proposal
///          time, OR at least 50 (Ordinary) or 100 (other kinds) distinct yes voters.
///   Attestation decisions by token vote (an Ordinary proposal calling Attestation) need the higher floor: 10 % of
///   locked power or 100 yes voters (RISK_REVIEW.md 3.8, P1), because in Bootstrap the same large holders could
///   otherwise dismiss a challenge against their own NGO with the 5 % floor.
///   On the voter-count path (50 or 100 voters, every kind) a yes voter counts only if its ballot weighs at least
///   `minCountedVoterLock` (100 PSY): addresses are free, so the voter minimum would otherwise be met by dust (the
///   Ordinary tier too).
///   The baseline counts only decided proposals whose turnout reached BASELINE_MIN_TURNOUT_BPS of the locked power at
///   proposal time, so spam proposals nobody votes on cannot pull it toward zero.
///   5 days of voting, then a 48-hour timelock, then anyone may execute. The Governor is the only caller allowed to
///   spend the Treasury, change Params, record fund approvals and decide attestation challenges by token vote.
contract Governor is Sys {
    uint8 public constant ORDINARY = 0;
    uint8 public constant TREASURY_KIND = 1;
    uint8 public constant PARAMETER = 2;
    uint8 public constant FUND = 3;
    uint8 public constant REMOVAL = 4;
    uint8 public constant UPGRADE = 5;
    uint8 public constant EMERGENCY = 6;
    uint256 public constant EMERGENCY_VOTING_PERIOD = 2 days;
    uint256 public constant BASELINE_WINDOW = 10;
    uint256 public constant BASELINE_MIN_TURNOUT_BPS = 100; // 1 % of locked power (twice the proposal threshold)

    struct Proposal {
        address proposer;
        uint8 kind;
        uint64 snapshotBlock;
        uint64 start;
        uint64 end;
        uint64 eta;
        uint256 totalPower; // total locked power at the snapshot
        uint256 yes;
        uint256 no;
        uint256 abstain;
        uint32 yesVoters;
        uint8 state; // 0 active, 1 defeated, 2 queued, 3 executed
        bytes32 descriptionHash;
    }

    Proposal[] private _props;
    mapping(uint256 => address[]) private _targets;
    mapping(uint256 => uint256[]) private _values;
    mapping(uint256 => bytes[]) private _calldatas;
    mapping(uint256 => mapping(address => bool)) public hasVoted;
    uint256[] private _turnouts;
    mapping(uint256 => bool) public highFloor; // Ordinary proposals that call Attestation (P1)
    mapping(uint256 => uint256) public lockedYesVoters; // yes voters whose ballot weighs at least minCountedVoterLock // turnout of decided proposals (for the baseline)
    mapping(uint256 => uint256) public ngoYesVoters; // elected NGOs that voted yes (Upgrade proposals need a majority)

    error BelowThreshold(uint256 power, uint256 needed);
    error BadKind();
    error ModeForbids();
    error NotEnoughNGOs(uint256 elected);
    error EmptyProposal();
    error LengthMismatch();
    error UnknownProposal();
    error VotingClosed();
    error AlreadyVoted();
    error NoVotingPower();
    error VotingOpen();
    error NotDecided();
    error NotQueued();
    error Timelocked(uint256 eta);
    error CallFailed(uint256 index, bytes ret);
    error TargetNotAllowed(uint8 kind, address target);
    error NetworkPaused();

    event Proposed(uint256 indexed id, address indexed proposer, uint8 kind, string description);
    event Voted(uint256 indexed id, address indexed voter, uint8 support, uint256 weight);
    event Decided(uint256 indexed id, bool passed, uint256 yes, uint256 no, uint256 quorum);
    event Executed(uint256 indexed id);

    receive() external payable {}

    function propose(
        uint8 kind,
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata calldatas,
        string calldata description
    ) external returns (uint256 id) {
        if (kind > EMERGENCY) revert BadKind();
        if (targets.length == 0) revert EmptyProposal();
        if (targets.length != values.length || targets.length != calldatas.length) revert LengthMismatch();
        for (uint256 i; i < targets.length; ++i) {
            if (!_allowed(kind, targets[i])) revert TargetNotAllowed(kind, targets[i]);
        }
        if (_isRoleHolder(msg.sender)) revert RoleHolderCannotVote();
        if (kind != ORDINARY && _mode() != 1) revert ModeForbids();
        if (kind == FUND) {
            uint256 e = INGOElection(Addrs.NGO_ELECTION).electedCount();
            if (e < C.MIN_NGOS_NORMAL) revert NotEnoughNGOs(e);
        }
        uint256 snap = block.number - 1;
        IVoteEscrow ve = IVoteEscrow(Addrs.VOTE_ESCROW);
        uint256 total = ve.totalAt(snap);
        uint256 needed = total * C.PROPOSAL_THRESHOLD_BPS / 10_000;
        uint256 p = ve.powerAt(msg.sender, snap);
        if (p == 0 || p < needed) revert BelowThreshold(p, needed);
        id = _props.length;
        _props.push(
            Proposal(
                msg.sender,
                kind,
                uint64(snap),
                uint64(block.timestamp),
                uint64(block.timestamp + (kind == EMERGENCY ? EMERGENCY_VOTING_PERIOD : C.VOTING_PERIOD)),
                0,
                total,
                0,
                0,
                0,
                0,
                0,
                keccak256(bytes(description))
            )
        );
        if (kind == ORDINARY) {
            for (uint256 i; i < targets.length; ++i) if (targets[i] == Addrs.ATTESTATION) highFloor[id] = true;
        }
        _targets[id] = targets;
        _values[id] = values;
        for (uint256 i; i < calldatas.length; ++i) _calldatas[id].push(calldatas[i]);
        emit Proposed(id, msg.sender, kind, description);
    }

    /// support: 0 no, 1 yes, 2 abstain.
    function vote(uint256 id, uint8 support) external {
        Proposal storage p = _get(id);
        if (block.timestamp >= p.end || p.state != 0) revert VotingClosed();
        if (_isRoleHolder(msg.sender)) revert RoleHolderCannotVote();
        if (hasVoted[id][msg.sender]) revert AlreadyVoted();
        uint256 w = ballotWeight(id, msg.sender);
        if (w == 0) revert NoVotingPower();
        hasVoted[id][msg.sender] = true;
        if (support == 1) {
            p.yes += w;
            p.yesVoters += 1;
            if (w >= _param("minCountedVoterLock")) lockedYesVoters[id] += 1;
            if (_isElected(msg.sender)) ngoYesVoters[id] += 1;
        } else if (support == 0) {
            p.no += w;
        } else {
            p.abstain += w;
        }
        IVoteEscrow(Addrs.VOTE_ESCROW).holdUntil(msg.sender, p.end);
        emit Voted(id, msg.sender, support, w);
    }

    /// The weight `voter` would cast on proposal `id` now.
    function ballotWeight(uint256 id, address voter) public view returns (uint256) {
        Proposal storage p = _get(id);
        IVoteEscrow ve = IVoteEscrow(Addrs.VOTE_ESCROW);
        uint256 then_ = ve.powerAt(voter, p.snapshotBlock);
        uint256 now_ = ve.powerAt(voter, block.number - 1);
        return then_ < now_ ? then_ : now_;
    }

    function baseline() public view returns (uint256) {
        uint256 n = _turnouts.length;
        if (n == 0) return 0;
        uint256 k = n < BASELINE_WINDOW ? n : BASELINE_WINDOW;
        uint256 s;
        for (uint256 i = n - k; i < n; ++i) s += _turnouts[i];
        return s / k;
    }

    /// The yes weight the proposal needs (the floor part may also be met by distinct yes voters).
    function quorumOf(uint256 id) public view returns (uint256 activeQuorum, uint256 floorWeight, uint256 minYesVoters) {
        Proposal storage p = _get(id);
        bool ordinary = p.kind == ORDINARY && !highFloor[id];
        activeQuorum = baseline() / 2;
        floorWeight = p.totalPower * (ordinary ? 5 : 10) / 100;
        minYesVoters = ordinary ? 50 : 100;
    }

    /// Minimum yes weight on the voter-count path, as a share of the locked PSY at the snapshot.
    uint256 public constant VOTER_PATH_MIN_YES_BPS = 100; // 1 %

    function passes(uint256 id) public view returns (bool) {
        Proposal storage p = _get(id);
        (uint256 aq, uint256 fw, uint256 mv) = quorumOf(id);
        // the voter-count path also needs a minimum yes weight: 100 wallets of 100 PSY alone no longer pass
        bool byCount = lockedYesVoters[id] >= mv && p.yes * 10_000 >= p.totalPower * VOTER_PATH_MIN_YES_BPS;
        if (!(p.yes > p.no && p.yes >= aq && (p.yes >= fw || byCount))) return false;
        if (p.kind == UPGRADE) return ngoYesVoters[id] * 2 > INGOElection(Addrs.NGO_ELECTION).electedCount();
        return true;
    }

    /// After voting ends: record the result; queue for execution if it passed.
    function decide(uint256 id) external {
        Proposal storage p = _get(id);
        if (block.timestamp < p.end) revert VotingOpen();
        if (p.state != 0) revert NotDecided();
        bool ok = passes(id);
        (uint256 aq, uint256 fw,) = quorumOf(id);
        uint256 turnout = p.yes + p.no + p.abstain;
        if (turnout * 10_000 >= p.totalPower * BASELINE_MIN_TURNOUT_BPS) _turnouts.push(turnout);
        if (ok) {
            p.state = 2;
            p.eta = uint64(p.kind == EMERGENCY ? block.timestamp : block.timestamp + C.TIMELOCK);
        } else {
            p.state = 1;
        }
        emit Decided(id, ok, p.yes, p.no, aq > fw ? aq : fw);
    }

    function execute(uint256 id) external {
        Proposal storage p = _get(id);
        if (p.state != 2) revert NotQueued();
        if (block.timestamp < p.eta) revert Timelocked(p.eta);
        if (p.kind != ORDINARY && _mode() != 1) revert ModeForbids();
        if (p.kind != UPGRADE && p.kind != EMERGENCY && IEmergencyPause(Addrs.EMERGENCY_PAUSE).networkPaused()) revert NetworkPaused();
        p.state = 3;
        address[] storage t = _targets[id];
        for (uint256 i; i < t.length; ++i) {
            (bool ok, bytes memory ret) = t[i].call{value: _values[id][i]}(_calldatas[id][i]);
            if (!ok) revert CallFailed(i, ret);
        }
        emit Executed(id);
    }

    /// Each kind may only call its own contracts, so an Ordinary vote (lower floor) can never spend, change parameters or
    /// remove an NGO.
    function _allowed(uint8 kind, address t) private pure returns (bool) {
        if (kind == TREASURY_KIND) return t == Addrs.TREASURY;
        if (kind == PARAMETER) return t == Addrs.PARAMS;
        if (kind == FUND) return t == Addrs.FUND_APPROVALS;
        if (kind == REMOVAL) return t == Addrs.NGO_ELECTION;
        // the Upgrade kind also replaces the bootstrap finality signers (FinalityCommittee.replaceBootstrap)
        if (kind == UPGRADE) return t == Addrs.UPGRADE_REGISTRY || t == Addrs.FINALITY_COMMITTEE;
        if (kind == EMERGENCY) return t == Addrs.EMERGENCY_PAUSE;
        return t != Addrs.TREASURY && t != Addrs.PARAMS && t != Addrs.FUND_APPROVALS && t != Addrs.GOVERNOR
            && t != Addrs.VOTE_ESCROW && t != Addrs.NGO_ELECTION && t != Addrs.UPGRADE_REGISTRY && t != Addrs.EMERGENCY_PAUSE
            && t != Addrs.DEV_COUNCIL && t != Addrs.FINALITY_COMMITTEE;
    }

    function _get(uint256 id) private view returns (Proposal storage) {
        if (id >= _props.length) revert UnknownProposal();
        return _props[id];
    }

    function proposalCount() external view returns (uint256) {
        return _props.length;
    }

    function getProposal(uint256 id) external view returns (Proposal memory) {
        return _get(id);
    }

    function actions(uint256 id)
        external
        view
        returns (address[] memory targets, uint256[] memory values, bytes[] memory calldatas)
    {
        _get(id);
        return (_targets[id], _values[id], _calldatas[id]);
    }
}
