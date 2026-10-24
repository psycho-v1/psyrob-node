# Operating the public node

These files run the public PSYROB node behind https://rpc.psyrob.com and https://explorer.psyrob.com. They are a
reference for operators; a normal node needs none of them (see the main `README.md` or `docs/WINDOWS-NODE.md`).

Layout of the public server: a user `psycho`; the code in `/home/psycho/psyrob`; the production clone the services run
from in `/home/psycho/psyrob-node`; keys in `/etc/psyrob`; node data in `/var/lib/psyrob-node`. The services run as the
user `psyrob`. Adjust the paths at the top of each file for another server.

## Files

| File | Purpose |
|---|---|
| `psyrob-node.service` | systemd unit of the node; signs bootstrap checkpoints with the three bootstrap keys |
| `psyrob-node.prelaunch.service` | the node unit's pre-launch form: serves only the launch ceremony page |
| `psyrob-miner.service`, `psyrob-miner.service.d/limits.conf` | systemd unit of the miner and its CPU limits (the miner address is in the drop-in `address.conf`, written by `KEYS.sh`) |
| `psyrob-watchdog.sh`, `.service`, `.timer` | health check every minute: restarts the node when `/health` stops answering or shows the wrong genesis, leaves a starting node alone, restarts the tunnel when only the public names fail |
| `check-before-mining.sh` | checks temperature, free memory and the node before the miner starts |
| `KEYS.sh` | step 1: makes the three bootstrap keys, the miner key and the release key (never prints a private key) and writes their public parts into `genesis/launch-87870.json` and `docs/RELEASE-KEY.pem` |
| `PRELAUNCH.sh` | step 2: serves the launch ceremony page |
| `LAUNCH.sh` | step 3: builds the genesis from the signed ceremony, builds and signs the downloads, installs the units and starts the network |

## Launch (chain 87870)

0. The production clone: `git clone /home/psycho/psyrob /home/psycho/psyrob-node && cd /home/psycho/psyrob-node && npm ci`
   (as `psycho`), and an empty data folder: `sudo install -d -m 0750 -o psyrob -g psyrob /var/lib/psyrob-node`.
1. `sudo bash deploy/KEYS.sh`, then commit `genesis/launch-87870.json` and `docs/RELEASE-KEY.pem` and tag
   `v10.0.0-prelaunch`. Back up `/etc/psyrob/*.key` and `/home/psycho/.psyrob-release/release.key` offline.
2. `sudo bash deploy/PRELAUNCH.sh`: https://explorer.psyrob.com/launch shows the ceremony; the three Dev Account
   holders sign.
3. `sudo bash deploy/LAUNCH.sh`.

Memory: the node takes up to 1.4 GB (1 GiB heap). A contract compile (`forge build`, via-IR) needs about 2 GB more:
pause other services first on this 3.3 GB server.
