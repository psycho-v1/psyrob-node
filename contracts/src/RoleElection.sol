// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Sys, Addrs, C, INGORegistry, IAttestation, ITreasury, IFinalityCommittee, IGovernanceMode} from "./Base.sol";

/// Operational roles: 0 CEO, 1 CTO, 2 Treasurer, 3 Community Lead, 4 Security Lead (DAG_SPEC.md section 8.5).
///   - Individuals only: an NGO (its wallet is its miner wallet) or a miner vouching for an NGO cannot stand.
///   - Elected by the elected NGOs, one NGO one vote, for 1-year terms, in Normal mode only.
///   - A round: 14 days of candidacy, then 14 days of voting. It opens when the role is vacant or its term ends within
///     28 days. The eligible candidate with the most votes (at least one) wins. If the top count is zero the role stays
///     vacant and the round can be run again.
///   - Ties are decided by a verifiable random draw among only the tied candidates (sorted by address,
///     winner = seed mod count). When voting has closed, the first finalize records the tie and opens a round of the
///     finality committee's randomness beacon (commit-reveal): the seed is its mix, which no
///     miner can influence. If nobody reveals, or no committee exists yet, the draw uses a seed block DRAW_DELAY chain
///     blocks later: the hash of the first finalised checkpoint at or after that block
///     (FinalityCommittee.checkpointBlock), mixed with the round ID and the role. If no such checkpoint is recorded
///     within CHECKPOINT_WAIT blocks of it (the committee stalled), the draw falls back once to the hash of the chain
///     block DRAW_DELAY blocks after the fallback. Anyone may run the draw once the seed exists, the node runs it every
///     chain block (advance), and it happens exactly once. Tied candidates who withdrew or became ineligible are
///     removed first; if one remains it wins without a draw, if none remain the role stays vacant.
///   - Role holders cannot vote anywhere while in office (VoteEscrow users check isRoleHolder).
///   - Pay: `rolePayPer30Days` PSY, streamed from the Treasury (Community/Treasury allocation), never from the
///     volunteer fund.
contract RoleElection is Sys {
    uint8 public constant ROLE_COUNT = 5;
    uint256 public constant MAX_CANDIDATES = 200; // bounds the gas of finalize
    uint64 public constant DRAW_DELAY = 30; // chain blocks between recording a tie and its seed block
    uint64 public constant CHECKPOINT_INTERVAL = 30; // chain blocks per checkpoint (node parameter)
    uint64 public constant CHECKPOINT_WAIT = 8_640; // ~24 h: then the draw falls back to a chain block hash

    uint8 public constant DRAW_NONE = 0;
    uint8 public constant DRAW_PENDING = 1;
    uint8 public constant DRAW_DONE = 2;
    uint8 public constant SOURCE_NONE = 0; // no draw needed (one eligible tied candidate left, or none)
    uint8 public constant SOURCE_CHECKPOINT = 1;
    uint8 public constant SOURCE_BLOCK = 2;
    uint8 public constant SOURCE_BEACON = 3; // the committee's commit-reveal beacon

    struct Draw {
        uint8 status;
        bool useCheckpoint;
        uint8 sourceKind;
        uint64 tieBlock; // chain height when the tie was recorded
        uint64 seedBlock; // chain height whose hash (or checkpoint at or after it) seeds the draw
        uint64 sourceRef; // checkpoint number or block number actually used
        uint64 drawnAt; // chain height of the draw
        uint256 votes; // the tied top vote count
        bytes32 sourceHash;
        bytes32 seed;
        address winner;
    }

    struct Holder {
        address who;
        uint64 termStart;
        uint64 termEnd;
        uint64 paidUntil;
    }

    struct Round {
        uint8 role;
        uint64 opens;
        bool finalized;
        address winner;
    }

    Holder[5] private _holders;
    Round[] private _rounds;
    mapping(uint256 => address[]) private _candidates;
    mapping(uint256 => mapping(address => uint256)) public votes;
    mapping(uint256 => mapping(address => bool)) public isCandidate;
    mapping(uint256 => mapping(address => bool)) public hasVoted;
    mapping(uint256 => mapping(address => uint256)) public deposits;
    mapping(uint8 => uint256) public openRoundOf; // role => roundId + 1 while a round is not finalized
    mapping(uint256 => bool) private _drawPending;
    mapping(uint256 => uint256) private _drawBeacon; // round => beacon round + 1 its tie draw waits for (0 = none)
    mapping(uint256 => Draw) private _draws;
    mapping(uint256 => address[]) private _tied; // sorted by address
    mapping(uint256 => mapping(address => bool)) public withdrawn;

    error NotNormalMode();
    error BadRole();
    error NotDue();
    error UnknownRound();
    error NotInCandidacy();
    error NotInVoting();
    error NotClosed();
    error AlreadyFinalized();
    error NotEligible();
    error AlreadyCandidate();
    error WrongDeposit(uint256 expected);
    error NotAnElectedNGO();
    error AlreadyVoted();
    error NotACandidate();
    error NothingToClaim();
    error TooManyCandidates();
    error DrawPending();
    error NoDraw();
    error AlreadyDrawn();
    error SeedNotReady(uint256 seedBlock);

    event RoundOpened(uint256 indexed roundId, uint8 indexed role, uint256 opens);
    event Candidate(uint256 indexed roundId, address indexed who);
    event Voted(uint256 indexed roundId, address indexed ngo, address indexed candidate);
    event RoleFilled(uint8 indexed role, address indexed who, uint256 termStart, uint256 termEnd);
    event Paid(uint8 indexed role, address indexed who, uint256 amount);
    event PayDeferred(uint8 indexed role, address indexed who, uint256 amount);
    event DeferredPaid(address indexed who, uint256 amount);
    event NoWinner(uint256 indexed roundId, uint8 indexed role);
    event Withdrawn(uint256 indexed roundId, address indexed who);
    event TieRecorded(uint256 indexed roundId, uint8 indexed role, address[] tied, uint256 votes, uint256 seedBlock, bool useCheckpoint);
    event DrawFallback(uint256 indexed roundId, uint256 checkpointNotRecorded, uint256 newSeedBlock);
    /// The tie draw: election (round) ID, role, the tied candidates (sorted), their vote count, the seed source
    /// (1 checkpoint number, 2 block number, 0 no draw needed), the source hash, the seed and the winner.
    event RoleDrawn(
        uint256 indexed roundId,
        uint8 indexed role,
        address[] tied,
        uint256 votes,
        uint8 sourceKind,
        uint256 sourceRef,
        bytes32 sourceHash,
        bytes32 seed,
        address winner
    );

    /// Outgoing holders' final pay that the Treasury could not cover at handover; paid by
    /// claimDeferredPay once the Treasury holds enough.
    mapping(address => uint256) public deferredPay;

    /// Open the role's due election, or return the round already open (the node also opens due rounds every block).
    function open(uint8 role) public whenActive returns (uint256 roundId) {
        if (role >= ROLE_COUNT) revert BadRole();
        if (_mode() != 1) revert NotNormalMode();
        if (openRoundOf[role] != 0) return openRoundOf[role] - 1;
        if (!_due(role)) revert NotDue();
        return _open(role);
    }

    /// A role is due for an election when it has no holder or its term ends within candidacy + voting.
    function _due(uint8 role) private view returns (bool) {
        Holder storage h = _holders[role];
        return h.who == address(0) || h.termEnd <= block.timestamp + C.ROLE_CANDIDACY + C.ROLE_VOTING;
    }

    function _open(uint8 role) private returns (uint256 roundId) {
        roundId = _rounds.length;
        _rounds.push(Round(role, uint64(block.timestamp), false, address(0)));
        openRoundOf[role] = roundId + 1;
        emit RoundOpened(roundId, role, block.timestamp);
    }

    function stand(uint256 roundId) external payable whenActive {
        Round storage r = _round(roundId);
        if (block.timestamp >= r.opens + C.ROLE_CANDIDACY) revert NotInCandidacy();
        if (isCandidate[roundId][msg.sender]) revert AlreadyCandidate();
        if (_candidates[roundId].length >= MAX_CANDIDATES) revert TooManyCandidates();
        if (
            INGORegistry(Addrs.NGO_REGISTRY).isNGO(msg.sender) || IAttestation(Addrs.ATTESTATION).hasActiveVouch(msg.sender)
                || _holdsOtherRole(msg.sender, r.role)
        ) revert NotEligible();
        uint256 d = _param("candidacyDeposit");
        if (msg.value != d) revert WrongDeposit(d);
        isCandidate[roundId][msg.sender] = true;
        deposits[roundId][msg.sender] = d;
        _candidates[roundId].push(msg.sender);
        emit Candidate(roundId, msg.sender);
    }

    function vote(uint256 roundId, address candidate) external whenActive {
        Round storage r = _round(roundId);
        uint256 vStart = r.opens + C.ROLE_CANDIDACY;
        if (block.timestamp < vStart || block.timestamp >= vStart + C.ROLE_VOTING) revert NotInVoting();
        if (!_isElected(msg.sender)) revert NotAnElectedNGO();
        if (hasVoted[roundId][msg.sender]) revert AlreadyVoted();
        if (!isCandidate[roundId][candidate] || withdrawn[roundId][candidate]) revert NotACandidate();
        hasVoted[roundId][msg.sender] = true;
        votes[roundId][candidate] += 1;
        emit Voted(roundId, msg.sender, candidate);
    }

    /// A candidate leaves the round (before it is decided). Its votes stop counting; the deposit is refunded as usual.
    function withdrawCandidacy(uint256 roundId) external whenActive {
        Round storage r = _round(roundId);
        if (r.finalized) revert AlreadyFinalized();
        if (!isCandidate[roundId][msg.sender] || withdrawn[roundId][msg.sender]) revert NotACandidate();
        withdrawn[roundId][msg.sender] = true;
        emit Withdrawn(roundId, msg.sender);
    }

    /// After voting: a single top candidate wins; a zero top count leaves the role vacant; a tie records a draw.
    function finalize(uint256 roundId) public whenActive {
        Round storage r = _round(roundId);
        if (block.timestamp < r.opens + C.ROLE_CANDIDACY + C.ROLE_VOTING) revert NotClosed();
        if (r.finalized) revert AlreadyFinalized();
        if (_drawPending[roundId]) revert DrawPending();
        address[] storage cs = _candidates[roundId];
        uint256 bestVotes;
        uint256 n;
        for (uint256 i; i < cs.length; ++i) {
            if (!_eligible(roundId, cs[i], r.role)) continue;
            uint256 v = votes[roundId][cs[i]];
            if (v > bestVotes) { bestVotes = v; n = 1; }
            else if (v == bestVotes && v > 0) ++n;
        }
        if (bestVotes == 0) {
            _close(roundId, r);
            emit NoWinner(roundId, r.role);
            return;
        }
        address[] memory top = new address[](n);
        uint256 k;
        for (uint256 i; i < cs.length; ++i) {
            if (_eligible(roundId, cs[i], r.role) && votes[roundId][cs[i]] == bestVotes) top[k++] = cs[i];
        }
        if (n == 1) {
            _close(roundId, r);
            _install(r, top[0]);
            return;
        }
        _sort(top);
        _tied[roundId] = top;
        _drawPending[roundId] = true;
        bool cp = IGovernanceMode(Addrs.GOVERNANCE_MODE).finalityActive();
        uint64 seedBlock = uint64(block.number) + DRAW_DELAY;
        _draws[roundId] = Draw(DRAW_PENDING, cp, 0, uint64(block.number), seedBlock, 0, 0, bestVotes, bytes32(0), bytes32(0), address(0));
        if (cp) _drawBeacon[roundId] = IFinalityCommittee(Addrs.FINALITY_COMMITTEE).requestBeacon();
        emit TieRecorded(roundId, r.role, top, bestVotes, seedBlock, cp);
    }

    /// Run the tie draw. Anyone may call it once the seed exists; it runs once. Reverts with SeedNotReady before that
    /// (except when the checkpoint never came: then it switches once to the block fallback and returns).
    function draw(uint256 roundId) public whenActive {
        Draw storage d = _draws[roundId];
        if (d.status == DRAW_NONE) revert NoDraw();
        if (d.status == DRAW_DONE) revert AlreadyDrawn();
        (bool ready, bool fellBack) = _tryDraw(roundId);
        if (!ready && !fellBack) revert SeedNotReady(d.seedBlock);
    }

    function _tryDraw(uint256 roundId) private returns (bool done, bool fellBack) {
        Draw storage d = _draws[roundId];
        Round storage r = _rounds[roundId];
        address[] memory tied = _tied[roundId];
        // remove tied candidates who withdrew or became ineligible
        uint256 m;
        for (uint256 i; i < tied.length; ++i) if (_eligible(roundId, tied[i], r.role)) ++m;
        address[] memory left = new address[](m);
        m = 0;
        for (uint256 i; i < tied.length; ++i) if (_eligible(roundId, tied[i], r.role)) left[m++] = tied[i];
        if (left.length <= 1) {
            _finishDraw(roundId, d, r, tied, SOURCE_NONE, 0, bytes32(0), bytes32(0), left.length == 1 ? left[0] : address(0));
            return (true, false);
        }
        uint256 br = _drawBeacon[roundId];
        if (br != 0) {
            IFinalityCommittee.BeaconRound memory b = IFinalityCommittee(Addrs.FINALITY_COMMITTEE).beacon(br - 1);
            if (!b.closed) return (false, false); // the committee is revealing
            _drawBeacon[roundId] = 0;
            if (b.reveals > 0) {
                _finishDraw(roundId, d, r, tied, SOURCE_BEACON, uint64(br - 1), b.mix, keccak256(abi.encode(b.mix, roundId, r.role)),
                    left[pick(b.mix, roundId, r.role, left.length)]);
                return (true, false);
            }
            // nobody revealed: the checkpoint / block sources, from now on
            d.seedBlock = uint64(block.number) + DRAW_DELAY;
            emit DrawFallback(roundId, 0, d.seedBlock);
            return (false, true);
        }
        (uint8 kind, uint64 ref, bytes32 h) = _seedSource(d);
        if (kind == SOURCE_NONE) {
            if (d.useCheckpoint && block.number > uint256(_checkpointHeight(d.seedBlock)) + CHECKPOINT_WAIT) {
                // the committee did not finalise the seed checkpoint: fall back, once, to a future chain block hash
                uint256 missing = _checkpointNumber(d.seedBlock);
                d.useCheckpoint = false;
                d.seedBlock = uint64(block.number) + DRAW_DELAY;
                emit DrawFallback(roundId, missing, d.seedBlock);
                return (false, true);
            }
            if (!d.useCheckpoint && block.number > uint256(d.seedBlock) + 256) {
                // the block hash is out of reach (nobody drew in time; the node draws every block): next block window
                d.seedBlock = uint64(block.number) + DRAW_DELAY;
                emit DrawFallback(roundId, 0, d.seedBlock);
                return (false, true);
            }
            return (false, false);
        }
        bytes32 seed = keccak256(abi.encode(h, roundId, r.role));
        address winner = left[pick(h, roundId, r.role, left.length)];
        _finishDraw(roundId, d, r, tied, kind, ref, h, seed, winner);
        return (true, false);
    }

    /// The draw itself, pure so anyone can recompute it: index into the tied candidates sorted by address.
    function pick(bytes32 sourceHash, uint256 roundId, uint8 role, uint256 count) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(sourceHash, roundId, role))) % count;
    }

    function _seedSource(Draw storage d) private view returns (uint8 kind, uint64 ref, bytes32 h) {
        if (d.useCheckpoint) {
            uint64 c = _checkpointNumber(d.seedBlock);
            h = IFinalityCommittee(Addrs.FINALITY_COMMITTEE).checkpointBlock(c);
            return h == bytes32(0) ? (SOURCE_NONE, 0, bytes32(0)) : (SOURCE_CHECKPOINT, c, h);
        }
        if (block.number <= d.seedBlock || block.number > uint256(d.seedBlock) + 256) return (SOURCE_NONE, 0, bytes32(0));
        h = blockhash(d.seedBlock);
        return h == bytes32(0) ? (SOURCE_NONE, 0, bytes32(0)) : (SOURCE_BLOCK, d.seedBlock, h);
    }

    /// The first checkpoint at or after chain height `b`.
    function _checkpointNumber(uint64 b) private pure returns (uint64) {
        return (b + CHECKPOINT_INTERVAL - 1) / CHECKPOINT_INTERVAL;
    }

    function _checkpointHeight(uint64 b) private pure returns (uint64) {
        return _checkpointNumber(b) * CHECKPOINT_INTERVAL;
    }

    function _finishDraw(
        uint256 roundId,
        Draw storage d,
        Round storage r,
        address[] memory tied,
        uint8 kind,
        uint64 ref,
        bytes32 h,
        bytes32 seed,
        address winner
    ) private {
        d.status = DRAW_DONE;
        d.sourceKind = kind;
        d.sourceRef = ref;
        d.sourceHash = h;
        d.seed = seed;
        d.winner = winner;
        d.drawnAt = uint64(block.number);
        _drawPending[roundId] = false;
        _close(roundId, r);
        emit RoleDrawn(roundId, r.role, tied, d.votes, kind, ref, h, seed, winner);
        if (winner == address(0)) emit NoWinner(roundId, r.role);
        else _install(r, winner);
    }

    function _close(uint256 roundId, Round storage r) private {
        r.finalized = true;
        if (openRoundOf[r.role] == roundId + 1) openRoundOf[r.role] = 0;
    }

    function _install(Round storage r, address winner) private {
        r.winner = winner;
        // A round opens at most 28 days before the term ends and closes 28 days later, so the outgoing term has ended.
        // The new holder is installed first and the outgoing one is paid up to its term end afterwards, so a payment
        // recipient cannot re-enter while the old holder is still in place.
        Holder memory old = _holders[r.role];
        uint256 start = block.timestamp;
        _holders[r.role] = Holder(winner, uint64(start), uint64(start + C.ROLE_TERM), uint64(start));
        emit RoleFilled(r.role, winner, start, start + C.ROLE_TERM);
        if (old.who != address(0) && old.termEnd > old.paidUntil) {
            uint256 amount = _param("rolePayPer30Days") * (old.termEnd - old.paidUntil) / 30 days;
            if (amount > 0) {
                // a Treasury short of PSY must not block the handover: the pay is deferred and claimable later
                try ITreasury(Addrs.TREASURY).payRole(old.who, amount) {
                    emit Paid(r.role, old.who, amount);
                } catch {
                    deferredPay[old.who] += amount;
                    emit PayDeferred(r.role, old.who, amount);
                }
            }
        }
    }

    /// Pay an outgoing holder's deferred final pay (anyone may call). Reverts while the Treasury is still short.
    function claimDeferredPay(address who) external whenActive {
        uint256 amount = deferredPay[who];
        if (amount == 0) revert NothingToClaim();
        deferredPay[who] = 0;
        ITreasury(Addrs.TREASURY).payRole(who, amount);
        emit DeferredPaid(who, amount);
    }

    function _eligible(uint256 roundId, address a, uint8 role) private view returns (bool) {
        return !withdrawn[roundId][a] && !_holdsOtherRole(a, role) && !INGORegistry(Addrs.NGO_REGISTRY).isNGO(a)
            && !IAttestation(Addrs.ATTESTATION).hasActiveVouch(a);
    }

    function _sort(address[] memory a) private pure {
        for (uint256 i = 1; i < a.length; ++i) {
            address x = a[i];
            uint256 j = i;
            while (j > 0 && a[j - 1] > x) {
                a[j] = a[j - 1];
                --j;
            }
            a[j] = x;
        }
    }

    function withdrawDeposit(uint256 roundId) external whenActive {
        if (!_round(roundId).finalized) revert NotClosed();
        uint256 d = deposits[roundId][msg.sender];
        if (d == 0) revert NothingToClaim();
        deposits[roundId][msg.sender] = 0;
        _send(msg.sender, d);
    }

    /// Pay the role's holder what has accrued (anyone may call). Paid by the Treasury.
    function claimPay(uint8 role) external whenActive {
        if (role >= ROLE_COUNT) revert BadRole();
        if (_payOut(role) == 0) revert NothingToClaim();
    }

    function _payOut(uint8 role) private returns (uint256 amount) {
        Holder storage h = _holders[role];
        if (h.who == address(0)) return 0;
        uint256 end = block.timestamp < h.termEnd ? block.timestamp : h.termEnd;
        if (end <= h.paidUntil) return 0;
        amount = _param("rolePayPer30Days") * (end - h.paidUntil) / 30 days;
        h.paidUntil = uint64(end);
        if (amount > 0) {
            ITreasury(Addrs.TREASURY).payRole(h.who, amount);
            emit Paid(role, h.who, amount);
        }
    }

    /// System call (every chain block): finalise rounds whose voting ended and run tie draws whose seed exists.
    function advance() external onlySystem {
        bool normal = _mode() == 1;
        for (uint8 role; role < ROLE_COUNT; ++role) {
            uint256 id = openRoundOf[role];
            if (id == 0) {
                // open due elections without waiting for someone to call open()
                if (normal && _due(role)) _open(role);
                continue;
            }
            if (_drawPending[id - 1]) _tryDraw(id - 1);
            else if (block.timestamp >= _rounds[id - 1].opens + C.ROLE_CANDIDACY + C.ROLE_VOTING) finalize(id - 1);
        }
    }

    function _holdsOtherRole(address a, uint8 role) private view returns (bool) {
        for (uint8 i; i < ROLE_COUNT; ++i) {
            if (i != role && _holders[i].who == a && _holders[i].termEnd > block.timestamp) return true;
        }
        return false;
    }

    function _round(uint256 roundId) private view returns (Round storage) {
        if (roundId >= _rounds.length) revert UnknownRound();
        return _rounds[roundId];
    }

    // ---- views ----

    function isRoleHolder(address a) external view returns (bool) {
        if (a == address(0)) return false;
        for (uint8 i; i < ROLE_COUNT; ++i) {
            if (_holders[i].who == a && _holders[i].termStart <= block.timestamp && _holders[i].termEnd > block.timestamp) {
                return true;
            }
        }
        return false;
    }

    function roleHolders() external view returns (address[] memory out) {
        out = new address[](ROLE_COUNT);
        for (uint8 i; i < ROLE_COUNT; ++i) {
            Holder storage h = _holders[i];
            if (h.termStart <= block.timestamp && h.termEnd > block.timestamp) out[i] = h.who;
        }
    }

    function holder(uint8 role) external view returns (Holder memory) {
        return _holders[role];
    }

    function roundCount() external view returns (uint256) {
        return _rounds.length;
    }

    function getRound(uint256 roundId) external view returns (Round memory) {
        return _round(roundId);
    }

    function getDraw(uint256 roundId) external view returns (Draw memory, address[] memory tied) {
        return (_draws[roundId], _tied[roundId]);
    }

    function candidates(uint256 roundId) external view returns (address[] memory) {
        return _candidates[roundId];
    }
}
