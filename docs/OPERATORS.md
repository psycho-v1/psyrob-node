# Notes for node and signer operators

Things that can go wrong when you run a PSYROB node, especially one that signs checkpoints.

## The LOCK file

The node writes its process number into `<data folder>/LOCK` while it runs and removes it when it stops. After a crash
the file stays behind. On the next start the node checks whether that process number still belongs to a running
program. If you restart in a different environment (another container, a reboot that hands out the same numbers), an
old number can point at some other program, and the node refuses to start with "data directory … is in use".

What to do: make sure no node is running on that data folder (`ps`, or `systemctl status psyrob-node`), then delete
the `LOCK` file and start again.

## Never run a signing key in two places

A node started with signing keys (`--signer-key`, once per key; on the public node the three bootstrap keys, which
sign checkpoints until the first finality committee, 2 of 3 needed) signs each checkpoint once per key. It remembers
which ones each key signed in `<data folder>/signed-checkpoints.json` (the last 15,000 entries).

- Never run the same key on two machines or two data folders at the same time. Both would sign, possibly different
  blocks for the same checkpoint number. That is equivocation: a committee member loses 90 % of the bond, and during
  bootstrap two conflicting checkpoints can split the network.
- Keep `signed-checkpoints.json` in every backup of the data folder, and restore it with the folder. A node that loses
  it may sign a checkpoint number again.
- Moving a signer to a new machine: stop the old node first, copy the data folder (including that file), then start the
  new one.
- Moving one bootstrap key off the public server: start the other machine's node with that key only after the
  public node runs without it (remove its `LoadCredential=`, `ExecStartPre=` and `--signer-key` lines from the unit and
  restart), and copy `signed-checkpoints.json` along. Nothing changes on chain: the list names addresses, not machines.

## A node that is starting is not dead

After a restart the node replays every stored block before it serves the chain. That takes minutes on a long chain.
Meanwhile `/health` answers 503 with `"starting": true` and the progress, and every page says "The node is starting".
Do not restart it, and do not delete its data: it is working. The watchdog leaves a starting node alone.
A node that is still catching up with the network says so in `/health` (`"syncing"`) and refuses to hand out mining
work until it has caught up; a miner pointed at it waits.

## Releases and the release key

`SHA256SUMS.txt` of every release is signed with the release key (Ed25519). The private key is
`/home/psycho/.psyrob-release/release.key` on the build server (mode 0600, made by `deploy/KEYS.sh`, never
printed); its public part is `docs/RELEASE-KEY.pem` in the repository and `release-key.pem` next to the downloads.
Back the private key up offline. Anyone can check a download:

    node scripts/verify-release.mjs <folder with the downloads>

and, after building the same tag themselves with the Node.js version named in `manifest.json`:

    node scripts/verify-release.mjs <downloads> --rebuilt <their dist/downloads>
