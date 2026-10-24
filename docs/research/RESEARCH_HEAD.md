# PSYROB research notes and decision log

10 October 2026. Basis for `docs/dag/DAG_SPEC.md`.

## 1. Method

- **Peer-reviewed only.** Candidate sources were checked against Crossref (`verify.py`): the record must be a journal
  article, a conference proceedings paper or a book chapter, its title must match, its author list must contain the
  expected first author, and the venue must not be a preprint server (arXiv, IACR ePrint, SSRN). USENIX proceedings have
  no DOIs; they were checked on usenix.org. Wrong matches were removed by hand (`merge.py` lists them).
- **Result: 178 verified peer-reviewed sources**, 26 of them qualitative (interview, grounded-theory, case-study or
  qualitative-review designs). Kaspa's KIPs and the IACR ePrint versions are not peer-reviewed; they are not counted and
  are named only where the peer-reviewed version (for example [ghostdag21] at ACM AFT 2021) is cited.
- **What was read, honestly:** each entry in the bibliography says how much was read.
  - 11 full-text readings of the sections that decide a design question;
  - 122 abstracts (Semantic Scholar or OpenAlex);
  - 28 entries with only a machine summary, and 17 with only the bibliographic record.

  **133 sources were read at abstract level or better.** The last 45 entries are listed but not relied on for any
  decision.
- **Limits:** paywalled full texts were not read; summaries of findings rest on the abstracts in those cases. Search was
  in English only.

## 2. Decision log

Each decision names the sources and the reasoning. "Locked" means the brief fixed it; the research then sets the details.

### D1. Consensus: GHOSTDAG block DAG with k = 18 at 10 s (locked bounds)
- Nakamoto-style security degrades as block interval approaches network delay [nakamoto-backbone], [pss17], [tight20],
  [race20], [kiffer18]; inclusive and DAG protocols keep parallel blocks instead of discarding them
  [ghost15], [inclusive15], [ghostdag21], [conflux20], [prism19], [ohie20], [sokdag].
- GHOSTDAG is chosen because it is a peer-reviewed generalisation of Nakamoto consensus with a single tolerance parameter k
  and an efficient greedy algorithm [ghostdag21]; BFT-DAG protocols (Narwhal, Bullshark, DAG-Rider) need a known
  validator set and are unsuitable for permissionless proof of work [narwhal22], [bullshark22], [dagrider21].
- k: with λ = 0.1 blocks/s and delay D, the anticone size is Poisson-bounded by mean 2Dλ. Measured delays are 10-15 s
  in Conflux's tests [conflux20] and ~12 s for 90 % propagation in Bitcoin [decker13]. With k = 18, the bound holds with
  probability > 1 − 10⁻⁵ even at D = 30 s, so the locked k ≥ 18 is comfortably safe at 10 s.
- Balance and selfish-mining strategies remain possible in any forkable protocol [spectre-security], [selfish14],
  [optselfish16], [nayak16], [feng-uncle], [bahack], [zhang-blockfreq]; red blocks earn nothing (D6) to reduce the gain.

### D2. Ordering and execution
- Conflict handling follows Conflux: the DAG order decides; conflicting transactions are skipped, not reasons to reject
  a block [conflux20]. Each block commits to the state after accepting its mergeset, so every block is fully
  validated before it is relayed.
- `block.number` = **chain height** (contiguous). The earlier draft used the DAA score, which skips values and broke wallet
  assumptions. Long periods (terms, epochs) use `block.timestamp`, bounded by the past median time and a 120 s
  future limit [szalachowski18].

### D3. Difficulty adjustment
- ASERT (absolutely scheduled exponential rise) on blue score and past median time. Window and epoch-based rules
  oscillate under hash-rate shocks [kraft16], [fullmer18], and newer rules are stable under weaker conditions than
  Bitcoin's [noda20]; variable-difficulty security needs the adjustment to track the honest rate [variable17].

### D4. Proof of work: Argon2d 32 MiB with miner signature
- Memory-hard functions raise ASIC cost [argon2-16], [tradeoff15], [scrypt17], [depthrobust17], [bandwidth17],
  [balloon16], [alwenblocki16]; data-dependent Argon2d resists tradeoff attacks better than Argon2i [argon2i-attack17].
  Asymmetric alternatives exist [equihash16] but Argon2d is already implemented and audited in this project.
- Proof of work as rate limiting has a long history [dworknaor92], [memorybound03], [abadi05].
- Risk accepted and documented: CPU mining attracts botnets and cryptojacking [botcoin14], [minesweeper18],
  [cryptominer19]; ASIC history [taylor17], energy [devries18] and pooling [cong21], [decentmetrics21] were considered.
  The miner signature keeps the reward key with whoever does the work.

### D5. Emission: equal 36 % pools, smooth decay, 12-month cap (locked split)
- Fees alone make mining unstable [carlsten16]; seignorage is the better way to fund mining early [chiu22]; security
  budget limits [budish], [pagnotta22], [huberman21], [leshno20], [inflation-security]. Therefore a long, smooth decay
  (halving every ~4 years, monthly steps) instead of abrupt halvings.
- The 12-month emission cap ties emission to elapsed time so a hash-rate surge cannot front-load it [noda20].
- Base fee burned, EIP-1559 style [roughgarden], [eip1559-22], [fee-burn], [easley19].
- Team allocation (12 %) in immutable vesting: credible commitment predicts project success [howell20], [lyandres22],
  [icoinsider], [vesting].
- No airdrop (locked); airdrops are also costly and attract farming [frowis19].

### D6. Rewards for parallel blocks
- Inclusive protocols reward off-chain blocks to remove the incentive to ignore them [inclusive15]; GHOSTDAG pays blue
  blocks. Red blocks get no subsidy, and their transaction fees go to the merging chain block, so producing red blocks
  never pays more than producing blue blocks.

### D7. Finality committee: 21 members, ≤ 1/7 per operator, NGO < 1/3 (locked shape)
- Quorum 15 of 21 is the Byzantine bound (> 2/3) [lamport82], [pbft99], [dls88], [flp85], [hotstuff19].
- A finality layer on top of a dynamically available chain gives the "ebb-and-flow" property: blocks continue when the
  committee stalls, and finality catches up [ebbflow21], [afgjort20], [cap21], [checkpoint].
- Committees drawn by randomness with rotation [algorand17], [omniledger18], [rapidchain18], [byzcoin16];
  randomness bias limits [randao], [cryptosortition].
- Slash equivocation only, because only safety faults can be attributed with cryptographic evidence [forensics21];
  the economic limits of slashing [budish]; long-range and checkpointing literature [longrange], [accountable-pos].

### D8. NGO attestation by staked vouching with a challenge
- Proof-of-personhood and web-of-trust schemes have no proven Sybil resistance [siddarth20], [borge17], [sybil02],
  [sybilguard06]; identity registration on ledgers trades privacy and integrity [azouvi18].
- Accreditation raises trust in nonprofits [bekkers03], [gugerty09], [ngo-certification]; NGO legitimacy and accountability
  are multi-dimensional [ebrahim03], [ngo-legitimacy], [ngo-accountability]; blockchain use in aid has potential and
  pitfalls [zwitter18], [kshetri17], [hyvarinen17].
- Decision: vouches by miners who have done real work (100 blue blocks), with locked stakes that are burned if a
  challenge succeeds.

### D9. Voting, quorum and elections
- Token voting concentrates power [fritsch24], [feichtinger23], [barbereau23], [sharma24]; DAO governance literature
  [dao19], [hassan21], [sokgov22], [beck18], [rikken19], [ziolkowski20], [vanpelt21], [liu23], [chen-dao], [defilippi16],
  [reijers16], [ostrom00].
- Participation quorums cause strategic abstention and the quorum paradox [herrera10], [aguiar10]; approval quorums
  dominate [maniquet15]. Decision: count yes weight against floors, and accept a unique-address minimum as an alternative
  floor.
- Snapshot of voting power at proposal start against flash-loan voting [qin21], [govattack], [defisok], [zhou23];
  bribery and vote markets [judmayer21] remain a known risk.
- NGO election: approval voting with top-100 selection; proportional methods are documented as the better but
  untallyable alternative [aziz17], [pjr17]; quadratic and liquid voting considered [lalley18], [kahng18].

### D10. Roles: elected by NGOs, cannot vote, paid from Treasury
- Separation of decision management from decision control [fama83], [jensen76], [coi-nonprofit]; term limits and
  accountability [termlimits]. Role holders cannot vote (locked), so they cannot approve their own pay.

### D11. Volunteer fund on BNB Chain: three independent factors
- Bridges fail through compromised keys and missing verification [bridgesok]; wallet contracts and multi-sigs have
  known pitfalls [diangelo20], [destefanis18], [gennaro16], [bdn18], [musig19]; upgradeable proxies add hidden power,
  so the fund is not upgradeable [upgradeable].

### D12. Peer discovery and networking
- Eclipse countermeasures (deterministic buckets, random selection, test-before-evict, feelers, anchors, more
  outbound) [eclipse15]; partitioning and routing attacks [hijack17], [eclipse-defense]; bootstrapping without
  censorship-prone seeds [dnsseed]; Sybil limits [sybil02]; topology and privacy [addrman], [txprobe], [dandelion17],
  [erlay19], [perigee20]; measurements [ethpeers18], [gencer18], [neudecker19], [discv5]; DHT design [kademlia02].

### D13. Wallet loss is permanent (locked)
- Users misunderstand key recovery [mai20], [eskandari15], [krombholz16], [voskobojnikov21], [froehlich21], [sas18],
  [khairuddin16], [elsden18]. Decision: no recovery path in any contract; every NGO page and wallet command shows the
  loss warning and asks to confirm a backup.

### D14. Audit method
- Static analysis, fuzzing and property testing of contracts [slither19], [securify18], [echidna20], [contractfuzzer18],
  [luu16], [atzei17], [ccsurvey], [perez21]; metering DoS [brokenmetre20]; MEV and front-running [flashboys20];
  heuristic usability evaluation of the pages [nielsen90]; general surveys [bonneau15], [garaykiayias20].

## 3. Bibliography

Read levels: "full text" (named sections read), "abstract", "machine summary" (Semantic Scholar TLDR only),
"bibliographic record only". Machine-readable list: `bibliography.json`.

