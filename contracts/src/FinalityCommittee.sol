// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Sys, Addrs, C, IMinerRegistry, INGOElection, INGORegistry} from "./Base.sol";

/// The finality committee (DAG_SPEC.md section 9).
///   21 members per 7-day epoch: 6 NGO seats (6/21 < 1/3) and 15 miner seats; quorum 15.
///   At most 3 seats per declared operator (3/21 = 1/7). An NGO cannot take a miner seat.
///   Members bond `committeeBond` PSY. Equivocation (two different checkpoints signed for the same number) burns 90 %
///   of the bond and pays 10 % to the reporter. Missed signatures are not slashed; members signing < 50 % of the
///   epoch's checkpoints lose that epoch's committee reward.
///   A member's bond stays locked until UNBOND_DELAY after the last committee it sat on was replaced (the evidence
///   window). An epoch's rewards are settled only once its committee was replaced and
///   SETTLE_DELAY has passed; checkpoints recorded for a settled epoch no longer change who earned a share, and the
///   total paid never exceeds the epoch's pool.
///   The committee is drawn only in Normal mode (process order: finality comes after the first election).
///   Draw: freeze candidates, then a seed produced after the freeze, then seal. The seed comes from the randomness
///   beacon of the committee then signing (commit-reveal); a finalised checkpoint or a block hash
///   only when there is no committee yet or nobody revealed. See the draw and beacon sections below.
///   A finality certificate needs, among its 15 signatures, MIN_NGO_SIGNATURES from NGO members (all NGO members if
///   fewer are active): miners alone can never finalise. Miner seat weight counts blue blocks over WEIGHT_EPOCHS epochs.
///   Bootstrap finality (DAG_SPEC.md section 9.1): until the first committee is sealed, the signers named in the
///   genesis (bootstrapSigners) finalise checkpoints with `bootstrapQuorum` of their signatures (2 of 3 dedicated keys
///   that do not mine). Bootstrap ends at
///   the first seal or BOOTSTRAP_PERIOD after genesis, whichever is first: afterwards only a committee
///   finalises. Until then a DAO vote (Upgrade kind) may replace the list, its quorum and its end, but never with a
///   quorum of half the list or less, so two conflicting bootstrap certificates always share a signer.
///   Certificates of that kind carry the epoch BOOTSTRAP_EPOCH.
contract FinalityCommittee is Sys {
    /// The epoch number bootstrap certificates carry (2^48 - 1: no calendar epoch reaches it; certificates encode the
    /// epoch in 6 bytes).
    uint256 public constant BOOTSTRAP_EPOCH = 2 ** 48 - 1;
    /// How long bootstrap finality may last at most (the same 12 months as the dev council's sunset).
    uint256 public constant BOOTSTRAP_PERIOD = 365 days;
    address[] private _bootstrap;
    address[] private _genesisBootstrap;
    mapping(address => bool) public isBootstrapSigner;
    /// Signatures a bootstrap certificate needs.
    uint256 public bootstrapQuorum;
    /// When bootstrap finality ends at the latest (unix seconds); 0 = genesis + BOOTSTRAP_PERIOD.
    uint256 public bootstrapEndsAt;
    error NoBootstrapSigners();
    error BadBootstrapQuorum();
    error BootstrapOver();
    error BadBootstrapEnd();
    event BootstrapReplaced(address[] signers, uint256 quorum, uint256 endsAt);

    constructor(address[] memory bootstrap, uint256 quorum) {
        _setBootstrap(bootstrap, quorum);
        for (uint256 i; i < bootstrap.length; ++i) _genesisBootstrap.push(bootstrap[i]);
    }

    function _setBootstrap(address[] memory list, uint256 quorum) private {
        if (list.length == 0 || list.length > 21) revert NoBootstrapSigners();
        // a majority: two certificates for different blocks then always share a signer, whose two signatures are proof
        if (quorum == 0 || quorum > list.length || quorum * 2 <= list.length) revert BadBootstrapQuorum();
        for (uint256 i; i < _bootstrap.length; ++i) isBootstrapSigner[_bootstrap[i]] = false;
        delete _bootstrap;
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == address(0) || isBootstrapSigner[list[i]]) revert NoBootstrapSigners();
            isBootstrapSigner[list[i]] = true;
            _bootstrap.push(list[i]);
        }
        bootstrapQuorum = quorum;
    }

    /// The latest moment bootstrap finality applies.
    function bootstrapDeadline() public view returns (uint256) {
        return bootstrapEndsAt != 0 ? bootstrapEndsAt : _genesis() + BOOTSTRAP_PERIOD;
    }

    /// True until the first committee is sealed or the bootstrap deadline has passed; false for good afterwards.
    function bootstrapActive() public view returns (bool) {
        return lastSealedEpoch == type(uint256).max && block.timestamp < bootstrapDeadline();
    }

    /// The addresses that may sign bootstrap checkpoints, or none once bootstrap is over.
    function bootstrapSigners() external view returns (address[] memory) {
        if (!bootstrapActive()) return new address[](0);
        return _bootstrap;
    }

    /// The bootstrap list as named at genesis (for pages, whether or not it is still active).
    function genesisBootstrapSigners() external view returns (address[] memory) {
        return _genesisBootstrap;
    }

    /// DAO only, while bootstrap is still active: a new list, quorum and end (at most BOOTSTRAP_PERIOD from now, and
    /// never later than genesis + 2 * BOOTSTRAP_PERIOD), for example to move the keys to new holders.
    function replaceBootstrap(address[] calldata list, uint256 quorum, uint256 endsAt) external onlyGovernor {
        if (!bootstrapActive()) revert BootstrapOver();
        if (endsAt <= block.timestamp || endsAt > block.timestamp + BOOTSTRAP_PERIOD || endsAt > _genesis() + 2 * BOOTSTRAP_PERIOD) revert BadBootstrapEnd();
        _setBootstrap(list, quorum);
        bootstrapEndsAt = endsAt;
        emit BootstrapReplaced(list, quorum, endsAt);
    }

    uint8 internal constant SEAT_NGO = 1;
    uint8 internal constant SEAT_MINER = 2;
    uint256 public constant MINER_WEIGHT_CAP_BPS = 500; // 5 % of the blocks of the weight window
    /// Epochs of blue blocks behind a miner's seat weight: work rented for one week buys a quarter of the weight
    ///.
    uint256 public constant WEIGHT_EPOCHS = 4;
    /// NGO signatures every finality certificate needs (2/3 of the 6 NGO seats).
    uint256 public constant MIN_NGO_SIGNATURES = 4;
    uint256 public constant UNBOND_DELAY = 14 days;
    /// Time after a committee is replaced before its epoch can be settled: certificates for checkpoints it signed just
    /// before the handover are included by then.
    uint256 public constant SETTLE_DELAY = 1 days;
    uint256 public constant MAX_MINER_CANDIDATES = 1_000; // bounds the gas of the weekly draw
    uint256 public minerCandidates;
    mapping(address => bool) private _asMiner;
    uint256 public ngoCandidates; // bonded as NGO (running total)
    mapping(address => bool) private _asNGO;
    /// Chain height of the last full freeze check (the scan over every bonded address runs at most once per
    /// CHECKPOINT_INTERVAL blocks, not every block).
    uint256 public lastFreezeCheck;
    bytes32 public constant CHECKPOINT_DOMAIN = keccak256("PSYROB-checkpoint");

    struct Bond {
        uint128 amount;
        uint64 since;
        uint64 unbondAt; // 0 = not leaving
    }

    mapping(address => Bond) public bonds;
    address[] private _bonded;
    mapping(address => uint256) private _bondedIdx; // index + 1

    mapping(uint256 => address[]) private _members; // epoch => members
    mapping(uint256 => mapping(address => uint8)) public seatOf; // epoch => member => seat type
    mapping(uint256 => bool) public sealed_;
    mapping(uint256 => bytes32) public seedOf;
    mapping(uint256 => mapping(address => bool)) public slashed;
    mapping(uint256 => mapping(address => uint256)) public signedCount;
    mapping(uint256 => uint256) public checkpointCount;
    mapping(uint256 => bool) public checkpointRecorded;
    /// Hash of the chain block of each recorded (final) checkpoint: a shared randomness source that nobody can choose
    /// once the committee has finalised it (used by the role-election tie draw).
    mapping(uint256 => bytes32) public checkpointBlock;
    mapping(uint256 => uint256) public rewardPool;
    mapping(uint256 => uint256) public eligibleCount; // 0 until settled; settled stores count + 1
    mapping(uint256 => mapping(address => bool)) public rewardClaimed;
    mapping(uint256 => uint256) public rewardPaid; // epoch => total paid to members
    uint256 public lastCheckpoint;
    /// When the committee of an epoch stopped signing (the next committee was sealed); 0 = still signing or never sealed.
    mapping(uint256 => uint256) public retiredAt;
    /// The last epoch whose committee an address sat on, plus 1 (0 = never sat).
    mapping(address => uint256) public lastServed;

    error WrongBond(uint256 expected);
    error AlreadyBonded();
    error NotEligible();
    error NotBonded();
    error TooEarly();
    error StillServing();
    error NotAMember();
    error NotEquivocation();
    error AlreadySlashed();
    error BadSignature();
    error EpochNotOver();
    error NotSettleable();
    error AlreadyClaimed();
    error CandidateListFull();

    event Bonded(address indexed who, uint256 amount);
    event UnbondRequested(address indexed who, uint256 at);
    event BondWithdrawn(address indexed who, uint256 amount);
    event Sealed(uint256 indexed epoch, address[] members, bytes32 seed);
    event CheckpointRecorded(uint256 indexed epoch, uint256 indexed number, bytes32 chainBlock, uint256 signers);
    event Slashed(uint256 indexed epoch, address indexed member, address reporter, uint256 burned, uint256 reward);
    event RewardClaimed(uint256 indexed epoch, address indexed member, uint256 amount);

    // ---- epochs ----

    function epochOf(uint256 t) public view returns (uint256) {
        uint256 g = _genesis();
        return t <= g ? 0 : (t - g) / C.EPOCH;
    }

    function currentEpoch() public view returns (uint256) {
        return epochOf(block.timestamp);
    }

    // ---- bonds ----

    function bond() external payable whenActive {
        if (bonds[msg.sender].amount != 0) revert AlreadyBonded();
        bool asNGO = _canSitAsNGO(msg.sender);
        if (!asNGO && !_canSitAsMiner(msg.sender)) revert NotEligible();
        if (!asNGO) {
            if (minerCandidates >= MAX_MINER_CANDIDATES) revert CandidateListFull();
            minerCandidates += 1;
            _asMiner[msg.sender] = true;
        } else {
            ngoCandidates += 1;
            _asNGO[msg.sender] = true;
        }
        uint256 b = _param("committeeBond");
        if (msg.value != b) revert WrongBond(b);
        bonds[msg.sender] = Bond(uint128(b), uint64(block.timestamp), 0);
        _bonded.push(msg.sender);
        _bondedIdx[msg.sender] = _bonded.length;
        emit Bonded(msg.sender, b);
    }

    function requestUnbond() external whenActive {
        Bond storage b = bonds[msg.sender];
        if (b.amount == 0) revert NotBonded();
        b.unbondAt = uint64(block.timestamp + UNBOND_DELAY);
        _removeBonded(msg.sender);
        emit UnbondRequested(msg.sender, b.unbondAt);
    }

    function withdrawBond() external whenActive {
        Bond storage b = bonds[msg.sender];
        if (b.amount == 0 || b.unbondAt == 0) revert NotBonded();
        if (block.timestamp < b.unbondAt) revert TooEarly();
        // Evidence window: a member that sat on a committee can be reported for equivocation until UNBOND_DELAY after
        // that committee was replaced (a committee keeps signing until the next one is sealed).
        uint256 s = lastServed[msg.sender];
        if (s != 0) {
            uint256 r = retiredAt[s - 1];
            if (r == 0) revert StillServing();
            if (block.timestamp < r + UNBOND_DELAY) revert TooEarly();
        }
        uint256 a = b.amount;
        delete bonds[msg.sender];
        emit BondWithdrawn(msg.sender, a);
        _send(msg.sender, a);
    }

    function _removeBonded(address a) private {
        uint256 i = _bondedIdx[a];
        if (i == 0) return;
        if (_asMiner[a]) {
            _asMiner[a] = false;
            minerCandidates -= 1;
        }
        if (_asNGO[a]) {
            _asNGO[a] = false;
            ngoCandidates -= 1;
        }
        address last = _bonded[_bonded.length - 1];
        _bonded[i - 1] = last;
        _bondedIdx[last] = i;
        _bonded.pop();
        _bondedIdx[a] = 0;
    }

    function _canSitAsNGO(address a) private view returns (bool) {
        return INGOElection(Addrs.NGO_ELECTION).isElected(a);
    }

    function _canSitAsMiner(address a) private view returns (bool) {
        return IMinerRegistry(Addrs.MINER_REGISTRY).isRegistered(a) && !INGORegistry(Addrs.NGO_REGISTRY).isNGO(a)
            && !_isRoleHolder(a);
    }

    // ---- the draw ----
    //
    // Freeze, seed, seal. At the first chain block of an epoch in Normal mode the candidate list, the
    // weights (blue blocks mined over the last WEIGHT_EPOCHS epochs, capped) and the declared operators are frozen. The
    // seed is then produced after the freeze, so nobody can tune bonds or operator labels to a known seed:
    //   - every rotation after the first: the mix of a beacon round opened at the freeze and revealed by the committee
    //     then signing (BEACON_WINDOW blocks). No miner can influence it;
    //   - if nobody revealed: the hash of the first finalised checkpoint at or after SEED_DELAY blocks later
    //     (checkpointBlock), mixed with the epoch;
    //   - the first committee (no checkpoint can exist yet, finality starts with it): the hash of the chain block
    //     SEED_DELAY blocks after the freeze;
    //   - if the seed checkpoint is not finalised within CHECKPOINT_WAIT blocks, once: a chain block SEED_DELAY later.
    // Until the new committee is sealed, the previous one keeps signing checkpoints (signerEpoch), so finality never
    // waits for its own seed. The node runs advance() every chain block, so the draw happens in the first block where
    // the seed exists.

    uint64 public constant SEED_DELAY = 30;
    uint64 public constant CHECKPOINT_INTERVAL = 30;
    uint64 public constant CHECKPOINT_WAIT = 2_880; // ~8 h
    uint8 public constant SOURCE_CHECKPOINT = 1;
    uint8 public constant SOURCE_BLOCK = 2;
    uint8 public constant SOURCE_BEACON = 3;

    struct Frozen {
        address who;
        uint64 weight;
        uint8 kind;
    }

    struct EpochDraw {
        uint64 freezeBlock;
        uint64 seedBlock;
        uint64 sealBlock; // chain height of the seal; 0 = not sealed
        uint64 sourceRef; // checkpoint number or block number used
        uint64 prevSealed; // the committee epoch before this one (rotation), or type(uint64).max
        bool useCheckpoint;
        uint8 sourceKind;
        bytes32 sourceHash;
    }

    mapping(uint256 => EpochDraw) private _epochDraws;
    mapping(uint256 => uint256) private _drawBeacon; // epoch => beacon round + 1 its draw waits for (0 = none)
    mapping(uint256 => Frozen[]) private _frozen;
    mapping(uint256 => bytes32[]) private _frozenOps;
    uint256 public lastSealedEpoch = type(uint256).max;

    event Frozen_(uint256 indexed epoch, uint256 candidates, uint256 seedBlock, bool useCheckpoint);
    event SeedFallback(uint256 indexed epoch, uint256 newSeedBlock);

    /// System call (every chain block): freeze the current epoch's candidates, then seal its committee once the seed
    /// exists. Normal mode only.
    function advance() external onlySystem {
        _closeBeacons();
        uint256 e = currentEpoch();
        if (_mode() != 1) return;
        EpochDraw storage d = _epochDraws[e];
        if (d.sealBlock != 0) return;
        if (d.freezeBlock == 0) {
            // cheap checks first: the running totals are an upper bound on who can sit, and the full scan over every
            // bonded address (external calls) runs at most once per CHECKPOINT_INTERVAL blocks
            if (ngoCandidates + minerCandidates < C.COMMITTEE_QUORUM) return;
            if (lastFreezeCheck != 0 && block.number < lastFreezeCheck + CHECKPOINT_INTERVAL) return;
            lastFreezeCheck = block.number;
            if (_readyToFreeze(e)) _freeze(e, d);
            return;
        }
        uint256 br = _drawBeacon[e];
        if (br != 0) {
            BeaconRound storage b = _beacons[br - 1];
            if (!b.closed) return; // the committee is revealing
            _drawBeacon[e] = 0;
            if (b.reveals > 0) {
                _seal(e, d, SOURCE_BEACON, uint64(br - 1), b.mix);
                return;
            }
            // nobody revealed: the earlier sources, from now on
            d.seedBlock = uint64(block.number) + SEED_DELAY;
            emit SeedFallback(e, d.seedBlock);
            return;
        }
        (bool ok, uint8 kind, uint64 ref, bytes32 h) = _seedFor(d);
        if (ok) {
            _seal(e, d, kind, ref, h);
            return;
        }
        uint256 cpHeight = uint256(_cpNumber(d.seedBlock)) * CHECKPOINT_INTERVAL;
        if ((d.useCheckpoint && block.number > cpHeight + CHECKPOINT_WAIT) || (!d.useCheckpoint && block.number > uint256(d.seedBlock) + 256)) {
            d.useCheckpoint = false;
            d.seedBlock = uint64(block.number) + SEED_DELAY;
            emit SeedFallback(e, d.seedBlock);
        }
    }

    function _cpNumber(uint64 b) private pure returns (uint64) {
        return (b + CHECKPOINT_INTERVAL - 1) / CHECKPOINT_INTERVAL;
    }

    function _seedFor(EpochDraw storage d) private view returns (bool, uint8, uint64, bytes32) {
        if (d.useCheckpoint) {
            uint64 c = _cpNumber(d.seedBlock);
            bytes32 h = checkpointBlock[c];
            return h == bytes32(0) ? (false, 0, 0, bytes32(0)) : (true, SOURCE_CHECKPOINT, c, h);
        }
        if (block.number <= d.seedBlock || block.number > uint256(d.seedBlock) + 256) return (false, 0, 0, bytes32(0));
        bytes32 bh = blockhash(d.seedBlock);
        return bh == bytes32(0) ? (false, 0, 0, bytes32(0)) : (true, SOURCE_BLOCK, d.seedBlock, bh);
    }

    /// Freeze only when the candidates can form a committee: 6 NGO and 15 miner candidates, or at least 15 in total
    /// (at least 4 of them NGOs) one day into the epoch. Otherwise the previous committee keeps signing (and, before the first committee, the
    /// network simply has no finality yet). This gives elected NGOs time to bond when Normal mode begins.
    function _readyToFreeze(uint256 e) private view returns (bool) {
        uint256 ngo;
        uint256 miner;
        for (uint256 i; i < _bonded.length; ++i) {
            address a = _bonded[i];
            if (_canSitAsNGO(a)) ++ngo;
            else if (_canSitAsMiner(a)) ++miner;
        }
        // never a committee that could finalise without NGO signatures: at least MIN_NGO_SIGNATURES NGO
        // candidates must be able to sit
        if (ngo < MIN_NGO_SIGNATURES) return false;
        if (ngo >= C.NGO_COMMITTEE_SEATS && miner >= C.MINER_COMMITTEE_SEATS) return true;
        return ngo + miner >= C.COMMITTEE_QUORUM && block.timestamp >= _genesis() + e * C.EPOCH + 1 days;
    }

    function _freeze(uint256 e, EpochDraw storage d) private {
        IMinerRegistry mr = IMinerRegistry(Addrs.MINER_REGISTRY);
        uint256 from = e > WEIGHT_EPOCHS ? e - WEIGHT_EPOCHS : 0;
        uint256 prevBlocks;
        for (uint256 x = from; x < e; ++x) prevBlocks += mr.epochBlocks(x);
        uint256 cap = prevBlocks * MINER_WEIGHT_CAP_BPS / 10_000;
        Frozen[] storage f = _frozen[e];
        bytes32[] storage fo = _frozenOps[e];
        for (uint256 i; i < _bonded.length; ++i) {
            address a = _bonded[i];
            uint256 w;
            uint8 kind;
            if (_canSitAsNGO(a)) {
                kind = SEAT_NGO;
                w = 1;
            } else if (_canSitAsMiner(a)) {
                kind = SEAT_MINER;
                if (prevBlocks == 0) w = 1;
                else for (uint256 x = from; x < e; ++x) w += mr.minedIn(x, a);
                if (cap > 0 && w > cap) w = cap;
            }
            if (w == 0) continue;
            f.push(Frozen(a, uint64(w), kind));
            fo.push(_operator(a));
        }
        d.freezeBlock = uint64(block.number);
        d.seedBlock = uint64(block.number) + SEED_DELAY;
        d.useCheckpoint = lastCheckpoint > 0 && lastSealedEpoch != type(uint256).max;
        d.prevSealed = lastSealedEpoch == type(uint256).max ? type(uint64).max : uint64(lastSealedEpoch);
        if (lastSealedEpoch != type(uint256).max) {
            // a committee exists: it produces the seed (beacon round opened now, after the freeze)
            _drawBeacon[e] = _requestBeacon() + 1;
        }
        emit Frozen_(e, f.length, d.seedBlock, d.useCheckpoint);
    }

    function _seal(uint256 e, EpochDraw storage d, uint8 kind, uint64 ref, bytes32 h) private {
        bytes32 seed = keccak256(abi.encode(h, e));
        d.sealBlock = uint64(block.number);
        d.sourceKind = kind;
        d.sourceRef = ref;
        d.sourceHash = h;
        sealed_[e] = true;
        seedOf[e] = seed;
        if (lastSealedEpoch != type(uint256).max) retiredAt[lastSealedEpoch] = block.timestamp;
        lastSealedEpoch = e;
        Frozen[] storage f = _frozen[e];
        uint256 n = f.length;
        address[] memory cand = new address[](n);
        uint256[] memory w = new uint256[](n);
        uint8[] memory kinds = new uint8[](n);
        bytes32[] memory cops = new bytes32[](n);
        uint256 ngoCands;
        uint256 minerCands;
        for (uint256 i; i < n; ++i) {
            cand[i] = f[i].who;
            w[i] = f[i].weight;
            kinds[i] = f[i].kind;
            cops[i] = _frozenOps[e][i];
            if (kinds[i] == SEAT_NGO) ++ngoCands;
            else ++minerCands;
        }
        uint256 prev = d.prevSealed;
        address[] memory chosen = new address[](C.COMMITTEE_SIZE);
        uint256 count;
        bytes32[] memory ops = new bytes32[](C.COMMITTEE_SIZE);
        uint256[] memory opSeats = new uint256[](C.COMMITTEE_SIZE);
        (count, seed) = _draw(e, prev, cand, w, kinds, cops, SEAT_NGO, C.NGO_COMMITTEE_SEATS, ngoCands, chosen, count, ops, opSeats, seed);
        (count, seed) =
            _draw(e, prev, cand, w, kinds, cops, SEAT_MINER, C.MINER_COMMITTEE_SEATS, minerCands, chosen, count, ops, opSeats, seed);
        address[] storage mem = _members[e];
        for (uint256 i; i < count; ++i) mem.push(chosen[i]);
        emit Sealed(e, mem, seed);
    }

    /// Weighted draw without replacement of `seats` members of one seat type. Members of the previous committee are
    /// skipped while enough other candidates exist (rotation). At most 3 seats per operator (frozen labels).
    function _draw(
        uint256 e,
        uint256 prev,
        address[] memory cand,
        uint256[] memory w,
        uint8[] memory kind,
        bytes32[] memory cops,
        uint8 seatType,
        uint256 seats,
        uint256 available,
        address[] memory chosen,
        uint256 count,
        bytes32[] memory ops,
        uint256[] memory opSeats,
        bytes32 seed
    ) private returns (uint256, bytes32) {
        uint256 n = cand.length;
        uint256 fresh;
        for (uint256 i; i < n; ++i) {
            if (kind[i] == seatType && w[i] > 0 && !_servedIn(prev, cand[i])) ++fresh;
        }
        bool skipPrevious = fresh >= seats;
        uint256 want = seats < available ? seats : available;
        for (uint256 s; s < want; ++s) {
            uint256 total;
            for (uint256 i; i < n; ++i) if (_drawable(prev, cand, w, kind, cops, seatType, skipPrevious, ops, opSeats, i)) total += w[i];
            if (total == 0) break;
            seed = keccak256(abi.encode(seed, s, seatType));
            uint256 r = uint256(seed) % total;
            for (uint256 i; i < n; ++i) {
                if (!_drawable(prev, cand, w, kind, cops, seatType, skipPrevious, ops, opSeats, i)) continue;
                if (r < w[i]) {
                    chosen[count++] = cand[i];
                    seatOf[e][cand[i]] = seatType;
                    lastServed[cand[i]] = e + 1;
                    _countOperator(cops[i], ops, opSeats);
                    w[i] = 0;
                    break;
                }
                r -= w[i];
            }
        }
        return (count, seed);
    }

    function _servedIn(uint256 prev, address a) private view returns (bool) {
        return prev != type(uint64).max && seatOf[prev][a] != 0;
    }

    function _drawable(
        uint256 prev,
        address[] memory cand,
        uint256[] memory w,
        uint8[] memory kind,
        bytes32[] memory cops,
        uint8 seatType,
        bool skipPrevious,
        bytes32[] memory ops,
        uint256[] memory opSeats,
        uint256 i
    ) private view returns (bool) {
        if (kind[i] != seatType || w[i] == 0) return false;
        if (skipPrevious && _servedIn(prev, cand[i])) return false;
        for (uint256 j; j < ops.length; ++j) {
            if (ops[j] == cops[i]) return opSeats[j] < C.MAX_SEATS_PER_OPERATOR;
            if (ops[j] == bytes32(0)) break;
        }
        return true;
    }

    function _operator(address a) private view returns (bytes32 op) {
        op = IMinerRegistry(Addrs.MINER_REGISTRY).operatorOf(a);
        if (op == bytes32(0)) op = bytes32(uint256(uint160(a)));
    }

    function _countOperator(bytes32 op, bytes32[] memory ops, uint256[] memory opSeats) private pure {
        for (uint256 j; j < ops.length; ++j) {
            if (ops[j] == op || ops[j] == bytes32(0)) {
                ops[j] = op;
                opSeats[j] += 1;
                return;
            }
        }
    }

    /// The committee that signs a checkpoint whose chain block has timestamp `t` and chain height `h`: the committee
    /// of t's epoch if it was sealed before h, otherwise the most recent earlier one. type(uint256).max = none.
    function signerEpoch(uint256 t, uint256 h) external view returns (uint256 signer) {
        uint256 e = epochOf(t);
        for (;;) {
            EpochDraw storage d = _epochDraws[e];
            if (d.sealBlock != 0 && d.sealBlock < h) return e;
            if (e == 0) return type(uint256).max;
            --e;
        }
    }

    function epochDraw(uint256 e) external view returns (EpochDraw memory, Frozen[] memory) {
        return (_epochDraws[e], _frozen[e]);
    }

    // ---- checkpoints, rewards, slashing ----

    /// The message a member signs for checkpoint `number` (every 30th chain block).
    function checkpointDigest(uint256 number, bytes32 chainBlock, bytes32 stateRoot) public view returns (bytes32) {
        // the genesis time binds the signature to this launch of the chain ID
        return keccak256(abi.encode(CHECKPOINT_DOMAIN, block.chainid, _genesis(), number, chainBlock, stateRoot));
    }

    /// System call: a finality certificate included in an accepted block. The node has verified the signatures
    /// (consensus rule); this records who signed, for rewards. Once `epoch` is settled its counts are closed: the
    /// checkpoint is still recorded (finality, seeds) but no longer changes who earned the epoch's reward.
    function recordCheckpoint(uint256 epoch, uint256 number, bytes32 chainBlock, address[] calldata signers)
        external
        onlySystem
    {
        if (checkpointRecorded[number]) return;
        checkpointRecorded[number] = true;
        checkpointBlock[number] = chainBlock;
        if (number > lastCheckpoint) lastCheckpoint = number;
        if (eligibleCount[epoch] == 0) {
            checkpointCount[epoch] += 1;
            for (uint256 i; i < signers.length; ++i) signedCount[epoch][signers[i]] += 1;
        }
        emit CheckpointRecorded(epoch, number, chainBlock, signers.length);
    }

    /// System call after the node credits the committee share of the mining subsidy.
    function notify(uint256 amount) external onlySystem {
        rewardPool[currentEpoch()] += amount;
    }

    function _eligible(uint256 e, address a) private view returns (bool) {
        uint256 cps = checkpointCount[e];
        return seatOf[e][a] != 0 && !slashed[e][a] && !missedReveal[e][a] && cps > 0 && signedCount[e][a] * 2 >= cps;
    }

    function claimReward(uint256 e) external whenActive {
        if (eligibleCount[e] == 0) {
            _requireSettleable(e);
            _settle(e);
        }
        if (!_eligible(e, msg.sender) || eligibleCount[e] < 2) revert NotEligible();
        if (rewardClaimed[e][msg.sender]) revert AlreadyClaimed();
        rewardClaimed[e][msg.sender] = true;
        uint256 share = rewardPool[e] / (eligibleCount[e] - 1);
        uint256 paid = rewardPaid[e] + share;
        if (paid > rewardPool[e]) revert NotEligible(); // never pay more than the pool (defence in depth)
        rewardPaid[e] = paid;
        emit RewardClaimed(e, msg.sender, share);
        _send(msg.sender, share);
    }

    /// Count eligible members once; if nobody earned the epoch's reward, it goes to the Treasury.
    function settle(uint256 e) external whenActive {
        if (eligibleCount[e] != 0) return;
        _requireSettleable(e);
        _settle(e);
    }

    /// An epoch can be settled when no more checkpoints can count for it: its calendar time is over and either it had
    /// no committee, its committee was replaced at least SETTLE_DELAY ago, or (no replacement ever sealed) two further
    /// epochs have begun.
    function settleable(uint256 e) public view returns (bool) {
        uint256 cur = currentEpoch();
        if (e >= cur) return false;
        if (!sealed_[e]) return true;
        uint256 r = retiredAt[e];
        if (r != 0) return block.timestamp >= r + SETTLE_DELAY;
        return cur >= e + 2;
    }

    function _requireSettleable(uint256 e) private view {
        if (e >= currentEpoch()) revert EpochNotOver();
        if (!settleable(e)) revert NotSettleable();
    }

    function _settle(uint256 e) private {
        address[] storage m = _members[e];
        uint256 k;
        for (uint256 i; i < m.length; ++i) if (_eligible(e, m[i])) ++k;
        eligibleCount[e] = k + 1;
        if (k == 0 && rewardPool[e] > 0) {
            uint256 a = rewardPool[e];
            rewardPool[e] = 0;
            _send(Addrs.TREASURY, a);
        }
    }

    /// Anyone may report two signatures by one member for the same checkpoint number with different contents.
    function reportEquivocation(
        uint256 e,
        uint256 number,
        bytes32 blockA,
        bytes32 rootA,
        bytes calldata sigA,
        bytes32 blockB,
        bytes32 rootB,
        bytes calldata sigB
    ) external whenActive {
        if (blockA == blockB && rootA == rootB) revert NotEquivocation();
        address a = _recover(checkpointDigest(number, blockA, rootA), sigA);
        address b = _recover(checkpointDigest(number, blockB, rootB), sigB);
        if (a != b) revert NotEquivocation();
        if (seatOf[e][a] == 0) revert NotAMember();
        if (slashed[e][a]) revert AlreadySlashed();
        slashed[e][a] = true;
        Bond storage bd = bonds[a];
        uint256 amount = bd.amount;
        bd.amount = 0;
        bd.unbondAt = 0;
        _removeBonded(a);
        uint256 reward = amount / 10;
        emit Slashed(e, a, msg.sender, amount - reward, reward);
        _burn(amount - reward);
        _send(msg.sender, reward);
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        address a = ecrecover(digest, v, r, s);
        if (a == address(0)) revert BadSignature();
        return a;
    }

    // ---- randomness beacon (commit-reveal) ----
    //
    // Every bonded address may commit to the top layer of a hash onion: top = keccak^N(secret). A beacon round opens
    // when a draw needs a seed (the committee freeze here; a role-election tie in RoleElection). For BEACON_WINDOW chain
    // blocks the members of the committee signing at that moment reveal the next layer of their onion (one whose
    // keccak256 equals their last revealed layer, or the top); the round's mix is the hash of all reveals. Only members
    // whose commitment predates the round take part, so nobody chooses a value after seeing the round open, and a layer
    // is fixed by the commitment, so a member can only stay silent. A member that committed and stays silent forfeits
    // that epoch's committee reward (missedReveal). If nobody reveals, the draw falls back to the earlier sources.

    uint64 public constant BEACON_WINDOW = 60; // chain blocks (~10 minutes)
    uint256 public constant MAX_BEACON_CLOSE = 4; // rounds closed per block at most

    struct BeaconRound {
        uint64 requestBlock;
        uint64 epoch; // the committee that reveals
        uint16 reveals;
        bool closed;
        bytes32 mix;
    }

    BeaconRound[] private _beacons;
    uint256 public beaconsClosed; // rounds [0, beaconsClosed) are closed
    mapping(address => bytes32) public beaconLayer; // the last revealed layer, or the committed top
    mapping(address => uint64) public beaconCommitBlock;
    mapping(address => uint256) public beaconCommits; // commitments made so far (the member's onion index)
    mapping(uint256 => mapping(address => bool)) public beaconRevealed; // round => member
    mapping(uint256 => mapping(address => bool)) public missedReveal; // epoch => member

    error NoCommitment();
    error RevealClosed();
    error NotABeaconMember();
    error AlreadyRevealed();
    error WrongLayer();
    error OnlyRoleElection();

    event BeaconCommitted(address indexed who, bytes32 top, uint256 index);
    event BeaconRequested(uint256 indexed round, uint256 epoch, uint256 untilBlock);
    event BeaconRevealed(uint256 indexed round, address indexed who, bytes32 layer);
    event BeaconClosed(uint256 indexed round, uint256 reveals, bytes32 mix);

    /// Commit to a new hash onion (bonded addresses; also before being drawn, so a new member is ready at once).
    function commitBeacon(bytes32 top) external whenActive {
        if (bonds[msg.sender].amount == 0) revert NotBonded();
        if (top == bytes32(0)) revert NoCommitment();
        // replacing a commitment while a reveal is owed counts as staying silent (otherwise a member could watch the
        // other reveals, then re-commit to escape the penalty)
        uint64 old = beaconCommitBlock[msg.sender];
        for (uint256 r = beaconsClosed; r < _beacons.length; ++r) {
            BeaconRound storage b = _beacons[r];
            if (old != 0 && old < b.requestBlock && seatOf[b.epoch][msg.sender] != 0 && !beaconRevealed[r][msg.sender]) {
                missedReveal[b.epoch][msg.sender] = true;
            }
        }
        beaconLayer[msg.sender] = top;
        beaconCommitBlock[msg.sender] = uint64(block.number);
        emit BeaconCommitted(msg.sender, top, beaconCommits[msg.sender]);
        beaconCommits[msg.sender] += 1;
    }

    /// Reveal the next layer for round `r`.
    function revealBeacon(uint256 r, bytes32 layer) external whenActive {
        if (r >= _beacons.length) revert RevealClosed();
        BeaconRound storage b = _beacons[r];
        if (b.closed || block.number > uint256(b.requestBlock) + BEACON_WINDOW) revert RevealClosed();
        if (seatOf[b.epoch][msg.sender] == 0 || slashed[b.epoch][msg.sender]) revert NotABeaconMember();
        if (beaconCommitBlock[msg.sender] == 0 || beaconCommitBlock[msg.sender] >= b.requestBlock) revert NoCommitment();
        if (beaconRevealed[r][msg.sender]) revert AlreadyRevealed();
        if (keccak256(abi.encode(layer)) != beaconLayer[msg.sender]) revert WrongLayer();
        beaconRevealed[r][msg.sender] = true;
        beaconLayer[msg.sender] = layer;
        b.mix = keccak256(abi.encode(b.mix, msg.sender, layer));
        b.reveals += 1;
        emit BeaconRevealed(r, msg.sender, layer);
    }

    /// A role-election tie asks for a beacon round (RoleElection only). Returns the round + 1, or 0 if no committee
    /// exists to reveal.
    function requestBeacon() external returns (uint256) {
        if (msg.sender != Addrs.ROLE_ELECTION) revert OnlyRoleElection();
        if (lastSealedEpoch == type(uint256).max) return 0;
        return _requestBeacon() + 1;
    }

    function _requestBeacon() private returns (uint256 r) {
        r = _beacons.length;
        uint64 ep = uint64(lastSealedEpoch);
        _beacons.push(BeaconRound(uint64(block.number), ep, 0, false, keccak256(abi.encode("PSYROB-beacon", block.chainid, r))));
        emit BeaconRequested(r, ep, block.number + BEACON_WINDOW);
    }

    /// Close rounds whose window ended; members that had committed in time and did not reveal forfeit the epoch reward.
    function _closeBeacons() private {
        uint256 i = beaconsClosed;
        uint256 n = _beacons.length;
        for (uint256 k; k < MAX_BEACON_CLOSE && i < n; ++k) {
            BeaconRound storage b = _beacons[i];
            if (block.number <= uint256(b.requestBlock) + BEACON_WINDOW) break;
            address[] storage m = _members[b.epoch];
            for (uint256 j; j < m.length; ++j) {
                address a = m[j];
                uint64 cb = beaconCommitBlock[a];
                if (cb != 0 && cb < b.requestBlock && !beaconRevealed[i][a] && !slashed[b.epoch][a]) missedReveal[b.epoch][a] = true;
            }
            b.closed = true;
            emit BeaconClosed(i, b.reveals, b.mix);
            ++i;
        }
        beaconsClosed = i;
    }

    function beacon(uint256 r) external view returns (BeaconRound memory) {
        return _beacons[r];
    }

    function beaconCount() external view returns (uint256) {
        return _beacons.length;
    }

    // ---- views ----

    /// NGO members whose signatures count for epoch e (slashed members excluded).
    function activeNgoMembers(uint256 e) public view returns (address[] memory out) {
        address[] storage m = _members[e];
        uint256 k;
        for (uint256 i; i < m.length; ++i) if (!slashed[e][m[i]] && seatOf[e][m[i]] == SEAT_NGO) ++k;
        out = new address[](k);
        k = 0;
        for (uint256 i; i < m.length; ++i) if (!slashed[e][m[i]] && seatOf[e][m[i]] == SEAT_NGO) out[k++] = m[i];
    }

    /// NGO signatures a certificate of epoch e needs: MIN_NGO_SIGNATURES, or every active NGO member if fewer.
    function ngoSignaturesRequired(uint256 e) external view returns (uint256) {
        uint256 n = activeNgoMembers(e).length;
        return n < MIN_NGO_SIGNATURES ? n : MIN_NGO_SIGNATURES;
    }

    function members(uint256 e) external view returns (address[] memory) {
        return _members[e];
    }

    /// Members whose signatures count for epoch e (slashed members excluded).
    function activeMembers(uint256 e) external view returns (address[] memory out) {
        address[] storage m = _members[e];
        uint256 k;
        for (uint256 i; i < m.length; ++i) if (!slashed[e][m[i]]) ++k;
        out = new address[](k);
        k = 0;
        for (uint256 i; i < m.length; ++i) if (!slashed[e][m[i]]) out[k++] = m[i];
    }

    function bondedList() external view returns (address[] memory) {
        return _bonded;
    }
}
