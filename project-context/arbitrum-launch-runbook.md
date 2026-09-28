# Arbitrum launch and hackathon LP return

This is an Arbitrum-only first launch, not cross-chain arbitrage. The two trade legs remain one guarded transaction. The live observer is not enabled by these source changes.

## Funding and account roles

Use the independently checked dedicated KMS account recorded in the private launch evidence. Native Arbitrum ETH pays deployment and operator gas. Native USDC is the proposed first starting asset. Do not send native ETH directly to MarketRebalancer: it does not accept native funding. Operating ERC-20 inventory belongs in the verified executor contract only after deployment, owner and code checks.

The same owner/operator KMS account was requested for this initial setup. This reduces setup complexity, but it also means that account has owner withdrawal and configuration powers. Operator-only restrictions cannot protect against compromise of a key which is also the owner.

## Unsigned executor preparation

Build and test the exact current source first:

```sh
npm run check
npm run test:integration
node --import tsx scripts/arbitrum-launch-plan.ts --owner OWNER_ADDRESS --output evidence/unsigned-arbitrum-launch.json
```

The last command is read-only. It reads the owner nonce, native balance, registry token metadata and deployment gas estimate. It writes deployment calldata and three owner setup calls: operator, gas ceiling and a 5,000,000-unit native-USDC input cap. It does not deploy, transfer inventory, approve a venue, unpause or switch the worker into execute mode.

The predicted CREATE address is not a deployed contract and is not a funding destination. Any earlier owner transaction changes that prediction. Rebuild immediately before signing and verify the resulting deployment receipt. The fee estimate covers deployment only, not setup, inventory, reverted trades or LP returns. Fee conditions can change.

After the owner signs and submits the deployment, verify the deployed code, owner, immutable router/Permit2/hook bindings and paused state. Then review the unsigned owner setup calls. The proposed minimum gross floor is 0.01 USDC, but this is only an additional contract floor: every worker trade must still cover its freshly budgeted gas plus the configured positive minimum net profit.

## One-market activation boundary

Choose one existing Aqua0 V4 or current SwapVM strategy and a real matching external V3 pool. Verify the external factory, pool currencies, fee tier and deployed code; discovery is not an approval. Confirm fresh Aqua0 LP consent, output backing, current quote price policy, protocol minimum trade size, intended executor caller, backend service credentials and fee conversion. The source default trade floor is $1, but a current admin override must be checked rather than inferred.

Fresh Arbitrum production-maker evidence is still required. The saved Base production-maker fork proves the actual adapter and vault path there, not the current Arbitrum deployment. The authenticated Arbitrum fixture-capture command was blocked during this session and was not retried through another route. `scripts/capture-production-maker.ts` is available for a separately authorized owner run; its existence is not a successful capture.

For an accepted captured fixture, the local replay is:

```sh
PRODUCTION_MAKER_FIXTURE=config/production-maker-arbitrum-fork.json \
PRODUCTION_MAKER_CHAIN_ID=42161 \
PRODUCTION_MAKER_RPC_URL=https://arb1.arbitrum.io/rpc \
forge test --match-path contracts/test/ProductionAquaAdapter.fork.t.sol -vv
```

This replay seeds local test inventory and displaces the external pool only on the fork. Profits created that way are test evidence, not live opportunities.

Keep the original persistent journal, SQLite history, economic-review state, private report/control credentials and one-worker ownership. Set actual executor and signer configuration only after review. A public transaction still requires both `mode: execute` and `execution[42161].allowBroadcast: true`, contract unpause and explicit market permissions. These settings remain off in this delivery. Pausing must continue reconciling previously sent hashes.

## Optional 90% LP return

The Arbitrum LP tab has a separate hackathon preview. The protected GET endpoint is `/api/admin/market-rebalancer/profit-share?chainId=42161&token=STARTING_TOKEN`. It accepts no success-only, wallet or time filter that could hide losses. It verifies a complete initial batch of at most 20 executions and refuses pending or noncanonical receipts, unknown costs, mixed profit assets and incomplete actual LP evidence.

The distributable pool is 90% of positive batch trading gain after both successful and reverted transaction fees. Native fees are valued in the starting token at the receipt block; this is an explicit historical conversion, not a claim that gas was actually paid in USDC. Deployment, hosting and payout-transaction costs are not included and must be reviewed separately.

Positive-net trades receive proportional shares of that pool, then each trade's share is split by exact actual principal sold by its Aqua0 LP sources. Integer dust is deterministic. Planned backing, current balances and LPs on the external exchange do not become payout entitlements. The preview never says LPs were paid and has no signing or activation control.

`ProfitReturnDistributor` is an optional separate owner-controlled contract bound to an executor and token. It pulls only the owner's explicit token allowance, enforces the exact 90% total, rejects duplicate execution hashes and reverts the whole batch on a failed or non-exact recipient transfer. The owner must review receipt/fee/LP evidence; the distributor does not independently prove historical receipts or offchain gas valuations.

Prepare unsigned payout calls from the downloaded preview:

```sh
node --import tsx scripts/profit-return-plan.ts \
  --proposal rebalancer-profit-return-proposal.json \
  --owner OWNER_ADDRESS --distributor VERIFIED_DISTRIBUTOR_ADDRESS \
  --output evidence/unsigned-lp-return.json
```

Before the owner submits anything, verify distributor code/bindings and that each `processed(hash)` is false, recheck for new losses or reorganizations, review payout gas, and use only realized surplus while preserving trading principal. The prepared approval is exact, not unlimited. The script signs and sends nothing.

This is the first reviewed showcase batch, not a recurring rewards service. A later batch cannot reuse any execution already processed by that distributor; repeating the initial preview fails safely. A recurring distribution policy and post-payment dashboard receipt reconciliation are separate work, not silently claimed here. The hackathon feature makes no permanent production profit-sharing promise.

## Release boundaries

The earlier LP tab, price controls and economic pause were already deployed in the September 28 readiness release. This launch branch adds physical-capacity bounds, optional return preparation and its UI. Do not report the old expansion checkout as the latest deployed state. Record current PR, CI and Railway revisions after any staging rollout. Leave main, onchain funds and live trading unchanged without their separate owner actions.
