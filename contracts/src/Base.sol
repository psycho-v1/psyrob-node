// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Fixed addresses of the PSYROB system contracts. They are created at genesis (genesis/build.js) and have no owner.
/// Their code can be replaced only through UpgradeRegistry (approved by the dev council until 60 NGOs are
/// first elected, then by the DAO); the DevVesting contracts never. DAG_SPEC.md sections 16 and 17.
library Addrs {
    address internal constant SYSTEM = 0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE;
    address internal constant BURN = 0x000000000000000000000000000000000000dEaD;
    address internal constant MINER_REGISTRY = 0x7070000000000000000000000000000000000001;
    address internal constant NGO_REGISTRY = 0x7070000000000000000000000000000000000002;
    address internal constant ATTESTATION = 0x7070000000000000000000000000000000000003;
    address internal constant VOTE_ESCROW = 0x7070000000000000000000000000000000000004;
    address internal constant NGO_ELECTION = 0x7070000000000000000000000000000000000005;
    address internal constant ROLE_ELECTION = 0x7070000000000000000000000000000000000006;
    address internal constant GOVERNOR = 0x7070000000000000000000000000000000000007;
    address internal constant TREASURY = 0x7070000000000000000000000000000000000008;
    address internal constant DEV_VESTING = 0x7070000000000000000000000000000000000009;
    address internal constant NGO_REWARDS = 0x707000000000000000000000000000000000000A;
    address internal constant FINALITY_COMMITTEE = 0x707000000000000000000000000000000000000B;
    address internal constant GOVERNANCE_MODE = 0x707000000000000000000000000000000000000C;
    address internal constant FUND_APPROVALS = 0x707000000000000000000000000000000000000d;
    address internal constant PARAMS = 0x707000000000000000000000000000000000000e;
    address internal constant DEV_VESTING_2 = 0x707000000000000000000000000000000000000F;
    address internal constant DEV_VESTING_3 = 0x7070000000000000000000000000000000000010;
    address internal constant DEV_COUNCIL = 0x7070000000000000000000000000000000000011;
    address internal constant UPGRADE_REGISTRY = 0x7070000000000000000000000000000000000012;
    address internal constant EMERGENCY_PAUSE = 0x7070000000000000000000000000000000000013;

    /// The 12 % team allocation: never upgraded, never paused, by anyone.
    function isDevVesting(address a) internal pure returns (bool) {
        return a == DEV_VESTING || a == DEV_VESTING_2 || a == DEV_VESTING_3;
    }
}

/// Constants fixed by the brief (locked rules) or by DAG_SPEC.md.
library C {
    uint256 internal constant NGO_SEATS = 100;
    uint256 internal constant TERM = 365 days;
    uint256 internal constant FIRST_ELECTION = 90 days; // the first election closes 3 months after genesis
    uint256 internal constant MAIN_ROUND = 30 days; // the annual round runs in the last 30 days of a term
    uint256 internal constant SUPPLEMENTARY_ROUND = 30 days;
    uint256 internal constant MIN_NGOS_NORMAL = 60; // Normal mode and fund decisions need 60 elected NGOs
    uint256 internal constant VOUCHES_NEEDED = 5;
    uint256 internal constant CHALLENGE_WINDOW = 7 days;
    uint256 internal constant DECISION_PERIOD = 5 days;
    uint256 internal constant MIN_DECISION_VOTES = 5;
    uint256 internal constant ROLES = 5; // CEO, CTO, Treasurer, Community Lead, Security Lead
    uint256 internal constant ROLE_TERM = 365 days;
    uint256 internal constant ROLE_CANDIDACY = 14 days;
    uint256 internal constant ROLE_VOTING = 14 days;
    uint256 internal constant EPOCH = 7 days;
    uint256 internal constant COMMITTEE_SIZE = 21;
    uint256 internal constant NGO_COMMITTEE_SEATS = 6; // 6/21 < 1/3
    uint256 internal constant MINER_COMMITTEE_SEATS = 15;
    uint256 internal constant COMMITTEE_QUORUM = 15; // > 2/3 of 21
    uint256 internal constant MAX_SEATS_PER_OPERATOR = 3; // 3/21 = 1/7
    uint256 internal constant VOTING_PERIOD = 5 days;
    uint256 internal constant TIMELOCK = 48 hours;
    uint256 internal constant PROPOSAL_THRESHOLD_BPS = 50; // 0.5 %
}

interface IMinerRegistry {
    function isRegistered(address a) external view returns (bool);
    function minedTotal(address a) external view returns (uint256);
    function activeEpochs(address a) external view returns (uint256);
    function minedIn(uint256 epoch, address a) external view returns (uint256);
    function epochBlocks(uint256 epoch) external view returns (uint256);
    function operatorOf(address a) external view returns (bytes32);
    function registeredMiners() external view returns (address[] memory);
}

interface INGORegistry {
    function isNGO(address a) external view returns (bool);
    function status(address a) external view returns (uint8);
    function setAttestationStatus(address ngo, uint8 s) external;
    function revoke(address ngo) external;
    function ngoCount() external view returns (uint256);
}

interface IAttestation {
    function hasActiveVouch(address voucher) external view returns (bool);
}

interface IVoteEscrow {
    function powerAt(address a, uint256 blockNumber) external view returns (uint256);
    function totalAt(uint256 blockNumber) external view returns (uint256);
    function holdUntil(address a, uint256 until) external;
    function averageOver(address a, uint256 fromBlock, uint256 toBlock) external view returns (uint256);
}

interface INGOElection {
    function isElected(address a) external view returns (bool);
    function isElectedIn(uint256 term, address a) external view returns (bool);
    function electedCount() external view returns (uint256);
    function electedList() external view returns (address[] memory);
    function currentTerm() external view returns (uint256);
}

interface INGORewards {
    function onElected(uint256 term, address ngo) external;
    function onRemoved(uint256 term, address ngo) external;
}

interface IRoleElection {
    function isRoleHolder(address a) external view returns (bool);
    function roleHolders() external view returns (address[] memory);
}

interface IFinalityCommittee {
    struct BeaconRound {
        uint64 requestBlock;
        uint64 epoch;
        uint16 reveals;
        bool closed;
        bytes32 mix;
    }

    function checkpointBlock(uint256 number) external view returns (bytes32);
    function requestBeacon() external returns (uint256);
    function beacon(uint256 r) external view returns (BeaconRound memory);
}

interface IGovernanceMode {
    function genesisTime() external view returns (uint256);
    function mode() external view returns (uint8);
    function finalityActive() external view returns (bool);
}

interface IDevCouncil {
    function retired() external view returns (bool);
    function retiredAt() external view returns (uint64);
}

interface IEmergencyPause {
    function blocked(address target) external view returns (bool);
    function networkPaused() external view returns (bool);
}

interface IFinalityCommitteeSeats {
    function currentEpoch() external view returns (uint256);
    function seatOf(uint256 e, address a) external view returns (uint8);
    function slashed(uint256 e, address a) external view returns (bool);
}

interface IParams {
    function get(bytes32 key) external view returns (uint256);
}

interface ITreasury {
    function payRole(address to, uint256 amount) external;
}

/// Shared helpers.
abstract contract Sys {
    error OnlySystem();
    error OnlyGovernor();
    error RoleHolderCannotVote();
    error TransferFailed();
    error Paused();

    modifier onlySystem() {
        if (msg.sender != Addrs.SYSTEM) revert OnlySystem();
        _;
    }

    modifier onlyGovernor() {
        if (msg.sender != Addrs.GOVERNOR) revert OnlyGovernor();
        _;
    }

    /// User entry points of a contract that EmergencyPause can stop (DAG_SPEC.md section 17.4). System calls and calls
    /// from the Governor pass, so a pause can never stop the chain's own bookkeeping or a DAO vote.
    modifier whenActive() {
        if (msg.sender != Addrs.SYSTEM && msg.sender != Addrs.GOVERNOR && IEmergencyPause(Addrs.EMERGENCY_PAUSE).blocked(address(this))) {
            revert Paused();
        }
        _;
    }

    function _genesis() internal view returns (uint256) {
        return IGovernanceMode(Addrs.GOVERNANCE_MODE).genesisTime();
    }

    function _mode() internal view returns (uint8) {
        return IGovernanceMode(Addrs.GOVERNANCE_MODE).mode();
    }

    function _param(bytes32 k) internal view returns (uint256) {
        return IParams(Addrs.PARAMS).get(k);
    }

    function _isRoleHolder(address a) internal view returns (bool) {
        return IRoleElection(Addrs.ROLE_ELECTION).isRoleHolder(a);
    }

    function _isElected(address a) internal view returns (bool) {
        return INGOElection(Addrs.NGO_ELECTION).isElected(a);
    }

    function _send(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _burn(uint256 amount) internal {
        _send(Addrs.BURN, amount);
    }

    /// PSY owed to addresses whose direct payment failed. They take it with withdrawOwed().
    mapping(address => uint256) public owed;

    event Owed(address indexed to, uint256 amount);

    /// Pay `to` with a gas stipend; if it refuses (a contract that reverts or uses too much gas), record the amount as
    /// owed instead of reverting. No recipient can block an election, a decision or a system call by refusing PSY.
    function _sendOrCredit(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = payable(to).call{value: amount, gas: 50_000}("");
        if (!ok) {
            owed[to] += amount;
            emit Owed(to, amount);
        }
    }

    function withdrawOwed() external whenActive {
        uint256 a = owed[msg.sender];
        owed[msg.sender] = 0;
        _send(msg.sender, a);
    }
}
