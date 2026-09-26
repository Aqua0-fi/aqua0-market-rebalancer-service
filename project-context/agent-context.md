# Context

The user requested a private service to keep Aqua0 prices aligned with other exchanges and help
bootstrap genuine trading. They subsequently required the name `market-rebalancer-service` throughout,
strong atomicity and profitability checks, and a plain-English explanation of the backend's role.

The current scope includes implementation, fork validation, protected staging updates and the existing
resource-limited AWS observer. Onchain executor deployment, funding and live trading remain separate
explicit actions and are not authorized by an observer upgrade.

Aqua0's backend registry supplies eight supported EVM chain IDs. Current integration uses `/api/swap/quote`
and `/api/swap/authorize` for the fleet V4 path. Source review confirmed `sameChainOnly: true` in the
fleet quote planner. External pricing comes from onchain Uniswap/Sushi V3 QuoterV2 calls at a pinned
RPC block. The service does not hold protocol signing keys or modify upstream vaults.

Runtime is one Node process, an embedded SQLite execution-history file, no separate database/indexer/Redis service, bounded sequential work, persistent
JSON transaction journal and loopback health endpoint. The contract uses prefunded operating inventory.
Fork tests independently instantiate real Aqua0 source, use real deployed market infrastructure and
synthetically displace the local Aqua0 pool price to prove a profitable route can settle.

The source tree is independently buildable; test-only Aqua0 source provenance is in `vendor/aqua0`.
Verification evidence and unresolved deployment requirements are separate documents.

The regular-V4 Rust replacement and projected-range facade now live in the sibling backend worktree.
This worker still uses the backend quote/authorize interfaces and full-transaction simulation; it does
not bypass the planner or duplicate LP consent logic. The existing admin UI now reports worker history,
canonical receipts and actual per-LP principal sold, with historical backing shown separately.
See `rebalancer-reporting.md`, `simulator-audit.md` and `delivery-verification.md` before continuing.

Automatic sizing and SwapVM implementation are described in `swapvm-sizing-plan.md`. Native V4
search preserves the real planner and reservation-netted backing. SwapVM uses actual deployed VM
quotes with a real caller and independent owner-controlled onchain allowlists. Discovery and policy
updates never imply funding or execution activation. The generated worker registry must include
canonical SwapVM bindings and known router header widths; run `scripts/sync-registry.ts` against the
specific backend source revision instead of hand-copying addresses.
