@echo off
REM PSYROB node for Windows (PSYROB testnet): follows the public node over wss://rpc.psyrob.com/p2p.
REM It does not mine and needs no port forwarding. Close this window (or press Ctrl+C) to stop.
cd /d "%~dp0"
node node\bin\psyrob-node.js --datadir "%~dp0data" --no-listen --http-host 127.0.0.1 --http-port 8787 --seeds wss://rpc.psyrob.com/p2p
pause
