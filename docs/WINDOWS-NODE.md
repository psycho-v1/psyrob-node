# Run a PSYROB node on Windows

This guide runs a follower node of the PSYROB testnet (chain ID **87870**, `0x1573e`) on a Windows PC. The node
does not mine. Node 10.0.0 or newer is required.

> **Use a new wallet key for this network.** Never reuse a key that was used on any other network.

> **Nobody starts with PSY.** There is no airdrop and no developer float: the developers, you and everyone else start with
> 0 PSY and obtain PSY only by mining. Anyone may run a node and a miner.

Your node connects **out** to the public node over `wss://rpc.psyrob.com/p2p`, a normal HTTPS/WebSocket connection.
You do **not** need port forwarding, router changes or a firewall rule, and nothing on your PC is exposed.

## 1. Install (once)

1. **Node.js 22 LTS or newer** from https://nodejs.org (Windows Installer `.msi`), default options.
2. **Git for Windows** from https://git-scm.com/download/win, default options.
3. In **PowerShell**:
   ```powershell
   node --version     # v22.x or higher
   git --version
   ```

## 2. Get the code (once), in a new folder


```powershell
cd $HOME\Documents
git clone https://github.com/psycho-v1/psyrob-node.git psyrob-node
cd psyrob-node
npm ci
```

## 3. Check you have the right network (must match exactly)

```powershell
npm run genesis:check
```

It must end with:

```
chain ID:              87870 (0x1573e), network testnet
genesis hash:          0xe80031e7dec18c0693f15cfc685b01dd6a226b2392ff08c85ec6e782549d7a15
```

If it prints anything else, or a line starting with `MISMATCH`, stop: you are not on the PSYROB testnet. Don't edit anything in `genesis\`.

## 4. Start the node

Double-click **`Start-PSYROB.bat`** in the `psyrob-node` folder, or in PowerShell:

```powershell
.\Start-PSYROB.bat
```

Keep the window open. You should see:

```
psyrob 10.0.0: chain 87870, genesis 0xe80031e7dec18c0693f15cfc685b01dd6a226b2392ff08c85ec6e782549d7a15
P2P on …, HTTP/RPC and explorer on http://127.0.0.1:8787
```

The node then downloads the block DAG into `psyrob-node\data`. If Windows asks whether to allow Node.js through
the firewall, you can click **Cancel**: the node listens only on `127.0.0.1` and only connects out.

## 5. Check you are in sync

Compare `chainHeight` and `tip` on these two pages; they must match (or differ by a block or two for a few seconds):

- your node: http://127.0.0.1:8787/health
- public node: https://rpc.psyrob.com/health

Your own copy of the explorer is at http://127.0.0.1:8787/

## Everyday use

- **Stop:** `Ctrl+C` in the node window (or close it). **Start again:** `Start-PSYROB.bat` (continues from `data\`).
- **Update** (when a new release is announced):
  ```powershell
  cd $HOME\Documents\psyrob-node
  git pull
  npm ci
  npm run genesis:check
  ```
- Wallet: network name `PSYROB testnet`, RPC `https://rpc.psyrob.com` (or your own `http://127.0.0.1:8787/rpc`),
  chain ID `87870`, symbol `PSY`.

## Troubleshooting

| You see | Do |
|---|---|
| `node` is not recognized | Reinstall Node.js 22+ and open a **new** PowerShell window |
| `MISMATCH` from `genesis:check` | Stop, and open an issue on GitHub with the hash it prints |
| no new blocks after a minute | Check that https://rpc.psyrob.com/health opens in your browser; if it does, open an issue on GitHub |
| port 8787 already in use | Another program uses the port: close it, or change `--http-port 8787` to `8788` in `Start-PSYROB.bat` |

