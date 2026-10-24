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

| Id | Authors | Year | Title | Venue | DOI / URL | Kind | Read |
|---|---|---|---|---|---|---|---|
| algorand17 | Yossi Gilad et al. | 2017 | Algorand | Proceedings of the 26th Symposium on Operating Systems Principles | https://doi.org/10.1145/3132747.3132757 | quantitative/technical | abstract |
| dls88 | Cynthia Dwork et al. | 1988 | Consensus in the presence of partial synchrony | Journal of the ACM | https://doi.org/10.1145/42282.42283 | quantitative/technical | abstract (OpenAlex) |
| flp85 | Michael J. Fischer et al. | 1985 | Impossibility of distributed consensus with one faulty process | Journal of the ACM | https://doi.org/10.1145/3149.214121 | quantitative/technical | abstract |
| forensics21 | Peiyao Sheng et al. | 2021 | BFT Protocol Forensics | Proceedings of the 2021 ACM SIGSAC Conference on Computer and Communications Security | https://doi.org/10.1145/3460120.3484566 | quantitative/technical | full text: conclusion |
| hotstuff19 | Maofan Yin et al. | 2019 | HotStuff | Proceedings of the 2019 ACM Symposium on Principles of Distributed Computing | https://doi.org/10.1145/3293611.3331591 | quantitative/technical | abstract |
| lamport82 | Leslie Lamport et al. | 1982 | The Byzantine Generals Problem | ACM Transactions on Programming Languages and Systems | https://doi.org/10.1145/357172.357176 | quantitative/technical | abstract |
| ouroboros17 | Aggelos Kiayias et al. | 2017 | Ouroboros: A Provably Secure Proof-of-Stake Blockchain Protocol | Lecture Notes in Computer Science | https://doi.org/10.1007/978-3-319-63688-7_12 | quantitative/technical | machine summary (Semantic Scholar TLDR) only |
| pbft99 | Miguel Castro et al. | 2002 | Practical Byzantine fault tolerance and proactive recovery | ACM Transactions on Computer Systems | https://doi.org/10.1145/571637.571640 | quantitative/technical | abstract (OpenAlex) |
| bridgesok | Mengya Zhang et al. | 2024 | Security of Cross-chain Bridges: Attack Surfaces, Defenses, and Open Problems | RAID 2024 | https://doi.org/10.1145/3678890.3678894 | quantitative/technical | abstract |
| wahrstatter24 | Anton Wahrstätter et al. | 2024 | Blockchain Censorship | Proceedings of the ACM Web Conference 2024 | https://doi.org/10.1145/3589334.3645431 | quantitative/technical | full text: abstract, inclusion-delay results, limitations (arXiv 2305.18545, same paper) |
| byzcoin16 | Eleftherios Kokoris-Kogias et al. | 2016 | Enhancing Bitcoin Security and Performance with Strong Consistency via Collective Signing | USENIX Security 2016 | https://www.usenix.org/conference/usenixsecurity16/technical-sessions/presentation/kogias | quantitative/technical | bibliographic record only |
| cryptosortition | S. Micali et al. | None | Verifiable random functions | 40th Annual Symposium on Foundations of Computer Science (Cat. No.99CB37039) | https://doi.org/10.1109/sffcs.1999.814584 | quantitative/technical | abstract |
| decentmetrics21 | Qinwei Lin et al. | 2021 | Measuring Decentralization in Bitcoin and Ethereum using Multiple Metrics and Granularities | 2021 IEEE 37th International Conference on Data Engineering Workshops (ICDEW) | https://doi.org/10.1109/icdew53142.2021.00022 | quantitative/technical | abstract |
| omniledger18 | Eleftherios Kokoris-Kogias et al. | 2018 | OmniLedger: A Secure, Scale-Out, Decentralized Ledger via Sharding | 2018 IEEE Symposium on Security and Privacy (SP) | https://doi.org/10.1109/sp.2018.000-5 | quantitative/technical | abstract |
| randao | Ewa Syta et al. | 2017 | Scalable Bias-Resistant Distributed Randomness | 2017 IEEE Symposium on Security and Privacy (SP) | https://doi.org/10.1109/sp.2017.45 | quantitative/technical | abstract (OpenAlex) |
| rapidchain18 | Mahdi Zamani et al. | 2018 | RapidChain | Proceedings of the 2018 ACM SIGSAC Conference on Computer and Communications Security | https://doi.org/10.1145/3243734.3243853 | quantitative/technical | abstract (OpenAlex) |
| bitcoinng16 | Ittay Eyal et al. | 2016 | Bitcoin-NG: A Scalable Blockchain Protocol | USENIX NSDI 2016 | https://www.usenix.org/conference/nsdi16/technical-sessions/presentation/eyal | quantitative/technical | bibliographic record only |
| ghost15 | Yonatan Sompolinsky et al. | 2015 | Secure High-Rate Transaction Processing in Bitcoin | Lecture Notes in Computer Science | https://doi.org/10.1007/978-3-662-47854-7_32 | quantitative/technical | machine summary (Semantic Scholar TLDR) only |
| nakamoto-backbone | Juan Garay et al. | 2024 | The Bitcoin Backbone Protocol: Analysis and Applications | Journal of the ACM | https://doi.org/10.1145/3653445 | quantitative/technical | abstract |
| pss17 | Rafael Pass et al. | 2017 | Analysis of the Blockchain Protocol in Asynchronous Networks | Lecture Notes in Computer Science | https://doi.org/10.1007/978-3-319-56614-6_22 | quantitative/technical | machine summary (Semantic Scholar TLDR) only |
| atzei17 | Nicola Atzei et al. | 2017 | A Survey of Attacks on Ethereum Smart Contracts (SoK) | Lecture Notes in Computer Science | https://doi.org/10.1007/978-3-662-54455-6_8 | quantitative/technical | machine summary (Semantic Scholar TLDR) only |
| brokenmetre20 | Daniel Perez et al. | 2020 | Broken Metre: Attacking Resource Metering in EVM | Proceedings 2020 Network and Distributed System Security Symposium | https://doi.org/10.14722/ndss.2020.24267 | quantitative/technical | abstract |
| ccsurvey | Huashan Chen et al. | 2020 | A Survey on Ethereum Systems Security | ACM Computing Surveys | https://doi.org/10.1145/3391195 | quantitative/technical | abstract |
| contractfuzzer18 | Bo Jiang et al. | 2018 | ContractFuzzer: fuzzing smart contracts for vulnerability detection | Proceedings of the 33rd ACM/IEEE International Conference on Automated Software Engineering | https://doi.org/10.1145/3238147.3238177 | quantitative/technical | abstract |
| defisok | Sam Werner et al. | 2022 | SoK: Decentralized Finance (DeFi) | Proceedings of the 4th ACM Conference on Advances in Financial Technologies | https://doi.org/10.1145/3558535.3559780 | quantitative/technical | abstract |
| echidna20 | Gustavo Grieco et al. | 2020 | Echidna: effective, usable, and fast fuzzing for smart contracts | Proceedings of the 29th ACM SIGSOFT International Symposium on Software Testing and Analysis | https://doi.org/10.1145/3395363.3404366 | quantitative/technical | abstract |
| flashboys20 | Philip Daian et al. | 2020 | Flash Boys 2.0: Frontrunning in Decentralized Exchanges, Miner Extractable Value, and Consensus Instability | 2020 IEEE Symposium on Security and Privacy (SP) | https://doi.org/10.1109/sp40000.2020.00040 | quantitative/technical | abstract |
| govattack | Lewis Gudgeon et al. | 2020 | The Decentralized Financial Crisis | 2020 Crypto Valley Conference on Blockchain Technology (CVCBT) | https://doi.org/10.1109/cvcbt50464.2020.00005 | quantitative/technical | abstract |
| luu16 | Loi Luu et al. | 2016 | Making Smart Contracts Smarter | Proceedings of the 2016 ACM SIGSAC Conference on Computer and Communications Security | https://doi.org/10.1145/2976749.2978309 | quantitative/technical | abstract (OpenAlex) |
| perez21 | Daniel Perez et al. | 2021 | Smart Contract Vulnerabilities: Vulnerable Does Not Imply Exploited | USENIX Security 2021 | https://www.usenix.org/conference/usenixsecurity21/presentation/perez | quantitative/technical | bibliographic record only |
| qin21 | Kaihua Qin et al. | 2021 | Attacking the DeFi Ecosystem with Flash Loans for Fun and Profit | Lecture Notes in Computer Science | https://doi.org/10.1007/978-3-662-64322-8_1 | quantitative/technical | full text: attack case studies (bZx) |
| securify18 | Petar Tsankov et al. | 2018 | Securify | Proceedings of the 2018 ACM SIGSAC Conference on Computer and Communications Security | https://doi.org/10.1145/3243734.3243780 | quantitative/technical | abstract |
| slither19 | Josselin Feist et al. | 2019 | Slither: A Static Analysis Framework for Smart Contracts | 2019 IEEE/ACM 2nd International Workshop on Emerging Trends in Software Engineering for Blockchain (WETSEB) | https://doi.org/10.1109/wetseb.2019.00008 | quantitative/technical | abstract |
| upgradeable | Mehdi Salehi et al. | 2023 | Not so Immutable: Upgradeability of Smart Contracts on Ethereum | Lecture Notes in Computer Science | https://doi.org/10.1007/978-3-031-32415-4_33 | quantitative/technical | bibliographic record only |
| zhou23 | Liyi Zhou et al. | 2023 | SoK: Decentralized Finance (DeFi) Attacks | 2023 IEEE Symposium on Security and Privacy (SP) | https://doi.org/10.1109/sp46215.2023.10179435 | quantitative/technical | abstract |
| bullshark22 | Alexander Spiegelman et al. | 2022 | Bullshark | Proceedings of the 2022 ACM SIGSAC Conference on Computer and Communications Security | https://doi.org/10.1145/3548606.3559361 | quantitative/technical | abstract |
| conflux20 | Chenxing Li et al. | 2020 | A Decentralized Blockchain with High Throughput and Fast Confirmation | USENIX ATC 2020 | https://www.usenix.org/conference/atc20/presentation/li-chenxing | quantitative/technical | full text: related work, deferred execution, evaluation passages |
| dagrider21 | Idit Keidar et al. | 2021 | All You Need is DAG | Proceedings of the 2021 ACM Symposium on Principles of Distributed Computing | https://doi.org/10.1145/3465084.3467905 | quantitative/technical | abstract |
| feng-uncle | Jianyu Niu et al. | 2019 | Selfish Mining in Ethereum | 2019 IEEE 39th International Conference on Distributed Computing Systems (ICDCS) | https://doi.org/10.1109/icdcs.2019.00131 | quantitative/technical | abstract |
| ghostdag21 | Yonatan Sompolinsky et al. | 2021 | PHANTOM GHOSTDAG | Proceedings of the 3rd ACM Conference on Advances in Financial Technologies | https://doi.org/10.1145/3479722.3480990 | quantitative/technical | full text: full text (ePrint version, read for the earlier DAG draft) |
| inclusive15 | Yoad Lewenberg et al. | 2015 | Inclusive Block Chain Protocols | Lecture Notes in Computer Science | https://doi.org/10.1007/978-3-662-47854-7_33 | quantitative/technical | machine summary (Semantic Scholar TLDR) only |
| ledgercombiner | Matthias Fitzi et al. | 2020 | Ledger Combiners for Fast Settlement | Lecture Notes in Computer Science | https://doi.org/10.1007/978-3-030-64375-1_12 | quantitative/technical | abstract |
| narwhal22 | George Danezis et al. | 2022 | Narwhal and Tusk | Proceedings of the Seventeenth European Conference on Computer Systems | https://doi.org/10.1145/3492321.3519594 | quantitative/technical | abstract |
| ohie20 | Haifeng Yu et al. | 2020 | OHIE: Blockchain Scaling Made Simple | 2020 IEEE Symposium on Security and Privacy (SP) | https://doi.org/10.1109/sp40000.2020.00008 | quantitative/technical | abstract |
| prism19 | Vivek Bagaria et al. | 2019 | Prism | Proceedings of the 2019 ACM SIGSAC Conference on Computer and Communications Security | https://doi.org/10.1145/3319535.3363213 | quantitative/technical | abstract |
| sokdag | Qin Wang et al. | 2023 | SoK: DAG-based Blockchain Systems | ACM Computing Surveys | https://doi.org/10.1145/3576899 | quantitative/technical | abstract |
| spectre-security | Christopher Natoli et al. | 2017 | The Balance Attack or Why Forkable Blockchains are Ill-Suited for Consortium | 2017 47th Annual IEEE/IFIP International Conference on Dependable Systems and Networks (DSN) | https://doi.org/10.1109/dsn.2017.44 | quantitative/technical | abstract (OpenAlex) |
| valentini26 | Giulio Jan Valentini et al. | 2026 | Approaches to MEV in DAG-based DLTs | Journal of Mathematical Cryptology | https://doi.org/10.1515/jmc-2025-0048 | quantitative/technical | abstract (Crossref) |
| fullmer18 | Daniel Fullmer et al. | 2018 | Analysis of Difficulty Control in Bitcoin and Proof-of-Work Blockchains | 2018 IEEE Conference on Decision and Control (CDC) | https://doi.org/10.1109/cdc.2018.8619082 | quantitative/technical | abstract |
| kraft16 | Daniel Kraft | 2015 | Difficulty control for blockchain-based consensus systems | Peer-to-Peer Networking and Applications | https://doi.org/10.1007/s12083-015-0347-x | quantitative/technical | machine summary (Semantic Scholar TLDR) only |
| noda20 | Shunya Noda et al. | 2025 | An Economic Analysis of Difficulty Adjustment Algorithms in Proof-of-Work Blockchain Systems | International Economic Review | https://doi.org/10.1111/iere.70028 | quantitative/technical | abstract (OpenAlex) |
| variable17 | Juan Garay et al. | 2017 | The Bitcoin Backbone Protocol with Chains of Variable Difficulty | Lecture Notes in Computer Science | https://doi.org/10.1007/978-3-319-63688-7_10 | quantitative/technical | machine summary (Semantic Scholar TLDR) only |
| deter21 | Kai Li et al. | 2021 | DETER: Denial of Ethereum Txpool sERvices | Proceedings of the 2021 ACM SIGSAC Conference on Computer and Communications Security | https://doi.org/10.1145/3460120.3485369 | quantitative/technical | abstract (OpenAlex) |
| mempoolflood | Muhammad Saad et al. | 2019 | Mempool optimization for Defending Against DDoS Attacks in PoW-based Blockchain Systems | 2019 IEEE International Conference on Blockchain and Cryptocurrency (ICBC) | https://doi.org/10.1109/bloc.2019.8751476 | quantitative/technical | abstract (OpenAlex) |
| saad20 | Muhammad Saad et al. | 2020 | Exploring the Attack Surface of Blockchain: A Comprehensive Survey | IEEE Communications Surveys &amp; Tutorials | https://doi.org/10.1109/comst.2020.2975999 | quantitative/technical | full text: DDoS, flooding and attack-surface sections (arXiv 1904.03487, preprint of the journal version) |
| budish | Eric Budish et al. | 2024 | The Economic Limits of Permissionless Consensus | Proceedings of the 25th ACM Conference on Economics and Computation (EC '24) | https://doi.org/10.1145/3670865.3673548 | quantitative/technical | abstract |
| carlsten16 | Miles Carlsten et al. | 2016 | On the Instability of Bitcoin Without the Block Reward | Proceedings of the 2016 ACM SIGSAC Conference on Computer and Communications Security | https://doi.org/10.1145/2976749.2978408 | quantitative/technical | full text: abstract and introduction |
| chiu22 | Jonathan Chiu et al. | 2022 | The economics of cryptocurrency: Bitcoin and beyond | Canadian Journal of Economics/Revue canadienne d'économique | https://doi.org/10.1111/caje.12625 | quantitative/technical | abstract (OpenAlex) |
| cong21tok | Lin William Cong et al. | 2020 | Tokenomics: Dynamic Adoption and Valuation | The Review of Financial Studies | https://doi.org/10.1093/rfs/hhaa089 | quantitative/technical | bibliographic record only |
| easley19 | David Easley et al. | 2019 | From mining to markets: The evolution of bitcoin transaction fees | Journal of Financial Economics | https://doi.org/10.1016/j.jfineco.2019.03.004 | quantitative/technical | bibliographic record only |
| eip1559-22 | Yulin Liu et al. | 2022 | Empirical Analysis of EIP-1559 | Proceedings of the 2022 ACM SIGSAC Conference on Computer and Communications Security | https://doi.org/10.1145/3548606.3559341 | quantitative/technical | abstract |
| fee-burn | Matheus V. X. Ferreira et al. | 2021 | Dynamic posted-price mechanisms for the blockchain transaction-fee market | Proceedings of the 3rd ACM Conference on Advances in Financial Technologies | https://doi.org/10.1145/3479722.3480991 | quantitative/technical | abstract |
| frowis19 | Michael Fröwis et al. | 2019 | The Operational Cost of Ethereum Airdrops | Lecture Notes in Computer Science | https://doi.org/10.1007/978-3-030-31500-9_17 | quantitative/technical | abstract |
| howell20 | Sabrina T Howell et al. | 2019 | Initial Coin Offerings: Financing Growth with Cryptocurrency Token Sales | The Review of Financial Studies | https://doi.org/10.1093/rfs/hhz131 | quantitative/technical | abstract (OpenAlex) |
| huberman21 | Gur Huberman et al. | 2021 | Monopoly without a Monopolist: An Economic Analysis of the Bitcoin Payment System | The Review of Economic Studies | https://doi.org/10.1093/restud/rdab014 | quantitative/technical | abstract (OpenAlex) |
| icoinsider | Hugo Benedetti et al. | 2021 | Digital Tulips? Returns to investors in initial coin offerings | Journal of Corporate Finance | https://doi.org/10.1016/j.jcorpfin.2020.101786 | quantitative/technical | bibliographic record only |
| inflation-security | Jonathan Chiu et al. | 2019 | Incentive Compatibility on the Blockchain | Studies in Economic Design | https://doi.org/10.1007/978-3-319-93809-7_20 | quantitative/technical | machine summary (Semantic Scholar TLDR) only |
| leshno20 | Jacob D. Leshno et al. | 2020 | Bitcoin: An Axiomatic Approach and an Impossibility Theorem | American Economic Review: Insights | https://doi.org/10.1257/aeri.20190494 | quantitative/technical | abstract |
| lyandres22 | Evgeny Lyandres et al. | 2022 | Initial Coin Offering (ICO) Success and Post-ICO Performance | Management Science | https://doi.org/10.1287/mnsc.2022.4312 | quantitative/technical | abstract |
| pagnotta22 | Emiliano S Pagnotta | 2021 | Decentralizing Money: Bitcoin Prices and Blockchain Security | The Review of Financial Studies | https://doi.org/10.1093/rfs/hhaa149 | quantitative/technical | abstract |
| roughgarden | Tim Roughgarden | 2021 | Transaction fee mechanism design | ACM SIGecom Exchanges | https://doi.org/10.1145/3476436.3476445 | quantitative/technical | abstract |
| vesting | Paul P. Momtaz | 2019 | Token Sales and Initial Coin Offerings: <i>Introduction</i> | The Journal of Alternative Investments | https://doi.org/10.3905/jai.2019.21.4.007 | quantitative/technical | abstract |
| accountable-pos | Ertem Nusret Tas et al. | 2023 | Bitcoin-Enhanced Proof-of-Stake Security: Possibilities and Impossibilities | 2023 IEEE Symposium on Security and Privacy (SP) | https://doi.org/10.1109/sp46215.2023.10179426 | quantitative/technical | abstract |
| afgjort20 | Thomas Dinsdale-Young et al. | 2020 | Afgjort: A Partially Synchronous Finality Layer for Blockchains | Lecture Notes in Computer Science | https://doi.org/10.1007/978-3-030-57990-6_2 | quantitative/technical | machine summary (Semantic Scholar TLDR) only |
| cap21 | Suryanarayana Sankagiri et al. | 2021 | Blockchain CAP Theorem Allows User-Dependent Adaptivity and Finality | Lecture Notes in Computer Science | https://doi.org/10.1007/978-3-662-64331-0_5 | quantitative/technical | bibliographic record only |
| checkpoint | Dimitris Karakostas et al. | 2021 | Securing Proof-of-Work Ledgers via Checkpointing | 2021 IEEE International Conference on Blockchain and Cryptocurrency (ICBC) | https://doi.org/10.1109/icbc51069.2021.9461066 | quantitative/technical | abstract |
| ebbflow21 | Joachim Neu et al. | 2021 | Ebb-and-Flow Protocols: A Resolution of the Availability-Finality Dilemma | 2021 IEEE Symposium on Security and Privacy (SP) | https://doi.org/10.1109/sp40001.2021.00045 | quantitative/technical | abstract |
| longrange | Evangelos Deirmentzoglou et al. | 2019 | A Survey on Long-Range Attacks for Proof of Stake Protocols | IEEE Access | https://doi.org/10.1109/access.2019.2901858 | quantitative/technical | abstract |
| nielsen90 | Jakob Nielsen et al. | 1990 | Heuristic evaluation of user interfaces | Proceedings of the SIGCHI conference on Human factors in computing systems Empowering people - CHI '90 | https://doi.org/10.1145/97243.97281 | quantitative/technical | abstract (OpenAlex) |
| axelsen22 | Henrik Axelsen et al. | 2022 | When is a DAO Decentralized? | Complex Systems Informatics and Modeling Quarterly | https://doi.org/10.7250/csimq.2022-31.04 | qualitative | abstract (Crossref) |
| barbereau23 | Tom Barbereau et al. | 2023 | Decentralised Finance’s timocratic governance: The distribution and exercise of tokenised voting rights | Technology in Society | https://doi.org/10.1016/j.techsoc.2023.102251 | quantitative/technical | abstract (OpenAlex) |
| beck18 |  et al. | 2018 | Governance in the Blockchain Economy: A Framework and Research Agenda | Journal of the Association for Information Systems | https://doi.org/10.17705/1jais.00518 | qualitative | abstract (OpenAlex) |
| dao19 | Shuai Wang et al. | 2019 | Decentralized Autonomous Organizations: Concept, Model, and Applications | IEEE Transactions on Computational Social Systems | https://doi.org/10.1109/tcss.2019.2938190 | quantitative/technical | abstract |
| davo25 | David Davó et al. | 2025 | The rise and fall of DAOstack: lessons for decentralized autonomous organizations | PeerJ Computer Science | https://doi.org/10.7717/peerj-cs.3320 | qualitative | abstract (Crossref) |
| defilippi16 | Primavera De Filippi et al. | 2016 | The invisible politics of Bitcoin: governance crisis of a decentralised infrastructure | Internet Policy Review | https://doi.org/10.14763/2016.3.427 | qualitative | abstract |
| dwivedi21 | Vimal Dwivedi et al. | 2021 | A Formal Specification Smart-Contract Language for Legally Binding Decentralized Autonomous Organizations | IEEE Access | https://doi.org/10.1109/ACCESS.2021.3081926 | quantitative/technical | abstract (OpenAlex) |
| feichtinger23 | Rainer Feichtinger et al. | 2023 | The Hidden Shortcomings of (D)AOs – An Empirical Study of On-Chain Governance | Lecture Notes in Computer Science | https://doi.org/10.1007/978-3-031-48806-1_11 | quantitative/technical | full text: abstract, introduction, conclusion and results table |
| fritsch24 | Robin Fritsch et al. | 2024 | Analyzing voting power in decentralized governance: Who controls DAOs? | Blockchain: Research and Applications | https://doi.org/10.1016/j.bcra.2024.100208 | quantitative/technical | full text: abstract, introduction, conclusion |
| hassan21 | Samer Hassan et al. | 2021 | Decentralized Autonomous Organization | Internet Policy Review | https://doi.org/10.14763/2021.2.1556 | qualitative | abstract |
| hude23 | Zarja Hude et al. | 2023 | DAOs: Introducing a New Era of Governance | Ljubljana Law Review | https://doi.org/10.51940/2023.1.195-219 | qualitative | abstract (Crossref) |
| ostrom00 | Elinor Ostrom | 2000 | Collective Action and the Evolution of Social Norms | Journal of Economic Perspectives | https://doi.org/10.1257/jep.14.3.137 | quantitative/technical | abstract (OpenAlex) |
| reijers16 | Wessel Reijers et al. | 2016 | Governance in Blockchain Technologies &amp; Social Contract Theories | Ledger | https://doi.org/10.5195/ledger.2016.62 | qualitative | abstract |
| riabokon26 | Anna Riabokon | 2026 | Programmable governance and institutional design in decentralized autonomous organizations: a comparative study of RARI DAO, Arbitrum DAO, and Optimism DAO | Frontiers in Blockchain | https://doi.org/10.3389/fbloc.2026.1890169 | qualitative | abstract (Crossref) |
| rikken19 | Olivier Rikken et al. | 2019 | Governance challenges of blockchain and decentralized autonomous organizations | Information Polity | https://doi.org/10.3233/ip-190154 | qualitative | abstract |
| rikken23 | Olivier Rikken et al. | 2023 | Governance impacts of blockchain-based decentralized autonomous organizations: an empirical analysis | Policy Design and Practice | https://doi.org/10.1080/25741292.2023.2270220 | quantitative/technical | abstract (OpenAlex) |
| schoonwinkel23 | Hamman Schoonwinkel | 2023 | Towards Fair Presentation of DAO Treasuries: An Evaluation of Native Governance Token Reporting Practices | The Journal of The British Blockchain Association | https://doi.org/10.31585/jbba-6-2-(3)2023 | qualitative | abstract (OpenAlex) |
| sokgov22 | Aggelos Kiayias et al. | 2022 | SoK: Blockchain Governance | Proceedings of the 4th ACM Conference on Advances in Financial Technologies | https://doi.org/10.1145/3558535.3559794 | quantitative/technical | abstract |
| borge17 | Maria Borge et al. | 2017 | Proof-of-Personhood: Redemocratizing Permissionless Cryptocurrencies | 2017 IEEE European Symposium on Security and Privacy Workshops (EuroS&amp;PW) | https://doi.org/10.1109/eurospw.2017.46 | quantitative/technical | abstract |
| platt23 | Moritz Platt et al. | 2023 | Sybil in the Haystack: A Comprehensive Review of Blockchain Consensus Mechanisms in Search of Strong Sybil Attack Resistance | Algorithms | https://doi.org/10.3390/a16010034 | quantitative/technical | abstract (Crossref) |
| schumm25 | Daria Schumm et al. | 2025 | Are We There Yet? A Study of Decentralized Identity Applications | IEEE Access | https://doi.org/10.1109/ACCESS.2025.3588170 | qualitative | abstract (OpenAlex) |
| siddarth20 | Divya Siddarth et al. | 2020 | Who Watches the Watchmen? A Review of Subjective Approaches for Sybil-Resistance in Proof of Personhood Protocols | Frontiers in Blockchain | https://doi.org/10.3389/fbloc.2020.590171 | quantitative/technical | full text: review conclusions, web-of-trust assessment |
| gapgame18 | Itay Tsabary et al. | 2018 | The Gap Game | Proceedings of the 2018 ACM SIGSAC Conference on Computer and Communications Security | https://doi.org/10.1145/3243734.3243737 | quantitative/technical | full text: abstract, model, conclusion (arXiv 1805.05288) |
| eskandari15 | Shayan Eskandari et al. | 2015 | A First Look at the Usability of Bitcoin Key Management | Proceedings 2015 Workshop on Usable Security | https://doi.org/10.14722/usec.2015.23015 | qualitative | abstract |
| krombholz16 | Katharina Krombholz et al. | 2017 | The Other Side of the Coin: User Experiences with Bitcoin Security and Privacy | Lecture Notes in Computer Science | https://doi.org/10.1007/978-3-662-54970-4_33 | qualitative | machine summary (Semantic Scholar TLDR) only |
| mai20 | Alexandra Mai et al. | 2020 | User Mental Models of Cryptocurrency Systems - A Grounded Theory Approach | SOUPS 2020 (USENIX) | https://www.usenix.org/conference/soups2020/presentation/mai | qualitative | full text: recommendations, limitations |
| voskobojnikov21 | Artemij Voskobojnikov et al. | 2021 | The U in Crypto Stands for Usable: An Empirical Study of User Experience with Mobile Cryptocurrency Wallets | Proceedings of the 2021 CHI Conference on Human Factors in Computing Systems | https://doi.org/10.1145/3411764.3445407 | qualitative | abstract |
| bdn18 | Dan Boneh et al. | 2018 | Compact Multi-signatures for Smaller Blockchains | Lecture Notes in Computer Science | https://doi.org/10.1007/978-3-030-03329-3_15 | quantitative/technical | machine summary (Semantic Scholar TLDR) only |
| destefanis18 | Giuseppe Destefanis et al. | 2018 | Smart contracts vulnerabilities: a call for blockchain software engineering? | 2018 International Workshop on Blockchain Oriented Software Engineering (IWBOSE) | https://doi.org/10.1109/iwbose.2018.8327567 | quantitative/technical | abstract (OpenAlex) |
| diangelo20 | Monika di Angelo et al. | 2020 | Characteristics of Wallet Contracts on Ethereum | 2020 2nd Conference on Blockchain Research &amp; Applications for Innovative Networks and Services (BRAINS) | https://doi.org/10.1109/brains49436.2020.9223287 | quantitative/technical | abstract |
| gennaro16 | Rosario Gennaro et al. | 2016 | Threshold-Optimal DSA/ECDSA Signatures and an Application to Bitcoin Wallet Security | Lecture Notes in Computer Science | https://doi.org/10.1007/978-3-319-39555-5_9 | quantitative/technical | machine summary (Semantic Scholar TLDR) only |
| musig19 | Gregory Maxwell et al. | 2019 | Simple Schnorr multi-signatures with applications to Bitcoin | Designs, Codes and Cryptography | https://doi.org/10.1007/s10623-019-00608-x | quantitative/technical | machine summary (Semantic Scholar TLDR) only |
| addrman | Alex Biryukov et al. | 2014 | Deanonymisation of Clients in Bitcoin P2P Network | Proceedings of the 2014 ACM SIGSAC Conference on Computer and Communications Security | https://doi.org/10.1145/2660267.2660379 | quantitative/technical | abstract |
| dandelion17 | Shaileshh Bojja Venkatakrishnan et al. | 2017 | Dandelion | ACM SIGMETRICS Performance Evaluation Review | https://doi.org/10.1145/3143314.3078528 | quantitative/technical | abstract (OpenAlex) |
| decker13 | Christian Decker et al. | 2013 | Information propagation in the Bitcoin network | IEEE P2P 2013 Proceedings | https://doi.org/10.1109/p2p.2013.6688704 | quantitative/technical | abstract (OpenAlex) |
| discv5 | Lucianna Kiffer et al. | 2021 | Under the Hood of the Ethereum Gossip Protocol | Lecture Notes in Computer Science | https://doi.org/10.1007/978-3-662-64331-0_23 | quantitative/technical | bibliographic record only |
| dnsseed | Angelique Faye Loe et al. | 2019 | You Shall Not Join | Proceedings of the 2019 ACM SIGSAC Conference on Computer and Communications Security | https://doi.org/10.1145/3319535.3345649 | quantitative/technical | abstract |
| eclipse-defense | Muoi Tran et al. | 2020 | A Stealthier Partitioning Attack against Bitcoin Peer-to-Peer Network | 2020 IEEE Symposium on Security and Privacy (SP) | https://doi.org/10.1109/sp40000.2020.00027 | quantitative/technical | abstract |
| eclipse15 | Ethan Heilman et al. | 2015 | Eclipse Attacks on Bitcoin's Peer-to-Peer Network | USENIX Security 2015 | https://www.usenix.org/conference/usenixsecurity15/technical-sessions/presentation/heilman | quantitative/technical | full text: countermeasures section in full |
| erlay19 | Gleb Naumenko et al. | 2019 | Erlay | Proceedings of the 2019 ACM SIGSAC Conference on Computer and Communications Security | https://doi.org/10.1145/3319535.3354237 | quantitative/technical | abstract (OpenAlex) |
| ethpeers18 | Seoung Kyun Kim et al. | 2018 | Measuring Ethereum Network Peers | Proceedings of the Internet Measurement Conference 2018 | https://doi.org/10.1145/3278532.3278542 | quantitative/technical | abstract |
| gencer18 | Adem Efe Gencer et al. | 2018 | Decentralization in Bitcoin and Ethereum Networks | Lecture Notes in Computer Science | https://doi.org/10.1007/978-3-662-58387-6_24 | quantitative/technical | abstract |
| hijack17 | Maria Apostolaki et al. | 2017 | Hijacking Bitcoin: Routing Attacks on Cryptocurrencies | 2017 IEEE Symposium on Security and Privacy (SP) | https://doi.org/10.1109/sp.2017.29 | quantitative/technical | abstract (OpenAlex) |
| kademlia02 | Petar Maymounkov et al. | 2002 | Kademlia: A Peer-to-Peer Information System Based on the XOR Metric | Lecture Notes in Computer Science | https://doi.org/10.1007/3-540-45748-8_5 | quantitative/technical | machine summary (Semantic Scholar TLDR) only |
| neudecker19 | Till Neudecker et al. | 2019 | Network Layer Aspects of Permissionless Blockchains | IEEE Communications Surveys &amp; Tutorials | https://doi.org/10.1109/comst.2018.2852480 | quantitative/technical | abstract |
| perigee20 | Yifan Mao et al. | 2020 | Perigee: Efficient Peer-to-Peer Network Design for Blockchains | Proceedings of the 39th Symposium on Principles of Distributed Computing | https://doi.org/10.1145/3382734.3405704 | quantitative/technical | abstract |
| sybil02 | John R. Douceur | 2002 | The Sybil Attack | Lecture Notes in Computer Science | https://doi.org/10.1007/3-540-45748-8_24 | quantitative/technical | machine summary (Semantic Scholar TLDR) only |
| sybilguard06 | Haifeng Yu et al. | 2006 | SybilGuard | ACM SIGCOMM Computer Communication Review | https://doi.org/10.1145/1151659.1159945 | quantitative/technical | abstract (OpenAlex) |
| txprobe | Sergi Delgado-Segura et al. | 2019 | TxProbe: Discovering Bitcoin’s Network Topology Using Orphan Transactions | Lecture Notes in Computer Science | https://doi.org/10.1007/978-3-030-32101-7_32 | quantitative/technical | abstract |
| bekkers03 | René Bekkers | 2003 | Trust, Accreditation, and Philanthropy in the Netherlands | Nonprofit and Voluntary Sector Quarterly | https://doi.org/10.1177/0899764003258102 | qualitative | abstract (OpenAlex) |
| charity-transparency | Fahad Saleh | 2020 | Blockchain without Waste: Proof-of-Stake | The Review of Financial Studies | https://doi.org/10.1093/rfs/hhaa075 | quantitative/technical | abstract (OpenAlex) |
| ebrahim03 | Alnoor Ebrahim | 2003 | Accountability In Practice: Mechanisms for NGOs | World Development | https://doi.org/10.1016/s0305-750x(03)00014-7 | qualitative | bibliographic record only |
| gugerty09 | Mary Kay Gugerty | 2009 | Signaling virtue: voluntary accountability programs among nonprofit organizations | Policy Sciences | https://doi.org/10.1007/s11077-009-9085-3 | qualitative | bibliographic record only |
| hyvarinen17 | Hissu Hyvärinen et al. | 2017 | A Blockchain-Based Approach Towards Overcoming Financial Fraud in Public Sector Services | Business &amp; Information Systems Engineering | https://doi.org/10.1007/s12599-017-0502-4 | quantitative/technical | machine summary (Semantic Scholar TLDR) only |
| islam26 | Md. Mujahidul Islam et al. | 2026 | Strengthening climate resilience in coastal Bangladesh: Analyzing the role of NGOs in adaptation governance from an intersectionality lens | Progress in Disaster Science | https://doi.org/10.1016/j.pdisas.2025.100498 | qualitative | abstract (OpenAlex) |
| kshetri17 | Nir Kshetri | 2017 | Will blockchain emerge as a tool to break the poverty chain in the Global South? | Third World Quarterly | https://doi.org/10.1080/01436597.2017.1298438 | qualitative | abstract (OpenAlex) |
| ngo-accountability | Patrick Kilby | 2006 | Accountability for Empowerment: Dilemmas Facing Non-Governmental Organizations | World Development | https://doi.org/10.1016/j.worlddev.2005.11.009 | qualitative | bibliographic record only |
| ngo-certification | Angela L. Bies | 2001 | Accountability, organizational capacity, and continuous improvement: Findings from Minnesota's nonprofit sector | New Directions for Philanthropic Fundraising | https://doi.org/10.1002/pf.3104 | qualitative | abstract (OpenAlex) |
| ngo-legitimacy | Sarah Lister | 2003 | NGO Legitimacy | Critique of Anthropology | https://doi.org/10.1177/0308275x03023002004 | qualitative | abstract (OpenAlex) |
| vanvoorst22 | Stijn van Voorst et al. | 2022 | Humanitarian aid NGOs’ accountability towards large donors: the case of the European Union’s DG ECHO | Journal of International Humanitarian Action | https://doi.org/10.1186/s41018-022-00129-8 | qualitative | abstract (Crossref) |
| zwitter18 | Andrej Zwitter et al. | 2018 | Blockchain for humanitarian action and development aid | Journal of International Humanitarian Action | https://doi.org/10.1186/s41018-018-0044-5 | qualitative | abstract |
| abadi05 | Martin Abadi et al. | 2005 | Moderately hard, memory-bound functions | ACM Transactions on Internet Technology | https://doi.org/10.1145/1064340.1064341 | quantitative/technical | abstract (OpenAlex) |
| alwenblocki16 | Joël Alwen et al. | 2016 | Efficiently Computing Data-Independent Memory-Hard Functions | Lecture Notes in Computer Science | https://doi.org/10.1007/978-3-662-53008-5_9 | quantitative/technical | machine summary (Semantic Scholar TLDR) only |
| argon2-16 | Alex Biryukov et al. | 2016 | Argon2: New Generation of Memory-Hard Functions for Password Hashing and Other Applications | 2016 IEEE European Symposium on Security and Privacy (EuroS&amp;P) | https://doi.org/10.1109/eurosp.2016.31 | quantitative/technical | abstract (OpenAlex) |
| argon2i-attack17 | Joel Alwen et al. | 2017 | Towards Practical Attacks on Argon2i and Balloon Hashing | 2017 IEEE European Symposium on Security and Privacy (EuroS&amp;P) | https://doi.org/10.1109/eurosp.2017.47 | quantitative/technical | abstract (OpenAlex) |
| balloon16 | Dan Boneh et al. | 2016 | Balloon Hashing: A Memory-Hard Function Providing Provable Protection Against Sequential Attacks | Lecture Notes in Computer Science | https://doi.org/10.1007/978-3-662-53887-6_8 | quantitative/technical | machine summary (Semantic Scholar TLDR) only |
| bandwidth17 | Ling Ren et al. | 2017 | Bandwidth Hard Functions for ASIC Resistance | Lecture Notes in Computer Science | https://doi.org/10.1007/978-3-319-70500-2_16 | quantitative/technical | machine summary (Semantic Scholar TLDR) only |
| botcoin14 | Danny Yuxing Huang et al. | 2014 | Botcoin: Monetizing Stolen Cycles | Proceedings 2014 Network and Distributed System Security Symposium | https://doi.org/10.14722/ndss.2014.23044 | quantitative/technical | abstract (OpenAlex) |
| cong21 | Lin William Cong et al. | 2020 | Decentralized Mining in Centralized Pools | The Review of Financial Studies | https://doi.org/10.1093/rfs/hhaa040 | quantitative/technical | abstract (OpenAlex) |
| cryptominer19 | Sergio Pastrana et al. | 2019 | A First Look at the Crypto-Mining Malware Ecosystem | Proceedings of the Internet Measurement Conference | https://doi.org/10.1145/3355369.3355576 | quantitative/technical | abstract |
| depthrobust17 | Joël Alwen et al. | 2017 | Depth-Robust Graphs and Their Cumulative Memory Complexity | Lecture Notes in Computer Science | https://doi.org/10.1007/978-3-319-56617-7_1 | quantitative/technical | machine summary (Semantic Scholar TLDR) only |
| devries18 | Alex de Vries | 2018 | Bitcoin's Growing Energy Problem | Joule | https://doi.org/10.1016/j.joule.2018.04.016 | quantitative/technical | machine summary (Semantic Scholar TLDR) only |
| dworknaor92 | Cynthia Dwork et al. | None | Pricing via Processing or Combatting Junk Mail | Lecture Notes in Computer Science | https://doi.org/10.1007/3-540-48071-4_10 | quantitative/technical | machine summary (Semantic Scholar TLDR) only |
| equihash16 | Alex Biryukov et al. | 2017 | Equihash: Asymmetric Proof-of-Work Based on  the Generalized Birthday Problem | Ledger | https://doi.org/10.5195/ledger.2017.48 | quantitative/technical | abstract |
| le21 | Vu Trung Duong Le et al. | 2021 | MRSA: A High-Efficiency Multi ROMix Scrypt Accelerator for Cryptocurrency Mining and Data Security | IEEE Access | https://doi.org/10.1109/ACCESS.2021.3131558 | quantitative/technical | abstract (OpenAlex) |
| memorybound03 | Cynthia Dwork et al. | 2003 | On Memory-Bound Functions for Fighting Spam | Lecture Notes in Computer Science | https://doi.org/10.1007/978-3-540-45146-4_25 | quantitative/technical | machine summary (Semantic Scholar TLDR) only |
| minesweeper18 | Radhesh Krishnan Konoth et al. | 2018 | MineSweeper | Proceedings of the 2018 ACM SIGSAC Conference on Computer and Communications Security | https://doi.org/10.1145/3243734.3243858 | quantitative/technical | abstract (OpenAlex) |
| scrypt17 | Joël Alwen et al. | 2017 | Scrypt Is Maximally Memory-Hard | Lecture Notes in Computer Science | https://doi.org/10.1007/978-3-319-56617-7_2 | quantitative/technical | machine summary (Semantic Scholar TLDR) only |
| taylor17 | Michael Bedford Taylor | 2017 | The Evolution of Bitcoin Hardware | Computer | https://doi.org/10.1109/mc.2017.3571056 | quantitative/technical | abstract (OpenAlex) |
| tradeoff15 | Alex Biryukov et al. | 2015 | Tradeoff Cryptanalysis of Memory-Hard Functions | Lecture Notes in Computer Science | https://doi.org/10.1007/978-3-662-48800-3_26 | quantitative/technical | abstract |
| azouvi18 | Sarah Azouvi et al. | 2017 | Who Am I? Secure Identity Registration on Distributed Ledgers | Lecture Notes in Computer Science | https://doi.org/10.1007/978-3-319-67816-0_21 | quantitative/technical | machine summary (Semantic Scholar TLDR) only |
| chen-dao | Yan Chen et al. | 2020 | Decentralized Governance of Digital Platforms | Journal of Management | https://doi.org/10.1177/0149206320916755 | qualitative | abstract |
| elsden18 | Chris Elsden et al. | 2018 | Making Sense of Blockchain Applications | Proceedings of the 2018 CHI Conference on Human Factors in Computing Systems | https://doi.org/10.1145/3173574.3174032 | qualitative | abstract |
| froehlich21 | Michael Froehlich et al. | 2022 | Blockchain and Cryptocurrency in Human Computer Interaction: A Systematic Literature Review and Research Agenda | Designing Interactive Systems Conference | https://doi.org/10.1145/3532106.3533478 | qualitative | abstract |
| khairuddin16 | Irni Eliana Khairuddin et al. | 2016 | Exploring Motivations for Bitcoin Technology Usage | Proceedings of the 2016 CHI Conference Extended Abstracts on Human Factors in Computing Systems | https://doi.org/10.1145/2851581.2892500 | qualitative | abstract (OpenAlex) |
| liu23 | Yue Liu et al. | 2022 | Defining blockchain governance principles: A comprehensive framework | Information Systems | https://doi.org/10.1016/j.is.2022.102090 | qualitative | abstract |
| sas18 | Corina Sas et al. | 2017 | Design for Trust | Proceedings of the 2017 CHI Conference on Human Factors in Computing Systems | https://doi.org/10.1145/3025453.3025886 | qualitative | abstract (OpenAlex) |
| sharma24 | Tanusree Sharma et al. | 2024 | Unpacking How Decentralized Autonomous Organizations (DAOs) Work in Practice | 2024 IEEE International Conference on Blockchain and Cryptocurrency (ICBC) | https://doi.org/10.1109/icbc59979.2024.10634404 | qualitative | full text: abstract, discussion and design implications |
| vanpelt21 | Rowan van Pelt et al. | 2020 | Defining Blockchain Governance: A Framework for Analysis and Comparison | Information Systems Management | https://doi.org/10.1080/10580530.2020.1720046 | qualitative | abstract |
| ziolkowski20 | Rafael Ziolkowski et al. | 2020 | Decision Problems in Blockchain Governance: Old Wine in New Bottles or Walking in Someone Else’s Shoes? | Journal of Management Information Systems | https://doi.org/10.1080/07421222.2020.1759974 | qualitative | abstract |
| coi-nonprofit | Jeffrey L. Callen et al. | 2003 | Board Composition, Committees, and Organizational Efficiency: The Case of Nonprofits | Nonprofit and Voluntary Sector Quarterly | https://doi.org/10.1177/0899764003257462 | quantitative/technical | abstract (OpenAlex) |
| fama83 | Eugene F. Fama et al. | 1983 | Separation of Ownership and Control | The Journal of Law and Economics | https://doi.org/10.1086/467037 | quantitative/technical | bibliographic record only |
| jensen76 | Michael C. Jensen et al. | 1976 | Theory of the firm: Managerial behavior, agency costs and ownership structure | Journal of Financial Economics | https://doi.org/10.1016/0304-405X(76)90026-X | quantitative/technical | bibliographic record only |
| termlimits | Michael Smart et al. | 2013 | Term limits and electoral accountability | Journal of Public Economics | https://doi.org/10.1016/j.jpubeco.2013.08.011 | quantitative/technical | bibliographic record only |
| aggarwal18 | Divesh Aggarwal et al. | 2018 | Quantum Attacks on Bitcoin, and How to Protect Against Them | Ledger | https://doi.org/10.5195/ledger.2018.127 | quantitative/technical | abstract (Crossref) |
| bahack | Yujin Kwon et al. | 2017 | Be Selfish and Avoid Dilemmas | Proceedings of the 2017 ACM SIGSAC Conference on Computer and Communications Security | https://doi.org/10.1145/3133956.3134019 | quantitative/technical | abstract |
| gervais16 | Arthur Gervais et al. | 2016 | On the Security and Performance of Proof of Work Blockchains | Proceedings of the 2016 ACM SIGSAC Conference on Computer and Communications Security | https://doi.org/10.1145/2976749.2978341 | quantitative/technical | abstract (OpenAlex) |
| kiffer18 | Lucianna Kiffer et al. | 2018 | A Better Method to Analyze Blockchain Consistency | Proceedings of the 2018 ACM SIGSAC Conference on Computer and Communications Security | https://doi.org/10.1145/3243734.3243814 | quantitative/technical | abstract (OpenAlex) |
| kitzler25 | Stefan Kitzler et al. | 2025 | The economic impact of DeFi crime events on decentralized autonomous organizations (DAOs) | The Journal of Finance and Data Science | https://doi.org/10.1016/j.jfds.2025.100171 | quantitative/technical | abstract (OpenAlex) |
| nayak16 | Kartik Nayak et al. | 2016 | Stubborn Mining: Generalizing Selfish Mining and Combining with an Eclipse Attack | 2016 IEEE European Symposium on Security and Privacy (EuroS&amp;P) | https://doi.org/10.1109/eurosp.2016.32 | quantitative/technical | abstract (OpenAlex) |
| optselfish16 | Ayelet Sapirshtein et al. | 2017 | Optimal Selfish Mining Strategies in Bitcoin | Lecture Notes in Computer Science | https://doi.org/10.1007/978-3-662-54970-4_30 | quantitative/technical | abstract |
| race20 | Amir Dembo et al. | 2020 | Everything is a Race and Nakamoto Always Wins | Proceedings of the 2020 ACM SIGSAC Conference on Computer and Communications Security | https://doi.org/10.1145/3372297.3417290 | quantitative/technical | abstract |
| selfish14 | Ittay Eyal et al. | 2018 | Majority is not enough | Communications of the ACM | https://doi.org/10.1145/3212998 | quantitative/technical | abstract |
| sello26 | Buti Sello et al. | 2026 | 51% attack vulnerability of nascent blockchains: a comprehensive review | Complex & Intelligent Systems | https://doi.org/10.1007/s40747-026-02256-w | qualitative | abstract (OpenAlex) |
| tight20 | Peter Gaži et al. | 2020 | Tight Consistency Bounds for Bitcoin | Proceedings of the 2020 ACM SIGSAC Conference on Computer and Communications Security | https://doi.org/10.1145/3372297.3423365 | quantitative/technical | abstract |
| zhang-blockfreq | Ren Zhang et al. | 2019 | Lay Down the Common Metrics: Evaluating Proof-of-Work Consensus Protocols' Security | 2019 IEEE Symposium on Security and Privacy (SP) | https://doi.org/10.1109/sp.2019.00086 | quantitative/technical | abstract |
| bonneau15 | Joseph Bonneau et al. | 2015 | SoK: Research Perspectives and Challenges for Bitcoin and Cryptocurrencies | 2015 IEEE Symposium on Security and Privacy | https://doi.org/10.1109/sp.2015.14 | quantitative/technical | abstract (OpenAlex) |
| garaykiayias20 | Juan Garay et al. | 2020 | SoK: A Consensus Taxonomy in the Blockchain Era | Lecture Notes in Computer Science | https://doi.org/10.1007/978-3-030-40186-3_13 | quantitative/technical | machine summary (Semantic Scholar TLDR) only |
| flyclient20 | Benedikt Bünz et al. | 2020 | FlyClient: Super-Light Clients for Cryptocurrencies | 2020 IEEE Symposium on Security and Privacy (SP) | https://doi.org/10.1109/SP40000.2020.00049 | quantitative/technical | abstract |
| logspace21 | Aggelos Kiayias et al. | 2021 | Mining in Logarithmic Space | Proceedings of the 2021 ACM SIGSAC Conference on Computer and Communications Security | https://doi.org/10.1145/3460120.3484784 | quantitative/technical | abstract |
| nipopow20 | Aggelos Kiayias et al. | 2020 | Non-interactive Proofs of Proof-of-Work | Lecture Notes in Computer Science | https://doi.org/10.1007/978-3-030-51280-4_27 | quantitative/technical | machine summary (Semantic Scholar TLDR) only |
| szalachowski18 | Pawel Szalachowski | 2018 | (Short Paper) Towards More Reliable Bitcoin Timestamps | 2018 Crypto Valley Conference on Blockchain Technology (CVCBT) | https://doi.org/10.1109/cvcbt.2018.00018 | quantitative/technical | abstract |
| aguiar10 | Luís Aguiar-Conraria et al. | 2010 | How quorum rules distort referendum outcomes: Evidence from a pivotal voter model | European Journal of Political Economy | https://doi.org/10.1016/j.ejpoleco.2010.03.004 | quantitative/technical | bibliographic record only |
| ain26 | Qurrat Ul Ain et al. | 2026 | Dynamic Quorum Mechanisms: Enhancing Governance Performance and Stability in the Tezos Ecosystem | IEEE Access | https://doi.org/10.1109/ACCESS.2026.3723064 | quantitative/technical | abstract (OpenAlex) |
| aziz17 | Haris Aziz et al. | 2015 | Justified Representation in Approval-Based Committee Voting | Proceedings of the AAAI Conference on Artificial Intelligence | https://doi.org/10.1609/aaai.v29i1.9324 | quantitative/technical | abstract (OpenAlex) |
| herrera10 | Helios Herrera et al. | 2010 | Quorum and Turnout in Referenda | Journal of the European Economic Association | https://doi.org/10.1111/j.1542-4774.2010.tb00542.x | quantitative/technical | abstract (OpenAlex) |
| judmayer21 | Aljosha Judmayer et al. | 2021 | Pay to Win: Cheap, Cross-Chain Bribing Attacks on PoW Cryptocurrencies | Lecture Notes in Computer Science | https://doi.org/10.1007/978-3-662-63958-0_39 | quantitative/technical | bibliographic record only |
| kahng18 | Anson Kahng et al. | 2021 | Liquid Democracy: An Algorithmic Perspective | Journal of Artificial Intelligence Research | https://doi.org/10.1613/jair.1.12261 | quantitative/technical | abstract (OpenAlex) |
| lalley18 | Steven P. Lalley et al. | 2018 | Quadratic Voting: How Mechanism Design Can Radicalize Democracy | AEA Papers and Proceedings | https://doi.org/10.1257/pandp.20181002 | quantitative/technical | abstract (OpenAlex) |
| maniquet15 | François Maniquet et al. | 2015 | Approval quorums dominate participation quorums | Social Choice and Welfare | https://doi.org/10.1007/s00355-014-0804-0 | quantitative/technical | machine summary (Semantic Scholar TLDR) only |
| mosley22 | Lawrence Mosley et al. | 2022 | Towards a systematic understanding of blockchain governance in proposal voting: A dash case study | Blockchain: Research and Applications | https://doi.org/10.1016/j.bcra.2022.100085 | quantitative/technical | abstract (OpenAlex) |
| pjr17 | Luis Sánchez-Fernández et al. | 2026 | Proportional justified representation | Artificial Intelligence | https://doi.org/10.1016/j.artint.2026.104503 | quantitative/technical | abstract (OpenAlex) |
| weidener25 | Lukas Weidener et al. | 2025 | Delegated voting in decentralized autonomous organizations: a scoping review | Frontiers in Blockchain | https://doi.org/10.3389/fbloc.2025.1598283 | qualitative | abstract (Crossref) |
