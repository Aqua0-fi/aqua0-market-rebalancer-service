# Aqua0 market-rebalancer-service

Private service for bringing Aqua0 market prices closer to external exchanges through profitable,
atomic, same-chain round trips. Service name: `market-rebalancer-service`.

The Solidity contract holds a bounded operating balance. The TypeScript process obtains actual-size
quotes, chooses a profitable cycle, obtains Aqua0's signed JIT authorization, simulates the complete
transaction, and submits only if all checks pass. Both swaps and the final profit check happen in
one transaction. A failed check reverts both swaps. Reverted transactions still consume network fees.

**Default: observe only. No contract from this repository has been deployed to mainnet, no live
trade has been sent, and no AWS or physical-machine deployment has been made.**

## Run locally

Requirements: Node 22+, npm, Foundry 1.5.1 / Solidity 0.8.34, Python 3 for fork evidence.

```sh
git clone --recurse-submodules https://github.com/Aqua0-fi/aqua0-market-rebalancer-service.git
cd aqua0-market-rebalancer-service
npm ci
npm run check
npm run test:integration
npm run doctor -- --chain 8453
cp config/rebalancer.example.json config/rebalancer.local.json
# Set the actual strategy class, trade sizes, fee budgets and API credentials before observation.
node --env-file=.env --import tsx src/cli.ts scan --config config/rebalancer.local.json
```

`doctor` verifies chain IDs, contract bytecode, router/hook PoolManager bindings and liquid external
pools. It does not sign, reserve Aqua0 capital, deploy, or send transactions. `scan` performs one
search pass; `run` repeats passes and serves loopback `/health` on port 9091. Observation calls only
Aqua0's read-only quote endpoint. The authorization endpoint is called only in explicitly enabled
execution mode after a candidate survives a fresh quote.

## Components

- `contracts/src/MarketRebalancer.sol`: atomic execution, inventory limits, owner-set gas price cap,
  minimum profit, venue/pool allowlists, replay protection, short deadlines and authenticated callbacks.
- `src/`: registry validation, Aqua0 client, Uniswap/Sushi V3 quoting, bounded size search, gas economics,
  whole-transaction simulation, signing, transaction journal and worker.
- `config/chains.json`: Aqua0 deployment snapshot and official Uniswap/Sushi deployment provenance.
  Includes Base, Arbitrum, Avalanche, Celo, Polygon, Monad and Robinhood. Availability is checked onchain.
- `contracts/test/MarketRebalancer.fork.t.sol`: real mainnet infrastructure with local Aqua0 vaults,
  actual signed JIT hooks and deliberately displaced local pool prices.
- `evidence/`: pinned blocks, block hashes, test output and measured gas. These demonstrate execution,
  not a promise of live profit or a production-backend authentication test.
- `vendor/aqua0/`: unmodified, hash-pinned Aqua0 contract source used only by fork tests. No sibling
  repository, private package token, server, database or operator key is required for local unit tests.

## Tests and limits

```sh
npm run typecheck
npm test
npm run contracts:test
npm run test:integration
python3 scripts/fork.py --chain 8453
python3 scripts/fork.py --chain 42161 --venue-index 1
# Replay a recorded block with an archive-capable RPC:
RPC_URL_BASE=https://your-provider.example python3 scripts/fork.py --chain 8453 --block BLOCK
```

Fork tests are opt-in and never silently replaced by mocks. See
[verification](project-context/verification.md) for what was actually tested and chain-specific limits.

The first implementation uses Aqua0 **V4 JIT** and Uniswap-compatible **V3** pools, including Sushi.
It does not yet trade Aqua0's separate SwapVM order surface, Aerodrome's distinct interface, V2 pools,
bridges or cross-chain cycles. External pair liquidity must actually exist. Celo's configured pair had
no liquid supported external pool in the recorded discovery pass, so it produces no route.

Read [how it works](project-context/how-it-works.md),
[operation and deployment](project-context/runbook.md), and
[remaining work](project-context/tech-debt.md) before enabling execution.
