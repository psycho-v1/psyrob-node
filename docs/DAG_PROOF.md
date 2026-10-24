# PSYROB is a block DAG

11 October 2026. Evidence that the network is a block DAG and not a linear chain: the code paths, the tests and
their measured results, what the selected chain is for, and the expected DAG width.

## 1. Code paths

| Property | Where | What it does |
|---|---|---|
| Blocks reference multiple parents | `common/header.js` (`parents`: 1 to 10, sorted); `node/src/template.js` `buildTemplate` (parents = `dag.virtualParents()`: every DAG tip, up to 10, heaviest first) | A miner's block points at all tips it knows. |
| Parallel blocks are kept | `node/src/consensus.js` `_addBlock` / `_connect` | Every valid block is added to the DAG, whatever its position. Nothing is discarded for being "off the chain". Blocks with unknown parents wait as orphans until their parents arrive; they are not dropped. |
| They are merged | `node/src/dag.js` `ghostdag` → `mergesetOf` | A new block's mergeset is past(B) \ past(selected parent): every block it newly references, chain or not. |
| Ordering is GHOSTDAG | `node/src/dag.js` `ghostdag`, `checkBlueCandidate`, `blueAnticoneSize`; `virtualParents` | Blue/red colouring with the anticone bound k = 18. Mergeset order is the selected parent, then ascending (blue work, hash). The virtual's selected parent is the tip with the most **blue work**, not the longest chain. |
| Transactions in parallel blocks are executed | `node/src/consensus.js` `acceptMergeset` | The loop over `gd.orderedMergeset` runs every transaction of every merged block (conflicts and duplicates are skipped, not fatal). |
| Miners of parallel blocks are rewarded | `acceptMergeset`, loop over `gd.mergesetBlues` | Subsidy for every blue block in the mergeset, chain or parallel. Priority fees go to the containing block's miner when it is blue (to the merging block's miner when red). `MinerRegistry.recordBlocks` counts every blue block. |
| Sync covers the whole DAG | `node/src/p2p.js` GETCHAIN/CHAIN, orphan parent requests | The chain locator finds the common point. Every block in the past of the peer's chain arrives as a parent, and the final reply lists all DAG tips, so unmerged parallel blocks are synced too (fixed 11 October; `dagnet.test.js`). |
| Every valid block is announced | `node/src/node.js` `onChainEvent('block')` → `p2p.announce` | Parallel blocks are relayed like chain blocks. |

## 2. Tests and measured results

| Test | Setup | Result |
|---|---|---|
| `node/test/dagproof.test.js`, six miners | 6 miners, each with its own full node; Poisson blocks (one per 10 s in total); every block reaches the others 8 s later (±25 %); 120 blocks; transfers sent through different miners | **121 blocks on a 74-block chain: width 1.64.** 49.6 % of blocks have 2+ parents; largest mergeset 4. **0 orphaned, 0 unmerged, 0 red.** All six nodes have the same DAG, tip and state root. 30 transfers, all executed, 15 of them carried by parallel (non-chain) blocks. 47 blue blocks off the selected chain were rewarded; `MinerRegistry.minedTotal` equals each miner's blue-block count. |
| `node/test/dagproof.test.js`, ordering | A private linear chain of 3 blocks against an honest DAG of 3 parallel blocks plus 1 merging block | The private chain is longer (chain height) but has less blue work. The node keeps the honest DAG: **GHOSTDAG, not longest chain.** |
| `node/test/dagnet.test.js`, real network | 5 nodes over TCP, 5 separate miner programs, 2 s added delay on every received block | 38 blocks on a 17-block chain: width 2.24, **42.1 % of blocks with 2+ parents**, largest mergeset 5. **0 orphaned**: every node holds every block. The miners were stopped mid-run, so 3 tips were left unmerged; a late sixth node synced all 39 blocks, those 3 tips included. (A first run gave 21 blocks, width 1.75, 61.9 %; the numbers vary between runs.) |
| `node/test/dagnet.test.js`, tips | A peer with two parallel tips nobody has merged | The joining node syncs both tips. Without the 11 October fix it got 3 of 4 blocks. |
| `node/test/ghostdag.test.js` | 7 parallel blocks with k = 3 | k + 1 blue, 3 red; red miners unpaid; blue miners paid. |
| `node/test/consensus.test.js` | Parallel blocks with the same transaction | Accepted once, skipped once; both miners paid. |

## 3. What the selected chain is for, and why the network is not linear

Every block names one of its parents as its **selected parent**: the one with the most blue work. Following selected parents from the heaviest tip back to genesis gives the **selected chain**. It is a spine through the DAG. It is used for:
- **Accepting mergesets:** each chain block executes the blocks it newly merges. This gives one deterministic order for all transactions (the "total order" GHOSTDAG defines).
- **The Ethereum view:** wallets need block numbers, so Ethereum block number n is the chain block at height n, and its transactions are the ones it accepted. Parallel blocks are reachable by hash (`eth_getBlockByHash`, `psy_getDagBlock`, `psy_getDagRange`).
- **Checkpoints:** the committee signs every 30th chain block. A checkpoint finalises that block's whole past, which includes every parallel block it merged.
- **Time and difficulty:** the past median time and the ASERT anchor use the selected parent.

None of this discards blocks or work:
- Parallel blocks are kept and merged, and their transactions are executed.
- Their miners are paid, and their work counts in the blue work that chooses the chain.
- A longest-chain node would orphan every parallel block; this node orphans none (section 2).

**Remaining places that look at chain blocks only, and why they stay:**

| Component | Behaviour | Status |
|---|---|---|
| Sync | Located by chain hashes; side blocks came only as parents | **Fixed**: the final reply carries all tips |
| RPC block numbers | Chain heights, for wallet compatibility | Kept by design; DAG fields added: `dagParents`, `blueScore`, `mergesetBlues`, `mergesetReds` on blocks; `psy_getDagBlock` (parents, children, blue score, blue work, colour, merged by, mergesets); `psy_getDagRange` |
| Explorer | Chain-block list plus strands on the home page | **Fixed**: the DAG page draws the graph with every parent link (`node/web/dag-graph.js`), chain or parallel, blue, red and not-merged-yet |
| Finality | Checkpoints are chain blocks | Correct for a DAG: finalising a chain block finalises its whole past |
| Rewards | Every blue block in a mergeset | DAG-native; only red blocks earn nothing (GHOSTDAG design) |
| Difficulty | ASERT on blue score | Counts blue blocks, chain and parallel (see the risk review, Part 4) |

## 4. Expected DAG width at 10 s per block

Simulation `scripts/dag-width.mjs` (3,000 blocks, GHOSTDAG k = 18, equal miners). The fraction of parallel blocks is about (1 − 1/N)(1 − e^(−D/10)). It depends on the network delay D, not on how many miners there are: the total block rate is fixed by the difficulty.

| Miners | Delay 1 s | Delay 2 s | Delay 5 s |
|---|---|---|---|
| 1 | width 1.00, 0 % with 2+ parents | 1.00, 0 % | 1.00, 0 % |
| 10 | 1.09, 9.0 % | 1.17, 16.5 % | 1.43, 36.6 % |
| 100 | 1.11, 10.4 % | 1.20, 18.9 % | 1.50, 40.2 % |

- **One miner:** it always builds on its own last block, so there are no parallel blocks.
- **Expected in practice:** with a realistic delay of 1 to 2 s (propagation plus 40 ms of Argon2d checking), about 10 to 20 % of blocks have two or more parents.
- **Red blocks:** none in any run. k = 18 tolerates far more parallelism than 10 s blocks produce.
- **Why parallel blocks are rare:** the locked 10 s interval keeps them rare, and this is safe. The DAG makes them harmless when they occur (nothing is wasted, no one is penalised for latency), rather than frequent.
