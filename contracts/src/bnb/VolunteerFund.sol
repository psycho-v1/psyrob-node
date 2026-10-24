// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20Like {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
}

/// The PSYROB volunteer fund on BNB Chain (DAG_SPEC.md section 12). NOT DEPLOYED: code and tests only.
///
/// A transfer needs all of:
///   1. a Fund proposal passed on the PSYROB chain, recorded in FundApprovals (id, token, to, amount);
///   2. signatures of at least 15 members of the current PSYROB finality committee, 4 of them NGO members, over that record (the governance
///      module check: each member's node verifies the record in PSYROB state before signing);
///   3. approvals by 3 of the 5 multi-sig signers (the Treasurer and 4 NGO signers);
///   4. a timelock of 48 hours, or 72 hours when the amount is at least 5 % of the fund's balance of that token.
///      During the timelock the Security Lead, or any 2 signers, can cancel.
///      "Balance" here is the balance minus transfers already queued, and the lower of that figure now and as last
///      recorded at least 72 hours earlier, so a deposit made just before queuing cannot turn a large transfer into a
///      48-hour one. A token's first transfer has no earlier figure and uses the current one.
///   Approvals and cancel votes count only while their signer is still one of the five current signers: a signer replaced by a committee handover no longer helps a transfer pass or fail.
///   5. the recipient is not a current PSYROB role holder (role pay never comes from this fund).
/// The committee, the signers, the Security Lead and the role holder list are replaced by a handover signed by 15
/// members of the current committee (4 of them NGO members), numbered one more than the last and bound to a PSYROB
/// chain block, which waits 48 hours and can be canceled by the Security Lead or 2 current signers.
/// Transfers also need 4 NGO signatures among the 15. There is no owner and no upgrade path.
contract VolunteerFund {
    uint256 public constant QUORUM = 15;
    uint256 public constant MAX_COMMITTEE = 21;
    uint256 public constant SIGNERS = 5;
    uint256 public constant THRESHOLD = 3;
    uint256 public constant CANCEL_VOTES = 2;
    uint256 public constant DELAY = 48 hours;
    uint256 public constant LARGE_DELAY = 72 hours;
    uint256 public constant LARGE_BPS = 500; // 5 %
    bytes32 public constant FUND_DOMAIN = keccak256("PSYROB-fund");
    bytes32 public constant COMMITTEE_DOMAIN = keccak256("PSYROB-committee");
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    uint256 public immutable psyrobChainId;
    /// The PSYROB genesis time: binds every signature to one launch of the PSYROB chain ID.
    uint256 public immutable psyrobGenesisTime;
    /// NGO signatures every transfer and handover needs among the 15 (the same rule as a finality certificate). A committee with fewer NGO seats is refused.
    uint256 public constant MIN_NGO_SIGNATURES = 4;
    /// A committee handover waits this long; the Security Lead or 2 current signers can cancel it.
    uint256 public constant HANDOVER_DELAY = 48 hours;
    uint8 public constant SEAT_NGO = 1;
    uint8 public constant SEAT_MINER = 2;

    /// What a handover installs. `epoch` numbers the handovers of this fund (each exactly one more than the last);
    /// `psyrobEpoch` and `psyrobBlock` name the PSYROB committee epoch and the PSYROB chain block (a final checkpoint at
    /// or after its seal) whose state the signers checked, so a handover is bound to PSYROB state.
    struct Handover {
        uint256 epoch;
        uint256 psyrobEpoch;
        bytes32 psyrobBlock;
        address[] committee;
        uint8[] seats; // SEAT_NGO or SEAT_MINER, one per committee member
        address[SIGNERS] signers;
        address securityLead;
        address[] roleHolders;
    }

    uint256 public epoch;
    uint256 public psyrobEpoch;
    address[] private _committee;
    mapping(address => bool) public isCommittee;
    mapping(address => bool) public isNgoMember;
    address[SIGNERS] public signers;
    address public securityLead;
    address[] private _roleHolders;
    mapping(address => bool) public isRoleHolder;

    /// The handover waiting for its timelock (digest 0 = none).
    bytes32 public pendingHandover;
    uint64 public pendingHandoverEta;
    uint256 private _handoverRound; // separates cancel votes of successive pending handovers
    mapping(uint256 => mapping(address => bool)) public handoverCancelVotedBy;

    struct Transfer {
        address token;
        address to;
        uint256 amount;
        uint64 eta;
        uint8 approvals;
        uint8 cancelVotes;
        bool canceled;
        bool executed;
    }

    mapping(uint256 => Transfer) public transfers;
    mapping(uint256 => bool) public queued;
    mapping(uint256 => mapping(address => bool)) public approvedBy;
    mapping(uint256 => mapping(address => bool)) public cancelVotedBy;
    mapping(address => uint256) public pending; // token => sum of queued, not yet executed or canceled transfers
    mapping(address => uint256) public balanceMark; // token => free balance recorded at markAt
    mapping(address => uint64) public markAt;

    error BadCommittee();
    error NotEnoughSignatures(uint256 valid);
    error NotEnoughNgoSignatures(uint256 valid);
    error AlreadyQueued();
    error RecipientIsRoleHolder();
    error NotQueued();
    error NotASigner();
    error AlreadyApproved();
    error Canceled();
    error Executed();
    error Timelocked(uint256 eta);
    error NotEnoughApprovals();
    error NotAllowed();
    error StaleEpoch();
    error ZeroAddress();
    error TransferFailed();
    error BadSignature();
    error NoPendingHandover();
    error HandoverPending();
    error WrongHandover();

    event Queued(uint256 indexed id, address token, address to, uint256 amount, uint256 eta, bool large);
    event Approved(uint256 indexed id, address indexed signer, uint256 approvals);
    event CancelVote(uint256 indexed id, address indexed by);
    event TransferCanceled(uint256 indexed id, address indexed by);
    event TransferExecuted(uint256 indexed id, address token, address to, uint256 amount);
    event CommitteeUpdated(uint256 indexed epoch, uint256 psyrobEpoch, bytes32 psyrobBlock, address[] committee, address securityLead);
    event HandoverProposed(uint256 indexed epoch, bytes32 digest, uint256 eta);
    event HandoverCanceled(uint256 indexed epoch, address indexed by);
    event Deposit(address indexed from, uint256 amount);

    constructor(uint256 psyrobChainId_, uint256 psyrobGenesisTime_, Handover memory first) {
        psyrobChainId = psyrobChainId_;
        psyrobGenesisTime = psyrobGenesisTime_;
        _setAll(first);
    }

    receive() external payable {
        emit Deposit(msg.sender, msg.value);
    }

    // ---- digests (identical to FundApprovals.digest on the PSYROB chain) ----

    function fundDigest(uint256 id, address token, address to, uint256 amount) public view returns (bytes32) {
        return keccak256(abi.encode(FUND_DOMAIN, psyrobChainId, psyrobGenesisTime, block.chainid, address(this), id, token, to, amount));
    }

    function committeeDigest(Handover memory h) public view returns (bytes32) {
        return keccak256(abi.encode(COMMITTEE_DOMAIN, psyrobChainId, psyrobGenesisTime, block.chainid, address(this), h));
    }

    // ---- transfers ----

    function queue(uint256 id, address token, address to, uint256 amount, bytes[] calldata sigs) external {
        if (queued[id]) revert AlreadyQueued();
        if (to == address(0)) revert ZeroAddress();
        if (isRoleHolder[to]) revert RecipientIsRoleHolder();
        _checkCommittee(fundDigest(id, token, to, amount), sigs);
        uint256 free = _freeBalance(token);
        uint256 ref = free;
        if (markAt[token] != 0 && balanceMark[token] < ref) ref = balanceMark[token];
        if (markAt[token] == 0 || block.timestamp >= markAt[token] + LARGE_DELAY) {
            balanceMark[token] = free;
            markAt[token] = uint64(block.timestamp);
        }
        bool large = amount * 10_000 >= ref * LARGE_BPS;
        uint256 eta = block.timestamp + (large ? LARGE_DELAY : DELAY);
        pending[token] += amount;
        queued[id] = true;
        transfers[id] = Transfer(token, to, amount, uint64(eta), 0, 0, false, false);
        emit Queued(id, token, to, amount, eta, large);
    }

    function approve(uint256 id) external {
        Transfer storage t = _live(id);
        if (!_isSigner(msg.sender)) revert NotASigner();
        if (approvedBy[id][msg.sender]) revert AlreadyApproved();
        approvedBy[id][msg.sender] = true;
        t.approvals += 1;
        emit Approved(id, msg.sender, approvalsOf(id));
    }

    /// The Security Lead cancels alone; signers cancel with 2 votes.
    function cancel(uint256 id) external {
        Transfer storage t = _live(id);
        if (msg.sender == securityLead) {
            _cancel(id, t);
            return;
        }
        if (!_isSigner(msg.sender)) revert NotAllowed();
        if (cancelVotedBy[id][msg.sender]) revert AlreadyApproved();
        cancelVotedBy[id][msg.sender] = true;
        t.cancelVotes += 1;
        emit CancelVote(id, msg.sender);
        if (_currentVotes(cancelVotedBy[id]) >= CANCEL_VOTES) _cancel(id, t);
    }

    function execute(uint256 id) external {
        Transfer storage t = _live(id);
        if (block.timestamp < t.eta) revert Timelocked(t.eta);
        if (approvalsOf(id) < THRESHOLD) revert NotEnoughApprovals();
        if (isRoleHolder[t.to]) revert RecipientIsRoleHolder();
        t.executed = true;
        pending[t.token] -= t.amount;
        emit TransferExecuted(id, t.token, t.to, t.amount);
        if (t.token == address(0)) {
            (bool ok,) = payable(t.to).call{value: t.amount}("");
            if (!ok) revert TransferFailed();
        } else {
            (bool ok, bytes memory ret) =
                t.token.call(abi.encodeWithSelector(IERC20Like.transfer.selector, t.to, t.amount));
            if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
        }
    }

    function _cancel(uint256 id, Transfer storage t) private {
        t.canceled = true;
        pending[t.token] -= t.amount;
        emit TransferCanceled(id, msg.sender);
    }

    /// Approvals of transfer `id` by the current signers.
    function approvalsOf(uint256 id) public view returns (uint256) {
        return _currentVotes(approvedBy[id]);
    }

    function _currentVotes(mapping(address => bool) storage by) private view returns (uint256 n) {
        for (uint256 i; i < SIGNERS; ++i) if (by[signers[i]]) ++n;
    }

    function _freeBalance(address token) private view returns (uint256) {
        uint256 bal = token == address(0) ? address(this).balance : IERC20Like(token).balanceOf(address(this));
        uint256 p = pending[token];
        return bal > p ? bal - p : 0;
    }

    function _live(uint256 id) private view returns (Transfer storage t) {
        if (!queued[id]) revert NotQueued();
        t = transfers[id];
        if (t.canceled) revert Canceled();
        if (t.executed) revert Executed();
    }

    // ---- committee handover ----

    /// Step 1: 15 members of the current committee (4 of them NGOs) signed the next handover. It waits HANDOVER_DELAY.
    function proposeCommittee(Handover calldata h, bytes[] calldata sigs) external {
        if (pendingHandover != bytes32(0)) revert HandoverPending();
        if (h.epoch != epoch + 1 || h.psyrobEpoch <= psyrobEpoch) revert StaleEpoch();
        bytes32 d = committeeDigest(h);
        _checkCommittee(d, sigs);
        pendingHandover = d;
        pendingHandoverEta = uint64(block.timestamp + HANDOVER_DELAY);
        _handoverRound += 1;
        emit HandoverProposed(h.epoch, d, pendingHandoverEta);
    }

    /// Step 2 (anyone, after the timelock): install exactly the handover that was proposed.
    function applyCommittee(Handover calldata h) external {
        bytes32 d = pendingHandover;
        if (d == bytes32(0)) revert NoPendingHandover();
        if (block.timestamp < pendingHandoverEta) revert Timelocked(pendingHandoverEta);
        if (committeeDigest(h) != d) revert WrongHandover();
        pendingHandover = bytes32(0);
        pendingHandoverEta = 0;
        _setAll(h);
    }

    /// The Security Lead cancels a pending handover alone; the current signers with 2 votes.
    function cancelCommittee() external {
        if (pendingHandover == bytes32(0)) revert NoPendingHandover();
        if (msg.sender != securityLead) {
            if (!_isSigner(msg.sender)) revert NotAllowed();
            mapping(address => bool) storage votes = handoverCancelVotedBy[_handoverRound];
            if (votes[msg.sender]) revert AlreadyApproved();
            votes[msg.sender] = true;
            if (_currentVotes(votes) < CANCEL_VOTES) return;
        }
        pendingHandover = bytes32(0);
        pendingHandoverEta = 0;
        emit HandoverCanceled(epoch + 1, msg.sender);
    }

    function _setAll(Handover memory h) private {
        uint256 n = h.committee.length;
        if (n < QUORUM || n > MAX_COMMITTEE || h.seats.length != n) revert BadCommittee();
        for (uint256 i; i < _committee.length; ++i) {
            isCommittee[_committee[i]] = false;
            isNgoMember[_committee[i]] = false;
        }
        delete _committee;
        uint256 ngo;
        for (uint256 i; i < n; ++i) {
            address a = h.committee[i];
            if (a == address(0) || isCommittee[a]) revert BadCommittee();
            if (h.seats[i] != SEAT_NGO && h.seats[i] != SEAT_MINER) revert BadCommittee();
            isCommittee[a] = true;
            if (h.seats[i] == SEAT_NGO) {
                isNgoMember[a] = true;
                ++ngo;
            }
            _committee.push(a);
        }
        if (ngo < MIN_NGO_SIGNATURES) revert BadCommittee();
        for (uint256 i; i < SIGNERS; ++i) {
            if (h.signers[i] == address(0)) revert ZeroAddress();
            for (uint256 j; j < i; ++j) if (h.signers[j] == h.signers[i]) revert BadCommittee();
            signers[i] = h.signers[i];
        }
        if (h.securityLead == address(0)) revert ZeroAddress();
        securityLead = h.securityLead;
        for (uint256 i; i < _roleHolders.length; ++i) isRoleHolder[_roleHolders[i]] = false;
        delete _roleHolders;
        for (uint256 i; i < h.roleHolders.length; ++i) {
            if (h.roleHolders[i] == address(0)) continue;
            isRoleHolder[h.roleHolders[i]] = true;
            _roleHolders.push(h.roleHolders[i]);
        }
        epoch = h.epoch;
        psyrobEpoch = h.psyrobEpoch;
        emit CommitteeUpdated(h.epoch, h.psyrobEpoch, h.psyrobBlock, h.committee, h.securityLead);
    }

    /// At least 15 distinct current committee members signed `digest`, at least 4 of them NGO members.
    function _checkCommittee(bytes32 digest, bytes[] calldata sigs) private view {
        address[] memory seen = new address[](sigs.length);
        uint256 valid;
        uint256 ngoValid;
        for (uint256 i; i < sigs.length; ++i) {
            address a = _recover(digest, sigs[i]);
            if (!isCommittee[a]) continue;
            bool dup;
            for (uint256 j; j < valid; ++j) if (seen[j] == a) dup = true;
            if (dup) continue;
            seen[valid++] = a;
            if (isNgoMember[a]) ++ngoValid;
        }
        if (valid < QUORUM) revert NotEnoughSignatures(valid);
        if (ngoValid < MIN_NGO_SIGNATURES) revert NotEnoughNgoSignatures(ngoValid);
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        if (uint256(s) > HALF_N) revert BadSignature();
        return ecrecover(digest, v, r, s);
    }

    function _isSigner(address a) private view returns (bool) {
        for (uint256 i; i < SIGNERS; ++i) if (signers[i] == a) return true;
        return false;
    }

    function committee() external view returns (address[] memory) {
        return _committee;
    }

    function roleHolders() external view returns (address[] memory) {
        return _roleHolders;
    }
}
