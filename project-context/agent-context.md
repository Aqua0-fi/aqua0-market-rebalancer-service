# Context

The user requested a private service to keep Aqua0 prices aligned with other exchanges and help
bootstrap genuine trading. They subsequently required the name `market-rebalancer-service` throughout,
strong atomicity and profitability checks, and a plain-English explanation of the backend's role.

This stage is implementation plus mainnet-fork validation. AWS capacity assessment, Kubernetes on the
user's 4-core i7 / 8 GB host, mainnet deployment and production trading are deferred. Do not silently
launch or fund a service while completing this stage.

Aqua0's backend registry supplies seven supported chain IDs. Current integration uses `/api/swap/quote`
and `/api/swap/authorize` for the fleet V4 path. Source review confirmed `sameChainOnly: true` in the
fleet quote planner. External pricing comes from onchain Uniswap/Sushi V3 QuoterV2 calls at a pinned
RPC block. The service does not hold protocol signing keys or modify upstream vaults.

Runtime is one Node process, no database/indexer/Redis of its own, bounded sequential work, persistent
JSON transaction journal and loopback health endpoint. The contract uses prefunded operating inventory.
Fork tests independently instantiate real Aqua0 source, use real deployed market infrastructure and
synthetically displace the local Aqua0 pool price to prove a profitable route can settle.

The source tree is independently buildable; test-only Aqua0 source provenance is in `vendor/aqua0`.
Verification evidence and unresolved deployment requirements are separate documents.
