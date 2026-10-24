// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Sys, Addrs, C, IMinerRegistry, INGORegistry, INGOElection} from "./Base.sol";

/// NGO attestation by staked vouching with a challenge (DAG_SPEC.md section 8.3).
///   1. Five registered miners (each with at least `vouchMinBlocks` blue blocks, not the NGO, not an NGO themselves)
///      vouch and lock `vouchBond` each.
///   2. A 7-day challenge window starts with the fifth vouch. Anyone may challenge by locking `challengeBond`.
///   3. A challenge is decided by the elected NGOs (one NGO, one vote; at least 5 votes, after 5 days), or at any time
///      by a governance decision (the Governor). In Interim mode the elected NGOs are the Interim Council.
///      Upheld: the vouchers' bonds are burned, the challenger is refunded, the NGO is rejected.
///      Dismissed: the challenger's bond is shared by the vouchers; the window restarts.
///   4. Without a pending challenge after the window, anyone may finalise: the NGO is attested.
///   a challenge that nobody decides within CHALLENGE_TIMEOUT lapses (anyone may close it): the
///   challenger gets the bond back and the window is not restarted, so one undecided challenge can no longer block an
///   NGO for good while no NGOs are elected. The token vote can still decide within the timeout, and can revoke the
///   attestation later. After a dismissal the same address cannot challenge that NGO again.
///   5. An attested NGO that is not elected can have its attestation revoked by a governance decision (revoke); an
///      elected one is removed through NGOElection.remove (a Removal proposal) instead. A Governor proposal calling
///      Attestation needs the high floor (10 % or 100 voters), the same as granting. Vouch bonds are not burned: a
///      stale or compromised NGO is not by itself evidence that its vouchers lied.
///   Vouch bonds unlock one term (365 days) after the vouch, unless burned.
///   A voucher backs at most `maxActiveVouches` NGOs at a time (RISK_REVIEW.md Part 3): without the cap, five
///   wallets with 100 blue blocks each could attest any number of NGOs run by one party. A voucher also needs a mining
///   history: blue blocks in at least `vouchMinEpochs` distinct 7-day epochs, so new voucher wallets cannot be made in
///   a burst (RISK_REVIEW.md 3.7). The five vouchers of one NGO must declare five different operators
///   (MinerRegistry.operatorOf; P3): labels are self-declared, but a false one becomes evidence for a challenge.
contract Attestation is Sys {
    struct Vouch {
        address voucher;
        uint96 bond;
        uint64 at;
        bool withdrawn;
    }

    struct Case {
        uint64 windowEnds; // 0 until the fifth vouch
        address challenger;
        uint96 challengeBond;
        bytes32 reasonHash;
        uint64 challengedAt;
        uint32 upholdVotes;
        uint32 dismissVotes;
        uint32 round; // increments with each challenge (separates NGO votes)
        bool done; // attested or rejected
    }

    mapping(address => Vouch[]) private _vouches;
    mapping(address => Case) private _cases;
    mapping(address => mapping(address => bool)) public hasVouched; // ngo => voucher
    mapping(address => mapping(uint32 => mapping(address => bool))) public decisionVoted; // ngo => round => NGO
    mapping(address => uint256) public activeVouches; // voucher => vouches not yet withdrawn or burned
    /// A pending challenge older than this lapses.
    uint256 public constant CHALLENGE_TIMEOUT = 14 days;
    mapping(address => mapping(address => bool)) public challengeBarred; // ngo => challenger whose challenge was dismissed

    error NotMinted();
    error NotEligibleVoucher();
    error AlreadyVouched();
    error EnoughVouches();
    error TooManyActiveVouches(uint256 max);
    error SameOperator(address otherVoucher);
    error WrongBond(uint256 expected);
    error NoWindow();
    error WindowClosed();
    error WindowOpen();
    error ChallengePending();
    error NoChallenge();
    error NotAnElectedNGO();
    error AlreadyVoted();
    error TooEarly();
    error NotEnoughVotes();
    error NothingToWithdraw();
    error NotAttested();
    error ElectedUseRemoval();
    error ChallengeBarred();

    event Vouched(address indexed ngo, address indexed voucher, uint256 count);
    event WindowStarted(address indexed ngo, uint256 endsAt);
    event Challenged(address indexed ngo, address indexed challenger, bytes32 reasonHash);
    event DecisionVote(address indexed ngo, address indexed voter, bool uphold);
    event ChallengeLapsed(address indexed ngo, address challenger);
    event ChallengeDecided(address indexed ngo, bool upheld, bool byGovernor);
    event Attested(address indexed ngo);
    event Rejected(address indexed ngo);
    event Revoked(address indexed ngo, bytes32 reasonHash);

    function vouch(address ngo) external payable whenActive {
        INGORegistry reg = INGORegistry(Addrs.NGO_REGISTRY);
        if (reg.status(ngo) != 1) revert NotMinted();
        IMinerRegistry mr = IMinerRegistry(Addrs.MINER_REGISTRY);
        if (
            msg.sender == ngo || !mr.isRegistered(msg.sender) || reg.isNGO(msg.sender)
                || mr.minedTotal(msg.sender) < _param("vouchMinBlocks")
                || mr.activeEpochs(msg.sender) < _param("vouchMinEpochs") || _isRoleHolder(msg.sender)
        ) revert NotEligibleVoucher();
        if (hasVouched[ngo][msg.sender]) revert AlreadyVouched();
        uint256 cap = _param("maxActiveVouches");
        if (activeVouches[msg.sender] >= cap) revert TooManyActiveVouches(cap);
        Vouch[] storage vs = _vouches[ngo];
        if (vs.length >= C.VOUCHES_NEEDED) revert EnoughVouches();
        bytes32 op = mr.operatorOf(msg.sender);
        for (uint256 i; i < vs.length; ++i) {
            if (!vs[i].withdrawn && mr.operatorOf(vs[i].voucher) == op) revert SameOperator(vs[i].voucher);
        }
        uint256 bond = _param("vouchBond");
        if (msg.value != bond) revert WrongBond(bond);
        hasVouched[ngo][msg.sender] = true;
        vs.push(Vouch(msg.sender, uint96(bond), uint64(block.timestamp), false));
        activeVouches[msg.sender] += 1;
        emit Vouched(ngo, msg.sender, vs.length);
        if (vs.length == C.VOUCHES_NEEDED) {
            _cases[ngo].windowEnds = uint64(block.timestamp + C.CHALLENGE_WINDOW);
            emit WindowStarted(ngo, block.timestamp + C.CHALLENGE_WINDOW);
        }
    }

    function challenge(address ngo, bytes32 reasonHash) external payable whenActive {
        Case storage c = _cases[ngo];
        if (c.windowEnds == 0) revert NoWindow();
        if (c.done || block.timestamp >= c.windowEnds) revert WindowClosed();
        if (c.challenger != address(0)) revert ChallengePending();
        if (challengeBarred[ngo][msg.sender]) revert ChallengeBarred();
        uint256 bond = _param("challengeBond");
        if (msg.value != bond) revert WrongBond(bond);
        c.challenger = msg.sender;
        c.challengeBond = uint96(bond);
        c.reasonHash = reasonHash;
        c.challengedAt = uint64(block.timestamp);
        c.upholdVotes = 0;
        c.dismissVotes = 0;
        c.round += 1;
        emit Challenged(ngo, msg.sender, reasonHash);
    }

    /// Elected NGOs (in Interim mode: the Interim Council) vote on a pending challenge.
    function decisionVote(address ngo, bool uphold) external whenActive {
        Case storage c = _cases[ngo];
        if (c.challenger == address(0)) revert NoChallenge();
        if (!_isElected(msg.sender)) revert NotAnElectedNGO();
        if (decisionVoted[ngo][c.round][msg.sender]) revert AlreadyVoted();
        decisionVoted[ngo][c.round][msg.sender] = true;
        if (uphold) c.upholdVotes += 1;
        else c.dismissVotes += 1;
        emit DecisionVote(ngo, msg.sender, uphold);
    }

    /// Close a challenge by the NGOs' vote: after 5 days, with at least 5 votes, simple majority (a tie dismisses).
    function resolve(address ngo) external whenActive {
        Case storage c = _cases[ngo];
        if (c.challenger == address(0)) revert NoChallenge();
        if (block.timestamp < c.challengedAt + C.DECISION_PERIOD) revert TooEarly();
        if (c.upholdVotes + c.dismissVotes < C.MIN_DECISION_VOTES) revert NotEnoughVotes();
        _decide(ngo, c.upholdVotes > c.dismissVotes, false);
    }

    /// Decision by token vote (a Governor proposal); used when too few NGOs are elected to decide.
    function governorDecide(address ngo, bool uphold) external onlyGovernor {
        if (_cases[ngo].challenger == address(0)) revert NoChallenge();
        _decide(ngo, uphold, true);
    }

    function _decide(address ngo, bool upheld, bool byGovernor) private {
        Case storage c = _cases[ngo];
        address challenger = c.challenger;
        uint256 cb = c.challengeBond;
        c.challenger = address(0);
        c.challengeBond = 0;
        emit ChallengeDecided(ngo, upheld, byGovernor);
        Vouch[] storage vs = _vouches[ngo];
        if (upheld) {
            c.done = true;
            uint256 burned;
            for (uint256 i; i < vs.length; ++i) {
                if (!vs[i].withdrawn) {
                    burned += vs[i].bond;
                    vs[i].withdrawn = true;
                    activeVouches[vs[i].voucher] -= 1;
                }
            }
            INGORegistry(Addrs.NGO_REGISTRY).setAttestationStatus(ngo, 3);
            emit Rejected(ngo);
            _burn(burned);
            _sendOrCredit(challenger, cb);
        } else {
            challengeBarred[ngo][challenger] = true;
            c.windowEnds = uint64(block.timestamp + C.CHALLENGE_WINDOW);
            emit WindowStarted(ngo, c.windowEnds);
            uint256 share = cb / vs.length;
            for (uint256 i; i < vs.length; ++i) _sendOrCredit(vs[i].voucher, share);
            _burn(cb - share * vs.length);
        }
    }

    /// Close a challenge nobody decided within CHALLENGE_TIMEOUT (anyone may call): the bond goes back to the challenger,
    /// the window keeps its end, so the NGO can be finalised once it has passed.
    function lapse(address ngo) external whenActive {
        Case storage c = _cases[ngo];
        address challenger = c.challenger;
        if (challenger == address(0)) revert NoChallenge();
        if (block.timestamp < uint256(c.challengedAt) + CHALLENGE_TIMEOUT) revert TooEarly();
        uint256 cb = c.challengeBond;
        c.challenger = address(0);
        c.challengeBond = 0;
        emit ChallengeLapsed(ngo, challenger);
        _sendOrCredit(challenger, cb);
    }

    /// Governance decision: revoke the attestation of an NGO that is not elected.
    function revoke(address ngo, bytes32 reasonHash) external onlyGovernor {
        if (INGORegistry(Addrs.NGO_REGISTRY).status(ngo) != 2) revert NotAttested();
        if (INGOElection(Addrs.NGO_ELECTION).isElected(ngo)) revert ElectedUseRemoval();
        INGORegistry(Addrs.NGO_REGISTRY).setAttestationStatus(ngo, 3);
        emit Revoked(ngo, reasonHash);
    }

    /// After the window, with no pending challenge: the NGO is attested.
    function finalize(address ngo) external whenActive {
        Case storage c = _cases[ngo];
        if (c.windowEnds == 0) revert NoWindow();
        if (c.done) revert WindowClosed();
        if (c.challenger != address(0)) revert ChallengePending();
        if (block.timestamp < c.windowEnds) revert WindowOpen();
        c.done = true;
        INGORegistry(Addrs.NGO_REGISTRY).setAttestationStatus(ngo, 2);
        emit Attested(ngo);
    }

    /// A voucher takes back its bond one term after vouching (if it was not burned).
    function withdrawVouch(address ngo) external whenActive {
        Vouch[] storage vs = _vouches[ngo];
        for (uint256 i; i < vs.length; ++i) {
            if (vs[i].voucher == msg.sender && !vs[i].withdrawn) {
                if (block.timestamp < vs[i].at + C.TERM) revert TooEarly();
                if (_cases[ngo].challenger != address(0)) revert ChallengePending();
                vs[i].withdrawn = true;
                activeVouches[msg.sender] -= 1;
                _send(msg.sender, vs[i].bond);
                return;
            }
        }
        revert NothingToWithdraw();
    }

    function hasActiveVouch(address voucher) external view returns (bool) {
        return activeVouches[voucher] > 0;
    }

    function vouchesOf(address ngo) external view returns (Vouch[] memory) {
        return _vouches[ngo];
    }

    function caseOf(address ngo) external view returns (Case memory) {
        return _cases[ngo];
    }
}
