// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Sys, Addrs, IDevCouncil} from "./Base.sol";

/// Contract and node updates (DAG_SPEC.md section 17.3). Every update follows the same path: submit, approve, timelock,
/// activate.
///
/// Contract update: the new code is first deployed as an ordinary contract (`impl`); the plan names the system contract
/// to replace (`target`) and records impl's code hash. When the timelock has passed, the node copies impl's code to the
/// target in the next chain block (the target keeps its address, balance and storage) and reports it back with
/// `activated`. Anyone can compile the source at the plan's git commit and compare the code hash.
///
/// Node update: the plan records the version, the git commit and the SHA-256 of the release file list (SHA256SUMS.txt).
/// When the timelock has passed, `requiredVersion` rises; a node older than that stops at that block ("upgrade
/// required") instead of following a split chain, and new consensus rules of the release start at the same block.
///
/// Approval: the dev council until it retires (first time 60 NGOs are elected), then only the Governor (an Upgrade
/// proposal: token vote and a majority of the elected NGOs). Timelocks: council 7 days (node); DAO 7 days (contract)
/// and 14 days (node). A plan the council approved that is not in force when the council retires waits at least
/// 14 days after the handover, so the DAO has time to cancel it.
///
/// The council approves node updates only. Every system contract either holds
/// PSY or feeds the NGO election, the Treasury or the volunteer fund: replacing MinerRegistry or NGORegistry could
/// invent miners and NGOs, Params could move the election rules, FundApprovals could record fund transfers. A node
/// update instead takes effect only on the nodes whose operators install it, in public, after 7 days. Contract
/// updates are the DAO's.
/// Never replaceable by anyone: the three DevVesting contracts (the 12 %) and DevCouncil (the handover rule).
contract UpgradeRegistry is Sys {
    uint8 public constant CONTRACT = 0;
    uint8 public constant NODE = 1;

    uint8 public constant SUBMITTED = 0;
    uint8 public constant APPROVED = 1;
    uint8 public constant ACTIVATED = 2;
    uint8 public constant CANCELLED = 3;
    uint8 public constant FAILED = 4; // impl's code changed or vanished before activation

    uint256 public constant COUNCIL_NODE_DELAY = 7 days;
    uint256 public constant DAO_CONTRACT_DELAY = 7 days;
    uint256 public constant DAO_NODE_DELAY = 14 days;
    uint256 public constant HANDOVER_GRACE = 14 days;
    /// The node version the network starts with (10.0.0). A council-approved node plan may only take the next patch or
    /// the next minor version above max(requiredVersion, BASE_VERSION): an absurd version that would halt
    /// every node needs the DAO.
    uint32 public constant BASE_VERSION = 10_000_000;

    struct Plan {
        uint8 kind;
        uint8 state;
        bool byDao;
        address submitter;
        address target; // contract plans
        address impl; // contract plans
        bytes32 codeHash; // contract plans: keccak256 of impl's runtime code
        uint32 version; // node plans: major * 1_000_000 + minor * 1_000 + patch
        bytes20 commit; // git commit of the source
        bytes32 releaseHash; // node plans: SHA-256 of SHA256SUMS.txt
        bytes32 descriptionHash; // keccak256 of the description text (published with the submission)
        uint64 submittedAt;
        uint64 approvedAt;
        uint64 eta;
        uint64 activatedAt;
    }

    Plan[] private _plans;
    uint256[] private _waitingContracts; // approved contract plans not yet activated
    uint256[] private _waitingNodes; // approved node plans not yet in force
    uint32 public requiredVersion; // highest node version in force

    error NotSystemContract(address target);
    error Protected(address target);
    error NoCode(address impl);
    error BadVersion();
    error UnknownPlan();
    error NotAllowed();
    error WrongState(uint8 state);

    event Submitted(uint256 indexed id, uint8 kind, address indexed submitter, address target, bytes32 codeHash, uint32 version, string description);
    event PlanApproved(uint256 indexed id, bool byDao, uint256 eta);
    event PlanCancelled(uint256 indexed id, bool byDao);
    event PlanActivated(uint256 indexed id, bool ok);
    event VersionRequired(uint32 version, uint256 indexed id);

    /// Anyone may submit; only an approval makes a plan count. For a contract update, `impl` must hold the new code.
    function submit(
        uint8 kind,
        address target,
        address impl,
        uint32 version,
        bytes20 commit,
        bytes32 releaseHash,
        string calldata description
    ) external returns (uint256 id) {
        bytes32 h;
        if (kind == CONTRACT) {
            if (!isSystemContract(target)) revert NotSystemContract(target);
            if (neverReplaceable(target)) revert Protected(target);
            if (impl.code.length == 0) revert NoCode(impl);
            h = impl.codehash;
            version = 0;
            releaseHash = 0;
        } else if (kind == NODE) {
            // the release must exist when the plan is submitted: its commit and the hash of its SHA256SUMS.txt
            if (version <= requiredVersion || version >= 1_000_000_000 || releaseHash == 0 || commit == bytes20(0)) revert BadVersion();
            target = address(0);
            impl = address(0);
        } else {
            revert NotAllowed();
        }
        id = _plans.length;
        _plans.push(Plan(kind, SUBMITTED, false, msg.sender, target, impl, h, version, commit, releaseHash, keccak256(bytes(description)), uint64(block.timestamp), 0, 0, 0));
        emit Submitted(id, kind, msg.sender, target, h, version, description);
    }

    function approve(uint256 id) external {
        Plan storage p = _get(id);
        if (p.state != SUBMITTED) revert WrongState(p.state);
        bool dao = _authority();
        if (p.kind == CONTRACT) {
            if (!dao) revert Protected(p.target);
            if (p.impl.codehash != p.codeHash) revert NoCode(p.impl);
        } else if (p.version <= requiredVersion || (!dao && !oneStep(p.version))) {
            revert BadVersion();
        }
        uint256 delay = p.kind == CONTRACT ? DAO_CONTRACT_DELAY : (dao ? DAO_NODE_DELAY : COUNCIL_NODE_DELAY);
        p.state = APPROVED;
        p.byDao = dao;
        p.approvedAt = uint64(block.timestamp);
        p.eta = uint64(block.timestamp + delay);
        if (p.kind == CONTRACT) _waitingContracts.push(id);
        else _waitingNodes.push(id);
        emit PlanApproved(id, dao, p.eta);
    }

    /// Is `v` one patch or one minor step above the current version (max(requiredVersion, BASE_VERSION))?
    function oneStep(uint32 v) public view returns (bool) {
        uint32 b = requiredVersion > BASE_VERSION ? requiredVersion : BASE_VERSION;
        uint32 bMajor = b / 1_000_000;
        uint32 bMinor = (b / 1_000) % 1_000;
        uint32 bPatch = b % 1_000;
        uint32 vMajor = v / 1_000_000;
        uint32 vMinor = (v / 1_000) % 1_000;
        uint32 vPatch = v % 1_000;
        if (vMajor != bMajor) return false;
        return (vMinor == bMinor && vPatch == bPatch + 1) || (vMinor == bMinor + 1 && vPatch == 0);
    }

    /// The approving body may cancel a plan until it is in force.
    function cancel(uint256 id) external {
        Plan storage p = _get(id);
        if (p.state != SUBMITTED && p.state != APPROVED) revert WrongState(p.state);
        bool dao = _authority();
        p.state = CANCELLED;
        _drop(p.kind == CONTRACT ? _waitingContracts : _waitingNodes, id);
        emit PlanCancelled(id, dao);
    }

    /// The council until it retires, the Governor after. Returns true for the Governor.
    function _authority() private view returns (bool dao) {
        bool retired = IDevCouncil(Addrs.DEV_COUNCIL).retired();
        if (msg.sender == Addrs.DEV_COUNCIL && !retired) return false;
        if (msg.sender == Addrs.GOVERNOR && retired) return true;
        revert NotAllowed();
    }

    // ---- activation (node) ----

    /// System call in every chain block: node plans whose timelock has passed come into force.
    function advance() external onlySystem {
        uint256[] storage w = _waitingNodes;
        for (uint256 i = w.length; i > 0; --i) {
            Plan storage p = _plans[w[i - 1]];
            if (block.timestamp < effectiveEta(w[i - 1])) continue;
            p.state = ACTIVATED;
            p.activatedAt = uint64(block.timestamp);
            if (p.version > requiredVersion) {
                requiredVersion = p.version;
                emit VersionRequired(p.version, w[i - 1]);
            }
            emit PlanActivated(w[i - 1], true);
            w[i - 1] = w[w.length - 1];
            w.pop();
        }
    }

    /// The oldest contract plan due now, for the node: (true, id, target, impl, codeHash), or (false, ...).
    function nextDue() external view returns (bool, uint256, address, address, bytes32) {
        uint256 best = type(uint256).max;
        for (uint256 i; i < _waitingContracts.length; ++i) {
            uint256 id = _waitingContracts[i];
            if (block.timestamp >= effectiveEta(id) && id < best) best = id;
        }
        if (best == type(uint256).max) return (false, 0, address(0), address(0), 0);
        Plan storage p = _plans[best];
        return (true, best, p.target, p.impl, p.codeHash);
    }

    /// System call: the node has copied (ok) or refused to copy (impl's code no longer matches) plan `id`.
    function activated(uint256 id, bool ok) external onlySystem {
        Plan storage p = _get(id);
        if (p.state != APPROVED || p.kind != CONTRACT) revert WrongState(p.state);
        p.state = ok ? ACTIVATED : FAILED;
        p.activatedAt = uint64(block.timestamp);
        _drop(_waitingContracts, id);
        emit PlanActivated(id, ok);
    }

    function _drop(uint256[] storage w, uint256 id) private {
        for (uint256 i; i < w.length; ++i) {
            if (w[i] == id) {
                w[i] = w[w.length - 1];
                w.pop();
                return;
            }
        }
    }

    /// When plan `id` comes into force: its eta, or for a council plan still waiting at the handover, at least 14 days
    /// after the handover.
    function effectiveEta(uint256 id) public view returns (uint256 eta) {
        Plan storage p = _get(id);
        eta = p.eta;
        if (!p.byDao) {
            IDevCouncil c = IDevCouncil(Addrs.DEV_COUNCIL);
            if (c.retired()) {
                uint256 g = uint256(c.retiredAt()) + HANDOVER_GRACE;
                if (g > eta) eta = g;
            }
        }
    }

    // ---- rules ----

    function isSystemContract(address a) public pure returns (bool) {
        uint160 x = uint160(a);
        uint160 base = uint160(0x7070000000000000000000000000000000000000);
        return x > base && x <= base + 0x13;
    }

    /// Never replaced, by the council or the DAO: the 12 % and the handover rule.
    function neverReplaceable(address a) public pure returns (bool) {
        return Addrs.isDevVesting(a) || a == Addrs.DEV_COUNCIL;
    }

    /// The council replaces no contract: every system contract is protected from it.
    function councilProtected(address a) public pure returns (bool) {
        return isSystemContract(a);
    }

    // ---- views ----

    function _get(uint256 id) private view returns (Plan storage) {
        if (id >= _plans.length) revert UnknownPlan();
        return _plans[id];
    }

    function getPlan(uint256 id) external view returns (Plan memory) {
        return _get(id);
    }

    function planCount() external view returns (uint256) {
        return _plans.length;
    }

    function waiting() external view returns (uint256[] memory contracts_, uint256[] memory nodes) {
        return (_waitingContracts, _waitingNodes);
    }
}
