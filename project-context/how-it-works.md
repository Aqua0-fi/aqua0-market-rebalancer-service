# How the market-rebalancer-service works

Think of it as a customer who buys where a token is cheaper and immediately sells the same token where
it is more expensive. These trades put pressure on the two prices to converge. It trades only when the
complete round trip meets the profit requirement. It does not force prices to match at a loss, and it
does not manufacture trades when there is no economic opportunity.

## A complete trade

1. A worker checks a configured Aqua0 pool and external Uniswap/Sushi pools on the same chain.
2. It tests a small configured list of trade sizes in both directions. This prices the actual size,
   including pool fees and price impact, rather than comparing two headline token prices.
3. It applies a slippage margin and reserves a conservative fee budget, including additional rollup
   charges where applicable. A user-configured minimum net profit must remain after that budget.
4. It refreshes the selected opportunity. Only then does it ask Aqua0 to authorize the specific JIT
   fill. The signature binds the pool, strategy class, direction, amount, price limit, router and expiry.
5. It simulates the _whole_ transaction, including both swaps and the contract's final profit check.
6. The executor exchanges the starting token for the intermediate token, exchanges that token back,
   and checks its final starting-token balance before returning successfully.

Aqua0 can be either the first or second exchange. Both legs happen on one chain and inside one call.
There is no interval where the service is committed to one completed swap while waiting to send the
other transaction. No bridge, loan or flash-loan repayment is involved.

## The check that protects operating capital

The contract reads its starting-token balance before trading. It requires:

`balance after both swaps >= balance before both swaps + required gross profit`

The service chooses `required gross profit` to cover a conservative fee budget plus its required net
profit. An owner-configured onchain minimum is an additional floor the operator cannot lower.

For example, suppose a cycle starts with 1,000 USDC, reserves 2 USDC worth of fees and requires 3 USDC
of net profit. The contract must finish at least 5 USDC above its starting balance. Returning only
1,004 USDC from that 1,000 USDC cycle fails the guard, even though the gross trading result is positive.
This is an illustrative example; actual configuration and gas conversion use integer token units.

If the second swap fails, output is too low, liquidity disappears, the signature expires, or the final
profit is too small, the entire EVM call reverts. The first swap, second swap, token transfers, approvals,
service replay flag and Aqua0's consumed authorization nonce are undone together.

The contract also refuses to spend pre-existing intermediate-token inventory on the second leg. It may
spend only tokens acquired during the first leg. Leftover intermediate tokens stay in the contract and
are not counted as profit. This prevents old inventory from hiding an otherwise losing round trip.

## What a revert cannot refund

A transaction that is included and reverts still costs network fees. It cannot roll back the chain's
fee payment. A profitable token cycle also needs to pay fees from the operator's separate native-token
balance. Profit is therefore not inferred merely from seeing two successful swaps.

The service caps the transaction's gas units and gas price, checks a second owner-set gas price cap
onchain, reserves worst-budgeted execution fees, checks OP Stack L1/operator fees against an extra
reserve, and stops when its daily fee budget or failure threshold is exhausted. Fee conversion into
the starting token uses a real external quote with a buffer. Additional fees and conversion prices can
change before inclusion, so these are conservative controls, not an absolute guarantee of zero fee loss.

A simulation is a rehearsal against a particular state, not a promise that later state will be identical.
The contract's balance check is the final authority. Short expiry, fresh quotes and preflight simulation
reduce unnecessary reverted submissions. Mempool competition can still consume gas; private transaction
transport and prolonged observation are later deployment decisions.

## Exactly how Aqua0 backend information is used

Yes, the service uses the existing Aqua0 backend to understand executable liquidity depth. It calls
`POST /api/swap/quote` with a concrete pool, strategy class, direction and input amount.

The fleet quote service resolves the pool's actual currencies, checks strategy consent, reads fleet
capital through `buildFleetJitPlanReader`, builds the LP-preference JIT ranges with
`sameChainOnly: true`, loads the PoolManager's current state, and simulates the proposed fill. It reports
what is requested versus what it can actually authorize. This is more informative than pool TVL or a
spot-price comparison: the service needs to know what output a particular trade size can receive now.

The rebalancer rejects quotes that are clamped, partially supported, for the wrong token pair, or for
a different input amount. It takes the smaller of previewed and authorized output. It does not rebuild
the full Aqua0 liquidity model, bypass user LP preferences, or assume all committed capital is available.
The quote endpoint is read-only. The authorization endpoint subsequently rechecks eligibility/capacity,
reserves backing and signs the exact fill. Simultaneous activity can make a preview stale; that is why
it refreshes, authorizes and simulates before submission.

External exchanges are queried independently through their QuoterV2 contracts. Those quotes execute
against real pool state at one RPC block and include the effect of the proposed size. The worker tests
multiple sizes, so a large apparent price gap with very little depth is not treated as unlimited profit.
It uses a bounded size grid; it does not claim a globally optimal trade-size algorithm.

## Permissions and operating model

The contract starts paused. The owner chooses operators, eligible Aqua0 pools, exact external pools,
per-starting-token input caps and minimum profit, and the gas-price ceiling. Operators can request
trades within those limits but cannot withdraw inventory. Only the owner can withdraw. Ownership
transfer requires acceptance. Approvals to Permit2/router are bounded to the trade and cleared afterward.

The worker has its own dedicated operator key. It never needs the Aqua0 backend's JIT signing key,
LP keys, governance key or a backend database credential. It uses the normal authenticated API surface.

One process owns each journal. It records the deterministic transaction hash before broadcasting. If an
RPC times out, the service reconciles that hash rather than sending again. Pending or ambiguous state
blocks further execution. The daily budget conservatively retains reserved costs even if a transaction
was cheaper, so a restart cannot silently reset the spending meter.

Offchain bookkeeping has a separate lifetime. An EVM revert cannot undo a database reservation already
created by the backend. For this same-chain path the existing backend expires the liquidity hold with
the signed authorization deadline. The service requests authorization only after a fresh profitable
quote, to avoid placing unnecessary temporary holds on LP capital.
