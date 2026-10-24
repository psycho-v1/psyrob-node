# PSYROB specification (block DAG), testnet v10.0

Status: **build specification**. The locked design rules of the project brief are binding. Every other choice below is
a decision made after the literature review in `docs/research/RESEARCH.md`; the source ids in brackets (for example
[ghostdag21]) refer to `docs/research/bibliography.json`.

## 1. Network identity

| Item | Value |
|---|---|
| Node version | 10.0.0 |
| Genesis | Built at the launch ceremony (section 17.1) from the three Dev Account signatures; its hash is recorded in `genesis/chain.json` when the network starts. A node that finds blocks of another genesis in its data folder moves them to `old-network-<time>/` and starts from this genesis. |
| Chain ID | **87870** (`0x1573e`), the testnet (owner decision, 24 October 2026); unused in the public registries (chainid.network, ethereum-lists, checked 24 October 2026). A mainnet will have a chain ID of its own. |
| Native token | PSY, 18 decimals, maximum supply 1,000,000,000 PSY (enforced by consensus, section 7) |
| Consensus | GHOSTDAG block DAG [ghostdag21], Argon2d proof of work, finality checkpoints signed by a 21-member committee |
| Execution | Ethereum Virtual Machine (Shanghai rules) over an account state |

**Replay warning.** Use a new key for this network: never reuse a key that was used on any other network, because transactions signed with it could be replayed. The explorer shows this warning on every page footer.

## 2. Parameters

| Parameter | Value | Reason |
|---|---|---|
| Target block interval T | 10 s per blue block | locked bound (≥ 10 s, first 12 months); verification cost of 32 MiB Argon2d (~38 ms) keeps sync cheap |
| k (anticone bound) | 18 | locked bound (k ≥ 18). With λ = 0.1 blocks/s, P(Poisson(2Dλ) > 18) < 10⁻⁵ for a worst-case delay D of 30 s; Conflux measured 10-15 s block delay on real P2P networks [conflux20], Bitcoin's measured propagation was ~12 s at the 90th percentile [decker13] |
| Max parents | 10 | bounds header size and GHOSTDAG work |
| Mergeset size limit | 180 blocks | 10·k, as in the reference implementation for k = 18 |
| Merge depth | 360 blue score (~1 h) | red blocks older than this cannot be merged (stops late "balance"-style injections [spectre-security]) |
| DAG finality depth | 8,640 blue score (~24 h) | the virtual chain never reorganises below this depth |
| Checkpoint interval | every 30 chain blocks (~5 min) | committee finality (section 9) |
| Committee epoch | 7 days (by block timestamp) | rotation (section 9) |
| Block gas limit | 10,000,000 | per block |
| Accepted gas per chain block | ≤ 30,000,000 | caps the work of one mergeset; protects against resource-metering DoS [brokenmetre20] |
| Base fee | EIP-1559 style, target 5,000,000 accepted gas per chain block, change ≤ 1/8, floor 1 gwei, burned | [roughgarden], [eip1559-22], [fee-burn] |
| Future timestamp limit | 120 s past local clock | timestamp manipulation bound [szalachowski18] |
| Past median time | median of the last 31 selected-chain timestamps | |
| Difficulty | ASERT on the DAA score (every merged block, blue or red) and the selected parent's timestamp, half-life 900 s | absolute schedule, no oscillation; counting all blocks makes any flood raise difficulty; a 10x jump is absorbed in ~40 min (risk review 4.1) [kraft16], [fullmer18], [noda20] |

**Early-network bounds (locked).** For the first 12 months after genesis (by past median time) the node refuses any parameter set with T < 10 s or k < 18, and the emission cap of section 7.3 applies. These values are compiled constants; changing them needs a new node release (a hard fork), never a governance vote.

## 3. Block format

Block = header + transaction list. The header is RLP-encoded:

```
[ version=7, parents[1..10] (32 B each, sorted ascending), timestamp, target (32 B),
  blueScore, blueWork, stateRoot, txRoot, receiptsRoot, acceptedTxRoot,
  gasLimit, gasUsed, baseFee, miner (20 B), extra (≤ 32 B), nonce (8 B), minerSig (65 B) ]
```

- `parents` are the DAG parents. The first rule of validity is that every parent is known and valid.
- `blueScore` and `blueWork` are the GHOSTDAG values of this block (section 4) and must match the node's computation.
- `stateRoot`, `receiptsRoot`, `acceptedTxRoot` commit to the state after this block **accepts its mergeset** (section 5). `gasUsed` is the accepted gas of that mergeset; `baseFee` is the base fee that applied to it.
- `txRoot` commits to this block's body, `keccak256(rlp([transactions, finality certificates]))`; the transactions are executed later, when a chain block accepts this block.
- **Miner signature:** `minerSig` is the secp256k1 signature by the `miner` address over `keccak256("PSYROB-miner-signature" ‖ signing bytes)`, where the signing bytes are the RLP of the header with `minerSig` empty (the nonce is included).
- **Proof of work:** `powHash = Argon2d(password = full header RLP including minerSig, salt = "PSYROB-PoW", m = 32 MiB, t = 1, p = 1, 32 bytes)`, valid iff `uint256(powHash) ≤ target`. Because the work covers the signature and the signature covers the nonce, each attempt needs a new signature by the miner wallet: the work cannot be outsourced to a pool operator without handing over the reward key (kept from the earlier design). The miner wallet is also the NGO wallet when the miner belongs to an NGO (section 8).
- Block hash = keccak256 of the full header RLP.

Argon2d with 32 MiB is chosen for CPU-friendly mining: memory-hard functions raise the cost of dedicated hardware [argon2-16], [tradeoff15], [scrypt17], [bandwidth17]. Data-dependent Argon2d is the right variant for proof of work (side channels do not matter here; Argon2i has weaker tradeoff resistance [argon2i-attack17], [alwenblocki16]). Known risk: CPU-mineable coins attract botnets and cryptojacking [botcoin14], [minesweeper18], [cryptominer19]; the miner signature and the registry (section 8) do not stop that, but the miner lottery (section 9) counts only registered miners.

## 4. GHOSTDAG

For a new block B with parents P (all known):

1. **Selected parent** SP = the parent with the largest `(blueWork, hash)`.
2. **Mergeset** M = past(B) \ past(SP) \ {SP}, found by walking back from the other parents and stopping at blocks in past(SP). If |M| + 1 > 180, B is invalid.
3. **Colouring.** SP is blue. The blocks of M are visited in ascending `(blueWork, hash)`. A candidate C is blue iff (a) at most k blue blocks of B's view are in the anticone of C, and (b) adding C does not give any blue block of B's view more than k blue blocks in its anticone. B's view is scanned along the selected chain, from B's own new blues back through SP, SP's selected parent, and so on, until a chain block that is in the past of C. Each block stores the blue-anticone size of each of its new blues, so the check is local. This is the greedy algorithm of [ghostdag21].
4. `blueScore(B) = blueScore(SP) + |blues of B|` (SP counted); `blueWork(B) = blueWork(SP) + Σ work(blues)`, with work = 2²⁵⁶ / (target + 1); `daaScore(B) = daaScore(SP) + |mergeset(B)|` (every merged block, used only by the difficulty rule).
5. **Ordering.** The mergeset in consensus order is: SP, then the other mergeset blocks in ascending `(blueWork, hash)`. The total order of the DAG is defined recursively along the selected chain.
6. **Merge depth.** A red block in M whose blue score is lower than `blueScore(SP) − 360` makes B invalid, and so does any parent whose blue score is lower than `blueScore(SP) − 360` (a block cannot point far into the past and force long reachability walks). Parents must not be ancestors of each other.
7. **Virtual block.** The node keeps a virtual block whose parents are the DAG tips (the ≤ 10 tips with the largest blueWork). The virtual's selected chain is the **chain**; each chain block accepts its mergeset. Reorganisations of the chain below DAG finality depth (8,640) or below the last committee checkpoint are refused.

Reachability (is X in past(Y)?) uses the fact that blueWork strictly increases along every parent edge: a backward walk from Y is cut at blocks with blueWork below X's.

## 5. Execution (accepting a mergeset)

Every block B, chain or not, commits to the state it would create as a chain block:

1. Start from the accepted state of SP.
2. Visit the mergeset in consensus order. For each block X: for each transaction in X in order:
   - skip it if it was already accepted in the selected chain of B (duplicate), if its nonce is not the sender's next nonce, if the sender cannot pay `gasLimit × maxFee`, if `maxFee < baseFee`, or if the accepted gas of this mergeset would exceed 30,000,000;
   - otherwise execute it in the EVM. EVM context: `block.number` = **chain height** of B (number of selected-chain ancestors, genesis = 0; contiguous, so wallets and tools see an ordinary increasing block number), `block.timestamp` = timestamp of B, `block.coinbase` = miner of X, `block.basefee` = baseFee of B, `block.prevrandao` = hash of SP.
   - Skipped transactions pay nothing and change nothing; they stay in the DAG and are reported by the explorer as "skipped" (Conflux-style handling of conflicting transactions [conflux20]).
3. Pay rewards (section 7) for each blue block of the mergeset, credit fees, run the system calls (section 10). Finality certificates carried by mergeset blocks are recorded if they are valid against this state; others are ignored (they cost their block nothing but space).
4. The result is B's `stateRoot`, `receiptsRoot`, `acceptedTxRoot` (hashes of accepted transactions in order) and `gasUsed`.

A block whose commitments do not match the node's own execution is invalid. The node keeps per-chain-block state undo records down to the DAG finality depth, so a chain reorganisation rolls back and re-applies.

**Transaction types:** legacy with EIP-155 signatures and EIP-1559 (type 2) transactions, chain ID as in section 1.

## 6. Mining and templates

`psy_getBlockTemplate(minerAddress)` returns a template with parents = the virtual's parents, the GHOSTDAG values, the commitments of executing the mergeset, mempool transactions (by tip, within the block gas limit) and the target. The separate miner application (`miner/`) searches nonces, signs each attempt with the miner key, and submits with `psy_submitBlock`. Templates are refreshed when a new tip arrives.

*Template ids.* A template's id is the first 16 bytes of keccak256 of its signing bytes. Those cover every header field, including the miner address, and through `txRoot` the transactions and certificates, so two different templates never share an id, and two miners asking the same node in the same second get distinct templates. Test: `node/test/template.test.js`.

## 7. Supply, emission and fees

### 7.1 Allocation of the 1,000,000,000 PSY

| Pool | Share | PSY | How it enters circulation |
|---|---|---|---|
| Mining | 36 % | 360,000,000 | block subsidy to the miner of each blue block |
| NGO | 36 % | 360,000,000 | the same amount per blue block, minted to the `NGORewards` contract and shared equally by elected NGOs |
| Development team | 12 % | 120,000,000 | genesis balances of three immutable `DevVesting` contracts, 40,000,000 PSY each, one per team member (Dev Accounts 1 to 3, section 8.6): 12-month cliff, then linear to month 48; no admin function, no voting power while unvested |
| Community/Treasury | 16 % | 160,000,000 | genesis balance of the `Treasury` contract, spent only by governance; role compensation is paid from it |

No address receives PSY at genesis. There is no airdrop: participants obtain PSY by mining (locked rule).

### 7.2 Decaying schedule (identical for mining and NGO pools)

`subsidy(blueScore) = R(s)`, where `s = floor(blueScore / 262,980)` (one step ≈ 30.4 days at 10 s) and `R(s) = R0 · 2^(−s/48)`, so the reward halves every 48 steps (≈ 4 years) and decays smoothly each month instead of in abrupt halvings. R0 is set so that the infinite sum equals 360,000,000 PSY; the last wei is enforced by the cap: a pool never mints more than its remaining amount. A long, slowly decaying subsidy keeps miner revenue from depending on fees alone, which is unstable [carlsten16]; the security budget and its limits are discussed in [budish], [pagnotta22], [huberman21].

### 7.3 Emission cap in the first 12 months (locked: "emission capped")

While the past median time is less than 365 days after genesis, the mining subsidy minted so far may not exceed the schedule of an ideal chain at exactly 10 s per blue block for the elapsed time, plus 16 blocks for the lag of the past median time behind the newest block. Blocks beyond that allowance get a reduced or zero subsidy. The NGO pool follows the same cap. This stops a hash-rate surge (or a difficulty lag) from front-loading emission.

### 7.4 Fees

The base fee is burned. The priority fee of an accepted transaction goes to the miner of the block that contained it if that block is blue; if it is red, to the miner of the chain block that accepted it (red blocks earn no subsidy, so including transactions in red blocks earns nothing extra [inclusive15]).

## 8. Participants and process order

The process order is locked: **mine PSY → publish off-chain dossier and mint details on-chain → attestation → election → finality checkpoint activation.**

### 8.1 Miners
- Anyone can mine with any address. Registering in `MinerRegistry` is needed to vouch for NGOs (8.3) and to be drawn for the committee (9).
- The node records, through a system call, how many blue blocks each miner address produced (per epoch and in total).

### 8.2 NGOs and their miner wallet
- Exactly **100 NGO seats**, **1-year terms**.
- **One wallet per NGO, and it is the miner wallet.** The NGO registers its miner address (which must have mined at least one blue block, which is how it obtains PSY for the fees) and mints its NGO record from that same address: name, country, legal registration reference, dossier URI and dossier hash (the dossier itself is published off-chain). Minting costs 100 PSY, burned. Attestation, the election and NGO votes all use the same address. An address can be an NGO only once.
- **Wallet loss is permanent.** There is no recovery or reassignment function anywhere. An NGO that loses its key must restart the full process with a new wallet (mine, mint, attestation, election). Wallet tools and pages say this before every NGO action, as user studies recommend [mai20], [eskandari15], [voskobojnikov21].
- NGOs cannot hold operational roles (8.5). People who work for NGOs can, with their own individual wallet.

### 8.3 Attestation
Independence and authenticity of an NGO cannot be checked by code, and objective identity schemes need trusted issuers while web-of-trust schemes have no proven Sybil resistance [siddarth20], [sybil02]. Third-party accreditation does raise trust in nonprofits [bekkers03], [gugerty09]. The decision is staked vouching by miners, with a challenge:
- An attestation needs **5 vouches** by registered miners, each of which has mined at least 100 blue blocks and is not the NGO's own miner. Each vouch locks 1,000 PSY until the end of the NGO's term.
- A voucher must have blue blocks in at least **4 distinct 7-day epochs** (`vouchMinEpochs`, governable 1 to 52), so voucher wallets cannot be created in a burst (RISK_REVIEW.md 3.7).
- The five vouchers of one NGO must declare **five different operators** (P3).
- A miner backs at most **10 NGOs at a time** (`maxActiveVouches`, governable 1 to 100): a vouch stays active until its bond is returned one term later or burned. Without the cap, five wallets with 100 blue blocks each could attest any number of NGOs run by one party [platt23]; with it, attesting m NGOs needs m/2 voucher wallets, each with 100 blue blocks and 10,000 PSY at risk (RISK_REVIEW.md Part 3).
- After the fifth vouch a **7-day challenge window** starts. Anyone can challenge by locking 1,000 PSY with a reason hash.
- A challenge is decided by a vote of the elected NGOs (one NGO, one vote, simple majority of those voting, minimum 5 votes, closed at least 5 days after the challenge; a tie dismisses). While too few NGOs are elected to reach 5 votes, it is decided by a token vote (an Ordinary proposal calling `Attestation.governorDecide`) under the rules of section 11.
- Payments to challengers and vouchers that refuse PSY (a contract that reverts) are recorded as owed and withdrawn later, so nobody can block a decision. If the challenge is upheld, the vouchers' locks are burned and the NGO is rejected; if not, the challenger's lock is split among the vouchers.

### 8.4 Election
- **Voters:** PSY locked in `VoteEscrow`. A ballot weighs min(locked at the block before the round opened, locked at the block before the ballot), so PSY locked after the round opened (bought or borrowed for the vote, including flash loans [qin21]) adds nothing, and the order in which ballots land in the DAG cannot change a result [valentini26]. Exception: the main round of term 1 opens at genesis, when nobody can hold PSY (no airdrop); there the ballot-time weight counts, and the lock is held until the round closes. Two further limits apply to every round (owner decision, 11 October 2026): the weight is at most the voter's **average locked PSY over the last 259,200 chain blocks** (~30 days), so recently locked PSY counts in proportion to its age; and one ballot weighs at most **1 % of the locked PSY** (`maxBallotWeightBps`, at the snapshot; in term 1's main round, at the ballot). The cap is per wallet and can be avoided by splitting PSY over wallets. Role holders cannot vote.
- **Method:** approval voting over attested candidates (a ballot lists them in increasing address order; at most 250 candidates per round); the 100 candidates with the most approval weight (> 0) win, ties to the earlier attestation, then the lower address. (Proportional rules such as PAV satisfy stronger representation axioms [aziz17], [pjr17], but cannot be tallied on-chain for an unbounded electorate; this limit is documented.)
- **Calendar:** the first election closes 3 months after genesis. Then elections are held every year; seats left empty are filled by monthly supplementary elections for the rest of the term.
- Elected NGOs receive equal shares of the NGO emission and become eligible for committee NGO seats.
- **First election:** a candidate also needs approvals from at least **5 distinct voters** who each have at least 100 PSY locked at the ballot (`firstElectionMinVoters`, `minCountedVoterLock`).
- **Term limit:** an NGO that held a seat in both of the two previous terms cannot stand or be elected; it may stand again after one full term without a seat. A supplementary seat counts as a term.
- **Removal:** an elected NGO can be removed for the rest of its term by a Removal proposal (section 11): it loses its seat, its unclaimed NGO rewards of the term (returned to the pool) and its attestation (status rejected, so it cannot stand again). Its record and dossier stay public. The seat is filled by the next supplementary election. A removal can take the network below 60 elected NGOs, and then the Interim rules apply (8.7). A removed NGO that sits on the current committee serves to the end of the epoch and is not drawn again.

### 8.5 Operational roles
- Five roles: **CEO, CTO, Treasurer, Community Lead, Security Lead**. Only individuals: an address that is an NGO, a registered NGO miner, or a vouching miner of a current NGO cannot be a candidate.
- Candidacy is open to any other address and requires a 100 PSY deposit, refunded after the election.
- **Elected by the elected NGOs**, one NGO one vote, for 1-year terms. This mirrors the separation of decision management and decision control [fama83], [jensen76].
- **Role holders cannot vote while in office**: their votes are refused by `VoteEscrow`, the `Governor`, the election and the role election.
- **Compensation** is paid in PSY by the `Treasury` (Community/Treasury allocation) as a linear stream, at a rate set by governance (default 2,000 PSY per 30 days per role). It is **never** paid from the volunteer fund: the BNB contract refuses any transfer to a current role holder (section 12). A holder that refuses the payment (a contract) is credited instead, so it cannot block its successor's election.
- At most 200 candidates per role round; the round opens at most 28 days before the term ends (14 days of candidacy, 14 days of voting).
- **Result:** the eligible candidate with the most votes wins. If the top count is zero, the role stays vacant and the round can be run again. Candidates may withdraw before the result.
- **Ties** are decided by a verifiable random draw among the tied candidates only:
  - the tie is recorded by the system call at the first chain block after voting closes (height `t`);
  - the seed is `keccak256(abi.encode(hash of the first finalised checkpoint at or after height t + 30, round ID, role))`;
  - the candidates are sorted by address, and the winner is `tied[seed mod count]`;
  - tied candidates who withdrew or became ineligible are removed first: if one remains it wins without a draw, and if none remain the role stays vacant;
  - if that checkpoint is not finalised within 8,640 blocks, the seed falls back once to the hash of the chain block 30 blocks later;
  - the draw runs once: anyone may run it, and the node runs it in the first block where the seed exists.

  The `RoleDrawn` event carries the round, the role, the tied candidates, their votes, the seed source, the source hash, the seed and the winner. The bias analysis is in `docs/SECURITY.md`, section 1.
- Powers are operational only. The Treasurer is one signer of the volunteer fund multi-sig. The Security Lead can cancel a queued volunteer-fund transfer during its timelock. No role can change parameters or move Treasury funds without a governance vote.

### 8.6 Development team
**Owner decisions of 15 October 2026 (section 17): powers only until 60 NGOs are first elected (one-way handover) or 12 months have passed, then emergency pause only. No Treasury access. The 12 % is immutable and never paused.** The team's 12 % sits in three `DevVesting` contracts (immutable), one per team member, 40,000,000 PSY each (owner decision, 12 October 2026: the team has three people, and each should have an account of their own with an equal share):

| | Vesting contract | Beneficiary |
|---|---|---|
| Dev Account 1 | `0x7070000000000000000000000000000000000009` | `0x4774424a774a833b73c3ea055ad953babf10a7a3` |
| Dev Account 2 | `0x707000000000000000000000000000000000000f` | `0x2ddfaa87f811515e5dc0a0fc3da958308cf64685` |
| Dev Account 3 | `0x7070000000000000000000000000000000000010` | `0xb14974d7d9b63d525112dbc1988e8d779454a383` |

Each contract pays only its own beneficiary, which can never be changed. The three keys were generated on the server with the wallet tool (`psyrob-wallet new`, a cryptographically secure random secp256k1 key written to a 0600 file, only the address printed) at the owner's choice. The owner hands each file to its member and then destroys all three files; no copy is kept, so a lost key cannot be recovered, and its PSY stays locked in that contract for good. The alternative (each member creating the key in their own wallet and sending only the address) was offered and not chosen.

 No contract has an owner or admin key. Code changes go through `UpgradeRegistry` (section 17.3) and pauses through `EmergencyPause` (section 17.4); the DevVesting contracts are never replaced or paused. Team members may participate as individuals like anyone else.

### 8.7 Modes and the Interim Council fallback
`GovernanceMode` computes the mode from the number of elected NGOs and the time since genesis:
- **Bootstrap** (first 3 months): mining, transfers, contracts, NGO minting, attestation and the first election run. No fund decisions, no role elections, no finality checkpoints.
- **Normal** (at least 60 elected NGOs): everything is active, including finality checkpoints, role elections, Treasury spending and volunteer-fund decisions.
- **Interim** (after 3 months with fewer than 60 elected NGOs): only mining and basic functions continue (transfers, contracts, NGO minting, attestation, the monthly supplementary elections, Ordinary proposals). The **Interim Council** is the set of NGOs elected so far. Its only power is to decide attestation challenges. It cannot spend, change parameters, hold role elections or activate finality. Once 60 NGOs are elected, the mode returns to Normal.

## 9. Finality committee

- **21 members** per epoch (7 days), **quorum 15** (more than two thirds, the classical Byzantine bound [lamport82], [pbft99], [dls88]).
- **Composition:** 6 NGO seats (6/21 < 1/3, locked rule "NGO < 1/3") and 15 miner seats.
- **Weight cap 1/7:** every seat has weight 1/21; no operator may hold more than 3 seats (3/21 = 1/7). An NGO's miner address cannot also take a miner seat. The cap is per address and per declared operator; it cannot detect one person behind many addresses, which is the general Sybil limit [sybil02].
- **Selection and rotation:**
  - NGO seats are drawn uniformly from elected NGOs that posted the committee bond.
  - Miner seats are drawn from bonded registered miners, with probability proportional to the blue blocks each mined in the previous 4 epochs (capped at 5 % of those epochs' blocks). Four epochs, so hash power rented for one week buys a quarter of the weight.
  - Members of the previous committee are skipped while enough other candidates exist (rotation).
- **Draw: freeze, seed, seal.**
  1. At the start of an epoch, once 6 NGO and 15 miner candidates exist (or 15 in total a day into the epoch, of which at least 4 NGOs), the candidates, weights and operator labels are frozen. Without 4 NGO candidates there is no committee, so miners alone can never finalise.
  2. The seed is then produced by the committee's **randomness beacon** (commit-reveal): a beacon round opens at the freeze, and for 60 chain blocks the members of the committee then signing reveal the next layer of the hash onion they committed to (`commitBeacon`, `revealBeacon`). The seed is the mix of the reveals, so no miner can influence it; a member that committed and stays silent forfeits that epoch's committee reward. If nobody reveals, the seed is the hash of the first finalised checkpoint at or after 30 blocks later, mixed with the epoch. The first committee uses the hash of the chain block 30 blocks after the freeze, because no committee or checkpoint exists yet. If the checkpoint is not finalised within 2,880 blocks, the seed falls back once to a chain block 30 blocks later. Remaining bias: `docs/SECURITY.md` section 3 [randhound17], [vdf18].
  3. The committee is sealed in the first block where the seed exists.

  Until then, the previous committee keeps signing checkpoints (`signerEpoch(timestamp, height)`). Bias analysis: `docs/SECURITY.md`, sections 1 and 2 [randao], [algorand17].
- **Candidates:** at most 1,000 bonded miner candidates at a time (bounds the gas of the weekly draw). The freeze check uses running totals and scans the candidates at most once per 30 blocks.
- **Bond and slashing:** committee bond 10,000 PSY. Signing two different checkpoints for the same checkpoint number is equivocation; anyone can submit both signatures to `FinalityCommittee`, which burns 90 % of the bond, pays 10 % to the reporter, and removes the member for the rest of the epoch. A bond can be withdrawn only 14 days after the member asked to leave **and** 14 days after the last committee it sat on was replaced (the evidence window), so equivocation cannot be escaped by leaving first. Missing signatures are not slashed (liveness faults are ambiguous and slashing them punishes honest members on bad networks [budish], [forensics21]); members who sign fewer than 50 % of the epoch's checkpoints lose their committee reward for that epoch.
- **Checkpoints:** every 30 chain blocks, members sign `keccak256("PSYROB-checkpoint" ‖ chainId ‖ genesisTime ‖ checkpointNumber ‖ chainBlockHash ‖ stateRoot)` (the genesis time binds a signature to one launch) once the checkpoint is 30 chain blocks deep. A checkpoint with 15 signatures of the epoch's committee, **at least 4 of them from NGO members** (every active NGO member if fewer than 4; owner's decision, so that miners alone can never finalise), is final: no node reorganises below it. If the committee is offline, blocks continue and finality waits (the finalised prefix lags and catches up, the ebb-and-flow property [ebbflow21], [checkpoint], [afgjort20]).
- **Activation:** the committee is drawn from the first epoch in Normal mode (process order). Before that, bootstrap finality applies (9.1).

### 9.1 Bootstrap finality

Owner decisions of 18 and 24 October 2026: finality from the first block, before any committee exists, from keys kept only for this:
- The genesis config names the **bootstrap signers** (`bootstrapSigners`, 1 to 21 addresses) and their **quorum** (`bootstrapQuorum`); both are part of the launch base the three Dev Account holders sign (section 17.1). This network: **three dedicated keys, 2 of 3**. They do not mine and hold no PSY (`deploy/KEYS.sh` makes them; the miner key is refused as one of them). For now all three are on the public server (`/etc/psyrob/bootstrap-1..3.key`, root:psyrob 0640), and the node signs with each (`--signer-key` given three times); moving a key to another machine later needs no change on chain.
- **Majority quorum.** The quorum must be more than half the list (contract and genesis builder refuse anything else). Two majorities of one set always share a member, so two conflicting bootstrap certificates for one checkpoint number would carry two signatures of one key for different blocks: proof of the fault, as quorum intersection does in Byzantine agreement [pbft99, lamport82; abstracts read]. There is still no bond to slash during bootstrap.
- `FinalityCommittee.bootstrapSigners()` returns the list while `bootstrapActive()`: no committee was ever sealed **and** the deadline has not passed. A checkpoint whose chain block has no sealed committee is final with `bootstrapQuorum()` valid signatures of the list. Its certificate carries the epoch `BOOTSTRAP_EPOCH` (2⁴⁸ − 1, which no calendar epoch reaches).
- **Deadline:** `BOOTSTRAP_PERIOD` = 12 months after genesis (the same as the dev council's sunset). After it, only a committee finalises; checkpoints wait until one is sealed.
- **Replacement:** only a DAO vote of the Upgrade kind may call `replaceBootstrap(list, quorum, endsAt)`, while bootstrap is active: a new list, a majority quorum, and an end at most 12 months from the vote and never later than genesis + 24 months. Ordinary proposals cannot target `FinalityCommittee`. The council has no say.
- The node (`consensus.js certSigners`) reads the list and the quorum from the contract for gossiped signatures, certificates and certificates in blocks, so every node accepts the same certificates. A final checkpoint stops reorganisations below it (`_includesFinal`). A node never signs a second, different checkpoint for a number one of its keys signed (`signed-checkpoints.json`, per key); a final checkpoint is never replaced by a second certificate for the same number.
- The **first seal** ends bootstrap for good; from then on only the committee rule (15 signatures, 4 of them NGOs) applies.
- **Risk, accepted by the owner for the testnet:** while all three keys are on one server, whoever controls that server controls finality; the 2-of-3 rule protects against one lost, leaked or doubly-run key, not against the whole server. Separate machines (and holders) are the next step and a mainnet precondition (section 18.5).
- **Committee reward:** 2 % of the mining subsidy of each blue block goes to `FinalityCommittee` and is shared by the members who signed at least 50 % of the epoch's checkpoints and did not stay silent in a beacon round. (This comes out of the mining pool; it is still mining emission.) An epoch is settled (eligible members counted once) only after its committee was replaced and one more day passed, or two epochs later if no successor is sealed; checkpoints recorded for a settled epoch no longer change the shares, and the total paid never exceeds the epoch's pool.

## 10. System calls

At the end of each mergeset acceptance, the node calls (as the zero-gas system sender `0xff…fe`):
- `MinerRegistry.recordBlocks(miners[], counts[])` for the blue blocks of the mergeset;
- `NGORewards.notify(amount)` with the NGO emission;
- `FinalityCommittee.notify(amount)` with the committee share;
- `FinalityCommittee.advance()` and `NGOElection.advance()` (epoch and election clocks);
- after those: `DevCouncil.advance()` (retires the council the first time 60 NGOs are elected, or 12 months after genesis; running it after the election means the block that elects the 60th NGO also retires the council), `UpgradeRegistry.advance()` (node updates whose timelock has passed come into force), then for each contract update due (`nextDue()`, at most 4 per block) the node copies the new code to the target if its hash still matches and the target is not a DevVesting contract or `DevCouncil`, and reports it with `activated(id, ok)`.

System calls cannot fail a block: if one reverts, the revert is recorded in the receipt list and the block remains valid.

## 11. On-chain governance (native chain)

- **Voting power:** PSY locked in `VoteEscrow`. The proposer needs the threshold at the block before the proposal (the snapshot). A ballot weighs min(locked at the snapshot, locked at the block before the ballot): PSY locked after the proposal appeared adds nothing, PSY unlocked since then does not count, and ballot order in the DAG cannot change a result [valentini26], [mosley22]. Role holders have no voting power while in office.
- **Kinds:** Ordinary (any contract except Treasury, Params, FundApprovals, NGOElection, Governor, VoteEscrow, UpgradeRegistry, EmergencyPause, DevCouncil and FinalityCommittee), Treasury, Parameter, Fund, **Removal** (only `NGOElection.remove`, section 8.4), **Upgrade** (only `UpgradeRegistry`, and `FinalityCommittee.replaceBootstrap`; it also needs yes votes from a majority of the NGOs elected when it is decided) and **Emergency** (only `EmergencyPause`; 2 days of voting and no timelock, so a 72-hour pause can be ended or extended in time). While the whole network is paused, only Upgrade and Emergency proposals are executed. Every kind except Ordinary needs Normal mode. An Ordinary proposal that calls `Attestation` (a challenge decided by token vote) uses the 10 % / 100-voter floor (P1). On every voter-count path (50 or 100 voters) a yes voter counts only if its ballot weighs at least 100 PSY (`minCountedVoterLock`), and the voter-count path also needs yes votes of at least 1 % of the locked PSY.
- **Bounded parameter changes:** besides its fixed [min, max] range, a parameter moves at most to double or half its current value per change, and at most once per 30 days, so proposals passed in parallel cannot be chained into a large jump (as Conflux bounds its parameter votes; RISK_REVIEW.md Part 3).
- **Proposal threshold:** 0.5 % of total locked voting power.
- **Quorum (active-participant quorum with floors).** Participation quorums make "no" voters abstain and can flip outcomes [herrera10], [aguiar10]; approval quorums dominate them [maniquet15]. PSYROB therefore counts **yes** weight. A proposal passes if yes > no and **yes ≥ max(50 % of the active-participation baseline, floor)**, where the baseline is the average total turnout of the last 10 decided proposals that reached a turnout of at least 1 % of locked power (so proposals nobody votes on cannot pull it down), and the floor is 5 % of total voting power for ordinary proposals and 10 % for Treasury, parameter, fund and removal proposals. The floor is also met if at least 50 (ordinary) or 100 (Treasury, parameter, fund, removal) distinct addresses voted yes (unique-address minima), so broad participation by small holders is not blocked by concentrated holdings [fritsch24], [feichtinger23], [barbereau23].
- **Voting period** 5 days, then a 48-hour timelock before execution.
- **Volunteer-fund decisions** also require Normal mode and at least 60 elected NGOs at proposal start (locked rule).

## 12. Volunteer fund on BNB Chain (code and tests only; not deployed)

The volunteer fund lives on BNB Chain in `VolunteerFund` (`contracts/src/bnb/VolunteerFund.sol`). A transfer needs all of:
1. **Community vote** on the native chain (section 11), which records the approved transfer (id, token, recipient, amount, BNB chain ID, fund address).
2. **Governance module check:** at least 15 of the 21 current committee members sign the approved transfer message after their node verifies it in native-chain state. `VolunteerFund` verifies these signatures against the committee set it stores; the set is handed over each epoch by a message signed by 15 of the previous committee.
3. **Multi-sig:** 3 of 5 signers (the Treasurer and 4 NGO signers elected by the NGOs) approve on BNB Chain.
4. **Timelock:** 48 hours, or 72 hours for a large transfer (≥ 5 % of the fund's free balance of that token: the balance minus queued transfers, the lower of now and the figure recorded at least 72 hours earlier, so a deposit just before queuing cannot shorten the timelock). During the timelock the Security Lead or any 2 multi-sig signers can cancel. Approvals and cancel votes count only while their signer is still a current signer.
5. **Recipient check:** never a current role holder (the role list is part of the committee-signed handover).

Rationale: cross-chain bridges fail most often through compromised validator keys and missing verification [bridgesok]; three independent factors (committee signatures, multi-sig, timelock with cancel) limit any single compromise, and on-chain wallet contracts have known pitfalls that the tests target [diangelo20], [destefanis18].

## 13. Peer-to-peer network

- TCP, length-prefixed frames with network magic; handshake carries version, chain ID, genesis hash, virtual blue score and listen port.
- **WebSocket transport** (`node/src/ws.js`): the same framed stream is also accepted at `GET /p2p` (Upgrade: websocket, RFC 6455, binary messages only, at most 5 MiB per message) on the HTTP port, so the public node is reachable as `wss://rpc.psyrob.com/p2p` through the Cloudflare tunnel, and seeds may be given as `wss://host/p2p`. Behind the tunnel every connection comes from the local tunnel process; the client address used for bans and per-address limits is the `CF-Connecting-IP` header, trusted only on loopback connections. WebSocket seeds are dialled directly and kept out of the address manager (its entries are TCP addresses); a node that reaches itself through its own seed drops that seed.
- **Peer discovery and connection logic** follows the countermeasures proven against eclipse attacks [eclipse15], [eclipse-defense], [hijack17]:
  - address manager with a "new" table (heard of) and a "tried" table (connected), each bucketed by /16 network group with a deterministic slot per address;
  - random selection from the tables, test-before-evict for the tried table, a feeler connection every 2 minutes, 2 anchor connections kept across restarts;
  - 8 outbound connections (at most 2 in the same /16), up to 64 inbound;
  - addresses learnt from seeds (configuration and a seed list in the repository; DNS seeding is censorship-prone [dnsseed]), from `getaddr`/`addr` messages (at most 1,000 per message, rate-limited) and from incoming connections;
  - misbehaviour scores and temporary bans.
- **Relay:** `inv` announcements and `getdata` for blocks and transactions; checkpoint signatures and certificates are gossiped. Every valid block is announced (not only new tips), because parallel blocks belong to the DAG.
- **Limits:** frames at most 4 MiB; per-peer token buckets per message type; at most 4 inbound connections per address (local addresses exempt); misbehaviour score 100 bans the address for an hour; HELLO must be the first message. Orphan pool: at most 512 orphans and 64 MiB, at most 256 orphans and 16 MiB per peer; when full, the peer holding the most bytes loses its oldest orphan first. Checkpoint and fund signatures are checked cheaply first (recent checkpoints on our chain only, duplicates dropped before any EVM call; committee read once per tip), and a signature from a non-member or a certificate that does not verify costs misbehaviour points. A block refused only because it conflicts with this node's own final checkpoint costs no points.
- **Sync:** a new node asks for the selected chain with a locator, then for the DAG blocks above the common point in topological order; blocks with unknown parents wait in an orphan pool and their parents are requested.
  - *Sync.* The `CHAIN` reply lists every block in parent-first order: each chain block comes after the blocks it merges, in GHOSTDAG's ascending (blue work, hash) order; at most 500 hashes, with exactly 500 meaning "ask again". Orphan-parent requests skip parents held in the DAG or the orphan pool. Only unsolicited blocks are rate-limited (with the proof-of-work budget); a block the node asked a peer for counts as solicited from that peer however long it takes to arrive. Announcements are gathered per peer for 50 ms into one `inv` (up to 500 items). A request stays due for 20 s, or longer while that peer still has received messages waiting to be checked, because a 500-block batch at 32 MiB Argon2d each can take longer than 20 s on a home PC. The next batch is asked for once no request to that peer is still due. A stall check every 5 s asks the best peer again if it is ahead and no block was added for 15 s. Test: `node/test/syncburst.test.js` (721 blocks with parallel pairs).
  - *Logging and back-off.* Nodes log outbound attempts, handshakes (user agent, blue score), closes (duration, bytes), bans (with the reason) and, on the seed, refusals of a banned address (once per 10 minutes per address). A WebSocket seed that closes before the handshake is retried after 5 s, doubling to at most 5 minutes, instead of every 5 s. A banned client cannot see the ban, so its log says the seed is unreachable or refusing the address. These are fixes to the rules already in this section, not new design decisions, so no new sources were consulted.

## 14. RPC

Ethereum JSON-RPC as wallets and tools need it (`eth_chainId`, `eth_blockNumber`, `eth_getBalance`, `eth_getTransactionCount`, `eth_getCode`, `eth_getStorageAt`, `eth_call`, `eth_estimateGas`, `eth_gasPrice`, `eth_maxPriorityFeePerGas`, `eth_feeHistory`, `eth_sendRawTransaction`, `eth_getTransactionByHash`, `eth_getTransactionReceipt`, `eth_getBlockByNumber`, `eth_getBlockByHash`, `eth_getLogs`, `net_version`, `web3_clientVersion`). Ethereum block numbers are **chain heights**: block n is the chain block at height n, and its transactions are the ones it accepted.

PSYROB methods: `psy_dagInfo`, `psy_getDagBlock`, `psy_tips`, `psy_getBlockTemplate`, `psy_submitBlock`, `psy_peers`, `psy_addrman`, `psy_finality`, `psy_fundSignatures`, `psy_supply`, `psy_mode`, `psy_metrics` (mining and holdings concentration, section 15). Historical state is not kept: state reads answer for the latest chain block. Limits per client: 200 calls burst, 50 per second; heavy methods (`eth_call`, `eth_estimateGas`, `eth_getLogs`, `psy_getBlockTemplate`) 20 burst, 5 per second; `eth_getLogs` at most 10,000 blocks.

## 15. Explorer and pages

Served by the node (`/`). The **animated spider-web home page** shows the DAG: parallel blocks appear as **strands of the same web**: each block is a knot, parent links are threads, chain blocks lie on the main strand, red blocks are drawn muted, and transfers keep animating across the web. Pages: home; DAG; block; transaction; address; NGOs (list, detail, **submission and minting**); **attestation** (vouch, challenge, decide); **election** (candidates, approve, results); **governance** (proposals, **voting**); **roles** (candidacy, role election, holders, compensation); **treasury** (Treasury balance and streams, DevVesting, NGO rewards, volunteer fund status); **finality committee**; emission; network (peers, chain ID warning); **decentralisation metrics** (`/metrics`, also `/api/metrics`): blue blocks per miner over the last day and PSY per ordinary address, each as top-1 and top-5 shares, Nakamoto coefficient, HHI and Gini; locked PSY, proposal turnout, NGO ballots and committee signing rate [axelsen22], [gencer18]. **Registration** (section 18.3): `/register/miner` and `/register/ngo`, written for people who have never used a block explorer. Writing pages use the browser wallet (EIP-1193) on chain 87870 and show the permanent-loss warning before NGO actions.

**Public explorer.**
- `explorer.psyrob.com` serves the explorer, and browsers that open `rpc.psyrob.com` are redirected to it. `/health`, `/api/*`, JSON-RPC (POST) and `/p2p` stay on the RPC name.
- Every page has four menus: Explorer, Governance, Network and Developers. It also carries a testnet banner ("Test network. No presale. Wallet loss is permanent."), plus an Interim banner while the network is in Interim mode.
- Read-only pages:
  - all proposals (`/proposals`, `/proposal/:id`: decoded actions, voters, the floor in use, timelock);
  - all election rounds (`/election-rounds`, `/election-round/:id`: approver counts against the first-election minimum, ballots);
  - My account (`/account`: an address only; nothing is signed);
  - mining statistics (`/mining`, `/api/mining`), pending transactions (`/mempool`) and top holders (`/holders`);
  - committee epochs (`/committee/:epoch`);
  - developer documentation (`/developers`) and contract read views (`/contracts`, `/contract/:name`, using `eth_call` only);
  - `/run-a-node` with Windows and Linux tabs;
  - on `/ngo/:addr`: term-limit status, removals and challenges.
- The data comes from a small incremental event index (`node/src/eventindex.js`): each chain block is read once, and no request scans the whole chain.
- Lists are paginated with fixed page sizes and caps.
- Bootstrap and the two fonts are self-hosted under `/vendor`, and the Content-Security-Policy allows only this origin.
- The front-page radar plots eight network figures (pace, blue share, miner spread, gas use, burn, locked PSY, NGO seats, finality signing).
- Governance (section 17): `/launch` (pre-launch mode only: the launch ceremony), `/upgrades` (dev council seats and keys, council actions, update plans and their timelocks, the required node version, how to check an update, the forms to submit and approve), `/pause` (what is paused, committee requests, history, the forms to ask for a pause). While anything is paused, every page shows a red banner with the target, who paused it, until when and the reason hash.

**Rewards are not transactions (15 October 2026, owner decision).** Block rewards, the committee and NGO pool shares and priority fees are credited by the node when a chain block accepts its mergeset (sections 5 and 7). They have no sender, signature, nonce or hash, and the RPC does not return them, so `/txs` lists signed transactions only. The node keeps, per chain block and outside consensus, the subsidy of each merged blue block and the fees per merged block and recipient (`paid`, recomputed when the blocks are replayed at start). The explorer shows them:
- on `/block/:ref`: who paid this block's own reward (the chain block that merged it blue, or none if it was merged red), and for a chain block every credit it made;
- on `/address/:addr`: the rewards credited to the address in the last 5,000 chain blocks, below its transactions;
- on `/ngos`: the NGO pool (balance, received, paid out, waiting), its latest income and the latest claims; on `/ngo/:addr`: that NGO's claims and forfeits;
- on `/tx/:hash`: PSY moved inside the transaction by an NGO pool claim (the transaction itself has value 0).

The same split is used by Ethereum explorers, which list block rewards, internal transfers and withdrawals apart from transactions; in Bitcoin the coinbase is listed as a transaction because it is one.

## 16. Contracts (created at genesis, no owner; replaceable only through UpgradeRegistry)

| Contract | Purpose |
|---|---|
| `MinerRegistry` | miner registration, blue-block counts (system call) |
| `NGORegistry` | NGO mint from the miner wallet, status, dossier |
| `Attestation` | vouches, challenges, decisions |
| `VoteEscrow` | locked PSY voting power with snapshots; refuses role holders |
| `NGOElection` | annual and supplementary approval elections of 100 NGOs |
| `RoleElection` | candidacy and NGO-elected roles; compensation streams |
| `Governor` | proposals, quorum rule, timelock, execution |
| `Treasury` | Community/Treasury allocation; spends only through `Governor` |
| `DevVesting` (three instances: Dev Accounts 1, 2 and 3) | 12 % team allocation, 4 % each, immutable vesting |
| `NGORewards` | equal sharing of the NGO emission among elected NGOs |
| `FinalityCommittee` | bonds, draw, rotation, checkpoint record, slashing, rewards |
| `GovernanceMode` | Bootstrap, Normal, Interim |
| `FundApprovals` | record of approved volunteer-fund transfers (read by committee nodes) |
| `DevCouncil` | the three Dev Account seats, their council keys, 2-of-3 actions, handover at the 60th NGO |
| `UpgradeRegistry` | contract and node update plans: submit, approve, timelock, activation |
| `EmergencyPause` | network and contract pauses, committee requests, limits |
| BNB: `VolunteerFund` | committee check, multi-sig, timelock, cancel, recipient rule |

Every contract that pays an address chosen by others uses a 50,000-gas stipend and falls back to an `owed` balance withdrawn with `withdrawOwed()`.

## 17. Dev council, upgrades and emergency pause

Owner decisions of 15 October 2026: before the network starts the three Dev Account holders sign their roles; until the NGOs form the DAO the devs can update the system; the 12 % can never be changed, blocked or stopped; when the DAO forms it takes over all signing powers, and the devs keep only an emergency pause. Contracts: `DevCouncil` (`0x7070…0011`), `UpgradeRegistry` (`0x7070…0012`), `EmergencyPause` (`0x7070…0013`).

### 17.1 Launch ceremony
- The node runs in pre-launch mode (`psyrob-node --prelaunch genesis/launch-87870.json`): no chain, only `/launch`.
- Each Dev Account holder connects the Dev Account wallet, names a **separate council key** (not any Dev Account wallet, not another seat's key) and signs with `personal_sign` a message naming the chain ID, the hash of the genesis base (chain ID, starting target, the three Dev Accounts, the extra text, the bootstrap finality keys and their quorum, and the hash of all contract code in `genesis/artifacts.json`), the seat and the council key. The start time is not signed; it is set when the genesis is built.
- The node checks each signature against the seat's fixed Dev Account address and saves it (`<datadir>/launch.json`). With all three, `genesis/build.js --launch` builds the genesis: `DevCouncil` is created with the three Dev Accounts and their council keys.
- Every node checks the three signatures when it loads the genesis; on the public chain ID 87870 a genesis without them is refused.

### 17.2 Dev council
- **Seats:** the three Dev Account holders, acting with their council keys. An action needs **2 of 3** keys; a proposal not approved within 3 days expires.
- **Until the first time 60 NGOs are elected, and for 12 months after genesis at most:** approve or cancel **node updates** (17.3); change **`committeeBond` and `candidacyDeposit`** (48-hour timelock, within the bounds and step limits of Params); **pause and end pauses** (17.4).
- **Never:** the Treasury, balances or minting, the DevVesting contracts, the NGO election and its rules (the other parameters, NGORegistry, MinerRegistry, Attestation, VoteEscrow), the handover rule, contract updates.
- **Handover:** the system call `DevCouncil.advance()` retires the council in the block in which `NGOElection.electedCount()` first reaches 60, or 12 months after genesis, whichever comes first. With few NGOs at that point the council keeps only the emergency pause, and node updates need the DAO. One-way: a later drop below 60 changes nothing. Queued parameter changes die; node updates the council approved that are not yet in force wait at least 14 days after the handover, so the DAO can cancel them.
- **After the handover:** only the emergency pause, at most one start every 7 days, none for 30 days after the DAO ended a council pause early.
- **Key replacement:** the seat's Dev Account wallet names a new council key; it takes effect after 48 hours unless both other seats cancel it. A thief with only the council key cannot replace it; a thief with only the Dev Account wallet can be stopped by the other seats.

### 17.3 Upgrades
- **Path:** submit (anyone) → approve → timelock → in force. The `/upgrades` page lists every plan and its state.
- **Contract update:** the new code is deployed as an ordinary contract; the plan names the system contract to replace and records the new code's hash. In the first block after the timelock the node copies the code (the address, balance and storage stay) if the hash still matches. The new code must keep the storage layout, and its constructor values (immutables) are those it was deployed with. Approved only by the DAO (Upgrade proposal); timelock 7 days. Never: the DevVesting contracts and `DevCouncil`; the node refuses them too, whatever the registry says.
- **Node update:** the plan records the version, the git commit and the SHA-256 of `SHA256SUMS.txt`. When the timelock has passed, `requiredVersion` rises; a node older than that refuses every block after the one that brought the version into force ("upgrade required") and stops making templates, instead of following a chain whose rules it does not know (the halt-at-height model of the Cosmos SDK upgrade module). New consensus rules of a release start from that block. Approved by the council (7 days) until the handover, then by the DAO (14 days). A council-approved plan may only take the next patch or minor version above max(requiredVersion, 10.0.0), and every node plan names its commit and release hash when it is submitted.
- **Checking:** contract code by compiling the plan's commit and comparing the code hash; releases by `sha256sum SHA256SUMS.txt` and `sha256sum -c`. The release build is reproducible, which this check needs to mean something [lamb22] (section 18.4). The design follows the principles of [samuel10] (threshold keys, replaceable authority, survivable key compromise) and [nikitin17] (accept only releases that are publicly logged and independently rebuilt; the chain is the log).

### 17.4 Emergency pause
- **Kinds:** one system contract (its user entry points revert; system calls and calls from the Governor pass), or the **whole network** (the node refuses every transaction except governance (Governor), the council, upgrades, the pause, finality beacon and equivocation transactions, and `DevVesting.release`, all with value 0).
- **Keeps running:** mining, rewards, system calls, finality, votes, upgrades, the handover and the 12 % vesting. `release()` still pays the Dev Account wallets, which cannot send PSY on until the pause ends: nobody transfers during a network pause.
- **Who:** the council (2 of 3 keys; it ends only pauses it started); after the handover also the **finality committee**: 14 of the members seated when the request opened, at least 4 of them NGOs, each calling `committeeVote(target, reason)` within 6 hours (a member opens at most 3 requests per 6 hours).
- **How long:** 72 hours at most, then it lifts by itself. Only the DAO (Emergency proposal) can pause for longer (up to 30 days at a time) or end a pause early after the handover.
- **Limits:** before the handover the council may renew its pauses and add targets for at most **7 days in a row**, then it cannot pause for 7 days; after the handover one start every 7 days and the 30-day lockout (17.2). The committee cannot pause the same target again within 7 days.
- **Never paused:** the DevVesting contracts, the Governor, `DevCouncil`, `UpgradeRegistry`, `GovernanceMode`, `Params` and `EmergencyPause`.
- The pause is a short, bounded brake with a public reason hash and a red banner on every explorer page. A study of 183 DeFi incidents found that 87 of the victims had a pause, 51 used it within 48 hours and one within the first hour [zhou23], which is why a small group can press it at once while only the DAO can make it last.

Sources for section 17: [samuel10] J. Samuel, N. Mathewson, J. Cappos, R. Dingledine, "Survivable key compromise in software update systems", ACM CCS 2010 (abstract and front matter read); [nikitin17] K. Nikitin et al., "CHAINIAC: Proactive software-update transparency via collectively signed skipchains and verified builds", USENIX Security 2017 (abstract and summary read); [lamb22] C. Lamb, S. Zacchiroli, "Reproducible builds: increasing the integrity of software supply chains", IEEE Software 39(2), 2022 (abstract read); [zhou23] L. Zhou et al., "SoK: Decentralized Finance (DeFi) attacks", IEEE S&P 2023 (abstract and summary read). The Cosmos SDK upgrade module and the Tezos amendment process are documentation of working systems, used as practice references, not as peer-reviewed sources.

## 18. Safety rules

These rules protect the state, the node, governance and the releases. Each has a regression test (`node/test/state.test.js`, `limits.test.js`, `stale-tip.test.js`, `bootstrap-quorum.test.js`, `miner.test.js`, `minergui.test.js`, `contracts/test/Rules.t.sol`, `Bootstrap.t.sol`, `Hardening.t.sol`). Where a rule needed a design choice, the choice and its reason are given.

### 18.1 State and blocks
- A block whose selected parent is deeper than the finality depth, or whose state can no longer be reached, is refused before any state change (no penalty for the sender). `moveTo` checks the whole path for undo/redo records before changing anything.
- Transactions that the old chain accepted and a reorganisation drops go back into the mempool, checked against the new tip; the transaction index drops them.
- Block templates leave out parents that validation would refuse (every parent and red mergeset block within the merge depth of the selected parent [ghostdag21; full text], the mergeset within its limit), so a stale tip (for example a block mined on an early chain while a node synced) never stops mining. A node does not hand out templates while it is still catching up (its tip is more than 10 minutes old and a peer ahead is still delivering blocks); a halted network can always restart.
- Blocks far below the finality depth (never re-executed) move their bulky data (raw bytes, transactions, receipts, payments, the full header) to a cold file (`cold.dat`, rebuilt at every start) and keep about 0.4 kB in memory instead of about 5.3 kB; reads come back from disk through a small cache.
- Consensus arithmetic is integer-only (the emission step by integer division; range checks before converting epochs and counts), and every consensus sort is a total order (DAG sorts by blue work then hash; the median time sorts plain integers), as deterministic ordering requires [ghostdag21].

### 18.2 Mempool, RPC and peers
- **Pending and queued:** a transaction behind a nonce gap is queued: at most 16 per sender and 1,024 in total, expired after 3 hours, never relayed or selected, and evicted first when the pool is full. A pending transaction replaces only a cheaper last-in-line transaction of another sender. Counts are kept per sender, not recomputed. (The split follows go-ethereum's pool; engineering practice, not a research decision.)
- **Limits:** every list method has range and result limits (`docs/RPC-LIMITS.md`); `psy_getDagRange` takes only safe integers and never walks past the highest blue score. Rate limits key IPv6 clients by /64, evict least recently used entries, and have a ceiling for all clients together.
- **Block submission:** at most 4 solutions per template, dropped once one is added; the 32 MiB proof of work and the signature are checked before the chain lock; each miner address has its own small budget, miners that had a block added through the node in the last day have a budget of their own, and everyone else shares one. Transaction signatures are checked before the lock too. Peer blocks are proof-of-work checked in a worker thread, in order, so the node keeps answering.
- **Start and sync:** while it replays its stored blocks the node serves a stand-in page and `/health` (503, `"starting": true`, progress); `/health` and `eth_syncing` report a sync. The watchdog leaves a starting node alone.
- **Address manager:** bucketed new and tried tables, source-group limits and a per-node secret key [eclipse15; countermeasures section read in full].

### 18.3 Governance
- The finality committee is drawn only with at least 4 NGO candidates, so miners alone never finalise.
- `GovernanceMode` remembers that Normal mode was reached; only 30 days in a row below 60 NGOs make the network Interim. A removal may not take the count below 60.
- A challenge nobody decides within 14 days lapses: the challenger gets the bond back and the NGO can be finalised. The token vote can still decide within the 14 days and revoke later. A dismissed challenger cannot challenge the same NGO again. (Design choice: a fixed committee deciding challenges would give the council powers over attestation that section 17.2 rules out.)
- The voter-count path of a proposal also needs yes votes of at least 1 % of the locked PSY.
- The NGO pot collected before the first election is streamed over one term (365 days) from the first election, shared each block by the NGOs then elected.
- BNB fund (code and tests only): transfers and handovers need 4 NGO signatures among the 15; handovers are numbered, name the PSYROB block they were checked against, wait 48 hours and can be cancelled by the Security Lead or 2 signers.
- **NGO names** (`/register/ngo`, `MinerRegistry.registerNgoMiner`): ASCII letters, digits, space and `. , & ' ( ) -` only, no double space, starting with a letter or digit and ending with a letter, digit, `)`, `.` or `'`; compared by letters and digits only, case-folded, 0 read as o and 1 as l, so look-alikes share one name. A name is shown as unverified until the NGO's record is attested (`ngoNameVerified`); anyone can release the name of a rejected NGO.
- **Registration pages:** `/register/miner` and `/register/ngo` let a person register by following the page alone (the owner's texts).

### 18.4 Miner and releases
- **Miner:** every template is re-encoded from its fields and compared with the node's signing bytes, must name the miner's wallet and carry the network's proof-of-work settings before anything is signed; all threads keep hashing while a solution is submitted; a submission that fails for a passing reason is retried for up to 30 seconds; an ordered list of nodes with failover, each checked for chain ID and genesis; a syncing node is waited out. The control page stores the key encrypted with a password (scrypt, AES-256-GCM).
- **Releases:** not obfuscated or minified; reproducible archives (every file time is the commit time, entries sorted, owners zeroed, gzip without timestamp, `SOURCE_DATE_EPOCH` for the .deb) [lamb22]; `SHA256SUMS.txt` signed with an Ed25519 release key whose public part is `docs/RELEASE-KEY.pem`; `scripts/verify-release.mjs` checks the signature, the files and, with `--rebuilt`, one's own build [nikitin17]. The Windows .exe has no Authenticode signature.
- Every version label on pages and in downloads comes from `NODE_VERSION`.

### 18.5 Before a mainnet
A chain ID of its own; bootstrap finality keys on separate machines held by separate people, or no bootstrap; an independent third-party audit; reproducible builds checked by someone other than the builder; a decision on the Windows code signature.

## 19. Known limits (documented, not hidden)

- Approval voting with token weight is not proportional and favours large holders (section 8.4).
- One-address seat caps cannot detect a single operator with many addresses. The same holds for the voucher cap (8.3) and for the published metrics, which count addresses, not operators.
- A party with a large share of the hash rate can still place and elect several NGOs in the first election; the measures make this slower, visible and costlier (RISK_REVIEW.md 3.7).
- Committee randomness can be biased slightly by a miner willing to withhold a block.
- The volunteer fund is not deployed; its addresses and signers are set at deployment.
- CPU mining attracts botnets; nothing in the protocol prevents rented or stolen CPU time.
- A node update is a hard fork that each operator chooses to install. The council (until the handover) or the DAO (after) can approve one, and nodes that do not install it stop at its activation block; what protects the 12 % and the handover against a release that removes those rules is that operators can see it during the 7 or 14 days and refuse to run it. No blockchain can prevent a fork that the people running it choose (section 17.3).
- Before the handover the council can still pause the network up to 7 days in every 14 (17.4), which slows the NGO election but cannot stop it.
