#!/bin/bash
# Run before starting psyrob-miner (no root needed). Exits 0 only if the CPU is cool, memory is available and the
# node answers. Limits: hottest thermal zone below 70 C, MemAvailable above 900 MB (2 x 32 MiB Argon2d plus the
# runtime, with margin for the other services on this host).
fail=0
max=0
for z in /sys/class/thermal/thermal_zone*/temp; do [ -r "$z" ] && t=$(( $(cat "$z") / 1000 )) && [ "$t" -gt "$max" ] && max=$t; done
echo "hottest thermal zone: ${max} C"
if [ "$max" -ge 70 ]; then echo "too hot (>= 70 C): do not start the miner"; fail=1; fi
avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
echo "MemAvailable: ${avail} MB"
if [ "$avail" -lt 900 ]; then echo "not enough memory (< 900 MB): do not start the miner"; fail=1; fi
if curl -sf --max-time 5 http://127.0.0.1:8787/health | grep -q '"chainId":87870'; then echo "node: answering"; else echo "node: not answering"; fail=1; fi
[ $fail = 0 ] && echo "OK to start: sudo systemctl start psyrob-miner"
exit $fail
