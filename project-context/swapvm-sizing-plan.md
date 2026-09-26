# Automatic sizing and SwapVM support

The owner rejected manual sample-size grids as the search algorithm. Replace them with simulator-driven
size selection before extending the price-arbitrage worker to SwapVM. Capital and minimum net-profit
limits remain operator decisions; the amounts evaluated during a search are not.

## Regular concentrated-liquidity path

Prepare the real fleet JIT reader, reservation-netted plan and pinned pool snapshot once per search.
Reuse the existing Rust projected-pool object for every V4 evaluation. Prepare the external V3 pool
from the same block; its standard swap arithmetic can use the existing concentrated-liquidity core
only after differential checks against the actual V3 quoter. This adapter describes trader amounts,
not V3 LP/protocol-fee accounting. Unknown snapshot coverage must constrain the search, not imply
empty liquidity.

For fixed-fee standard pools, optimize the round trip using the product of the two post-trade marginal
exchange rates, fees and conservative slippage factors. Bracket and refine the marginal break-even
point inside the funding/input/capacity limits; inspect integer neighbours and liquidity boundaries.
Both venue orders compete on net profit. Preserve integer arithmetic. Do not label an approximate
integer optimum a proof over all possible inputs. Pool preparation is amortized; no backend LP scan
or external RPC round trip belongs inside the native sizing loop.

The read-only search interface exposes candidate amounts and provenance, not private LP records.
It must retain strategist consent, actual available capacity, the public minimum-trade/price policies,
network separation, and a fixed block identity. Refresh and authorize only the selected candidate.
Simulate the entire transaction before signing; the onchain capital/profit guard remains authoritative.

## SwapVM path

Use the deployed router's own quote and swap functions. Do not interpret or copy its opcode formulas.
Resolve its immutable Aqua binding, actual header width, maker/order hash, pair and shipped identity.
Keep opaque programs opaque: arbitrary VM programs are not guaranteed to have a concave profit curve.
Use bounded adaptive, multi-bracket search over actual VM quotes, report the best evaluated candidate
and search limits, and never claim a universal optimum for an arbitrary program.

Add a distinct venue to the executor without changing the existing V4/V3 wire values or allowing
arbitrary calls. Bind router, maker/order and token pair; construct exact-input taker data with an
explicit output floor and executor receiver; approve only the exact input and clear allowances.
Require one Aqua-family leg and one external V3 leg, measured input/output and the unchanged final
starting-token profit floor. Partial fills and overspending old intermediate balances still revert.

Discovery/policies/history need a real venue discriminator. Do not disguise a SwapVM order as a V4
pool or manufacture tick spacing. Existing V4 policies migrate without implicit new approvals.

## Acceptance

Compare regular-pool optimizer results against dense/exhaustive independent search and actual pinned
EVM quotes, including tick boundaries, constrained inventory and no-profit cases. Verify both atomic
SwapVM round-trip directions on real deployed-router forks, including wrong header/hash/maker,
output floors, rollback and allowance cleanup. Keep failing setup separate from execution evidence.
No funded live executor, wallet transfer, global execution enablement or production/main change is
part of this implementation. Preserve the running observer and unrelated staging features.
