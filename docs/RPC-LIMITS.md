# JSON-RPC limits

Every method that walks a range of blocks, transactions, logs or addresses has a fixed range and result limit, and
CPU-heavy methods have their own rate limit, so no single request can stall the node. Each limit below is in the code
named in the last column and checked by a test where marked.

## Per request

| Method | Range limit | Result limit | Notes | Code / test |
|---|---|---|---|---|
| `psy_getDagRange(from, to)` | `to` ≤ `from` + 500 blue scores; both non-negative safe integers (decimal or 0x), else −32602; never walks past the highest blue score in the DAG | 2,000 blocks | | `rpc.js`, `dag.js blocksInBlueScoreRange`; `limits.test.js` |
| `eth_getLogs(filter)` | 10,000 chain blocks (−32005) | 10,000 logs (−32005) | at most 100 addresses, 4 topic positions, 100 alternatives per topic (−32602) | `rpc.js`; `limits.test.js` |
| `eth_feeHistory(count, …)` | 1,024 chain blocks | — | | `rpc.js` |
| `psy_metrics(window)` | three fixed windows (hour, day, week of chain blocks) | top 10 miners | cached per window per tip | `metrics.js` |
| `psy_getBlockTemplate(miner)` | — | one template; at most 512 kept | same template for 3 s for the same miner and tips; refused while the node is still syncing (−32005) | `rpc.js` |
| `psy_submitBlock(id, nonce, sig)` | — | — | at most 4 submissions per template; per miner address 4, then 1 per second; miners with a block added here in the last day 8, then 4 per second; everyone else shares 8, then 4 per second (−32005 "busy") | `rpc.js` |
| `eth_getTransactionCount(a, 'pending')` | the sender's pooled transactions (≤ 64 + 16) | — | | `rpc.js`, `mempool.js` |
| `psy_peers`, `psy_addrman` | — | — | local callers only | `http.js` |
| JSON-RPC batch | 100 calls per batch | | each call counts against the limits below | `http.js` |
| Request body | 1 MiB | | | `http.js` |

## Per client (IP address; IPv6 by /64) and for all clients together

| Limiter | Burst, then per second | Applies to |
|---|---|---|
| all methods | 200, then 50 (`--rpc-rate`) | every JSON-RPC call |
| heavy methods, per client | 20, then 5 | `eth_call`, `eth_estimateGas`, `psy_getBlockTemplate`, `eth_getLogs`, `psy_submitBlock`, `psy_getDagRange`, `psy_metrics` |
| heavy methods, all clients | 120, then 40 | the same methods |
| pages | 60, then 10 | explorer pages |
| downloads | 6 at a time for all clients; 12 per hour per client | `/downloads/` packages (`downloads.js`) |

A refused call gets HTTP 429 with a JSON-RPC error (−32005), never a web page. While the node replays its stored
blocks at start-up, every JSON-RPC call gets a JSON error −32005 ("the node is starting") from the stand-in server.
