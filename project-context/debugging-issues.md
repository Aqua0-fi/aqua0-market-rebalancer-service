# Debugging findings

## Robinhood UniversalRouter tuple differs

Resolved during mainnet-fork testing on 2026-09-17. The configured router accepted the legacy tuple
but passed a slice from the middle of the payload to the hook. The Aqua0 magic prefix was missing,
JIT liquidity was never injected, and the swap reverted. Trace evidence showed the wrong hook bytes
reaching the real PoolManager. The current Uniswap IV4Router includes `minHopPriceX36` before hookData.

Fix: pin `extendedV4Encoding` in the registry and as an immutable constructor argument. The Robinhood
row uses the extended tuple with the additional relative bound disabled; the absolute per-leg output
floor and final balance-profit guard remain mandatory. Other proven rows use the legacy tuple. All
three Robinhood fork tests pass at RPC block 65470614 after this change. This may also merit a separate
upstream frontend/backend router-encoder review; those repositories were not modified in this task.

## Arbitrum RPC height is not Solidity block.number

Resolved during the same fork run. Arbitrum fork RPC block 506134498 reported EVM block.number 25998033.
Using RPC height for the contract's short expiry would make every submitted cycle fail its lifetime
bound. The contract now exposes `executionBlockNumber()`, and submission builds the onchain expiry
from that read. RPC heights continue to control quote freshness and receipt confirmations.

## Familiar dummy private key collides with live delegated account

Resolved in the local fork fixture. The small test private key 0xB0B resolved to an address that already
had delegated code on Base. Aqua0's strategist verification correctly attempted ERC-1271 rather than
EOA recovery. Replace low-valued keys with uniquely derived test-only keys. No existing account or
live delegation was changed, and no test keys are used by the production worker.

## Public endpoint retention and local tooling

Base PublicNode served fresh state but refused older uncached storage without an archive token.
The official Base RPC served the pinned state through Foundry's transport. The evidence runner uses
`cast rpc` and records a block/hash; replay requires a provider retaining that block.

macOS sandbox restrictions caused Foundry's proxy initialization to panic and the tsx CLI IPC socket
to fail. Tests were run with appropriate local tool permissions; Node now invokes the tsx loader via
`node --import tsx` without the CLI IPC server. These failures were not protocol test passes.

## Fee-tier fixture selection

A replay exposed an unconditional `break` in the test fixture's external-pool search. It checked only
fee tier 500; Monad's active pool uses tier 3000. Put the assignment and break inside the liquidity
condition. The corrected fixture passes all three Monad cases at block 105639937. The failed attempt
is retained as `evidence/monad-fixture-discovery-failure.*`; it was a fixture defect, not proof that
Monad lacked liquidity.

## Next-day replay and public RPC availability

On 2026-09-18, several public RPCs had pruned the previous day's uncached account state. The exact
historical replay correctly failed in fixture setup. Keep those failed reports, pin a new block and
rerun; do not relabel unavailable historical state as a successful test. Fresh Base discovery also
needed the public read endpoint `https://base-rpc.publicnode.com` after the default endpoint rejected
requests. An archive-capable production/test provider is required for dependable historical replay.

## Patched executor versus pinned legacy fixture compiler

The 0.8.37 executor initially could not share a compilation unit with the test-vendored Aqua0 contracts pinned to 0.8.34. The vendor source was not relaxed or edited. The legacy fixture now calls a generated ABI interface and deploys the separately built 0.8.37 executor artifact. Both Arbitrum route orders and full rollback pass against actual Uniswap and Sushi infrastructure. The generated boundary is checked during contract verification.

## Admin surface declaration and economics

The full backend suite caught the newly mounted economic-review route missing from the explicit audited admin path list. The path was added, and all private-authentication/public-schema surface tests passed. A baseline archive initially lacked the Ponder package dependency symlink; after sharing the same complete dependency tree, only the same five existing durability/mock failures remained in both source revisions.
