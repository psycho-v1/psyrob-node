// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Addrs, C, INGOElection} from "./Base.sol";

/// Bootstrap, Normal and Interim modes (DAG_SPEC.md section 8.7).
///   Bootstrap: the first 3 months. Mining, transfers, NGO minting, attestation and the first election.
///   Normal:    at least 60 elected NGOs. Everything, including finality, role elections and spending.
///   Interim:   after 3 months with fewer than 60 elected NGOs. Only mining and basic functions; the Interim Council
///              (the NGOs elected so far) may only decide attestation challenges.
/// Once Normal mode has been reached, a dip below 60 elected NGOs (a yearly rollover that elects fewer, a removal, the
/// term limit, or the first block of a term before finalize) keeps Normal mode for NORMAL_GRACE; only 30 days in a row
/// below 60 make the network Interim. The node records the count every chain block (advance()).
contract GovernanceMode {
    uint8 public constant BOOTSTRAP = 0;
    uint8 public constant NORMAL = 1;
    uint8 public constant INTERIM = 2;
    uint256 public constant NORMAL_GRACE = 30 days;

    uint256 public immutable genesisTime;
    bool public normalReached;
    uint64 public belowSince; // when the count last fell below 60 after Normal mode was reached; 0 = not below

    error OnlySystem();

    constructor(uint256 genesisTime_) {
        genesisTime = genesisTime_;
    }

    function mode() public view returns (uint8) {
        if (block.timestamp < genesisTime + C.FIRST_ELECTION) return BOOTSTRAP;
        if (INGOElection(Addrs.NGO_ELECTION).electedCount() >= C.MIN_NGOS_NORMAL) return NORMAL;
        if (normalReached && (belowSince == 0 || block.timestamp < uint256(belowSince) + NORMAL_GRACE)) return NORMAL;
        return INTERIM;
    }

    /// System call (every chain block): remember that Normal mode was reached and since when the count is below 60.
    function advance() external {
        if (msg.sender != Addrs.SYSTEM) revert OnlySystem();
        if (block.timestamp < genesisTime + C.FIRST_ELECTION) return;
        if (INGOElection(Addrs.NGO_ELECTION).electedCount() >= C.MIN_NGOS_NORMAL) {
            normalReached = true;
            belowSince = 0;
        } else if (normalReached && belowSince == 0) {
            belowSince = uint64(block.timestamp);
        }
    }

    function finalityActive() external view returns (bool) {
        return mode() == NORMAL;
    }

    /// Interim Council member: an NGO elected so far, while the network is in Interim mode.
    function isInterimCouncil(address a) external view returns (bool) {
        return mode() == INTERIM && INGOElection(Addrs.NGO_ELECTION).isElected(a);
    }
}
