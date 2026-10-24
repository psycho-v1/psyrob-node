#!/bin/bash
# PSYROB launch, step 2 of 3: open the launch ceremony (DAG_SPEC.md section 17.1). Run once, as root, after
# deploy/KEYS.sh, once the production clone exists (deploy/README.md):
#
#   sudo bash /home/psycho/psyrob/deploy/PRELAUNCH.sh
#
# In order: move the production clone (/home/psycho/psyrob-node) to the pre-launch tag; install the pre-launch form of
# the node unit and start it. https://explorer.psyrob.com/launch then shows the ceremony: each Dev Account holder
# connects the Dev Account wallet, names a separate council key and signs; the text they sign names the three bootstrap
# keys and their 2-of-3 quorum. When all three seats are signed, run deploy/LAUNCH.sh (step 3).
# The Cloudflare tunnel is not touched. Log: /var/log/psyrob-prelaunch.log.
set -euo pipefail

TAG=v10.0.0-prelaunch
R=/home/psycho/psyrob-node
DEV=/home/psycho/psyrob
LOG=/var/log/psyrob-prelaunch.log
[ "$(/usr/bin/id -u)" = 0 ] || { echo "run it with sudo: sudo bash $DEV/deploy/PRELAUNCH.sh"; exit 1; }
for i in 1 2 3; do [ -s /etc/psyrob/bootstrap-$i.key ] || { echo "no /etc/psyrob/bootstrap-$i.key: run deploy/KEYS.sh first"; exit 1; }; done
[ -d "$R/.git" ] || { echo "no production clone $R: see deploy/README.md"; exit 1; }
touch "$LOG"; chmod 0644 "$LOG"
exec > >(tee -a "$LOG") 2>&1
say() { echo "$(date -u '+%F %T UTC') | $*"; }
asme() { sudo -u psycho -H "$@"; }

say "production clone -> $TAG"
systemctl stop psyrob-node 2>/dev/null || true
asme git -C "$R" fetch --tags origin
asme git -C "$R" checkout --detach "$TAG"

say "installing the pre-launch node unit"
# a hand-made drop-in (/etc/systemd/system/psyrob-node.service.d/*.conf) would replace this unit's start command: move
# any aside
DROP=/var/backups/psyrob-dropins-$(date +%s)
for f in /etc/systemd/system/psyrob-node.service.d/*.conf; do
  [ -e "$f" ] || continue
  mkdir -p "$DROP"; mv "$f" "$DROP/"; say "moved the drop-in $f aside to $DROP"
done
install -m 0644 "$R/deploy/psyrob-node.prelaunch.service" /etc/systemd/system/psyrob-node.service
systemctl daemon-reload
systemctl start psyrob-node
ok=0
for i in $(seq 1 60); do
  if curl -sf --max-time 2 http://127.0.0.1:8787/health | grep -q '"prelaunch":true'; then ok=1; break; fi
  sleep 1
done
curl -s --max-time 3 http://127.0.0.1:8787/health; echo
if [ $ok != 1 ]; then say "the pre-launch page did not come up"; journalctl -u psyrob-node -n 30 --no-pager; exit 1; fi
sleep 3
curl -sf --max-time 10 https://explorer.psyrob.com/health && echo && say "https://explorer.psyrob.com/launch is open" \
  || say "explorer.psyrob.com did not answer yet (the tunnel may need a few seconds)"
say "done: the three Dev Account holders sign at https://explorer.psyrob.com/launch; then run: sudo bash $DEV/deploy/LAUNCH.sh"
