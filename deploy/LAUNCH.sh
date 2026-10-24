#!/bin/bash
# PSYROB launch, step 3 of 3: start the network after the launch ceremony (DAG_SPEC.md section 17.1). Run once,
# as root, when https://explorer.psyrob.com/launch shows all three seats signed:
#
#   sudo bash /home/psycho/psyrob/deploy/LAUNCH.sh
#
# In order: check the signed ceremony file (/var/lib/psyrob-node/launch.json); in the dev repository (as psycho):
# build genesis/genesis-87870.json from it (start time = now), write the new genesis hash into genesis/chain.json and
# the watchdog, run the genesis check, commit and tag v10.0.0, and build the downloads, signed with the release key
# (/home/psycho/.psyrob-release/release.key, from deploy/KEYS.sh); then stop the pre-launch page, move the production
# clone (/home/psycho/psyrob-node) to the tag, copy the downloads, install the node and miner units and the watchdog,
# start the node and wait up to 180 s for /health with the new genesis. If it does not come up, the pre-launch page
# comes back (the signatures are kept) and the script exits non-zero. Then the miner starts if
# deploy/check-before-mining.sh passes, and the watchdog timer starts. Log: /var/log/psyrob-launch.log.
set -euo pipefail

TAG=v10.0.0
R=/home/psycho/psyrob-node
DEV=/home/psycho/psyrob
DATA=/var/lib/psyrob-node
LOG=/var/log/psyrob-launch.log
[ "$(/usr/bin/id -u)" = 0 ] || { echo "run it with sudo: sudo bash $DEV/deploy/LAUNCH.sh"; exit 1; }
RELKEY=/home/psycho/.psyrob-release/release.key
[ -s "$RELKEY" ] || { echo "no release key $RELKEY: run deploy/KEYS.sh first"; exit 1; }
touch "$LOG"; chmod 0644 "$LOG"
exec > >(tee -a "$LOG") 2>&1
say() { echo "$(date -u '+%F %T UTC') | $*"; }
asme() { sudo -u psycho -H "$@"; }

[ -f "$DATA/launch.json" ] || { say "no $DATA/launch.json: run deploy/PRELAUNCH.sh and the ceremony first"; exit 1; }
signed=$(node -e "const l=JSON.parse(require('fs').readFileSync('$DATA/launch.json','utf8'));console.log((l.launchSignatures||[]).filter(Boolean).length)")
[ "$signed" = 3 ] || { say "only $signed of 3 seats are signed: the ceremony is not complete"; exit 1; }

# a second run (after a later step failed) keeps the genesis already committed and tagged: rebuilding it would give a
# new start time and so a new genesis hash
if asme git -C "$DEV" rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  GENESIS=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$DEV/genesis/genesis-87870.json','utf8')).hash)")
  [[ "$GENESIS" =~ ^0x[0-9a-f]{64}$ ]] || { say "no genesis hash"; exit 1; }
  asme git -C "$DEV" diff --quiet "$TAG" -- genesis/genesis-87870.json || { say "genesis/genesis-87870.json differs from tag $TAG"; exit 1; }
  asme bash -c "cd '$DEV' && node genesis/check.js"
  say "resuming: $TAG exists, genesis $GENESIS checked"
else
  say "building the genesis from the signed ceremony"
  install -o psycho -g psycho -m 0644 "$DATA/launch.json" "$DEV/genesis/launch-87870.signed.json"
  asme bash -c "cd '$DEV' && node genesis/build.js --launch genesis/launch-87870.signed.json --out genesis/genesis-87870.json"
  GENESIS=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$DEV/genesis/genesis-87870.json','utf8')).hash)")
  [[ "$GENESIS" =~ ^0x[0-9a-f]{64}$ ]] || { say "no genesis hash"; exit 1; }
  asme bash -c "cd '$DEV' && sed -i -E 's/\"genesis\": (null|\"0x[0-9a-f]{64}\")/\"genesis\": \"$GENESIS\"/' genesis/chain.json && sed -i -E 's/^GENESIS=0x[0-9a-f]{64}/GENESIS=$GENESIS/' deploy/psyrob-watchdog.sh && sed -i -E 's/0x0{64}/$GENESIS/g' docs/WINDOWS-NODE.md"
  asme bash -c "cd '$DEV' && node genesis/check.js"
  say "genesis $GENESIS checked"

  say "commit and tag $TAG"
  asme git -C "$DEV" add genesis/genesis-87870.json genesis/launch-87870.signed.json genesis/chain.json deploy/psyrob-watchdog.sh docs/WINDOWS-NODE.md
  asme git -C "$DEV" commit -q -m "Genesis $GENESIS, chain 87870 (launch ceremony signed by Dev Accounts 1-3)"
  asme git -C "$DEV" tag -a "$TAG" -m "PSYROB testnet v10.0.0, chain 87870, genesis $GENESIS"
fi

say "building the downloads, signed with the release key (a few minutes)"
asme bash -c "cd '$DEV' && PSYROB_RELEASE_KEY='$RELKEY' nice -n 10 npm run release" || { say "release build failed; the network is not started (the pre-launch page stays)"; exit 1; }

say "stopping the pre-launch page; production clone -> $TAG"
systemctl stop psyrob-node
asme git -C "$R" fetch --tags origin
asme git -C "$R" checkout --detach "$TAG"
if [ -d "$DEV/dist/downloads" ] && ls "$DEV"/dist/downloads/manifest.json >/dev/null 2>&1; then
  asme mkdir -p "$R/dist/downloads"
  asme find "$R/dist/downloads" -maxdepth 1 -type f -delete
  asme cp -a "$DEV"/dist/downloads/. "$R/dist/downloads/"
  say "downloads: $(ls "$R/dist/downloads" | tr '\n' ' ')"
fi

back_to_prelaunch() {
  say "the node did not come up: back to the pre-launch page (signatures kept)"
  systemctl stop psyrob-node || true
  install -m 0644 "$R/deploy/psyrob-node.prelaunch.service" /etc/systemd/system/psyrob-node.service
  systemctl daemon-reload
  systemctl start psyrob-node
}

say "installing the node and miner units and the watchdog"
# a hand-made drop-in (/etc/systemd/system/psyrob-node.service.d/*.conf) would replace this unit's start command: move
# any aside
DROP=/var/backups/psyrob-dropins-$(date +%s)
for f in /etc/systemd/system/psyrob-node.service.d/*.conf; do
  [ -e "$f" ] || continue
  mkdir -p "$DROP"; mv "$f" "$DROP/"; say "moved the drop-in $f aside to $DROP"
done
install -m 0644 "$R/deploy/psyrob-node.service" /etc/systemd/system/psyrob-node.service
install -m 0644 "$R/deploy/psyrob-miner.service" /etc/systemd/system/psyrob-miner.service
install -d -m 0755 /etc/systemd/system/psyrob-miner.service.d
install -m 0644 "$R/deploy/psyrob-miner.service.d/limits.conf" /etc/systemd/system/psyrob-miner.service.d/limits.conf
[ -s /etc/systemd/system/psyrob-miner.service.d/address.conf ] || { say "no miner address drop-in: run deploy/KEYS.sh first"; exit 1; }
install -m 0755 "$R/deploy/psyrob-watchdog.sh" /usr/local/bin/psyrob-watchdog.sh
install -m 0644 "$R/deploy/psyrob-watchdog.service" /etc/systemd/system/psyrob-watchdog.service
install -m 0644 "$R/deploy/psyrob-watchdog.timer" /etc/systemd/system/psyrob-watchdog.timer
systemctl daemon-reload
systemctl enable psyrob-node psyrob-watchdog.timer
systemctl start psyrob-node
ok=0
for i in $(seq 1 180); do
  if curl -sf --max-time 2 http://127.0.0.1:8787/health | grep -q "\"genesis\":\"$GENESIS\""; then ok=1; break; fi
  sleep 1
done
curl -s --max-time 3 http://127.0.0.1:8787/health; echo
if [ $ok != 1 ]; then journalctl -u psyrob-node -n 30 --no-pager; back_to_prelaunch; exit 1; fi
say "the network is up: chain 87870, genesis $GENESIS"

if sudo -u psycho bash "$R/deploy/check-before-mining.sh"; then
  systemctl start psyrob-miner
  say "miner started"
else
  say "miner NOT started (see the check above); start it later with: sudo systemctl start psyrob-miner"
fi
systemctl start psyrob-watchdog.timer
say "watchdog timer started"
sleep 5
curl -sf --max-time 10 https://explorer.psyrob.com/health && echo && say "explorer.psyrob.com answers" || say "explorer.psyrob.com did not answer yet (the tunnel may need a few seconds)"
say "done"
