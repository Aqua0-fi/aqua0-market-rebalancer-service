# Narrow Uniswap V4 runtime hotfix

This branch backports the V4 RPC-alignment repair from staging PR #6 onto the exact source identified by the active worker image: `0a27b33b4e1163f610630e153916980ee063c92c` / `sha256:afffac9509e7bcd540f97880fc0ac537c2d8ca8a306bd416e11fe83acfe1bb24`.

Only `src/runner.ts` and the new `src/v4-quote-state.ts` change runtime behavior. No observation-history feature, CLI/configuration change, signer change, contract change, dependency change, approval or profit/input-limit change is included. Both V4 quote checkpoints now wait for real RPC catch-up and verify canonical hash within existing freshness limits. Transient V4 expiry/reorg classification survives the drained read batch instead of incrementing chain-error backoff.

The same 15 V4 regressions used by staging PR #6 pass here. Full validation passed 157 unit tests, 47 contract tests, 18 local owner-maintenance helper tests and three isolated local-EVM integration tests, plus formatting, type checks, provenance and build. The earlier USDC/DAI V4 fork proof uses the identical unchanged compiled executor and vendored hook source; it is seeded local test capital, not a live profitability proof.

An image built from this commit is preparation only. The owner-run updater must pin this source and the exact image digest, verify the old image and current controls, preserve durable transaction history, and use an isolated read-only V4 probe without signer credentials before any owner-applied restart. No live settings or worker process was changed by creating or publishing this branch.
