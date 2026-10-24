// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Sys, Addrs, IDevCouncil, IFinalityCommitteeSeats} from "./Base.sol";

/// Emergency pause (DAG_SPEC.md section 17.4, owner decisions of 15 October 2026).
///
/// Two kinds: one system contract (its user entry points revert with Paused, through Sys.whenActive), or the whole
/// network (target = address(0): the node refuses every user transaction except an allowlist: governance, upgrades,
/// the pause itself, the council, finality beacon transactions and DevVesting.release, all with value 0). Mining,
/// rewards, system calls, finality and the handover keep running; the 12 % keeps vesting and can be released into the
/// Dev Account wallets, which cannot send it on until the pause ends (no transfers for anyone).
///
/// Who: the dev council (2 of 3 council keys, through DevCouncil); after the handover also the finality committee:
/// 14 of the current epoch's members, at least 4 of them NGOs, each sending `committeeVote` within 6 hours.
/// Length: at most 72 hours, then it lifts by itself. Only a DAO vote (Governor, Emergency proposal) can pause for
/// longer (up to 30 days at a time) or end a pause early. Before the handover the council can also end or renew its
/// pauses.
/// Limits: before the handover the council may renew its pauses (and add targets) for at most 7 days in a row, counted
/// from the first pause of the run; then it cannot pause for 7 days after the run's planned end (unlimited
/// renewals would let two keys stop the NGO election forever and keep the council's powers). After the handover the council can start a pause at most once every 7 days, and not at all for 30 days
/// after the DAO ended one of its pauses early. The committee cannot pause the same target again within 7 days of its
/// last committee pause. Nothing can pause the DevVesting contracts, the Governor, the council, the upgrade registry
/// or this contract.
contract EmergencyPause is Sys {
    uint256 public constant MAX_PAUSE = 72 hours;
    uint256 public constant DAO_MAX_PAUSE = 30 days;
    uint256 public constant COUNCIL_COOLDOWN = 7 days;
    uint256 public constant COUNCIL_LOCKOUT = 30 days;
    uint256 public constant COUNCIL_MAX_RUN = 7 days; // before the handover
    uint256 public constant COMMITTEE_VOTES = 14;
    uint256 public constant COMMITTEE_NGO_VOTES = 4;
    uint256 public constant REQUEST_TTL = 6 hours;
    uint256 public constant COMMITTEE_REPAUSE = 7 days;
    uint8 internal constant SEAT_NGO = 1;

    uint8 public constant BY_COUNCIL = 1;
    uint8 public constant BY_COMMITTEE = 2;
    uint8 public constant BY_DAO = 3;

    struct Pause {
        uint8 by;
        uint64 at;
        uint64 until;
        bytes32 reason;
        uint256 record; // index in history + 1
    }

    struct Record {
        address target;
        uint8 by;
        uint64 at;
        uint64 until;
        bool endedEarly;
        bytes32 reason;
    }

    struct Request {
        address target;
        bytes32 reason;
        uint64 epoch;
        uint64 openedAt;
        uint16 votes;
        uint16 ngoVotes;
        bool done;
    }

    mapping(address => Pause) public pauses; // address(0) = the whole network
    Record[] private _history;
    uint64 public lastCouncilPauseAfterHandover;
    uint64 public councilLockoutUntil;
    uint64 public councilRunStart; // before the handover: the current (or last) run of council pauses
    uint64 public councilRunEnd;
    mapping(address => uint64) public lastCommitteePause;
    Request[] private _requests;
    mapping(uint256 => mapping(address => bool)) public voted;
    /// The open request for (target, reason): id + 1, found without scanning.
    mapping(bytes32 => uint256) public openRequest;
    /// Requests a member opened in its current 6-hour window, and when that window began.
    uint256 public constant MAX_OPEN_PER_MEMBER = 3;
    mapping(address => uint64) public openWindowStart;
    mapping(address => uint8) public openedInWindow;

    error NotPausable(address target);
    error OnlyCouncil();
    error CouncilCooldown(uint256 until);
    error AlreadyPaused(uint256 until);
    error NotPaused();
    error NotACommitteeMember();
    error AlreadyVoted();
    error CommitteeCooldown(uint256 until);
    error TooLong();
    error CouncilStillActive();
    error TooManyRequests();
    error NotTheCouncilsPause();

    event PauseStarted(address indexed target, uint8 by, bytes32 reason, uint256 until);
    event PauseEnded(address indexed target, uint8 by, bool early);
    event CommitteeVoted(uint256 indexed request, address indexed member, address target, bytes32 reason, uint256 votes, uint256 ngoVotes);

    // ---- views used by the contracts and the node ----

    /// A paused system contract (its user entry points revert).
    function blocked(address target) external view returns (bool) {
        return target != address(0) && pauses[target].until > block.timestamp;
    }

    /// The whole network is paused (the node allows only the allowlisted transactions).
    function networkPaused() external view returns (bool) {
        return pauses[address(0)].until > block.timestamp;
    }

    /// Targets a pause may name: the network, or a system contract with user entry points (not the 12 %, governance,
    /// the council, the registry, the modes, the parameters or this contract).
    function pausable(address t) public pure returns (bool) {
        return t == address(0) || t == Addrs.MINER_REGISTRY || t == Addrs.NGO_REGISTRY || t == Addrs.ATTESTATION || t == Addrs.VOTE_ESCROW
            || t == Addrs.NGO_ELECTION || t == Addrs.ROLE_ELECTION || t == Addrs.TREASURY || t == Addrs.NGO_REWARDS
            || t == Addrs.FINALITY_COMMITTEE || t == Addrs.FUND_APPROVALS;
    }

    // ---- council ----

    function pauseByCouncil(address target, bytes32 reason) external {
        if (msg.sender != Addrs.DEV_COUNCIL) revert OnlyCouncil();
        if (!pausable(target)) revert NotPausable(target);
        uint256 until = block.timestamp + MAX_PAUSE;
        if (IDevCouncil(Addrs.DEV_COUNCIL).retired()) {
            uint256 next = uint256(lastCouncilPauseAfterHandover) + COUNCIL_COOLDOWN;
            if (lastCouncilPauseAfterHandover != 0 && block.timestamp < next) revert CouncilCooldown(next);
            if (block.timestamp < councilLockoutUntil) revert CouncilCooldown(councilLockoutUntil);
            lastCouncilPauseAfterHandover = uint64(block.timestamp);
        } else if (block.timestamp < councilRunEnd) {
            // inside a run: renew or add a target, but never past 7 days from the run's start
            uint256 cap = uint256(councilRunStart) + COUNCIL_MAX_RUN;
            if (until > cap) until = cap;
            if (until <= block.timestamp) revert CouncilCooldown(uint256(councilRunEnd) + COUNCIL_COOLDOWN);
        } else {
            uint256 next = uint256(councilRunEnd) + COUNCIL_COOLDOWN;
            if (councilRunEnd != 0 && block.timestamp < next) revert CouncilCooldown(next);
            councilRunStart = uint64(block.timestamp);
        }
        _start(target, BY_COUNCIL, reason, until);
        if (until > councilRunEnd) councilRunEnd = uint64(until);
    }

    /// Before the handover the council can end a pause early.
    function unpauseByCouncil(address target) external {
        if (msg.sender != Addrs.DEV_COUNCIL || IDevCouncil(Addrs.DEV_COUNCIL).retired()) revert OnlyCouncil();
        // only its own pauses: a committee or DAO pause is not the council's to lift
        if (pauses[target].by != BY_COUNCIL) revert NotTheCouncilsPause();
        _end(target, BY_COUNCIL);
    }

    // ---- finality committee ----

    /// A committee member asks to pause `target` for `reason`. The committee may do so after the handover only. Votes for the same target and reason within 6 hours of the first
    /// add up; the request belongs to the committee seated at the first vote for its whole 6 hours, so an epoch change
    /// does not reset it. At 14 votes with at least 4 NGO members the pause starts. A member opens at most
    /// 3 requests per 6 hours, and a request is found through a mapping, so votes never scan a growing list.
    function committeeVote(address target, bytes32 reason) external returns (uint256 id) {
        if (!pausable(target)) revert NotPausable(target);
        if (!IDevCouncil(Addrs.DEV_COUNCIL).retired()) revert CouncilStillActive();
        IFinalityCommitteeSeats fc = IFinalityCommitteeSeats(Addrs.FINALITY_COMMITTEE);
        bytes32 k = keccak256(abi.encode(target, reason));
        uint256 open = openRequest[k];
        if (open != 0) {
            Request storage o = _requests[open - 1];
            if (o.done || block.timestamp > uint256(o.openedAt) + REQUEST_TTL) open = 0; // expired or carried out
        }
        if (open == 0) {
            uint256 next = uint256(lastCommitteePause[target]) + COMMITTEE_REPAUSE;
            if (lastCommitteePause[target] != 0 && block.timestamp < next) revert CommitteeCooldown(next);
            uint256 e0 = fc.currentEpoch();
            if (fc.seatOf(e0, msg.sender) == 0 || fc.slashed(e0, msg.sender)) revert NotACommitteeMember();
            if (block.timestamp >= uint256(openWindowStart[msg.sender]) + REQUEST_TTL) {
                openWindowStart[msg.sender] = uint64(block.timestamp);
                openedInWindow[msg.sender] = 0;
            }
            if (openedInWindow[msg.sender] >= MAX_OPEN_PER_MEMBER) revert TooManyRequests();
            openedInWindow[msg.sender] += 1;
            _requests.push(Request(target, reason, uint64(e0), uint64(block.timestamp), 0, 0, false));
            open = _requests.length;
            openRequest[k] = open;
        }
        id = open - 1;
        Request storage r = _requests[id];
        uint8 seat = fc.seatOf(r.epoch, msg.sender);
        if (seat == 0 || fc.slashed(r.epoch, msg.sender)) revert NotACommitteeMember();
        if (voted[id][msg.sender]) revert AlreadyVoted();
        voted[id][msg.sender] = true;
        r.votes += 1;
        if (seat == SEAT_NGO) r.ngoVotes += 1;
        emit CommitteeVoted(id, msg.sender, target, reason, r.votes, r.ngoVotes);
        if (r.votes >= COMMITTEE_VOTES && r.ngoVotes >= COMMITTEE_NGO_VOTES) {
            r.done = true;
            lastCommitteePause[target] = uint64(block.timestamp);
            _start(target, BY_COMMITTEE, reason, block.timestamp + MAX_PAUSE);
        }
    }

    // ---- DAO ----

    /// Pause (or keep paused) for `duration` from now, up to 30 days: the only way past 72 hours.
    function daoPause(address target, bytes32 reason, uint256 duration) external onlyGovernor {
        if (!pausable(target)) revert NotPausable(target);
        if (duration == 0 || duration > DAO_MAX_PAUSE) revert TooLong();
        Pause storage p = pauses[target];
        if (p.until > block.timestamp) _close(target, p, false); // the DAO's pause replaces the running one
        _open(target, BY_DAO, reason, block.timestamp + duration);
    }

    /// End a pause early. If the council started it, the council cannot pause for the next 30 days.
    function daoUnpause(address target) external onlyGovernor {
        if (pauses[target].by == BY_COUNCIL && pauses[target].until > block.timestamp) {
            councilLockoutUntil = uint64(block.timestamp + COUNCIL_LOCKOUT);
        }
        _end(target, BY_DAO);
    }

    // ---- internals ----

    /// Start or renew a 72-hour pause; it never shortens a longer one that is running.
    function _start(address target, uint8 by, bytes32 reason, uint256 until) private {
        Pause storage p = pauses[target];
        if (p.until >= until) revert AlreadyPaused(p.until);
        if (p.until > block.timestamp) _close(target, p, false);
        _open(target, by, reason, until);
    }

    function _open(address target, uint8 by, bytes32 reason, uint256 until) private {
        _history.push(Record(target, by, uint64(block.timestamp), uint64(until), false, reason));
        pauses[target] = Pause(by, uint64(block.timestamp), uint64(until), reason, _history.length);
        emit PauseStarted(target, by, reason, until);
    }

    function _end(address target, uint8 by) private {
        Pause storage p = pauses[target];
        if (p.until <= block.timestamp) revert NotPaused();
        _close(target, p, true);
        emit PauseEnded(target, by, true);
    }

    function _close(address, Pause storage p, bool early) private {
        if (p.record != 0) {
            Record storage r = _history[p.record - 1];
            r.until = uint64(block.timestamp);
            r.endedEarly = early;
        }
        p.until = uint64(block.timestamp);
    }

    function historyCount() external view returns (uint256) {
        return _history.length;
    }

    function history(uint256 i) external view returns (Record memory) {
        return _history[i];
    }

    function requestCount() external view returns (uint256) {
        return _requests.length;
    }

    function request(uint256 i) external view returns (Request memory) {
        return _requests[i];
    }
}
