# Arbitrum USDC/DAI readiness - 2026-10-01

## Scope and safety

This is a read-only diagnosis and a DISABLED configuration draft. No live worker settings, approvals, funds or transactions were changed. The existing worker was already in execute mode, so enabling a market is not a harmless UI change: it may immediately permit automated real-fund trades. Do not activate this draft as part of a code rollout.

The draft in `config/arbitrum-usdc-dai-policy.disabled.json` is a market-policy BODY, not a complete worker configuration. It belongs to chain 42161 and pool `0x1f7d6bb891093beb90fb3802388282e1d2fea68118c3220d902c7a8e207b5f15`. `expectedVersion: 0` reflects the absent policy observed during this audit; obtain the current version before any later owner change. `approved` deliberately remains false.

## Verified identities and state

The Aqua0 V4 pool uses native Arbitrum USDC `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`, DAI `0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1`, fee 100 (0.01%), spacing 1, hook `0xEa0ff3277279cf94dC8A5B9923dD7bb1a30e80C8`, and PoolManager `0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32`. Neither a 3000 fee nor spacing 60 identifies this pool.

At 08:07 UTC, canonical backend readers returned class 10 with 87.655475 USDC and 20.441321780918490531 DAI committed/available. Class 12 had zero on both legs. They are different Aqua0 allocation identities and have different strategists; they are not fee tiers or interchangeable pool IDs. The registered class-10 strategist was `0xfca63c50066acfe952785d36c591a113294d9e53`.

Direct class-consent reads returned false for both class 10 and class 12. The deployed backend still enforces that check. The pinned contract source includes `ClassNotApprovedForPool` in its JIT verification path. This audit has not yet bytecode-matched that source to the live hook; do not claim that removing the backend check alone is safe, or silently remove it.

Pinned Arbitrum block 510600051, hash `0xc17c874d937d5aa5de5bc2c24cad819e463878b773b8e3e5882dd8600fb0585a`, showed executor `0x0C527b9B1D603863CADC1CBBc1483036ac21D252` unpaused with its operator allowed. Its USDC balance was 5.704396, USDC maximum input 5, and on-chain minimum gross profit 0.01 USDC. DAI starting-token limits were zero. The bot draft therefore starts AND ends in USDC; this is distinct from a DAI-starting cycle. Its proposed minimum NET profit is 0.01 USDC after fee accounting, which is stricter than interpreting the contract's gross minimum as net.

The executor's allowlist did NOT include this Aqua0 V4 pool or any discovered external USDC/DAI V3 pool. The hook's router allowlist did include the configured Universal Router.

## What remains required

1. Resolve class-10 consent through the actual strategist-controlled process, or separately review and deploy an intentional protocol change. Creating a class, funding vaults, choosing an LP range and allowing a bot market are different operations. No signature was generated here.
2. Owner-review the exact Aqua0 pool and external-pool allowlists on the executor. Do not grant broad token/factory permissions or remove guards as a substitute. No allowlist transaction was generated or sent here.
3. Review the disabled bot policy: class 10, USDC base token, 5 USDC cap, proposed 0.01 USDC minimum NET profit, and `amounts: []` for the existing optimizer rather than invented fixed-size trades. The live V4 catalog currently has no saved policy for this pool.
4. Recheck current LP preferences/ranges, class capacity, live fee estimate, RPC freshness and quote support. Positive external liquidity does not prove useful depth or positive arbitrage. Preserve the existing atomic two-leg simulation, slippage bounds, daily gas budget, receipt reconciliation and economic pause checks.
5. Run a local-only exact-pair end-to-end fork test before any separately owner-executed live activation. Existing generic fork or unit results are not proof that this exact live route is executable or profitable.

## External pools discovered at the pinned block

These are candidates, NOT recommendations or grants of permission. All had a nonzero `liquidity()` read, which does not measure usable depth by itself. All were unapproved on this executor.

| Venue | Fee | Address |
| --- | --- | --- |
| Uniswap V3 | 100 | `0x7CF803e8d82A50504180f417B8bC7a493C0a0503` |
| Uniswap V3 | 500 | `0x9264e764e6D5D252a5c17C457C9Bb059b8831Bb1` |
| Uniswap V3 | 3000 | `0xD46c8A1940113ae64f960B7aA12EF5dcAB0ffe0E` |
| Uniswap V3 | 10000 | `0xbFf936a43e6Fe6F891789bE66043BcC8eFfee938` |
| Sushi V3 | 100 | `0x5DcF1Aa6B3422D8A59dc0e00904E02A1c1ea5a58` |

The current worker supports the listed Uniswap V3 and Sushi V3 factories. It is not scanning every DEX or every possible multi-hop path. Its strategy evaluates the two orders of the Aqua0/external two-leg cycle, subject to eligibility and permission checks.

## Idle-reporting repair

The original worker marked an iteration with zero eligible markets as a successful price search. The extracted patch reports `Waiting for an eligible approved market` and returns a skipped result without advancing `lastSuccess` or fabricating a successful last scan. Heartbeat and receipt reconciliation remain intact. Tests cover the actual USDC/DAI fee/spacing identity with unapproved, degraded and absent market states; none alters a saved policy.

The original history worktree remains untouched at `working-dir/rebalancer-readiness-20260928/worker-review`, branch `feat/rebalancer-history`, base `0a27b33b4e1163f610630e153916980ee063c92c`. Observation/balance modules in that work were not connected to CLI startup. They are preserved separately, not represented as a completed feature by this patch.

Read-only raw evidence is retained in the sibling `pool-discovery-20261001/evidence` directory on the owner's machine. It includes timestamps, pinned block identity, exact selected getter outputs, and tests. No credentials or private keys are included in this note or the draft.
