// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Sys, Addrs, C, INGOElection} from "./Base.sol";

interface IUpgradeRegistryCouncil {
    function approve(uint256 id) external;
    function cancel(uint256 id) external;
}

interface IParamsSet {
    function set(bytes32 k, uint256 v) external;
}

interface IEmergencyPauseCouncil {
    function pauseByCouncil(address target, bytes32 reasonHash) external;
    function unpauseByCouncil(address target) external;
}

/// The dev council (DAG_SPEC.md section 17, owner decisions of 15 October 2026).
///
/// Seats: the three Dev Account holders (the DevVesting beneficiaries). Each seat acts with a separate council key that
/// the holder named at the launch ceremony and signed with the Dev Account wallet; the Dev Account wallet itself
/// cannot act here except to replace its seat's key.
///
/// Until the first time 60 NGOs are elected, two of the three keys can: approve or cancel node updates (UpgradeRegistry,
/// 7-day timelock; contract updates are the DAO's), change the committee bond and the role candidacy deposit (48-hour
/// timelock, inside the bounds of Params), and pause or unpause (at once; renewals up to 7 days in a row, then 7 days
/// without). They cannot spend or touch the Treasury, the DevVesting contracts, the NGO election and its rules, the
/// handover rule, balances or minting: those are not actions this contract can take, and Params, UpgradeRegistry and
/// EmergencyPause refuse them.
///
/// Handover: the node's per-block system call `advance()` retires the council the first time 60 NGOs are elected.
/// Retirement is one-way: it never comes back, even if the NGO count drops later. After it, the only action left is
/// an emergency pause (EmergencyPause enforces the 7-day cooldown and the 30-day lockout), and key replacement.
contract DevCouncil is Sys {
    uint8 public constant UPGRADE_APPROVE = 0; // arg = UpgradeRegistry plan id (node updates)
    uint8 public constant UPGRADE_CANCEL = 1; // arg = plan id
    uint8 public constant PARAM = 2; // key = parameter name, arg = new value
    uint8 public constant PAUSE = 3; // target (0 = whole network), key = reason hash
    uint8 public constant UNPAUSE = 4; // target
    uint8 public constant CANCEL_ACTION = 5; // arg = action id (a queued PARAM change)
    uint8 public constant LAST_KIND = 5;

    uint256 public constant PARAM_DELAY = 48 hours;
    uint256 public constant KEY_DELAY = 48 hours;
    uint256 public constant ACTION_TTL = 3 days; // an action not approved by a second seat within this time expires

    uint8 public constant PROPOSED = 0;
    uint8 public constant QUEUED = 1;
    uint8 public constant EXECUTED = 2;
    uint8 public constant CANCELLED = 3;

    struct Action {
        uint8 kind;
        uint8 approvals; // bit i = seat i approved
        uint8 state;
        uint64 proposedAt;
        uint64 eta;
        address target;
        bytes32 key;
        uint256 arg;
    }

    address[3] public devAccount; // fixed: the DevVesting beneficiaries
    address[3] public councilKey;
    address[3] public pendingKey;
    uint64[3] public pendingKeyEta;
    bool public retired;
    uint64 public retiredAt;
    Action[] private _actions;
    /// Cancel votes on a seat's pending key change (bit i = seat i voted). 
    uint8[3] public pendingKeyCancels;

    error NotCouncil();
    error NotDevAccount();
    error BadKind();
    error Retired();
    error UnknownAction();
    error NotPending();
    error Expired();
    error AlreadyApproved();
    error NotQueued();
    error Timelocked(uint256 eta);
    error BadKey();
    error NoPendingKey();

    event Proposed(uint256 indexed id, uint8 indexed seat, uint8 kind, address target, bytes32 key, uint256 arg);
    event Approved(uint256 indexed id, uint8 indexed seat);
    event Queued(uint256 indexed id, uint256 eta);
    event Executed(uint256 indexed id);
    event Cancelled(uint256 indexed id);
    event KeyChangeRequested(uint8 indexed seat, address newKey, uint256 eta);
    event KeyChangeCancelVote(uint8 indexed seat, uint8 by);
    event KeyChangeCancelled(uint8 indexed seat, uint8 bySeat);
    event KeyChanged(uint8 indexed seat, address newKey);
    event CouncilRetired(uint256 at, uint256 electedNGOs);

    /// accounts: the three Dev Account wallets (DevVesting beneficiaries); keys: their council keys from the launch
    /// ceremony (address(0) = seat without a key yet; its Dev Account wallet can name one with the 48-hour delay).
    constructor(address[3] memory accounts, address[3] memory keys_) {
        for (uint256 i; i < 3; ++i) {
            devAccount[i] = accounts[i];
            if (keys_[i] != address(0)) _checkKey(i, keys_[i], keys_);
            councilKey[i] = keys_[i];
        }
    }

    // ---- handover ----

    /// System call in every chain block: retire the council the first time 60 NGOs are elected (one-way).
    /// Hard sunset: the council retires 12 months after genesis even if 60 NGOs were never elected.
    uint256 public constant SUNSET = 365 days;

    function advance() external onlySystem {
        if (retired) return;
        uint256 n = INGOElection(Addrs.NGO_ELECTION).electedCount();
        if (n >= C.MIN_NGOS_NORMAL || block.timestamp >= _genesis() + SUNSET) {
            retired = true;
            retiredAt = uint64(block.timestamp);
            emit CouncilRetired(block.timestamp, n);
        }
    }

    // ---- 2-of-3 actions ----

    function propose(uint8 kind, address target, bytes32 key, uint256 arg) external returns (uint256 id) {
        uint8 seat = _seat(msg.sender);
        if (kind > LAST_KIND) revert BadKind();
        if (retired && kind != PAUSE) revert Retired();
        id = _actions.length;
        _actions.push(Action(kind, uint8(1 << seat), PROPOSED, uint64(block.timestamp), 0, target, key, arg));
        emit Proposed(id, seat, kind, target, key, arg);
        emit Approved(id, seat);
    }

    function approve(uint256 id) external {
        uint8 seat = _seat(msg.sender);
        Action storage a = _get(id);
        if (a.state != PROPOSED) revert NotPending();
        if (block.timestamp > a.proposedAt + ACTION_TTL) revert Expired();
        if (retired && a.kind != PAUSE) revert Retired();
        if (a.approvals & (1 << seat) != 0) revert AlreadyApproved();
        a.approvals |= uint8(1 << seat);
        emit Approved(id, seat);
        if (a.kind == PARAM) {
            a.state = QUEUED;
            a.eta = uint64(block.timestamp + PARAM_DELAY);
            emit Queued(id, a.eta);
        } else {
            _execute(id, a);
        }
    }

    /// A queued parameter change, after its 48-hour timelock (anyone may send it).
    function execute(uint256 id) external {
        Action storage a = _get(id);
        if (a.state != QUEUED) revert NotQueued();
        if (block.timestamp < a.eta) revert Timelocked(a.eta);
        if (retired) revert Retired();
        _execute(id, a);
    }

    function _execute(uint256 id, Action storage a) private {
        a.state = EXECUTED;
        uint8 k = a.kind;
        if (k == UPGRADE_APPROVE) {
            IUpgradeRegistryCouncil(Addrs.UPGRADE_REGISTRY).approve(a.arg);
        } else if (k == UPGRADE_CANCEL) {
            IUpgradeRegistryCouncil(Addrs.UPGRADE_REGISTRY).cancel(a.arg);
        } else if (k == PARAM) {
            IParamsSet(Addrs.PARAMS).set(a.key, a.arg);
        } else if (k == PAUSE) {
            IEmergencyPauseCouncil(Addrs.EMERGENCY_PAUSE).pauseByCouncil(a.target, a.key);
        } else if (k == UNPAUSE) {
            IEmergencyPauseCouncil(Addrs.EMERGENCY_PAUSE).unpauseByCouncil(a.target);
        } else {
            Action storage other = _get(a.arg);
            if (other.state != QUEUED && other.state != PROPOSED) revert NotPending();
            other.state = CANCELLED;
            emit Cancelled(a.arg);
        }
        emit Executed(id);
    }

    // ---- council keys ----

    /// The Dev Account wallet of `seat` names a new council key; it takes effect after 48 hours unless another seat
    /// cancels it (a thief holding only the old council key cannot replace it, and cannot stop the replacement).
    function requestKeyChange(uint8 seat, address newKey) external {
        if (seat > 2) revert BadKey();
        if (msg.sender != devAccount[seat]) revert NotDevAccount();
        address[3] memory ks = councilKey;
        ks[seat] = address(0);
        _checkKey(seat, newKey, ks);
        pendingKey[seat] = newKey;
        pendingKeyEta[seat] = uint64(block.timestamp + KEY_DELAY);
        pendingKeyCancels[seat] = 0;
        emit KeyChangeRequested(seat, newKey, pendingKeyEta[seat]);
    }

    /// Cancelling a pending key change needs both other seats: one stolen council key can no longer block
    /// another seat's recovery, while two honest seats can still stop a thief who holds only a Dev Account wallet.
    function cancelKeyChange(uint8 seat) external {
        uint8 by = _seat(msg.sender);
        if (seat > 2 || by == seat) revert NotCouncil();
        if (pendingKey[seat] == address(0)) revert NoPendingKey();
        uint8 votes = pendingKeyCancels[seat] | uint8(1 << by);
        pendingKeyCancels[seat] = votes;
        emit KeyChangeCancelVote(seat, by);
        if (votes != uint8(7 & ~(1 << seat))) return; // both other seats
        pendingKey[seat] = address(0);
        pendingKeyEta[seat] = 0;
        pendingKeyCancels[seat] = 0;
        emit KeyChangeCancelled(seat, by);
    }

    function applyKeyChange(uint8 seat) external {
        if (seat > 2 || pendingKey[seat] == address(0)) revert NoPendingKey();
        if (block.timestamp < pendingKeyEta[seat]) revert Timelocked(pendingKeyEta[seat]);
        address k = pendingKey[seat];
        address[3] memory ks = councilKey;
        ks[seat] = address(0);
        _checkKey(seat, k, ks); // still distinct from the other seats' keys
        councilKey[seat] = k;
        pendingKey[seat] = address(0);
        pendingKeyEta[seat] = 0;
        emit KeyChanged(seat, k);
    }

    /// A council key is not zero, not any Dev Account wallet and not another seat's key.
    function _checkKey(uint256 seat, address k, address[3] memory ks) private view {
        if (k == address(0)) revert BadKey();
        for (uint256 i; i < 3; ++i) {
            if (k == devAccount[i] && devAccount[i] != address(0)) revert BadKey();
            if (i != seat && ks[i] == k) revert BadKey();
        }
    }

    // ---- views ----

    function _seat(address a) private view returns (uint8) {
        if (a != address(0)) {
            for (uint8 i; i < 3; ++i) if (councilKey[i] == a) return i;
        }
        revert NotCouncil();
    }

    function seatOf(address a) external view returns (int8) {
        if (a == address(0)) return -1;
        for (uint8 i; i < 3; ++i) if (councilKey[i] == a) return int8(i);
        return -1;
    }

    function _get(uint256 id) private view returns (Action storage) {
        if (id >= _actions.length) revert UnknownAction();
        return _actions[id];
    }

    function getAction(uint256 id) external view returns (Action memory) {
        return _get(id);
    }

    function actionCount() external view returns (uint256) {
        return _actions.length;
    }

    function keys() external view returns (address[3] memory accounts, address[3] memory current, address[3] memory pending, uint64[3] memory etas) {
        return (devAccount, councilKey, pendingKey, pendingKeyEta);
    }
}
