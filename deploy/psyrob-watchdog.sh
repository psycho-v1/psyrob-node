#!/bin/bash
# /usr/local/bin/psyrob-watchdog.sh. Run every minute by psyrob-watchdog.timer.
# 1. The node must answer /health locally with chain 87870 and the network's genesis hash, else restart psyrob-node
#    (and only it; a running miner restarts with it through Requires=).
# 2. If the node is fine locally but neither public name answers through Cloudflare, restart the tunnel.
GENESIS=0x0000000000000000000000000000000000000000000000000000000000000000
# A node that is replaying its stored blocks answers /health with 503 and "starting": true; it is left alone. Replay
# time grows with the chain, so as a second guard: no check in the first 10 minutes, and after that no restart until the
# node has logged "replayed ..." since it started, unless it has been starting for over 2 hours.
START=$(systemctl show -p ActiveEnterTimestampMonotonic --value psyrob-node)
NOW=$(awk '{printf "%d", $1 * 1000000}' /proc/uptime)
if [ "${START:-0}" -gt 0 ] && [ $((NOW - START)) -lt 600000000 ]; then exit 0; fi
PID=$(systemctl show -p MainPID --value psyrob-node)
if [ "${PID:-0}" -gt 0 ] && [ $((NOW - START)) -lt 7200000000 ] \
   && ! journalctl -q -o cat _PID="$PID" | grep -q ' replayed [0-9]*/[0-9]* blocks'; then
  exit 0
fi
H=$(curl -s --max-time 8 http://127.0.0.1:8787/health)
# while replaying, the node answers 503 with "starting":true and its progress: alive, leave it alone
if printf '%s' "$H" | grep -q '"starting":true' && printf '%s' "$H" | grep -q "\"genesis\":\"$GENESIS\""; then exit 0; fi
if ! printf '%s' "$H" | grep -q '"chainId":87870' || ! printf '%s' "$H" | grep -q "\"genesis\":\"$GENESIS\""; then
  logger -t psyrob-watchdog "node not answering locally (or wrong chain or genesis), restarting psyrob-node"
  systemctl restart psyrob-node
  exit 0
fi
if ! curl -sf --max-time 10 https://rpc.psyrob.com/health >/dev/null \
   && ! curl -sf --max-time 10 https://explorer.psyrob.com/health >/dev/null; then
  logger -t psyrob-watchdog "node fine locally but unreachable via Cloudflare, restarting psyrob-tunnel"
  systemctl restart psyrob-tunnel
fi
