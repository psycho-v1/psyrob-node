# PSYROB security analysis

Design analyses the specification refers to (`docs/dag/DAG_SPEC.md`), and the risks that remain. Source ids in
brackets refer to `docs/research/bibliography.json`.

## 1. Role-election tie draw: how much can it be biased?

**Rule** (`RoleElection`):
- **Recording the tie:** when voting closes, the node's system call records any tie at the first chain block after the
  close (chain height `t`). Nobody chooses that moment.
- **The seed:** the committee's randomness beacon (section 3); if nobody reveals, the hash of the first finalised
  checkpoint at or after height `t + 30`, mixed with the round ID and the role.
- **The winner:** `tied[seed mod count]`, with the tied candidates sorted by address.
- **Fallback:** only if no checkpoint at that height is finalised within 8,640 blocks (about 24 h), the seed falls back
  once to the hash of a chain block 30 blocks after the fallback.

The seed does not exist when voting closes, and nobody chooses which block supplies it. The draw runs exactly once.

**What a miner can do with the checkpoint source: withhold.** A miner whose block would become the chain block at the
seed height learns the outcome before publishing it (the round ID and role are public). If the outcome is unwelcome, it
can throw the block away and hope the next block at that height gives a better one. Let `α` be the probability that
the attacker produces the chain block at that height (about its share of the hash rate; a little more in a DAG, where a
parallel block at the same height can win the selected-parent tie-break). Let `n` be the number of tied candidates.
Each withholding is a fresh coin, so the favoured candidate wins with probability

`P = 1 / (n − α(n − 1))`, instead of `1/n`.

| α (attacker's share) | n = 2 | n = 3 |
|---|---|---|
| 10 % | 52.6 % (fair 50 %) | 35.7 % (fair 33.3 %) |
| 30 % | 58.8 % | 41.7 % |
| 50 % | 66.7 % | 50.0 % |

Every withheld block costs the attacker that block's reward and fees, and the attempt shows up as a missing block at a
known height.

**Why the checkpoint source limits it:**
1. The seed height is fixed when the tie is recorded, 30 blocks ahead. Nobody can wait for a convenient block, and it
   cannot be re-rolled after the draw, because the draw runs once and the node runs it in the first block where the
   seed exists.
2. Only a finalised checkpoint counts. Once it is final, a reorganisation cannot replace the seed block, so a miner
   cannot rewrite history to change an outcome that is already known.
3. The committee cannot choose the outcome. It can only refuse to finalise. To force the fallback, at least 7 of 21
   members (a blocking minority) must stall finality for 24 hours in public. That buys one re-roll, at the cost of
   their committee rewards and an obvious stall.

## 2. Committee draw: seed sources and remaining bias

**Rotations (every committee after the first)** are seeded by the committee's randomness beacon (section 3). Only if
nobody reveals do they fall back to the hash of the first finalised checkpoint at or after 30 blocks later, mixed with
the epoch; for that fallback the analysis of section 1 applies:
- The candidates, weights and operators are frozen before the seed exists, so nobody can grind them against a known
  seed.
- The only influence is a miner withholding the checkpoint block.
- Forcing the one-shot fallback takes a blocking minority of 7 members stalling finality for 8 hours in public.

**The first committee** cannot use the beacon or a committee checkpoint: no committee exists before it. The options
considered:

| Option | Remaining bias | Verdict |
|---|---|---|
| Hash of the block just before the seal | The sealing block's miner knows and can withhold; candidates could also adjust after seeing it | rejected |
| Commit-reveal among bonded candidates (RANDAO) [randao] | The last revealer can abort; several colluding candidates gain one bit each; needs extra rounds and bonds | rejected: more bias with colluding candidates, more machinery |
| Several block hashes combined | The miner of the last block still decides the result | no gain |
| Verifiable delay function | Unbiasable, but needs an EVM precompile that does not exist here | not available |
| **Hash of the chain block 30 blocks after the freeze (chosen)** | Withholding by the miner of that one block | least biasable option available |

**Remaining bias of the first committee:**
- **Effect:** for any outcome the attacker wants (for example "I get at least 3 seats") with fair probability `p`,
  withholding raises it to `p / (1 − α(1 − p))`, where `α` is its share of the hash rate. Example: α = 30 % and
  p = 20 % gives 26.3 %.
- **Cost:** every withheld block costs that block's reward.
- **Bounds:** at most 3 seats per declared operator; NGO seats only for elected NGOs; the candidate list is fixed before
  the seed exists; the first committee serves one epoch, and every later one is seeded by the beacon.

## 3. The randomness beacon

Every bonded address may commit to the top of a hash onion, `keccak^N(secret)` (the node derives the secret from the
signer key and commits automatically; N = 4,096). When a draw needs a seed (the committee freeze, or a role-election
tie) a beacon round opens. For 60 chain blocks the members of the committee then signing reveal the next layer of their
onion; the round's mix is the hash of all reveals, and the draw is sealed from it. Only commitments made before the
round opened count.

- **What it removes:** the miner of a seed block has no influence.
- **What remains:** a member can see earlier reveals and stay silent, choosing between two outcomes; k colluding
  members choose among up to 2^k. Silence is visible on chain and costs the member that epoch's committee reward
  (`missedReveal`). Because layers are fixed by the commitment, no member can choose a value, only withhold one. This is
  the known last-revealer limit of commit-reveal [randhound17]; removing it needs threshold signatures or a verifiable
  delay function [vdf18], neither available as an EVM precompile here.
- **Fallback:** if nobody reveals, or no committee exists yet (the first committee), sections 1 and 2 apply.
- **Cost:** one commit transaction per member every 4,096 rounds, and one reveal per round (about one a week, plus role
  ties). Members need a little PSY for gas.

Sources (known from earlier reading, not re-read in full): [randhound17] E. Syta et al., "Scalable Bias-Resistant
Distributed Randomness", IEEE S&P 2017; [vdf18] D. Boneh, J. Bonneau, B. Bünz, B. Fisch, "Verifiable Delay
Functions", CRYPTO 2018.

## 4. Open risks and limits

1. **No independent audit.** An independent third-party audit is required before a mainnet.
2. **Token-weighted voting concentrates power** [fritsch24], [feichtinger23]; approval voting is not proportional
   [aziz17].
3. **Sybil limits:** per-address caps cannot detect one operator with many addresses [sybil02]. The voucher cap raises
   the cost of placing many NGOs but does not identify operators; the legal identity of an NGO is checked off-chain by
   challengers (docs/RISK_REVIEW.md 3.2).
4. **CPU mining invites botnets** [botcoin14], [cryptominer19].
5. **Bootstrap finality** rests on three keys that are, for now, on one server (DAG_SPEC.md section 9.1).
6. **No historical state** (RPC answers state queries for the latest block only), and a restart replays the whole block
   log (audit F-08). Old block data leaves memory and state roots are incremental (F-01), but start-up time still grows
   with the chain (68,795 blocks took ~30 minutes on 10 November 2026); state snapshots are the planned fix.
7. **The BNB volunteer fund is not deployed.** Each committee handover must be relayed to BNB Chain by someone (any
   party can relay; the contract checks the signatures). The node signs fund transfer records but does not yet build or
   sign the committee handover (audit F-14): that signer must exist before the fund is deployed.
8. **Server resources:** the server running the public node has 16 GB of memory (3.3 GB until 10 November 2026)
   shared with other services, and it is the only public node (audit F-10).
9. **Capture of the first election** by a party with a large share of the hash rate is made slower, visible and
   costlier, not impossible (docs/RISK_REVIEW.md 3.7).
10. At each NGO term boundary the elected count is 0 until the main round is finalised, so the mode shows Interim
    briefly, and committee and governance pause. A role-election round due at that moment opens once Normal mode
    returns.
11. A member's node signs every FundApprovals record automatically, so control of the Governor implies control of fund
    approvals. That is the design (the fund follows governance), with the BNB-side multisig and timelock as the brake.
12. Miners can move timestamps within the ±120 s drift; epochs depend on `block.timestamp`, so epoch boundaries can
    shift by up to that much.

## 5. v11 audit (BASE-F 2.0, commit 2789047): status of the open findings

Fixed in 11.1.0: F-01 (incremental state root), F-03 (`eth_call` off the chain lock), F-04 (merge-depth check before
GHOSTDAG), F-06 (per-peer requests), F-13 (test), I-4; F-05 is mitigated there by the template gas policy and fixed
by protocol 10.1.0.

| ID | Status | Reason |
|---|---|---|
| F-02 | Accepted testnet risk (owner decision) | The bootstrap finality, miner and release keys stay on one host for the testnet; they move to separate machines and holders before a mainnet. |
| F-07 | Accepted testnet risk (owner decision) | Chain ID 87870 and the v10 keys are kept; the replay warning above and on every explorer page stays. |
| F-09 | Accepted testnet risk (owner decision) | The 2-of-3 dev council approves node updates and can pause until the NGO handover, as specified. |
| F-05 | Fixed in protocol 10.1.0, in force once the council's node update is | Mergeset budget 10 M gas and four precompiles repriced (DAG_SPEC.md 5.1): the worst full mergeset 17 s -> 2.4 s; until the update is in force only the template policy of 11.1.0 applies. |
| F-08 | Future work | State snapshots are a larger change that must be proven to give the same state roots; until then every start replays the block log (section 4.6). |
| F-10 | Accepted testnet risk | One public node (explorer, RPC, seed); more independent operators are needed, not code. |
| F-11 | Mitigated in the explorer | Names cannot be unique (genuine NGOs share names, for example national branches); the explorer lists namesakes with country and registration and warns when two records claim the same country and registration reference, and a false record is removed by a challenge (8.3). |
| F-12 | Accepted testnet risk | A lapsed challenge refunds its bond, so one undecided challenge can delay an attestation by up to 14 days at no cost; changing `Attestation` is a contract update that needs a DAO vote (DAG_SPEC.md 18.3). |
| F-14 | Future work, before deployment | The volunteer fund is not deployed; the node-side committee handover signer is built before it is (section 4.7). |
| I-7 | Owner | psyrob.com still names Testnet v10; the explorer is already correct. |

