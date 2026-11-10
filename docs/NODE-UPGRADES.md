# Node upgrades without a new network

PSYROB has two different procedures. Use the right one.

| | Node upgrade (this page) | Launch ceremony (deploy/README.md "Launch") |
|---|---|---|
| When | A new node release, including new consensus rules | A new network: a new genesis, balances reset |
| Chain, balances, history | Stay | Start again |
| Who signs | 2 of the 3 dev council keys, on chain | The 3 Dev Account wallets sign the genesis |
| Where | Explorer, Governance → Node upgrade approval (`/upgrade`) | The pre-launch server (`/launch`) |

## Release number and protocol version

Every node has two numbers (node/src/params.js):

- `NODE_VERSION`: the release number (11.0.3, 11.1.0, …). It names the download and changes with every release.
- `PROTOCOL_VERSION`: the consensus rules the node implements, as the UpgradeRegistry contract counts them. Every fresh
  genesis starts at the registry's `BASE_VERSION`, **10.0.0**.

The node compares the version the network requires (`UpgradeRegistry.requiredVersion`) with its protocol version.
If the network requires more, the node stops following the chain at that block and says so in its log, in `/health`
and on the explorer, instead of following a chain whose rules it does not know.

Which releases need an upgrade plan:

- **No consensus change** (explorer, RPC, P2P, performance, memory, tools): keep `PROTOCOL_VERSION`, release as
  usual. No plan, no signatures. Operators update when they like.
- **New consensus rules** (block validity, execution, gas, state, rewards): raise `PROTOCOL_VERSION` by one minor step
  (10.0.0 → 10.1.0 → 10.2.0 …), and gate the new rules on the required version reaching it, so every node switches at
  the same block.
- **A fix every node must run** without new rules: one patch step (10.1.0 → 10.1.1).

The first protocol step is **10.1.0** (release 11.2.0): the audit F-05 gas rules (DAG_SPEC.md section 5.1). Until
the council's plan for it is in force, a 10.1.0 node applies the old rules, so it can be installed early.

Before the handover the council can approve only one step above the version in force: the next minor or the next
patch. A larger jump needs a DAO vote (an Upgrade proposal), available once 60 NGOs are elected.

## Step by step

1. **Build and publish the release.** Commit, tag, `npm run release`, publish the files with `SHA256SUMS.txt` and
   its signature. Note the commit hash and `sha256sum SHA256SUMS.txt`.
2. **Submit the plan** on `/upgrade` ("Propose a node update"), from any wallet with a little PSY for gas:
   - Protocol version: the page offers the steps the council may approve.
   - Git commit and SHA-256 of `SHA256SUMS.txt` from step 1.
   - Description: keep the template's lines, which the approval page reads:
     ```
     PSYROB node 11.1.0: one-line summary
     Release: 11.1.0
     Consensus change: yes
     Changes:
     - …
     ```
   The description is published in the `Submitted` event and its keccak256 hash is stored in the plan; the page shows
   whether the text matches.
3. **Council signatures.** Each council member opens `/upgrade/<plan>`, checks the release (step "Check it yourself"
   on the page), connects the wallet holding their **council key** (not the Dev Account wallet) and presses:
   - the first: **Sign: start the approval** (DevCouncil `propose`, action "approve update", argument = plan number);
   - the second: **Sign: approve this update** (DevCouncil `approve` of that action).

   The second signature must come within 3 days of the first, or the first expires and someone starts again. While
   signatures are being collected, every explorer page shows a banner linking to the plan.
4. **Timelock.** With two signatures the plan is approved and waits 7 days in public. The banner says when it takes
   effect. Operators install the release in this time. The council can still cancel (two keys again).
5. **In force.** The first chain block after the timelock raises `requiredVersion`. Nodes with the new release apply
   the new rules from that block; older nodes stop there and ask for the update.

## How the signatures are checked

Nothing is checked by the explorer alone. The DevCouncil contract accepts `propose` and `approve` only from the three
council keys named at the launch ceremony (or their replacements, after the public 48-hour key change), records each
seat's signature as a bit (`getAction(id).approvals`), refuses a second signature from the same seat, and calls
`UpgradeRegistry.approve(plan)` itself when the second seat signs. UpgradeRegistry refuses versions that are not one
step up, and starts the timelock. Anyone can read all of it on `/contract/DevCouncil` and `/contract/UpgradeRegistry`
or with `eth_call`.

## Moving to this scheme (once)

Nodes up to release 11.0.3 compare the required version with their release number (11.0.3) and would not stop at a
required protocol version of 10.1.0. Before the council approves the first protocol step, make sure every known node
(the public node, the miners' nodes, PSYROB Suite) runs a release with `PROTOCOL_VERSION`.
