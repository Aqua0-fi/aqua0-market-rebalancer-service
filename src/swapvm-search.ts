import { erc20Abi, type Address, type PublicClient } from "viem";
import { executorAbi } from "./abi.js";
import { nativeCostForQuote } from "./fees.js";
import { same, type ChainConfig, type Settings } from "./config.js";
import { assertFresh, ceilDiv, type Candidate } from "./strategy.js";
import { discover, quoteV3, type ExternalPool } from "./venues.js";
import type { AquaClient } from "./aqua.js";
import type { SwapVMMarketCatalog } from "./swapvm-catalog.js";
import type { SwapVMMarket } from "./swapvm.js";
import type { MarketPolicy } from "./market-catalog.js";

export interface SwapVMChoice {
  kind: "aqua";
  candidate: Candidate;
  startToken: Address;
  market: SwapVMMarket;
  policy: MarketPolicy;
  external: ExternalPool;
  inputCap: bigint;
}
interface SearchContext {
  client: PublicClient;
  chain: ChainConfig;
  settings: Settings;
  aqua: AquaClient;
  catalog: SwapVMMarketCatalog;
  onEvent: (event: string, data: Record<string, unknown>) => void;
}
export async function swapVMGasBudget(
  context: SearchContext,
  baseToken: Address,
  external: ExternalPool,
): Promise<bigint> {
  const { client, chain, settings } = context;
  const fee =
    settings.execution[String(chain.chainId)] ??
    settings.quoteFees[String(chain.chainId)];
  if (!fee)
    throw new Error(
      "A read-only fee budget must be configured before economic quotes",
    );
  const gasAsset = nativeCostForQuote(
    chain,
    fee.wrappedNative,
    fee.maxGasUnits * fee.maxFeePerGas + fee.l1FeeReserveWei,
  );
  const block = await client.getBlockNumber();
  const cost = same(gasAsset.token, baseToken)
    ? gasAsset.amount
    : await quoteV3(
        client,
        external.venue.quoter,
        fee.gasConversionFee,
        gasAsset.token,
        baseToken,
        gasAsset.amount,
        block,
      );
  return ceilDiv(cost * BigInt(fee.gasCostBufferBps), 10000n);
}
export async function collectSwapVMChoices(
  context: SearchContext,
): Promise<SwapVMChoice[]> {
  const { client, chain, settings, aqua, catalog } = context;
  const execution = settings.execution[String(chain.chainId)];
  const caller =
    execution?.executor ?? settings.quoteFees[String(chain.chainId)]?.caller;
  const markets = catalog
    .list()
    .markets.filter(
      (entry) =>
        entry.market.chainId === chain.chainId &&
        entry.readyToQuote &&
        entry.policy,
    );
  if (!markets.length) return [];
  if (!caller) {
    context.onEvent("swapvm_quote_blocked", {
      chainId: chain.chainId,
      reason:
        "Configure the intended executor/caller; opaque VM quotes must not silently use a different msg.sender",
    });
    return [];
  }
  const choices: SwapVMChoice[] = [];
  for (const { market, policy: supplied } of markets) {
    const policy = supplied!;
    const startToken = policy.baseToken as Address;
    const block = await client.getBlock();
    let inputCap = BigInt(policy.maxInput);
    if (inputCap >= 1n << 128n) inputCap = (1n << 128n) - 1n;
    if (settings.mode === "execute") {
      if (!execution) throw new Error("No funded execution configuration");
      const [balance, limit] = await Promise.all([
        client.readContract({
          address: startToken,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [execution.executor],
          blockNumber: block.number,
        }),
        client.readContract({
          address: execution.executor,
          abi: executorAbi,
          functionName: "limits",
          args: [startToken],
          blockNumber: block.number,
        }),
      ]);
      if (balance < inputCap) inputCap = balance;
      if (limit[0] < inputCap) inputCap = limit[0];
    }
    if (inputCap <= 0n) continue;
    const pools = await discover(
      client,
      chain,
      { currency0: market.token0, currency1: market.token1 },
      block.number,
    );
    for (const external of pools) {
      try {
        catalog.assertApproved(market, policy);
        const gasBudget = await swapVMGasBudget(context, startToken, external);
        const result = await aqua.optimizeSwapVM({
          chain,
          market,
          policy,
          external,
          caller,
          network: settings.networkMode,
          maxInput: inputCap,
          gasBudget,
          slippageBps: settings.slippageBps,
        });
        context.onEvent("swapvm_automatic_sizing", {
          chainId: chain.chainId,
          strategyId: market.stableStrategyId,
          externalPool: external.address,
          searches: result.searches,
        });
        for (const candidate of result.candidates)
          choices.push({
            kind: "aqua",
            candidate,
            startToken,
            market,
            policy,
            external,
            inputCap,
          });
      } catch {
        context.onEvent("swapvm_sizing_rejected", {
          chainId: chain.chainId,
          strategyId: market.stableStrategyId,
          externalPool: external.address,
        });
      }
    }
  }
  return choices;
}

/** The search result is provisional. Re-quote only the chosen size at fresh state and the real caller. */
export async function refreshSwapVMChoice(
  context: SearchContext,
  choice: SwapVMChoice,
): Promise<Candidate | null> {
  const { chain, client, settings, aqua, catalog } = context;
  const execution = settings.execution[String(chain.chainId)];
  if (!execution?.allowBroadcast || settings.mode !== "execute")
    throw new Error("Trading is not enabled");
  catalog.assertApproved(choice.market, choice.policy);
  const gasBudget = await swapVMGasBudget(
    context,
    choice.startToken,
    choice.external,
  );
  const result = await aqua.optimizeSwapVM({
    chain,
    market: choice.market,
    policy: choice.policy,
    external: choice.external,
    caller: execution.executor,
    network: settings.networkMode,
    maxInput: choice.inputCap,
    gasBudget,
    slippageBps: settings.slippageBps,
    fixedAmount: choice.candidate.trade.first.amountIn,
  });
  const candidate = result.candidates.find(
    (item) => item.aquaFirst === choice.candidate.aquaFirst,
  );
  if (!candidate) return null;
  assertFresh(
    candidate,
    await client.getBlockNumber(),
    Date.now(),
    settings.maxQuoteAgeMs,
    settings.maxBlockLag,
  );
  if (
    (await client.getBlock({ blockNumber: candidate.blockNumber })).hash !==
    candidate.quoteBlockHash
  )
    throw new Error("Refreshed SwapVM quote block reorganized");
  catalog.assertApproved(choice.market, choice.policy);
  return candidate;
}
