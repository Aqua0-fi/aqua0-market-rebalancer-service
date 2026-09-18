# Remaining work before production activation

- Mainnet executor deployment, owner/operator addresses, funding limits, real strategy IDs and service
  API credentials are intentionally unset. No funded production-backend round trip has been attempted.
- Observe real markets long enough to measure opportunities after network and hosting costs. Seeded
  fork price gaps prove mechanics; they do not establish live profitability or demand.
- Only Aqua0 V4 plus Uniswap/Sushi-compatible V3 exact-input swaps are implemented. SwapVM, V2,
  Aerodrome, multi-hop and cross-chain routes need distinct adapters and fork evidence.
- Celo's configured token pair has no discovered liquid supported external pool. Leave it idle until
  genuine executable depth exists or a separately tested venue/pair is configured.
- RPC subscriptions and backend authorization credentials require operational provisioning. Short-lived
  caller-token renewal is not an embedded authentication provider in this worker.
- The size optimizer is a bounded configured grid. Quote calls are sequential to constrain resource/RPC
  use. Production throughput and latency tuning must be measured, not assumed.
- OP Stack fee oracles are required to support both `getL1Fee` and `getOperatorFee`. Unsupported
  deployments fail closed. Buffers reduce fee risk but cannot freeze inclusion-time fees or token prices.
- No external security audit, MEV/private-transport integration, multi-host leader election or automatic
  dropped-transaction replacement. Run one worker with a durable journal and dedicated account.
- AWS capacity assessment and possible Kubernetes deployment on the user's physical machine are
  deferred by request. Docker packaging alone is not a claim that either host has spare capacity.
