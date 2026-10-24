// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Sys, C, Addrs, INGORegistry} from "./Base.sol";

/// Miner registration and blue-block counts (DAG_SPEC.md sections 8.1 and 10).
/// The node records, by system call, how many blue blocks each miner address produced. Registration needs at least
/// one mined blue block: that is how a participant first obtains PSY (no airdrop).
contract MinerRegistry is Sys {
    mapping(address => bool) public isRegistered;
    mapping(address => uint256) public minedTotal;
    mapping(uint256 => mapping(address => uint256)) public minedIn; // epoch => miner => blue blocks
    mapping(uint256 => uint256) public epochBlocks; // epoch => blue blocks recorded
    mapping(address => uint256) public activeEpochs; // distinct 7-day epochs in which the miner had a blue block
    mapping(address => bytes32) public operatorOf; // optional declared operator (committee cap of 3 seats)
    address[] private _registered;
    uint256 public totalRecorded;
    /// the NGO an NGO's miner was registered for (registerNgoMiner), and who holds each NGO name. One miner
    /// address per NGO name (names compared without case).
    mapping(address => string) public ngoName;
    mapping(address => string) public ngoDescription;
    mapping(bytes32 => address) public ngoNameHolder;
    uint256 public constant MAX_NAME = 80;
    uint256 public constant MAX_DESCRIPTION = 280;

    error NeverMined();
    error AlreadyRegistered();
    error NotRegistered();
    error LengthMismatch();
    error BadName();
    error NameTaken();

    event Registered(address indexed miner, bytes32 operator);
    event OperatorDeclared(address indexed miner, bytes32 operator);
    event NgoMinerRegistered(address indexed miner, string name, string description);
    event NgoNameReleased(address indexed miner, string name);

    function epochOf(uint256 t) public view returns (uint256) {
        uint256 g = _genesis();
        return t <= g ? 0 : (t - g) / C.EPOCH;
    }

    function currentEpoch() external view returns (uint256) {
        return epochOf(block.timestamp);
    }

    /// Register msg.sender (the miner wallet). `operator` may group several addresses run by one operator; it is
    /// self-declared and cannot be checked on-chain.
    function register(bytes32 operator) external whenActive {
        if (isRegistered[msg.sender]) revert AlreadyRegistered();
        if (minedTotal[msg.sender] == 0) revert NeverMined();
        isRegistered[msg.sender] = true;
        _registered.push(msg.sender);
        operatorOf[msg.sender] = operator == bytes32(0) ? bytes32(uint256(uint160(msg.sender))) : operator;
        emit Registered(msg.sender, operatorOf[msg.sender]);
    }

    /// Register msg.sender as the miner of an NGO (the /register/ngo page). Same rules as `register`; it also records
    /// the NGO's name and a short description, and refuses a name another miner address already holds. The NGO's
    /// formal record (country, registration, dossier) is minted later in NGORegistry from the same address.
    function registerNgoMiner(string calldata name, string calldata description) external whenActive {
        if (isRegistered[msg.sender]) revert AlreadyRegistered();
        if (minedTotal[msg.sender] == 0) revert NeverMined();
        if (!validName(name) || bytes(description).length > MAX_DESCRIPTION) revert BadName();
        bytes32 k = nameKey(name);
        if (ngoNameHolder[k] != address(0)) revert NameTaken();
        ngoNameHolder[k] = msg.sender;
        ngoName[msg.sender] = name;
        ngoDescription[msg.sender] = description;
        isRegistered[msg.sender] = true;
        _registered.push(msg.sender);
        operatorOf[msg.sender] = bytes32(uint256(uint160(msg.sender)));
        emit Registered(msg.sender, operatorOf[msg.sender]);
        emit NgoMinerRegistered(msg.sender, name, description);
    }

    /// Name rules (against squatting and look-alikes). A name is 1-80 characters from a
    /// small set: ASCII letters, digits, space and . , & ' ( ) -; it starts with a letter or digit, ends with a letter,
    /// a digit, ")", "." or "'" (as in "Doctors Without Borders (MSF)", "Acme Inc." or "Male'"), and has no two spaces
    /// in a row. No other characters, so no look-alike letters from other scripts.
    function validName(string memory name) public pure returns (bool) {
        bytes memory b = bytes(name);
        if (b.length == 0 || b.length > MAX_NAME) return false;
        bytes1 last = b[b.length - 1];
        if (!_alnum(b[0]) || !(_alnum(last) || last == 0x29 || last == 0x2E || last == 0x27)) return false;
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            if (_alnum(c)) continue;
            if (c == 0x20) { if (b[i - 1] == 0x20) return false; continue; }
            if (c != 0x2E && c != 0x2C && c != 0x26 && c != 0x27 && c != 0x28 && c != 0x29 && c != 0x2D) return false;
        }
        return true;
    }

    function _alnum(bytes1 c) private pure returns (bool) {
        return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A);
    }

    /// The key an NGO name is held under: only its letters and digits, in lower case, with the digit 0 read as the
    /// letter o and the digit 1 as the letter l, hashed. "Oxfam", "oxfam.", "Ox-fam" and "0xfam" share one key.
    function nameKey(string memory name) public pure returns (bytes32) {
        bytes memory b = bytes(name);
        bytes memory k = new bytes(b.length);
        uint256 n;
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            if (c >= 0x41 && c <= 0x5A) c = bytes1(uint8(c) + 32);
            if (c == 0x30) c = 0x6F; // 0 -> o
            if (c == 0x31) c = 0x6C; // 1 -> l
            if ((c >= 0x61 && c <= 0x7A) || (c >= 0x32 && c <= 0x39)) k[n++] = c;
        }
        assembly { mstore(k, n) }
        return keccak256(k);
    }

    /// Verified: the address holding the name is an attested NGO in NGORegistry. Until then pages show the name as
    /// unverified: anyone who has mined can register any free name.
    function ngoNameVerified(address miner) external view returns (bool) {
        return bytes(ngoName[miner]).length != 0 && INGORegistry(Addrs.NGO_REGISTRY).status(miner) == 2;
    }

    /// Anyone may free the name of an address whose NGO record was rejected; the address stays a registered miner.
    function releaseNgoName(address miner) external {
        if (INGORegistry(Addrs.NGO_REGISTRY).status(miner) != 3) revert BadName();
        string memory name = ngoName[miner];
        if (bytes(name).length == 0) revert BadName();
        delete ngoNameHolder[nameKey(name)];
        delete ngoName[miner];
        delete ngoDescription[miner];
        emit NgoNameReleased(miner, name);
    }

    function declareOperator(bytes32 operator) external whenActive {
        if (!isRegistered[msg.sender]) revert NotRegistered();
        operatorOf[msg.sender] = operator == bytes32(0) ? bytes32(uint256(uint160(msg.sender))) : operator;
        emit OperatorDeclared(msg.sender, operatorOf[msg.sender]);
    }

    /// System call: blue blocks accepted in one mergeset.
    function recordBlocks(address[] calldata miners, uint256[] calldata counts) external onlySystem {
        if (miners.length != counts.length) revert LengthMismatch();
        uint256 e = epochOf(block.timestamp);
        uint256 sum;
        for (uint256 i; i < miners.length; ++i) {
            if (counts[i] == 0) continue;
            if (minedIn[e][miners[i]] == 0) activeEpochs[miners[i]] += 1;
            minedTotal[miners[i]] += counts[i];
            minedIn[e][miners[i]] += counts[i];
            sum += counts[i];
        }
        epochBlocks[e] += sum;
        totalRecorded += sum;
    }

    function registeredMiners() external view returns (address[] memory) {
        return _registered;
    }

    function registeredCount() external view returns (uint256) {
        return _registered.length;
    }
}
