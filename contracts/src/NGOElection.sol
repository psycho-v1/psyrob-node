// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Sys, Addrs, C, INGORegistry, IVoteEscrow, INGORewards} from "./Base.sol";

/// Elections of exactly 100 NGO seats for 1-year terms (DAG_SPEC.md section 8.4).
///   Term 1 starts 90 days after genesis; term n starts 365 days after term n-1.
///   Main round for term n: the 30 days before it starts (for term 1: from genesis to day 90). It fills up to 100 seats.
///   Supplementary rounds during term n: 30-day rounds (up to 11) that fill seats left empty, for the rest of the term.
/// Voting: approval ballots weighted by PSY locked in VoteEscrow at the block before the ballot; one ballot per voter
/// per round; role holders cannot vote. A ballot lists the approved candidates in increasing address order. Candidates: attested NGOs that stand, from their miner wallet.
/// Winners: the candidates with the most approval weight (> 0), ties to the earlier attestation, then the lower address.
/// Snapshot (RISK_REVIEW.md Part 3): a ballot weighs min(locked PSY at the block before the round opened, locked PSY
/// at the block before the ballot), so PSY locked after a round opened (bought or borrowed for the vote) adds nothing,
/// and the order in which ballots land in the DAG cannot change a result. Exception: the main round of term 1 opens at
/// genesis, when nobody can hold PSY yet (no airdrop); there the ballot-time weight applies, held until the close.
/// Lock-time weight and cap (RISK_REVIEW.md 3.7): the weight is also at most the voter's average locked PSY over the
/// LOCK_WINDOW chain blocks (about 30 days) before the ballot, so PSY locked shortly before voting counts only in
/// proportion to the time it has been locked; and one ballot weighs at most `maxBallotWeightBps` of the total locked
/// PSY (at the round's snapshot; in term 1's main round, at the ballot). A cap per wallet can be avoided by splitting
/// PSY over wallets; it bounds what one wallet does, not what one party does.
/// Term limit: an NGO elected in both of the two previous terms cannot stand (or be elected) for the next one; it may
/// stand again after a full term without a seat. A seat won in a supplementary round counts as a term.
/// First election (main round of term 1, RISK_REVIEW.md 3.8 (b)): besides its approval weight, a candidate needs
/// approvals from at least `firstElectionMinVoters` distinct ballots whose voter had at least `minCountedVoterLock`
/// PSY locked at the ballot. Addresses are cheap, so this raises the cost of a capture by a few wallets; it does not
/// stop one party with many funded wallets.
/// Removal: an elected NGO can be removed for the rest of its term by a Removal proposal (Governor kind 4: 10 % floor,
/// Normal mode, 48-hour timelock). It loses its seat, its unclaimed NGO rewards of the term and its attestation; the seat
/// is filled in the next supplementary round.
contract NGOElection is Sys {
    uint256 public constant MAX_CANDIDATES = 250;
    uint256 public constant LOCK_WINDOW = 259_200; // chain blocks, ~30 days at 10 s
    uint256 public constant MAX_CONSECUTIVE_TERMS = 2;

    struct Round {
        uint32 term;
        uint8 slot; // 0 = main round, 1..11 = supplementary
        uint64 opens;
        uint64 closes;
        uint16 seats;
        bool finalized;
        uint32 ballots;
    }

    Round[] private _rounds;
    mapping(uint256 => address[]) private _candidates;
    mapping(uint256 => mapping(address => bool)) public isCandidate;
    mapping(uint256 => mapping(address => uint256)) public approvals;
    mapping(uint256 => mapping(address => bool)) public hasBallot;
    mapping(uint256 => mapping(uint256 => uint256)) public roundOf; // term => slot => roundId + 1
    mapping(uint256 => mapping(address => bool)) private _elected; // term => ngo
    mapping(uint256 => address[]) private _electedList; // term => ngos
    mapping(address => uint256) public lastElectedTerm;
    mapping(uint256 => uint256) public snapshotOf; // roundId => block whose locked PSY counts (0: ballot time)
    mapping(uint256 => mapping(address => bool)) public removedIn; // term => ngo
    mapping(uint256 => mapping(address => uint256)) public approvers; // roundId => candidate => counted voters

    error NoRoundDue();
    error RoundExists();
    error NoSeats();
    error UnknownRound();
    error NotOpen();
    error NotClosed();
    error AlreadyFinalized();
    error NotAttested();
    error AlreadyCandidate();
    error TooManyCandidates();
    error AlreadyVoted();
    error NoVotingPower();
    error NotACandidate(address a);
    error DuplicateApproval(address a);
    error ApprovalsNotSorted();
    error NotElected();
    error WouldLeaveTooFew();
    error TermLimit();

    event RoundOpened(uint256 indexed roundId, uint256 term, uint256 slot, uint256 seats, uint256 opens, uint256 closes);
    event Candidate(uint256 indexed roundId, address indexed ngo);
    event Ballot(uint256 indexed roundId, address indexed voter, uint256 weight, address[] approved);
    event Elected(uint256 indexed roundId, uint256 indexed term, address indexed ngo, uint256 approvalWeight);
    event RoundFinalized(uint256 indexed roundId, uint256 elected);
    event Removed(uint256 indexed term, address indexed ngo, bytes32 reasonHash);

    // ---- calendar ----

    function termStart(uint256 term) public view returns (uint256) {
        return _genesis() + C.FIRST_ELECTION + (term - 1) * C.TERM;
    }

    function currentTerm() public view returns (uint256) {
        uint256 t1 = _genesis() + C.FIRST_ELECTION;
        if (block.timestamp < t1) return 0;
        return 1 + (block.timestamp - t1) / C.TERM;
    }

    /// The round that should be open now: (term, slot, opens, closes), or ok = false.
    function dueRound() public view returns (bool ok, uint256 term, uint256 slot, uint256 opens, uint256 closes) {
        uint256 cur = currentTerm();
        uint256 next = cur + 1;
        uint256 mainOpens = next == 1 ? _genesis() : termStart(next) - C.MAIN_ROUND;
        if (block.timestamp >= mainOpens) return (true, next, 0, mainOpens, termStart(next));
        if (cur == 0) return (false, 0, 0, 0, 0);
        uint256 into = block.timestamp - termStart(cur);
        slot = into / C.SUPPLEMENTARY_ROUND + 1;
        if (slot > 11) return (false, 0, 0, 0, 0);
        opens = termStart(cur) + (slot - 1) * C.SUPPLEMENTARY_ROUND;
        return (true, cur, slot, opens, opens + C.SUPPLEMENTARY_ROUND);
    }

    // ---- rounds ----

    /// Open the round that is due now. Anyone may call; the node also calls `advance` every chain block.
    function open() public whenActive returns (uint256 roundId) {
        (bool ok, uint256 term, uint256 slot, uint256 opens, uint256 closes) = dueRound();
        if (!ok) revert NoRoundDue();
        if (roundOf[term][slot] != 0) revert RoundExists();
        uint256 seats = C.NGO_SEATS - (slot == 0 ? 0 : _electedList[term].length);
        if (seats == 0) revert NoSeats();
        roundId = _rounds.length;
        _rounds.push(Round(uint32(term), uint8(slot), uint64(opens), uint64(closes), uint16(seats), false, 0));
        roundOf[term][slot] = roundId + 1;
        if (!(term == 1 && slot == 0)) snapshotOf[roundId] = block.number - 1;
        emit RoundOpened(roundId, term, slot, seats, opens, closes);
    }

    function stand(uint256 roundId) external whenActive {
        Round storage r = _round(roundId);
        if (block.timestamp >= r.closes) revert NotOpen();
        if (INGORegistry(Addrs.NGO_REGISTRY).status(msg.sender) != 2) revert NotAttested();
        if (isCandidate[roundId][msg.sender]) revert AlreadyCandidate();
        if (r.slot != 0 && _elected[r.term][msg.sender]) revert AlreadyCandidate();
        if (termLimited(r.term, msg.sender)) revert TermLimit();
        if (_candidates[roundId].length >= MAX_CANDIDATES) revert TooManyCandidates();
        isCandidate[roundId][msg.sender] = true;
        _candidates[roundId].push(msg.sender);
        emit Candidate(roundId, msg.sender);
    }

    function vote(uint256 roundId, address[] calldata approved) external whenActive {
        Round storage r = _round(roundId);
        if (block.timestamp >= r.closes || block.timestamp < r.opens) revert NotOpen();
        if (_isRoleHolder(msg.sender)) revert RoleHolderCannotVote();
        if (hasBallot[roundId][msg.sender]) revert AlreadyVoted();
        uint256 w = ballotWeight(roundId, msg.sender);
        if (w == 0) revert NoVotingPower();
        hasBallot[roundId][msg.sender] = true;
        r.ballots += 1;
        bool counted = IVoteEscrow(Addrs.VOTE_ESCROW).powerAt(msg.sender, block.number - 1) >= _param("minCountedVoterLock");
        // approvals in strictly increasing address order: duplicates are impossible and the check is linear
        for (uint256 i; i < approved.length; ++i) {
            address c = approved[i];
            if (i > 0 && c <= approved[i - 1]) revert ApprovalsNotSorted();
            if (!isCandidate[roundId][c]) revert NotACandidate(c);
            approvals[roundId][c] += w;
            if (counted) approvers[roundId][c] += 1;
        }
        IVoteEscrow(Addrs.VOTE_ESCROW).holdUntil(msg.sender, r.closes);
        emit Ballot(roundId, msg.sender, w, approved);
    }

    function finalize(uint256 roundId) public whenActive {
        Round storage r = _round(roundId);
        if (block.timestamp < r.closes) revert NotClosed();
        if (r.finalized) revert AlreadyFinalized();
        r.finalized = true;
        address[] memory cs = _candidates[roundId];
        uint256 n = cs.length;
        uint256[] memory w = new uint256[](n);
        uint256[] memory at = new uint256[](n);
        INGORegistry reg = INGORegistry(Addrs.NGO_REGISTRY);
        for (uint256 i; i < n; ++i) {
            // a candidate whose attestation was revoked (removed NGO) cannot win
            // nor one that reached the term limit after standing (a late supplementary seat in the previous term)
            w[i] = reg.status(cs[i]) == 2 && !termLimited(r.term, cs[i]) ? approvals[roundId][cs[i]] : 0;
            at[i] = _attestedAt(reg, cs[i]);
        }
        if (r.term == 1 && r.slot == 0) {
            uint256 minVoters = _param("firstElectionMinVoters");
            for (uint256 i; i < n; ++i) if (approvers[roundId][cs[i]] < minVoters) w[i] = 0;
        }
        uint256 seats = r.seats;
        if (r.slot != 0) {
            uint256 taken = _electedList[r.term].length;
            seats = taken >= C.NGO_SEATS ? 0 : C.NGO_SEATS - taken;
        }
        uint256 elected;
        for (uint256 k; k < seats; ++k) {
            uint256 best = type(uint256).max;
            for (uint256 i; i < n; ++i) {
                if (w[i] == 0) continue;
                if (best == type(uint256).max || _better(w[i], at[i], cs[i], w[best], at[best], cs[best])) best = i;
            }
            if (best == type(uint256).max) break;
            address ngo = cs[best];
            uint256 weight = w[best];
            w[best] = 0;
            if (_elected[r.term][ngo]) continue;
            _elected[r.term][ngo] = true;
            _electedList[r.term].push(ngo);
            lastElectedTerm[ngo] = r.term;
            INGORewards(Addrs.NGO_REWARDS).onElected(r.term, ngo);
            ++elected;
            emit Elected(roundId, r.term, ngo, weight);
        }
        emit RoundFinalized(roundId, elected);
    }

    /// The weight `voter` would cast in `roundId` now (see the snapshot rule above).
    function ballotWeight(uint256 roundId, address voter) public view returns (uint256 w) {
        IVoteEscrow ve = IVoteEscrow(Addrs.VOTE_ESCROW);
        uint256 b = block.number - 1;
        w = ve.powerAt(voter, b);
        uint256 avg = ve.averageOver(voter, b > LOCK_WINDOW ? b - LOCK_WINDOW : 0, b);
        if (avg < w) w = avg;
        uint256 snap = snapshotOf[roundId];
        if (snap != 0) {
            uint256 then_ = ve.powerAt(voter, snap);
            if (then_ < w) w = then_;
        }
        uint256 cap = ve.totalAt(snap != 0 ? snap : b) * _param("maxBallotWeightBps") / 10_000;
        if (cap < w) w = cap;
    }

    /// True if `ngo` held a seat in both terms before `term` (MAX_CONSECUTIVE_TERMS = 2).
    function termLimited(uint256 term, address ngo) public view returns (bool) {
        if (term <= MAX_CONSECUTIVE_TERMS) return false;
        for (uint256 k = 1; k <= MAX_CONSECUTIVE_TERMS; ++k) {
            if (!_elected[term - k][ngo] && !removedIn[term - k][ngo]) return false;
        }
        return true;
    }

    /// Removal of an elected NGO for the rest of the current term (a Removal proposal, executed by the Governor).
    function remove(address ngo, bytes32 reasonHash) external onlyGovernor {
        uint256 term = currentTerm();
        if (!_elected[term][ngo]) revert NotElected();
        // a removal must not take the network out of Normal mode
        if (_electedList[term].length <= C.MIN_NGOS_NORMAL) revert WouldLeaveTooFew();
        _elected[term][ngo] = false;
        removedIn[term][ngo] = true;
        address[] storage l = _electedList[term];
        for (uint256 i; i < l.length; ++i) {
            if (l[i] == ngo) {
                l[i] = l[l.length - 1];
                l.pop();
                break;
            }
        }
        emit Removed(term, ngo, reasonHash);
        INGORewards(Addrs.NGO_REWARDS).onRemoved(term, ngo);
        INGORegistry(Addrs.NGO_REGISTRY).revoke(ngo);
    }

    /// System call (every chain block): finalise closed rounds, open the round that is due.
    function advance() external onlySystem {
        uint256 n = _rounds.length;
        if (n > 0) {
            Round storage last = _rounds[n - 1];
            if (!last.finalized && block.timestamp >= last.closes) finalize(n - 1);
        }
        (bool ok, uint256 term, uint256 slot,,) = dueRound();
        if (ok && roundOf[term][slot] == 0) {
            uint256 seats = C.NGO_SEATS - (slot == 0 ? 0 : _electedList[term].length);
            if (seats > 0) open();
        }
    }

    function _better(uint256 w1, uint256 a1, address c1, uint256 w2, uint256 a2, address c2) private pure returns (bool) {
        if (w1 != w2) return w1 > w2;
        if (a1 != a2) return a1 < a2;
        return c1 < c2;
    }

    function _attestedAt(INGORegistry reg, address a) private view returns (uint256) {
        (bool ok, bytes memory ret) = address(reg).staticcall(abi.encodeWithSignature("attestedAt(address)", a));
        return ok && ret.length == 32 ? abi.decode(ret, (uint256)) : 0;
    }

    function _round(uint256 roundId) private view returns (Round storage) {
        if (roundId >= _rounds.length) revert UnknownRound();
        return _rounds[roundId];
    }

    // ---- views ----

    function isElected(address a) external view returns (bool) {
        return _elected[currentTerm()][a];
    }

    function isElectedIn(uint256 term, address a) external view returns (bool) {
        return _elected[term][a];
    }

    function electedCount() external view returns (uint256) {
        return _electedList[currentTerm()].length;
    }

    function electedList() external view returns (address[] memory) {
        return _electedList[currentTerm()];
    }

    function electedListOf(uint256 term) external view returns (address[] memory) {
        return _electedList[term];
    }

    function roundCount() external view returns (uint256) {
        return _rounds.length;
    }

    function getRound(uint256 roundId) external view returns (Round memory) {
        return _round(roundId);
    }

    function candidates(uint256 roundId) external view returns (address[] memory) {
        return _candidates[roundId];
    }
}
