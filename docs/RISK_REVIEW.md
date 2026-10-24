# PSYROB risk review

11 October 2026.
- **Part 3** (risks from the owner's three manuscripts, checked against the code) is at the end.
- **Part 4** (block flooding and empty-block abuse) is below.
- **Part 2** (proof that the network is a block DAG) is in `docs/DAG_PROOF.md`.

Sources are peer-reviewed and verified against Crossref (DOI); each entry in `docs/research/bibliography.json` says what was read. Papers that could not be opened are not cited.

## Part 4. Block flooding and empty-block abuse

Empty blocks are **not** rejected. A block is legitimately empty when nothing is pending, and such a rule is defeated by one dummy transaction. The defences below make flooding expensive and harmless instead.

### 4.1 Difficulty: does it count all blocks?

**Before:** ASERT counted the blue score. Red blocks (outside the k bound) did not raise difficulty, so an attacker able to make many red blocks could flood the DAG without the block rate pushing back.

**Fix (consensus):** a DAA score that counts every merged block, blue or red, as in Kaspa's design. `daaScore(B) = daaScore(SP) + |mergeset(B)|`, and ASERT uses it (`node/src/dag.js`, `Chain.expectedTarget`). Rewards and emission still follow blue blocks only; this changes difficulty, not reward logic.

**Response speed.** The ASERT half-life of 3,600 s needed about 1,140 extra blocks (3 hours) to absorb a 10x jump. It is now **900 s (90 blocks)**, chosen from a simulation of half-lives 300 to 3,600 s with Poisson block times [kraft16], [fullmer18], [noda20]:

| Half-life | 10x jump: back to ≥ 9 s per block | Extra blocks | 2x jump: back | Steady-state noise of the interval |
|---|---|---|---|---|
| 3,600 s (before) | 176 min | 1,141 | 115 min | 1.7 % |
| 1,800 s | 74 min | 571 | 65 min | 2.8 % |
| **900 s (now)** | **42 min** | **286** | **29 min** | **4.2 %** |
| 600 s | 26 min | 190 | 29 min | 5.4 % |
| 300 s | 20 min | 95 | 7 min | 8.5 % |

The cost of a shorter half-life is timing manipulation. A miner may move its timestamp up to 120 s into the future, which makes the next block at most 2^(120/900) ≈ 10 % easier. 900 s keeps that small while absorbing a 10x jump within the hour. Extra blocks during a jump do not add emission: the first-year cap ties emission to elapsed time.

Tests (`node/test/flood.test.js`):
- the 10x jump returns to 10.0 s per block, ≥ 9 s after 570 blocks or 47 min (deterministic model);
- with blue-only counting and half the blocks red, the same jump would still run at 5.0 s per block;
- a flood of 8 parallel blocks with k = 3 (4 red) raises the DAA score by all of them and makes the next block harder.

### 4.2 Cost of checking bad blocks

Argon2d verification costs 32 MiB and about 40 ms of CPU. A peer sending junk must not make a node pay that for nothing. Measures:
1. **Cheap checks first** (`Chain._addBlock`): sizes and fields, then the target and the past median time against the selected parent (pure arithmetic), then the body hash, then one signature recovery, and only then Argon2d. Transaction signatures are checked last. Orphans, whose parents are unknown, must at least not claim a target more than 16 times easier than the current one. Measured cost of refusing:
   - a forged easy target: 0.7 ms;
   - a wrong body: 0.3 ms;
   - an implausible orphan: 0.3 ms;
   - a block with valid fields but bad proof of work: 45.7 ms.
2. **Memory is bounded:** one Argon2d instance reuses its 32 MiB, and block intake is serialised, so junk cannot multiply memory use.
3. **Bans:** any invalid block adds 100 to the peer's misbehaviour score. The peer is disconnected at once, and its address banned for an hour.
   - **Bans are by address, never by peer ID.** IPv4 bans one address; IPv6 bans the whole /64 prefix (one subscriber's range), so switching addresses within it does not help.
   - **Fixed 11 October:** local and private addresses used to be exempt; they are now banned too, unless `--no-ban-local` is set for a devnet on one machine.
   - Tested: a banned peer reconnecting with a new node ID is refused before any handshake.
   - Eclipse and Sybil limits on connections: at most 64 inbound, 4 per address, and 2 outbound per network group [eclipse15], [neudecker19].
4. **Rate limits:**
   - **Per peer, all blocks:** at most 20 per second (burst 200, enough for sync).
   - **Unsolicited blocks** (not requested from that same peer) get proof-of-work checks from three budgets, all of which must allow it:
     - the peer's own share (burst 4, 2 per second);
     - the inbound pool (15/s);
     - the outbound pool (10/s, reserved for the peers this node chose, which attackers cannot easily become).
   - **Requested blocks are not limited:** sync, orphan parents and blocks this node asked a peer for after its announcement. Honest relay announces first and sends on request, so it never touches the budget.
   - **Fixed 11 October:** a block counts as requested only if it was asked from the very peer that sends it. An attacker can no longer ride on a request made to an honest peer.
   - **Over budget**, a block is dropped without a ban and can be fetched later through its announcement.

   Tested:
   - **One connection:** an unsolicited flood of 120 valid blocks had 4 checked and 116 dropped.
   - **Four connections from one attacker** sent 200 unsolicited blocks: 16 were checked (each connection's share) and 184 dropped. Meanwhile an honest peer's new block arrived and was accepted 677 ms into the flood.

Basis: flooding and denial of service as attack classes on blockchains [saad20]; transaction-pool flooding and its countermeasures [deter21], [mempoolflood].

### 4.3 DAG bloat limits

| Limit | Value | Where |
|---|---|---|
| Parents per block | 1 to 10, sorted, none an ancestor of another | `common/header.js`, `Chain._connect` |
| Mergeset size | ≤ 180 | `Chain._connect` |
| Merge depth | red blocks and parents within 360 blue score of the selected parent | `Chain._connect` |
| Block body | ≤ 2,000 transactions, total gas ≤ 10,000,000 (≈ 625 KB of calldata at most), ≤ 8 certificates, ≤ 21 signatures per certificate (new) | `Chain._addBlock`, `decodeCert` |
| Header | fixed fields, extra data ≤ 32 bytes, 10 parents at most | `decodeHeader` |
| Frame | ≤ 4 MiB | `p2p.js` |
| Timestamps | ≤ 120 s in the future, after the past median time of the selected chain | `Chain._addBlock` |
| Orphans | ≤ 512, oldest evicted, proof of work checked before storing | `Chain._addBlock` |

**Blocks outside the k = 18 bound are red.** They stay in the DAG (it must remain consistent) and their transactions are executed if valid, but they earn no subsidy. Their transaction fees go to the miner of the block that merged them. A miner gains nothing by producing them, and they now raise difficulty (4.1).

**Certificate cap (new):** a certificate could carry any number of signatures, each costing a signature recovery. It is now capped at 21, the committee size. Test: a 22-signature certificate is refused at decoding.

### 4.4 Censorship by empty blocks

Test `node/test/flood.test.js`, censorship:
- **Setup:** 10 miners, 2 s network delay, 90 blocks. Users send transfers every few seconds to the honest nodes. Miners 1 to 3 (30 % of the hash rate) mine only empty blocks.
- **Result:** every transaction is confirmed (41 of 41).
  - Mean delay from sending to acceptance: **29.9 s with the censor, 27.9 s without**.
  - 90th percentile: 54.6 s in both runs.
- **Why it is mild:** the censor's blocks are merged by honest blocks rather than replacing them. Honest blocks keep carrying transactions; the censor only removes its own share of the inclusion opportunities.
- **Comparison:** real-world measurements on Ethereum found censoring builders delayed sanctioned transactions by 85 % on average [wahrstatter24]. In a DAG with honest majority hash rate, empty-block censorship is bounded by the censor's share.

### 4.5 Incentives: is there any reward advantage to mining empty blocks?

No. The analysis (no reward logic was changed):
- The subsidy per blue block does not depend on its content.
- Transaction fees (priority fees) go to the block that contained the transaction, so an empty block forgoes fees.
- A red block earns nothing either way, and becoming red is not affected by block size at 10 s per block: no run produced a red block (`docs/DAG_PROOF.md`, section 4).
- A transaction included in several parallel blocks pays its fee once, to the first block in GHOSTDAG order. Duplicates earn nothing. Miners therefore have a small incentive to pick different transactions, as in inclusive protocols [inclusive15], but none to leave blocks empty.
- Larger blocks take slightly longer to propagate. At 10 s blocks and k = 18, that does not change the chance of being blue.

The long-run risk is the opposite one: when subsidies fall, fee-only rewards create "mining gaps" and instability [gapgame18], [carlsten16]. That is why the emission keeps a real subsidy for decades (spec section 7).

### 4.6 Storage and sync after a flood

- **Sync works after a flood.** Test: after the 120-block flood, a new node synced all 86 accepted blocks in 1.8 s. The final sync reply also carries every DAG tip (fixed in Part 2).
- **A flood's size is bounded by work.** Every flood block needs real proof of work at the current difficulty, and the DAA now raises difficulty for every block.
- **Pruning:**
  - **done:** undo records below the finality depth are dropped;
  - **not done:** block data is kept forever (archive node), and a new node replays every block.
  - **Next step (not implemented):** a pruning point below the finality depth, with a state snapshot signed through a finality checkpoint, so new nodes start from it. Disk use today is about 1–2 KB per empty block.

### Part 4 summary

| Item | Status | Code | Test |
|---|---|---|---|
| Difficulty counts all blocks | **fixed** (DAA score) | `dag.js`, `consensus.js` | `flood.test.js` (DAA flood) |
| Fast response to a 10x jump | **fixed** (half-life 900 s) | `params.js` | `flood.test.js` (10x jump) |
| Cheap checks before Argon2d | **fixed** (reordered, target first, orphan sanity) | `consensus.js` `_addBlock` | `flood.test.js` (junk costs) |
| Ban peers sending invalid blocks | **fixed**: by address (IPv6 /64), local addresses included, new peer IDs do not help | `p2p.js` `ban`, `banKey` | `flood.test.js` (disconnect, reconnect refused, /64) |
| Proof-of-work budget for unsolicited blocks | **fixed**: per-peer share, separate inbound and outbound pools, "requested" means requested from that peer | `p2p.js` `onBlockMsg` | `flood.test.js` (flood of 120; four-connection fair share) |
| Bloat limits (parents, mergeset, sizes, timestamps) | handled; certificate signature cap **fixed** | see 4.3 | `flood.test.js`, `ghostdag.test.js`, `common.test.js` |
| Red blocks earn nothing | handled | `consensus.js` `acceptMergeset` | `ghostdag.test.js` |
| 30 % empty-block censorship | handled: all confirmed, +2 s mean delay | – | `flood.test.js` (censorship) |
| Reward advantage to empty blocks | none found; no change | – | analysis 4.5 |
| Sync after a flood | handled | `p2p.js` | `flood.test.js` |
| Pruning of block data | **not handled** (archive node); next step described | – | – |

## Part 3. Risks from the three manuscripts

### 3.0 Method

- **Inputs.** The owner's three manuscripts were read in full, including tables, propositions, reference lists and appendices:
  - "CPU mining in DAG-based distributed ledgers" (Table 6, 12 risk themes);
  - "NGOs in the governance and consensus of DAG-based ledgers" (Table 7 and 8 propositions);
  - "Designing DAOs for DAG-based ledgers" (Tables 3, 5, 6 and 8 propositions).
- **Handling of the manuscripts.** They were read from a temporary folder outside the repository, never added to git, and deleted afterwards.
- **Not evidence.** The manuscripts are not peer reviewed. They served only as a checklist of risks.
- **Sources.** Every decision below cites peer-reviewed sources whose DOI was checked against Crossref and whose abstract or full text was read. The read level of each source is in `docs/research/bibliography.json`.
  - 19 sources were added for this part, all read at abstract level.
  - Three references were not used:
    - Kontinen & Bananuka 2022: the DOI given in the manuscript does not exist in Crossref.
    - Djosetro & Arts 2024: the manuscript gives no DOI.
    - Sharma et al. 2026: not verified.
- **Status:**
  - *handled*: a rule in code covers the risk, and a named test checks it;
  - *partly*: some of the risk remains, and the remainder is stated;
  - *not handled*: the risk is open;
  - *accepted*: a non-code risk, with the off-chain measure that is needed;
  - *fixed*: newly handled in this review.
- **Locked rules.** None was changed. Where a fix would touch a design choice that the owner may want to make, it is listed in 3.6 instead of being built.

### 3.1 CPU mining (manuscript 1, Table 6)

| Risk | Applies to PSYROB (file, function) | Status | Fix or measure | Source | Test |
|---|---|---|---|---|---|
| Hardware specialisation (GPU, FPGA, ASIC) | Yes: Argon2d with 32 MiB per attempt over the full signed header (`common/pow.js` `checkPow`) | partly | No change. Argon2d is memory-hard, and its data-dependent addressing resists time-memory trade-offs better than data-independent modes [argon2-16], [tradeoff15]. At 32 MiB, every parallel attempt needs its own DRAM, which narrows the advantage of special hardware without removing it: an FPGA accelerator for the memory-hard Scrypt beat commercial CPUs and GPUs in efficiency [le21]. More memory would exclude small machines, including the 3.3 GB server. The residual risk is accepted and watched through mining concentration on `/metrics`. | [argon2-16], [tradeoff15], [le21] | `common.test.js` (Argon2d vectors) |
| Cryptojacking (botnets, stolen CPU) | Yes: any CPU can mine (`miner/`) | accepted | No code fix is possible: the protocol cannot tell rented or stolen CPU time from owned. Off-chain: no browser miner is ever published, the pages never mine, the miner runs only as a command with an explicit key file, and suspicious mining concentration (`/metrics`) is reported to hosting providers. | [botcoin14], [minesweeper18], [cryptominer19] | – |
| Low security budget, 51 % attacks | Yes: a young chain with little hash rate | partly | Finality committee: a checkpoint every 30 chain blocks becomes final with 15 of 21 signatures, and a node refuses any block whose chain does not contain the final checkpoint (`Chain._includesFinal`). A hash-rate majority can then no longer reverse finalised history. Before Normal mode (fewer than 60 elected NGOs) there is no committee, and only proof of work protects the chain. Nascent chains are where most 51 % attacks happen, and checkpointing and BFT layers are the studied countermeasures [sello26], [checkpoint], [ebbflow21]. Off-chain: until finality is active, recipients of large transfers should wait for many confirmations. | [sello26], [checkpoint], [ebbflow21], [budish], [pagnotta22] | `ghostdag.test.js` (final checkpoint cannot be reorganised away, **new**), `Finality.t.sol`, `flow.test.js` |
| Selfish mining, withholding, pool concentration | Yes | partly | Parallel honest blocks are merged, not orphaned: 0 orphans in every Part 2 run. Blocks outside the k bound are red and earn nothing. No GHOSTDAG-specific selfish-mining bound is claimed. Pools cannot be seen on-chain [cong21]. The committee caps each declared operator at 3 seats, but operator labels are self-declared. Mining concentration is now published (**fixed**, N17). | [selfish14], [optselfish16], [ghostdag21], [cong21], [gencer18] | `ghostdag.test.js` (red blocks unpaid), `dagproof.test.js`, `Finality.t.sol` `test_operatorCapThreeSeats`, `flow.test.js` (metrics) |
| DAG-specific attacks: parasite chains, unstable ordering, double spends, ordering and MEV | Yes: `node/src/dag.js` (GHOSTDAG), `consensus.js` (`_connect`, `acceptMergeset`) | partly | Parasite chains: a parent must lie within the merge depth (360) of the selected parent, and final checkpoints are never reorganised away. Ordering: the selected parent, then ascending (blue work, hash), the same on every node. Double spends: of two conflicting transactions in parallel blocks, the one later in GHOSTDAG order is skipped. Ordering and MEV: miners order transactions inside their own block, so MEV is possible, and in a DAG it can also act on the order of blocks [valentini26], [flashboys20]. No general MEV defence exists (accepted). Governance tallies were made order-independent (**fixed**, A11). | [ghostdag21], [sokdag], [valentini26], [flashboys20] | `ghostdag.test.js` (merge depth), `consensus.test.js` (conflicting copy skipped), `dagproof.test.js` (all nodes agree; GHOSTDAG order, not longest chain) |
| Spam and resource exhaustion | Yes | handled | Part 4: EIP-1559 base fee (burned), gas and size limits, a DAA score over every block, cheap checks before Argon2d, per-peer proof-of-work budgets, address bans, and per-sender mempool limits. | [saad20], [deter21], [mempoolflood], [eip1559-22] | `flood.test.js` (all eight tests) |
| Central coordination: seed nodes, whitelists | Yes: `genesis/seeds.txt`, `--seeds`, `p2p.js` address gossip | partly | There is no whitelist anywhere: any address mines and any node joins. One reachable seed is enough, because peers are learnt by address gossip under eclipse countermeasures. The seed list is still empty. Off-chain: before public launch, publish at least three seeds run by independent operators (elected NGOs, for example), so the network does not depend on the project's host [dnsseed], [eclipse15]. | [dnsseed], [eclipse15], [neudecker19] | `units.test.js` (address manager), `dagnet.test.js` |
| Governance opacity, key-person dependence | Yes | partly | The rules are in ownerless genesis contracts, replaceable only through `UpgradeRegistry` with public timelocks (DAG_SPEC.md section 17). Every vote and decision is an event shown on the pages; the dev council's powers are limited and end at the handover or after 12 months (section 17.2), and `DevVesting` has no owner. Key person: one developer maintains the code and runs the testnet. Off-chain: publish the repository (pending owner approval), add a second maintainer, and commission an independent audit (docs/SECURITY.md section 4). | [defilippi16], [sokgov22], [beck18] | `Participants.t.sol` `test_devVestingCliffAndLinear`, `Governance.t.sol` (only the Governor spends) |
| Distribution fairness, holdings concentration | Yes | partly | Locked allocation: 36 % mining, 36 % NGOs (equal per elected NGO), 12 % team (12-month cliff, then linear vesting to month 48, no powers), 16 % Treasury. No presale and no airdrop. Who ends up holding PSY depends on who mines, which code cannot make fair. Holdings concentration (top shares, Nakamoto coefficient, Gini) is now published (**fixed**, N17). | [gencer18], [decentmetrics21], [fritsch24] | `consensus.test.js` (genesis: 28 % allocated), `units.test.js` (emission, metrics) |
| Energy | Yes | accepted | Proof of work turns electricity into security; that is the design, so no code fix. Off-chain: publish an energy estimate (network hash rate times measured joules per attempt on a reference CPU) with each annual report. | [charity-transparency] | – |
| Regulatory exposure | Yes | accepted | No code fix. Off-chain: a legal opinion before mainnet on the status of PSY, the volunteer fund on BNB Chain and NGO participation; a legal wrapper for the Treasury and the roles (row "Legal form" in 3.3); no presale and no price statements; and the published replay warning for 87870. | [axelsen22], [hude23], [dwivedi21] | – |
| Quantum computing; vanishing block rewards | Yes: secp256k1 ECDSA for transactions, miner signatures and checkpoints (`common/crypto.js`); the subsidy halves every 48 steps of 262,980 blue blocks (about 4 years, `emission.js`) | quantum: not handled; rewards: partly | Quantum: elliptic-curve signatures could be broken by a large quantum computer, while proof of work is much less exposed [aggarwal18]. A fix needs a post-quantum signature scheme and a hard fork, so it is out of scope for now. Off-chain: a migration plan, and advice not to reuse addresses (the public key is revealed at the first spend). Rewards: the subsidy decays for decades instead of ending, so fee-only mining, with its instability [carlsten16], [gapgame18], is far away. | [aggarwal18], [carlsten16], [gapgame18] | `units.test.js` (emission table) |

### 3.2 NGOs (manuscript 2, Table 7 and propositions)

| Risk | Applies to PSYROB (file, function) | Status | Fix or measure | Source | Test |
|---|---|---|---|---|---|
| Capture by the project or by funders | Yes: NGO pay (`NGORewards`), team powers (`DevVesting`), Treasury spending (`Governor`, `Treasury.spend`) | partly | NGOs are paid by rule: equal shares of the 36 % pool, never discretionary grants from the project. The team has no powers, and only a passed Treasury vote spends. Funders and conflicts of interest are not visible to code. Off-chain: the dossier template must list funders, PSY holdings and conflicts, and challengers check them. The remaining channel, capture through the token-weighted election, is the "plutocratic voting" row in 3.3. | [vanvoorst22], [ngo-legitimacy] | `Governance.t.sol` `test_ngoRewardsHeldUntilElectedThenShared`, `Participants.t.sol` `test_devVestingCliffAndLinear` |
| Tokenism (seats without decision rights) | Yes | handled | Elected NGOs:<br>- decide attestation challenges, one NGO one vote (`Attestation.decisionVote`);<br>- elect the five roles (`RoleElection.vote`);<br>- hold 6 of 21 committee seats, which sign finality;<br>- are needed, 60 of them, for Normal mode and for fund decisions. | [islam26] | `Participants.t.sol` (challenge decisions), `Governance.t.sol` `test_rolesElectedByNGOsCannotVoteAndArePaidFromTreasury`, `test_fundProposalNeedsSixtyNGOs`, `Finality.t.sol` `test_drawSixNGOAndFifteenMinerSeats` |
| Fictitious or impersonated NGOs: how is an NGO verified before it mints, and can one party register many? | Yes: `NGORegistry.mint`, `Attestation.vouch`, `challenge`, `finalize` | partly; the multiple-registration part is **fixed** (A12) | Before minting, nothing but a mined block and the 100 PSY fee is checked: the locked process order verifies after minting. Verification is attestation: 5 staked vouches, then a 7-day challenge decided by the elected NGOs or by a token vote. Many NGOs from one party: before this review, five voucher wallets could attest any number of NGOs. Now a voucher backs at most 10 NGOs at a time (`maxActiveVouches`), so m NGOs need m/2 voucher wallets, each with 100 blue blocks and 10,000 PSY at risk of burning. Identity-based admission stays weaker against Sybils than proof of work or stake [platt23]. Legal identity is checked off-chain (accepted): challengers look up the registration number in the national registry named in the dossier. Verifiable credentials are not yet mature enough to replace this [schumm25], [siddarth20], and third-party accreditation is the established signal [bekkers03]. | [platt23], [schumm25], [siddarth20], [bekkers03] | `RiskReview.t.sol` `test_voucherBacksAtMostTenNGOsAtATime`, `Participants.t.sol` `test_challengeUpheldByGovernorBurnsVouches`, `flow.test.js` |
| Concentration in a few large NGOs | Yes | partly | Pay and votes are equal per NGO, whatever its size; 100 seats; at most 3 committee seats per declared operator; at most 2 consecutive terms (A16). One party behind several NGO wallets cannot be detected; the voucher cap and the voucher history (A12, A17) raise its cost (3.7). Seats go to the most-approved candidates, not by lot: the owner kept approval-based seats (3.6). | [fritsch24], [weidener25] | `Finality.t.sol` `test_operatorCapThreeSeats`, `RiskReview.t.sol` (voucher cap), `ElectionCapture.t.sol` |
| Collusion or halting of finality | Yes: `FinalityCommittee` | handled | NGO seats are 6 of 21, below one third (locked). NGOs alone can neither finalise (15 signatures needed) nor block finality (7 non-signers needed). Equivocation burns 90 % of the bond, and members who sign fewer than half the checkpoints get no reward. If the committee halts, blocks continue and only finality lags (an ebb-and-flow design [ebbflow21]); the draw has one-shot fallbacks. | [ebbflow21], [forensics21], [pbft99] | `Finality.t.sol` `test_drawSixNGOAndFifteenMinerSeats`, `test_equivocationSlashed`, `test_rewardsNeedHalfTheCheckpoints`, `CommitteeDraw.t.sol` (fallback) |
| NGO technical capacity | Yes | accepted | NGOs must mine one block and, for a committee seat, run a signing node; code cannot check capacity. Off-chain: the `/run-a-node` and `/mine` guides, a technical partner or shared infrastructure, and a test-network trial before a committee seat. Signing records are public (`/committee`, `/metrics`). | [ngo-certification] | `flow.test.js` (committee signs) |
| Contested legitimacy of the NGOs themselves | Yes | accepted | Legitimacy is negotiated off-chain, so code cannot judge it. On-chain support: public dossiers, the challenge window, annual elections and, new, removal (A13). Off-chain: a dossier template (registration, governing body, annual report, funders) and public reporting. | [ngo-legitimacy], [vanvoorst22] | `RiskReview.t.sol` `test_removalProposalRemovesAnElectedNGO` |
| Legal liability | Yes | accepted | NGOs sign checkpoints and decide challenges, so liability is a legal question. Off-chain: a limited-liability legal wrapper and a written scope of duties before mainnet, with legal advice per jurisdiction. | [hude23], [dwivedi21] | – |
| Loss of permissionlessness | Yes | handled | Mining, running a node and transfers need no permission. NGO roles are confined to governance and a minority of the finality seats, and finality starts only in Normal mode. | [platt23], [ghostdag21] | `consensus.test.js`, `CommitteeDraw.t.sol` `test_noCommitteeBeforeNormalMode` |
| Rule-based pay | Yes | handled | NGOs get equal shares of the NGO pool by protocol (`NGORewards.notify`, `claim`). The committee gets 2 % of the mining emission, by signing record. Roles get `rolePayPer30Days` from the Treasury, a bounded parameter that is now also step-limited (A14). | [vanvoorst22] | `Governance.t.sol` `test_ngoRewardsHeldUntilElectedThenShared`, `Finality.t.sol` `test_rewardsNeedHalfTheCheckpoints`, `RiskReview.t.sol` (parameter step) |
| Rotation (fixed terms, limited renewal, reconfiguration) | Yes: `NGOElection.stand`, `finalize`, `termLimited` | **fixed** (owner decision, A16) | 1-year NGO terms (locked), annual elections, and a weekly committee rotation by verifiable draw. An NGO that held a seat in both of the two previous terms cannot stand or be elected; after one full term without a seat it may stand again. A supplementary seat counts as a term. Committees that are re-drawn from fresh randomness limit how long any group of members can act together [algorand17], [omniledger18]. | [algorand17], [omniledger18] | `ElectionCapture.t.sol` `test_termLimit_twoConsecutiveTermsThenOneTermOut`, `CommitteeDraw.t.sol` (rotation) |
| Public reporting of votes and node performance | Yes | handled | Every ballot and decision is an event (`Ballot`, `Voted`, `DecisionVote`, `RoleDrawn`), shown on `/election`, `/governance`, `/attestation` and `/roles`. Signatures per committee member are on `/committee`, and signing rates and participation are on `/metrics` (**fixed**, N17). Funding sources: in the dossier (off-chain). | [axelsen22], [decentmetrics21] | `flow.test.js` (pages, metrics) |
| Removal procedure | Yes | **fixed** (A13) | A Removal proposal (Governor kind 4: 10 % floor or 100 yes voters, Normal mode, 48-hour timelock) calls `NGOElection.remove`. The NGO loses its seat, its unclaimed rewards for the term (they return to the pool) and its attestation; the seat is refilled in the next supplementary round. Ordinary proposals cannot target `NGOElection`. Before attestation, the challenge applies; committee misbehaviour is slashed. | [riabokon26], [sokgov22] | `RiskReview.t.sol` `test_removalProposalRemovesAnElectedNGO`, `test_removalNeedsNormalMode` |

### 3.3 DAO design (manuscript 3, Tables 3, 5, 6 and propositions)

| Risk | Applies to PSYROB (file, function) | Status | Fix or measure | Source | Test |
|---|---|---|---|---|---|
| Plutocratic voting | Yes: weight = PSY locked in `VoteEscrow` (`Governor.vote`, `NGOElection.vote`) | partly | The floor can also be met by 50 or 100 distinct yes voters (locked rule), and the quorum counts yes weight. Role elections and attestation decisions are one NGO, one vote. NGO election (owner decision): locked-PSY weighting is kept, with two limits (A15). A ballot weighs at most the voter's average locked PSY over the last ~30 days, so recently locked PSY counts in proportion to its age. And one ballot weighs at most 1 % of the locked PSY (`maxBallotWeightBps`). Attestation, which does not depend on holdings, is the filter for who can be elected. A per-wallet cap can be avoided by splitting PSY over wallets, so it limits one wallet, not one party (3.7). Token-weighted voting favours large holders [fritsch24], [feichtinger23], [barbereau23]; DAOs without weighted decisions were more viable in one large sample [rikken23]. | [fritsch24], [feichtinger23], [barbereau23], [rikken23], [davo25], [lalley18] | `Governance.t.sol` `test_governorUniqueVoterMinimumMeetsFloor`, `ElectionCapture.t.sol` (lock-time weight, per-wallet cap) |
| Cost of participation; inactivity (a quorum that is never reached) | Yes: `Governor.passes`, `baseline` | handled | The quorum adapts: half the average turnout of the last 10 decided proposals, so falling turnout lowers it [ain26]. The floor can be met by 50 or 100 small voters, ballots are simple, and fees are low. If even the floor is never met, nothing executes: the status quo remains, and there is no default action. Delegation is not offered, because it concentrates power [weidener25]. A yes-counting quorum avoids the strategic abstention that participation quorums cause [herrera10]. | [herrera10], [ain26], [weidener25] | `Governance.t.sol` `test_governorFloorFailsWithoutEnoughYes`, `test_governorUniqueVoterMinimumMeetsFloor` |
| Expertise | Yes | partly | The CTO and the Security Lead are elected by the NGOs; there is no expert panel. Off-chain: a published technical review of each parameter or treasury proposal before the vote. | [sharma24] | `Governance.t.sol` (roles) |
| Legal form | Yes | accepted | No legal person exists for the Treasury or the roles. Off-chain: a foundation or association before the Treasury becomes material, as recommended for DAOs [hude23]; the regulatory test of "sufficient decentralisation" is uncertain [axelsen22]. | [hude23], [dwivedi21], [axelsen22] | – |
| Contributor conditions | Yes | partly | Role holders get predictable pay streamed from the Treasury and 1-year terms, and the pay can no longer change by more than double or half per 30 days (A14). The team allocation vests on a fixed schedule. Other contributors depend on Treasury proposals. | [sharma24], [davo25] | `Governance.t.sol` `test_rolesElectedByNGOsCannotVoteAndArePaidFromTreasury`, `RiskReview.t.sol` (parameter step) |
| Voting attack vectors | Yes | handled (**fixed**, A11) | Flash loans: weight is read at the previous block. PSY bought or borrowed after a proposal appeared now adds nothing (snapshot minimum, A11). Double votes: one ballot per address, with the lock held until the vote ends. Proposal spam: the 0.5 % threshold. Kinds restrict targets, and every execution waits out the timelock. Off-chain vote buying cannot be prevented by code. | [mosley22], [qin21], [govattack], [kitzler25] | `Governance.t.sol` `test_flashLockedPowerCannotVote`, `RiskReview.t.sol` (two Governor snapshot tests), `Audit.t.sol` A3 |
| Votes tallied from snapshots or commit-reveal (DAG ordering) | Yes: ballots arrive in parallel blocks and execute in GHOSTDAG order | **fixed** (A11); the spec already promised a snapshot, the code read ballot-time weight | Weights are fixed at the snapshot (proposal block, round opening) and sums do not depend on order, so a miner reordering ballots cannot change a tally [valentini26]. The deadline is the only order-sensitive point; a censoring miner can only delay ballots by its own share of blocks (Part 4.4: +2 s mean at 30 %) [wahrstatter24]. Commit-reveal is not used, because ballots are public for accountability (manuscript 2, proposition 8). Exception: term 1's main election opens at genesis, before anyone can hold PSY, so ballot-time weight applies there. | [valentini26], [wahrstatter24], [mosley22] | `RiskReview.t.sol` `test_governorBallotIgnoresPSYLockedAfterTheProposal`, `test_governorBallotWeighsTheSmallerOfSnapshotAndNow`, `test_supplementaryRoundUsesItsOpeningSnapshot`, `flood.test.js` (censorship) |
| Governance weight kept separate from consensus weight | Yes | partly | Hash power and committee seats give no votes: voting weight is PSY locked in `VoteEscrow`, and committee bonds, held in `FinalityCommittee`, do not count. The remaining overlap is that elected NGOs both decide (roles, challenges) and hold 6 of 21 committee seats, which is bounded below one third (locked). A party that both mines and locks PSY cannot be detected. | [axelsen22], [ebbflow21] | `Participants.t.sol` `test_voteEscrowSnapshotsAndHold`, `Finality.t.sol` |
| Bounded parameter changes | Yes: `Params.set` | **fixed** (A14); absolute [min, max] bounds already existed | Each change is now limited to between half and double the current value, and each key changes at most once per 30 days, so parallel proposals cannot be chained. The step rule follows Conflux's documented per-round limit (a project document, not evidence). | [sokgov22] | `RiskReview.t.sol` `test_parameterChangeAtMostDoubleOrHalfOncePer30Days` |
| Execution delays | Yes | handled | A 48-hour timelock on every Governor proposal; the volunteer fund waits 48 or 72 hours and can be cancelled during that time. | [sokgov22], [govattack] | `Governance.t.sol` `test_governorTreasurySpendWithFloorAndTimelock`, `Finality.t.sol` `test_fundLargeTransferHas72hAndCanBeCanceled`, `RiskReview.t.sol` (removal waits for the timelock) |
| Emergency powers that expire | Yes | handled | There is no pause, admin or upgrade key: the genesis contracts have no owner. The Interim Council's only power (attestation decisions) ends automatically when 60 NGOs are elected (`GovernanceMode.isInterimCouncil`). The volunteer fund's cancel power (the Security Lead, or 2 signers) can only stop a pending transfer during its timelock, and its holders change with each epoch and term. | [riabokon26] | `Governance.t.sol` `test_modesBootstrapInterimNormal`, `Finality.t.sol` (fund cancel) |
| Treasury reporting | Yes: `/treasury` | handled | Balances are shown in PSY only, with no market valuation. The team allocation is shown as held, vested and released; the NGO pool's undistributed PSY is shown separately, and fund approvals are listed. Undistributed native tokens are not presented as assets at market value [schoonwinkel23]. | [schoonwinkel23] | `flow.test.js` (pages) |
| Published decentralisation and participation metrics | Yes | **fixed** (N17) | `/metrics`, `/api/metrics` and `psy_metrics` publish blue blocks per miner over the last day and PSY per ordinary address, each as top-1 and top-5 shares, Nakamoto coefficient, HHI and Gini, plus locked PSY, proposal turnout, NGO ballots and the committee signing rate. Every node computes the same numbers for the same tip. Counts are per address, not per operator. | [axelsen22], [gencer18], [decentmetrics21] | `units.test.js` (concentration), `flow.test.js` (metrics checked against an independent count) |

### 3.4 Code fixes in this part

| Id | Change | Files | Tests |
|---|---|---|---|
| A11 | Snapshot ballots: min(weight at the snapshot, weight at the ballot) in the Governor and in NGO election rounds after term 1's main round | `Governor.sol` (`ballotWeight`, `vote`), `NGOElection.sol` (`snapshotOf`, `ballotWeight`, `vote`) | `RiskReview.t.sol` (3 tests) |
| A12 | At most 10 active vouches per voucher (`maxActiveVouches`, governable 1 to 100) | `Attestation.sol` (`vouch`), `Params.sol` | `RiskReview.t.sol` (voucher cap), `flow.test.js` (30 vouchers) |
| A13 | Removal of an elected NGO: Governor kind 4 → `NGOElection.remove` → rewards forfeited (`NGORewards.onRemoved`) and attestation revoked (`NGORegistry.revoke`); `finalize` skips candidates who are no longer attested | `Governor.sol`, `NGOElection.sol`, `NGORewards.sol`, `NGORegistry.sol`, `Base.sol` | `RiskReview.t.sol` (2 tests) |
| A14 | Parameter changes limited to ×2 or ÷2, once per 30 days per key | `Params.sol` (`set`) | `RiskReview.t.sol` (parameter step) |
| N17 | Published metrics | `node/src/metrics.js`, `explorer.js` (`/metrics`, `/api/metrics`), `rpc.js` (`psy_metrics`) | `units.test.js`, `flow.test.js` |
| A15 | NGO-election ballot weight: also at most the average locked PSY over the last 259,200 chain blocks (~30 days, `VoteEscrow.averageOver`) and at most `maxBallotWeightBps` (1 %) of the locked PSY | `NGOElection.sol` (`ballotWeight`), `VoteEscrow.sol`, `Params.sol` | `ElectionCapture.t.sol` (2 tests) |
| A16 | Term limit: 2 consecutive terms, then one term out | `NGOElection.sol` (`termLimited`, `stand`, `finalize`) | `ElectionCapture.t.sol` (term limit) |
| A17 | Voucher history: blue blocks in at least `vouchMinEpochs` (4) distinct 7-day epochs | `MinerRegistry.sol` (`activeEpochs`), `Attestation.sol` (`vouch`), `Params.sol` | `ElectionCapture.t.sol` (voucher history), `flow.test.js` |
| – | Test added for an existing rule: a final checkpoint cannot be reorganised away | `node/test/ghostdag.test.js` | itself |

### 3.5 Accepted risks and the off-chain measures they need

1. **Cryptojacking:** never publish a browser miner, and report abusive concentration.
2. **Energy:** publish an annual energy estimate.
3. **Regulation and legal form:** a legal opinion and a legal wrapper (foundation or association) before mainnet; no price statements; keep the replay warning.
4. **NGO identity and legitimacy:** a dossier template (registration number and registry, governing body, annual report, funders, PSY holdings, conflicts of interest); challengers check it.
5. **NGO capacity:** guides, a technical partner or shared infrastructure, and a test-network trial before a committee seat.
6. **Liability:** a limited-liability vehicle and a written scope of duties.
7. **Seeds and key person:** at least three independent seed operators, a second maintainer, and an independent audit.
8. **Quantum:** a post-quantum migration plan; no address reuse.
9. **Before Normal mode:** large transfers need many confirmations, since finality is not active yet.

### 3.6 Owner decisions (11 October 2026)

1. **Term limit: built (A16).** At most 2 consecutive terms; re-election is allowed after one full term without a seat.
2. **Appointment by lot: not built.** Seats stay approval-based. A lottery would need verifiable randomness that no participant can steer:
   - The sources on chain are the committee's commit-reveal beacon and, as a fallback, the finalised-checkpoint seed (docs/SECURITY.md sections 1 to 3). A member can bias the beacon by staying silent, and a miner the fallback by withholding a block. That bias is small for a weekly committee but matters more for year-long seats.
   - A lottery would therefore need a stronger beacon first: for example, a threshold beacon among the committee, or a verifiable random function [cryptosortition].
3. **NGO election weighting: built as decided (A15).** Locked-PSY weighting is kept, with a lock-time weight and a per-wallet cap. Attestation is the filter that does not depend on holdings.

### 3.7 Capture of the first election, and extra voucher wallets

**What the first election is.** It is the main round of term 1. It opens at genesis and closes on day 90; only attested NGOs can stand.

**Who can hold voting PSY by then.** Only miners:
- There is no airdrop or presale.
- The team allocation is held by `DevVesting`, which has no owner and a 12-month cliff, so it cannot be locked for voting.
- The Treasury cannot spend in Bootstrap mode, because Treasury proposals need Normal mode.
- The NGO pool (about 15 million PSY by day 90) stays in `NGORewards` until NGOs are elected.

So the voting PSY in the first election is at most the mined PSY: about **15.0 million PSY** in 90 days (777,600 blue blocks; the first-year emission cap ties emission to time).

**What stops one party from capturing it, and how far that goes:**

| Measure | What it does | Limit |
|---|---|---|
| Mining is the only source of PSY | Capturing the vote needs a large share of the hash rate for weeks. A party with share s ends up with about s of the voting PSY, if it keeps all its PSY locked and others lock theirs too. | Low turnout is the weak point: if only 20 % of the mined PSY is locked, a 10 % miner holds half the weight. |
| Approval voting with 100 seats | Every approval counts the voter's full weight, so candidates with broad support outrank a bloc that approves only its own NGOs. | It fails if honest voters approve few candidates or do not vote. |
| Lock-time weight (A15, new) | PSY counts at its average locked amount over the last ~30 days. Buying or borrowing PSY shortly before the vote buys little weight. | It does not stop a miner who locks early. |
| Per-wallet cap of 1 % (A15, new) | One wallet cannot carry a large share. | It can be avoided by splitting PSY over wallets; this is shown in a test and documented. |
| Attestation (non-holdings filter) | Each NGO needs 5 vouches by miners with a history, bonds at risk, and a 7-day challenge window. | In Bootstrap, a challenge is decided by token vote, which the same party may dominate (proposal P1 below). |
| Voucher cap and voucher history (A12, A17, new) | Each NGO costs 5 vouches from wallets that mined 100 blue blocks over at least 4 distinct weeks, with 1,000 PSY locked per vouch for a year. | A rich miner can still pay this (worked example below). |
| Consequences are bounded | NGOs hold 6 of 21 committee seats, below one third (locked), so captured NGO seats can neither finalise nor block finality. Fund transfers also need a Fund vote, 15 committee signatures, 3 of 5 signers and a timelock. Terms are limited to two in a row (A16), elections are annual, and Removal (A13) applies. | The captor would still elect the five roles, decide attestation challenges, and draw NGO-pool rewards for the term. |

**What stops a party from creating extra voucher wallets.** Each voucher wallet needs all of the following:
- registration (one mined blue block);
- 100 blue blocks of its own;
- (new) blue blocks in at least 4 distinct 7-day epochs (`vouchMinEpochs`), so a burst of new wallets in one week is not eligible;
- 1,000 PSY locked per vouch for a year, burned if a challenge against that NGO is upheld.

Each voucher backs at most 10 NGOs at a time.

**Worked example.** Placing 34 NGOs (a third of the seats) needs 17 voucher wallets: 1,700 blue blocks spread over at least 4 weeks, 170,000 PSY locked for a year, plus 34 mined NGO wallets and 3,400 PSY in burned mint fees.
- At 10 % of the hash rate that is about 2 days of blocks and about 10 days of block rewards.
- It is within reach before day 90.

The measures make such capture slower, visible and costly, but they do not prevent it. That is the documented limit of identity-free admission [platt23], [siddarth20].

**Proposed further fixes.** None of these changes a locked rule. None is built yet; each needs the owner's choice.
- **P1. Bootstrap challenges.** While no NGO is elected, a challenge decided by token vote could need the 10 % floor (as for Treasury) instead of the Ordinary 5 %. An NGO with a pending challenge already cannot stand, because it is not attested.
- **P2. Voucher overlap on the attestation page.** For each NGO, show how many other NGOs its five vouchers also back, so that clusters run by one party are easy to see and to challenge.
- **P3. Distinct operators.** Require an NGO's five vouchers to declare five different operators. This is weak, because labels are self-declared, but a false declaration becomes evidence for a challenge.
- **P4. Turnout warning.** Publish on `/metrics` and `/election` the share of mined PSY locked for the first election, so a low-turnout capture is visible before the round closes.

New tests: `contracts/test/ElectionCapture.t.sol` covers the lock-time weight, the per-wallet cap and its splitting limit, the term limit, and the voucher history. The fixture's vouchers and `node/test/flow.test.js` now mine over 4 weeks.

### 3.8 Safeguards approved on 11 October 2026 (P1, P2, P4, P3, (b)) and the cluster cap (a)

**Locked rules.** For each change, the locked rules it touches:
- P1, P2, P3, P4, (b): none.
  - P1 uses the existing 10 % tier of the locked floor rule.
  - (b) can leave seats empty in the first election, which makes the locked Interim fallback more likely but does not change it.
- (a): waiting for the owner's OK; see below.

| Id | Change | Where | Test |
|---|---|---|---|
| P1 (A18) | An Ordinary proposal that calls `Attestation` (deciding a challenge by token vote) needs the higher floor: 10 % of the locked PSY or 100 yes voters, in every mode. On the 100-voter path (this tier and every non-Ordinary kind), a yes voter counts only if its ballot weighs at least 100 PSY (`minCountedVoterLock`), so dust wallets cannot meet the minimum (owner check, 11 October 2026). While no NGOs are elected, the same large holders could otherwise dismiss a challenge against their own NGO at the 5 % floor. | `Governor.sol` (`highFloor`, `quorumOf`, `lockedYesVoters`, `passes`) | `Safeguards.t.sol` `test_P1_attestationDecisionByTokenVoteNeedsTheHigherFloor`, `test_P1_hundredVoterPathNeedsHundredPSYPerVoter` |
| P2 (N18) | The attestation page and each NGO page list the other NGOs whose vouchers overlap with this NGO's, so clusters stand out and can be challenged. | `explorer.js` (`ngoList` `sharesWith`) | `flow.test.js`: every NGO shares vouchers with exactly the 9 others of its voucher group |
| P3 (A19) | An NGO's five vouchers must declare five different operators (`MinerRegistry.operatorOf`). Labels are self-declared, so this does not stop a party that declares falsely, but a false declaration becomes evidence for a challenge. | `Attestation.sol` (`vouch`, `SameOperator`) | `Safeguards.t.sol` `test_P3_fiveVouchersMustDeclareFiveOperators` |
| P4 (N19) | `/election` and `/metrics` show the PSY locked for voting as a share of circulating PSY. In Bootstrap they warn when it is below 50 % (the threshold is a judgement call: below half, a holder of a large share of the mined PSY can decide most seats). | `explorer.js` (`turnoutPanel`) | `flow.test.js` (panel shown; warning only in Bootstrap below 50 %) |
| (b) (A20) | First election only (main round of term 1): a candidate needs approvals from at least `firstElectionMinVoters` (5) distinct ballots, each from a voter with at least `minCountedVoterLock` (100 PSY) locked at the ballot. These come on top of the approval weight. One large wallet counts as one voter. | `NGOElection.sol` (`approvers`, `vote`, `finalize`), `Params.sol` | `Safeguards.t.sol`: 5 counted voters elect; 4 heavy voters do not; voters below 100 PSY are not counted |

**Limits.**
- (b) raises the cost of a capture by a few wallets: 5 funded wallets per seat. It does not stop one party with many funded wallets, because addresses are free [platt23].
- P3 relies on honest declarations.
- P2 and P4 only make a capture visible; they do not prevent it.

**Found while building:**
- **Test fixture (A21).** The fixture advanced blocks with `vm.roll(block.number + 1)`. Under the via-ir build, `block.number` is cached across `vm.roll`, so repeated calls in one test did not advance the block. That is why the compiler's lint warned. The fixture now uses `vm.getBlockNumber()`.
- **Effect on earlier tests.** Earlier tests that relied on several rolls in a row ran with fewer distinct blocks than intended. All suites pass with the fix.

**(a) Weekly cap per connected voucher cluster: not built (owner decision, 11 October 2026: option 1).** The analysis that led to it:
- **Design considered.** Vouchers who back the same NGO within the same week are linked, and the cluster is the connected set. A cluster may start at most N attestation windows per week (for example N = 10).
- **Why it touches a locked rule in effect.** Honest vouchers co-vouch widely, so in practice the honest community forms one large cluster.
  - The cap would then limit the whole network's weekly NGO intake.
  - Vouchers can only start in week 4 (A17), and windows take a week, so roughly 8 weeks remain before the first election closes on day 90.
  - With N = 10 that allows at most about 80 NGOs, and with N = 5 about 40. That risks the locked target of 100 NGOs in the first election and the 60 needed to avoid Interim mode.
- **Little protection.** An attacker evades the cap by using disjoint groups of 5 voucher wallets, which A12 and A17 already make it pay for, so the cap would protect little.
- **Options for the owner:**
  1. Do not build (a). (Recommended.)
  2. Build it with the cap applied only after the first election.
  3. Build it with a large N (for example 25), which does not threaten the first election but rarely binds.

