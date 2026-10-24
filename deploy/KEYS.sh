#!/bin/bash
# PSYROB launch, step 1 of 3: make the keys the launch needs. Run as root:
#
#   sudo bash /home/psycho/psyrob/deploy/KEYS.sh
#
# 1. Three bootstrap finality keys, /etc/psyrob/bootstrap-1.key .. bootstrap-3.key (root:psyrob, 0640), made with the
#    node's wallet tool. They sign checkpoints until the first finality committee is sealed (any 2 of 3, for 12 months
#    at most; DAG_SPEC.md section 9.1). They never mine and never hold PSY. All three stay on this server for now; to
#    move one later, copy its file to the other machine and delete it here: nothing changes on chain.
# 2. The miner key, /etc/psyrob/miner.key (root:psyrob, 0640), its address in /etc/psyrob/miner.address and in the
#    miner unit's drop-in /etc/systemd/system/psyrob-miner.service.d/address.conf. It must differ from the bootstrap keys.
# 3. The release key, /home/psycho/.psyrob-release/release.key (psycho, 0600): it signs SHA256SUMS.txt of every
#    release. Its public part is written to docs/RELEASE-KEY.pem in the repository.
# 4. The three bootstrap addresses are written into genesis/launch-87870.json (bootstrapSigners, quorum 2).
# Existing key files are never overwritten: a second run only prints what is there. No private key is ever printed.
# Afterwards: review and commit genesis/launch-87870.json and docs/RELEASE-KEY.pem, tag v10.0.0-prelaunch, then run
# deploy/PRELAUNCH.sh (step 2).
set -euo pipefail

DEV=/home/psycho/psyrob
K=/etc/psyrob
REL=/home/psycho/.psyrob-release
[ "$(/usr/bin/id -u)" = 0 ] || { echo "run it with sudo: sudo bash $DEV/deploy/KEYS.sh"; exit 1; }
asme() { sudo -u psycho -H "$@"; }
umask 0077
id psyrob >/dev/null 2>&1 || { echo "no user psyrob (the services run as it)"; exit 1; }

# a key file's address only (the wallet tool never prints a key)
addr_of() { node -e "const fs=require('fs');import('$DEV/common/crypto.js').then(c=>{const k=Buffer.from(fs.readFileSync('$1','utf8').trim().replace(/^0x/,''),'hex');console.log('0x'+Buffer.from(c.privateKeyToAddress(k)).toString('hex'))})"; }
make_key() {
  if [ -s "$1" ]; then echo "exists: $1"; else node "$DEV/node/bin/psyrob-wallet.js" new --out "$1" >/dev/null; echo "made:   $1"; fi
  chown root:psyrob "$1"; chmod 0640 "$1"
}

install -d -m 0750 -o root -g psyrob "$K"
addrs=()
for i in 1 2 3; do
  make_key "$K/bootstrap-$i.key"
  a=$(addr_of "$K/bootstrap-$i.key"); [[ "$a" =~ ^0x[0-9a-f]{40}$ ]] || { echo "could not read the address of bootstrap key $i"; exit 1; }
  addrs+=("$a"); echo "  bootstrap key $i: $a"
done
[ "$(printf '%s\n' "${addrs[@]}" | sort -u | wc -l)" = 3 ] || { echo "the three bootstrap keys must differ"; exit 1; }
printf '%s\n' "${addrs[@]}" > "$K/bootstrap-addresses.txt"; chmod 0644 "$K/bootstrap-addresses.txt"

make_key "$K/miner.key"
miner=$(addr_of "$K/miner.key"); [[ "$miner" =~ ^0x[0-9a-f]{40}$ ]] || { echo "could not read the miner address"; exit 1; }
for a in "${addrs[@]}"; do [ "$a" != "$miner" ] || { echo "the miner key must not be a bootstrap key"; exit 1; }; done
echo "$miner" > "$K/miner.address"; chmod 0644 "$K/miner.address"
install -d -m 0755 /etc/systemd/system/psyrob-miner.service.d
printf '[Service]\nEnvironment=PSYROB_MINER_ADDRESS=%s\n' "$miner" > /etc/systemd/system/psyrob-miner.service.d/address.conf
chmod 0644 /etc/systemd/system/psyrob-miner.service.d/address.conf
echo "  miner key: $miner"

install -d -m 0700 -o psycho -g psycho "$REL"
if [ -s "$REL/release.key" ]; then
  echo "exists: $REL/release.key"
  asme node "$DEV/scripts/release-key.mjs" public --key "$REL/release.key" > "$DEV/docs/RELEASE-KEY.pem"
else
  asme node "$DEV/scripts/release-key.mjs" new --out "$REL/release.key" > "$DEV/docs/RELEASE-KEY.pem"
  echo "made:   $REL/release.key"
fi
chown psycho:psycho "$DEV/docs/RELEASE-KEY.pem"
echo "release public key (docs/RELEASE-KEY.pem):"; cat "$DEV/docs/RELEASE-KEY.pem"

asme node -e "
const fs = require('fs'); const f = '$DEV/genesis/launch-87870.json';
const l = JSON.parse(fs.readFileSync(f, 'utf8'));
l.bootstrapSigners = process.argv.slice(1); l.bootstrapQuorum = 2;
fs.writeFileSync(f, JSON.stringify(l, null, 1) + '\n');
console.log('genesis/launch-87870.json: bootstrapSigners ' + l.bootstrapSigners.join(', ') + ', quorum 2');
" "${addrs[@]}"
echo "done. Back up /etc/psyrob/*.key and $REL/release.key offline. Next: review and commit genesis/launch-87870.json"
echo "and docs/RELEASE-KEY.pem, tag v10.0.0-prelaunch, then: sudo bash $DEV/deploy/PRELAUNCH.sh"
