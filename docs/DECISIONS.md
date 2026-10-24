# Decisions

Owner decisions and the design choices behind the current network, with their reason and, where one applies, the
peer-reviewed basis (source ids refer to `docs/research/bibliography.json`; what was read is marked). The rules
themselves are in `docs/dag/DAG_SPEC.md`.

| Decision | Date | Reason and basis |
|---|---|---|
| Chain ID **87870** for the testnet; a mainnet gets a chain ID of its own | 24 October 2026 | Owner's choice. Checked unused on chainid.network (2,830 chains) and ethereum-lists. Wallet transactions (EIP-155) carry only the chain ID, so every page tells users to use a new key for this network. |
| Bootstrap finality: **2 of 3 dedicated keys** that do not mine and hold no PSY; all three on the public server for now; at most 12 months; only a DAO vote replaces them, and only with a majority quorum | 24 October 2026 | Finality from the first block without trusting one key. Two majorities of one set always share a member, so two conflicting certificates carry proof of the fault [pbft99, lamport82; abstracts read]. Keys on one server protect against one lost, leaked or doubly-run key, not against the server; separate machines are a mainnet precondition. |
| After the dev council's 12-month sunset with fewer than 60 NGOs, the council keeps only the rate-limited emergency pause; node updates then need the DAO | 24 October 2026 | A limited, visible brake stays available; no new powers. Foundry test at genesis + 366 days with 10 NGOs. |
| Block templates leave out parents that validation would refuse; no templates while a node catches up | 24 October 2026 | A stale tip must never stop mining. Mirrors the existing merge-depth rule [ghostdag21; full text]; validation is unchanged. |
| Old block data leaves memory (cold file), heap 1 GiB | 24 October 2026 | Measured about 5.3 kB of heap per block for full entries and 0.4 kB for cold ones; engineering measurement, no research decision. |
| Peer blocks are proof-of-work checked in a worker thread | 24 October 2026 | The node must keep answering while it checks 32 MiB Argon2d proofs; engineering practice. |
| Every RPC list method has range and result limits (`docs/RPC-LIMITS.md`) | 24 October 2026 | No single request may stall the node; engineering practice. |
| Consensus arithmetic integer-only; total orders on consensus sorts | 24 October 2026 | Identical ordering and state on every node is what GHOSTDAG's security argument assumes [ghostdag21]. |
| Address manager unchanged (bucketed tables, source groups, secret key) | 24 October 2026 | Eclipse-attack countermeasures [eclipse15; countermeasures section read in full]. |
| NGO names: small ASCII character set, look-alike folding, "unverified" until attested, release on rejection | 24 October 2026 | Against squatting and look-alike impersonation of real NGOs; no research decision. |
| The official miner only (no native miner) | 24 October 2026 | Owner's choice. The miner checks templates before signing, keeps all threads busy during a submission, retries passing failures, fails over between nodes and stores its key encrypted. |
| Releases plain, reproducible and signed with a published Ed25519 key | 24 October 2026 | A checksum list served by the same host is not enough; reproducible builds let anyone tie a release to its source [lamb22; abstract read], [nikitin17; abstract and summary read]. |
| One shared name for every version label (`NODE_VERSION`) | 24 October 2026 | Labels cannot drift apart. |
| The dev council, upgrades with public timelocks, the emergency pause | 15 October 2026 | DAG_SPEC.md section 17 and its sources there. |
| The team's 12 % in three equal, immutable DevVesting contracts | 12 October 2026 | Three team members, each with an account of their own. |

Not done, and why: an independent third-party audit (needed before a mainnet); incremental state roots and full pruning
with snapshots (the cold store bounds memory, not disk or replay time); more public nodes (an operational task); a
signed Windows executable (no certificate); a WebAssembly Argon2d without the 32 MiB wipe after each hash (needs a
WebAssembly toolchain this server does not have).
