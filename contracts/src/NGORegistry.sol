// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Sys, Addrs, IMinerRegistry, IAttestation} from "./Base.sol";

/// NGO records (DAG_SPEC.md section 8.2). An NGO is identified by its miner wallet: the address that mines, mints the
/// record, is attested, is elected and votes. There is no recovery or reassignment: a lost key means a full restart
/// with a new wallet.
contract NGORegistry is Sys {
    uint8 public constant NONE = 0;
    uint8 public constant MINTED = 1; // dossier published, waiting for vouches
    uint8 public constant ATTESTED = 2;
    uint8 public constant REJECTED = 3;

    struct NGO {
        string name;
        string country;
        string registration; // legal registration reference
        string dossierURI; // off-chain dossier
        bytes32 dossierHash;
        uint64 mintedAt;
        uint64 attestedAt;
        uint8 status;
    }

    mapping(address => NGO) private _ngos;
    address[] private _list;

    error NotARegisteredMiner();
    error AlreadyAnNGO();
    error WrongFee(uint256 expected);
    error RoleHolderCannotBeNGO();
    error VoucherCannotBeNGO();
    error EmptyField();
    error OnlyAttestation();
    error OnlyElection();
    error NotAnNGO();

    event Minted(address indexed ngo, string name, string dossierURI, bytes32 dossierHash);
    event StatusChanged(address indexed ngo, uint8 status);
    event DossierUpdated(address indexed ngo, string dossierURI, bytes32 dossierHash);

    /// Mint the NGO record from the miner wallet. Pays the minting fee in PSY (burned).
    function mint(
        string calldata name,
        string calldata country,
        string calldata registration,
        string calldata dossierURI,
        bytes32 dossierHash
    ) external payable whenActive {
        if (!IMinerRegistry(Addrs.MINER_REGISTRY).isRegistered(msg.sender)) revert NotARegisteredMiner();
        if (_ngos[msg.sender].status != NONE) revert AlreadyAnNGO();
        if (_isRoleHolder(msg.sender)) revert RoleHolderCannotBeNGO();
        if (IAttestation(Addrs.ATTESTATION).hasActiveVouch(msg.sender)) revert VoucherCannotBeNGO();
        if (bytes(name).length == 0 || bytes(dossierURI).length == 0 || dossierHash == bytes32(0)) revert EmptyField();
        uint256 fee = _param("ngoMintFee");
        if (msg.value != fee) revert WrongFee(fee);
        _ngos[msg.sender] = NGO(name, country, registration, dossierURI, dossierHash, uint64(block.timestamp), 0, MINTED);
        _list.push(msg.sender);
        _burn(fee);
        emit Minted(msg.sender, name, dossierURI, dossierHash);
    }

    /// The NGO may publish a new dossier version (for example its annual report). The status does not change.
    function updateDossier(string calldata dossierURI, bytes32 dossierHash) external whenActive {
        NGO storage n = _ngos[msg.sender];
        if (n.status == NONE) revert NotAnNGO();
        if (bytes(dossierURI).length == 0 || dossierHash == bytes32(0)) revert EmptyField();
        n.dossierURI = dossierURI;
        n.dossierHash = dossierHash;
        emit DossierUpdated(msg.sender, dossierURI, dossierHash);
    }

    function setAttestationStatus(address ngo, uint8 s) external {
        if (msg.sender != Addrs.ATTESTATION) revert OnlyAttestation();
        NGO storage n = _ngos[ngo];
        if (n.status == NONE) revert NotAnNGO();
        n.status = s;
        if (s == ATTESTED) n.attestedAt = uint64(block.timestamp);
        emit StatusChanged(ngo, s);
    }

    /// Removal of an elected NGO (NGOElection.remove, after a Removal proposal): the attestation is revoked, so the
    /// NGO cannot stand again. The record and its dossier stay public.
    function revoke(address ngo) external {
        if (msg.sender != Addrs.NGO_ELECTION) revert OnlyElection();
        NGO storage n = _ngos[ngo];
        if (n.status != ATTESTED) revert NotAnNGO();
        n.status = REJECTED;
        emit StatusChanged(ngo, REJECTED);
    }

    function isNGO(address a) external view returns (bool) {
        return _ngos[a].status != NONE;
    }

    function status(address a) external view returns (uint8) {
        return _ngos[a].status;
    }

    function attestedAt(address a) external view returns (uint256) {
        return _ngos[a].attestedAt;
    }

    function get(address a) external view returns (NGO memory) {
        return _ngos[a];
    }

    function ngoCount() external view returns (uint256) {
        return _list.length;
    }

    function list(uint256 start, uint256 count) external view returns (address[] memory out) {
        uint256 n = _list.length;
        if (start >= n) return new address[](0);
        uint256 end = start + count > n ? n : start + count;
        out = new address[](end - start);
        for (uint256 i = start; i < end; ++i) out[i - start] = _list[i];
    }
}
