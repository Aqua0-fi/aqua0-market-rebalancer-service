# Arbitrum launch completion

Scope: finish the remaining Arbitrum showcase work using existing free RPCs. Keep all trades on one chain. Preserve atomic execution, profit floors, receipt recovery, LP consent, current price-policy defaults and the separate memory project. Public transactions, funding, live market approvals, price-policy changes and execution activation are not performed by this implementation session; prepare reviewed owner-run inputs instead.

## Reconciled baseline

The September 28 readiness release already deployed the LP-wallet tab, receipt fee accounting, durable economic pause/review and scoped price-policy controls to staging. The older expansion worktree is not the latest release. Worker source is based on 0096894. Backend launch baseline is d9432708; frontend launch baseline is 113cf100. New work uses feat/rebalancer-arbitrum-launch. Do not rebuild those completed features.

## Remaining work

1. Verify the current KMS public key against the expected operator address without signing. Check Arbitrum funding read-only and prepare unsigned deployment/setup transactions with clear costs and a 5 USDC input cap. Funding the operator is separate from funding the executor.
2. Resolve the production-maker fork issue. The older reverse test displaced an external pool by 100,000 units and then demanded nearly the entire virtual inventory from a small real vault. Preserve this failing evidence. Test realistic bounded displacement and both route orders using the actual Arbitrum maker, vaults and deployed routers, with only local test balances. Enforce a physical output upper bound during prepared SwapVM search without bypassing full-transaction simulation.
3. Implement the hackathon-only 90% LP return path. Base it on confirmed net gain after receipt fees and losses, not quoted gain. Require complete canonical actual-principal evidence; planned backing is not payout entitlement. Keep unlike tokens separate, use deterministic integer allocation and reject duplicate execution identities. Provide a reviewed, replay-protected payout mechanism and local EVM proof. No live payouts or automatic production commitment.
4. Verify changed source, security behavior, current fork fixtures and the protected UI. Record exact successes, failures and unresolved live gates. Staging updates must preserve existing runtime state and teammate changes; production promotion is separate.

## Acceptance

Never turn a unavailable read into zero gas, a missing LP into a guessed recipient, a static quote into execution proof, or a wallet deposit into permission to enable every market. No total-completion claim without source and execution evidence. No new paid infrastructure or background training is needed.
