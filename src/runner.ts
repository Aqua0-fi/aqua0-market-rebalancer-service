import { registryBlockers } from "./registry.js";
import { nativeCostForQuote } from "./fees.js";
import { erc20Abi, type Address, type PublicClient } from "viem";
import { executorAbi } from "./abi.js";
import { AquaClient } from "./aqua.js";
import {
  clientFor,
  discover,
  quoteV3,
  verifyChain,
  type ExternalPool,
} from "./venues.js";
import { findPool, same, type ChainConfig, type Settings } from "./config.js";
import {
  findCandidates,
  ceilDiv,
  assertFresh,
  type Candidate,
} from "./strategy.js";
import { reconcile, submit } from "./execution.js";
import { Journal } from "./state.js";
import type { HistoryStore } from "./history.js";
import type { MarketCatalog } from "./market-catalog.js";
import type { SwapVMMarketCatalog } from "./swapvm-catalog.js";
import {
  collectSwapVMChoices,
  refreshSwapVMChoice,
  type SwapVMChoice,
} from "./swapvm-search.js";
import { refreshPublicMarkets } from "./discovery.js";
export const json = (value: unknown): string =>
  JSON.stringify(value, (_, v: unknown) =>
    typeof v === "bigint" ? v.toString() : v,
  );
export const log = (
  event: string,
  data: Record<string, unknown> = {},
): void => {
  console.log(json({ time: new Date().toISOString(), event, ...data }));
};
export function safeError(error: unknown): string {
  const message =
    error instanceof Error
      ? (error.message.split("\n")[0] ?? error.name)
      : "Unknown failure";
  return message
    .replace(/https?:\/\/\S+/gi, "[RPC or API URL]")
    .replace(/0x[0-9a-fA-F]{64}/g, "[redacted]")
    .slice(0, 220);
}
export class Runner {
  private clients = new Map<number, PublicClient>();
  private verified = new Set<number>();
  readonly metrics = {
    scans: 0,
    candidates: 0,
    submitted: 0,
    errors: 0,
    lastSuccess: 0,
    lastHeartbeat: Date.now(),
    scanStartedAt: 0,
    scanDurationMs: 0,
  };
  private errors = new Map<number, number>();
  private lastScans = new Map<number, { at: string; error: string | null }>();
  private readonly startedAt = new Date().toISOString();
  private lastDiscoveryAt = 0;
  constructor(
    private readonly chains: ChainConfig[],
    private readonly settings: Settings,
    private readonly aqua: AquaClient,
    private readonly journal: Journal,
    private readonly history?: HistoryStore,
    private readonly catalog?: MarketCatalog,
    private readonly swapVMCatalog?: SwapVMMarketCatalog,
  ) {
    if (settings.discovery.enabled && !catalog)
      throw new Error("Discovery needs a persistent market catalog");
  }
  private swapVMMarkets() {
    return (
      this.swapVMCatalog?.list().markets.filter((m) => m.readyToQuote) ?? []
    );
  }
  private markets() {
    return this.settings.discovery.enabled
      ? this.catalog!.activeMarkets()
      : this.settings.markets;
  }
  private assertMarketApproval(market: Settings["markets"][number]) {
    if (!this.settings.discovery.enabled) return;
    const current = this.catalog!.activeMarkets().find(
      (m) => m.chainId === market.chainId && same(m.poolId, market.poolId),
    );
    if (
      !current ||
      current.classId !== market.classId ||
      !same(current.baseToken, market.baseToken) ||
      current.maxInput !== market.maxInput ||
      current.minNetProfit !== market.minNetProfit ||
      current.amounts.join(",") !== market.amounts.join(",")
    )
      throw new Error(
        "Market approval changed or discovery became stale; refresh before authorizing or broadcasting",
      );
  }
  reportingStatus() {
    return {
      version: 1 as const,
      service: "market-rebalancer-service",
      network: this.settings.networkMode,
      mode: this.settings.mode,
      generatedAt: new Date().toISOString(),
      startedAt: this.startedAt,
      metrics: { ...this.metrics },
      chains: this.chains.map((chain) => ({
        chainId: chain.chainId,
        name: chain.name,
        nativeCurrency: chain.nativeCurrency ?? null,
        configuredMarkets:
          this.markets().filter((m) => m.chainId === chain.chainId).length +
          this.swapVMMarkets().filter((m) => m.market.chainId === chain.chainId)
            .length,
        registryBlockers: registryBlockers(chain),
        deploymentVerified: this.verified.has(chain.chainId),
        executionEnabled:
          this.settings.mode === "execute" &&
          !!this.settings.execution[String(chain.chainId)]?.allowBroadcast,
        circuitOpen:
          (this.errors.get(chain.chainId) ?? 0) >=
          this.settings.maxConsecutiveErrors,
        lastScan: this.lastScans.get(chain.chainId) ?? null,
        pools: chain.pools.map((pool) => ({
          poolId: pool.poolId,
          currency0: pool.currency0,
          currency1: pool.currency1,
        })),
      })),
    };
  }
  async scan(): Promise<void> {
    const started = Date.now();
    this.metrics.scanStartedAt = started;
    this.metrics.lastHeartbeat = started;
    if (
      this.settings.discovery.enabled &&
      started - this.lastDiscoveryAt >= this.settings.discovery.intervalMs
    ) {
      this.lastDiscoveryAt = started;
      const result = await refreshPublicMarkets(
        this.chains,
        this.aqua,
        this.catalog!,
      );
      this.metrics.lastHeartbeat = Date.now();
      if (result.succeeded > 0) this.metrics.lastSuccess = Date.now();
      log("public_v4_discovery", result);
      if (this.swapVMCatalog) {
        for (const chain of this.chains) {
          try {
            this.swapVMCatalog.recordListing(
              chain,
              await this.aqua.listSwapVM(chain),
            );
          } catch {
            this.swapVMCatalog.recordFailure(chain.chainId);
          }
          this.metrics.lastHeartbeat = Date.now();
        }
      }
    }
    for (const chainId of new Set([
      ...this.markets().map((m) => m.chainId),
      ...this.swapVMMarkets().map((m) => m.market.chainId),
    ])) {
      if (
        (this.errors.get(chainId) ?? 0) >= this.settings.maxConsecutiveErrors
      ) {
        const last = this.lastScans.get(chainId);
        if (
          this.settings.mode !== "observe" ||
          (last && Date.now() - Date.parse(last.at) < 120000)
        ) {
          log("circuit_open", { chainId });
          continue;
        }
        this.errors.set(chainId, 0);
      }
      try {
        await this.scanChain(chainId);
        this.errors.set(chainId, 0);
        this.metrics.lastSuccess = Date.now();
        this.lastScans.set(chainId, {
          at: new Date().toISOString(),
          error: null,
        });
      } catch (error) {
        this.metrics.errors++;
        this.errors.set(chainId, (this.errors.get(chainId) ?? 0) + 1);
        log("chain_error", { chainId, error: safeError(error) });
        this.lastScans.set(chainId, {
          at: new Date().toISOString(),
          error: safeError(error),
        });
      }
    }
    this.metrics.scans++;
    this.metrics.lastHeartbeat = Date.now();
    this.metrics.scanDurationMs = this.metrics.lastHeartbeat - started;
  }
  private async scanChain(chainId: number): Promise<void> {
    const configured = this.chains.find((c) => c.chainId === chainId);
    if (!configured) throw new Error("Unknown configured chain");
    const chain = this.settings.discovery.enabled
      ? { ...configured, pools: this.catalog!.activePools(chainId) }
      : configured;
    let client = this.clients.get(chainId);
    if (!client) {
      client = clientFor(chain);
      this.clients.set(chainId, client);
    }
    if (!this.verified.has(chainId)) {
      await verifyChain(client, chain);
      this.verified.add(chainId);
    }
    const execution = this.settings.execution[String(chainId)];
    // Reconcile pending transactions even when a policy or quote profile changed.
    if (
      !(await reconcile(
        client,
        chain,
        this.settings,
        this.journal,
        this.history,
      ))
    ) {
      log("pending_transaction", { chainId });
      return;
    }
    if (
      execution &&
      this.journal.get(`${chainId}:${execution.operator.toLowerCase()}`)
        .errors >= this.settings.maxConsecutiveErrors
    ) {
      throw new Error("Receipt failure circuit is open");
    }
    const config = execution ?? this.settings.quoteFees[String(chainId)];
    if (!config)
      throw new Error(
        "Configure a read-only chain fee budget before economic scans",
      );
    if (this.settings.mode === "execute" && !execution)
      throw new Error("No funded execution configuration");
    const v4Markets = this.markets().filter((m) => m.chainId === chainId);
    if (v4Markets.length) {
      const blockers = registryBlockers(chain);
      if (blockers.length > 0)
        throw new Error(`Chain not ready: ${blockers.join("; ")}`);
    }
    const choices: (
      | {
          kind: "v4";
          startToken: Address;
          candidate: Candidate;
          market: Settings["markets"][number];
          pool: ReturnType<typeof findPool>;
          external: ExternalPool;
        }
      | SwapVMChoice
    )[] = [];
    let quoteFailures = 0,
      completedQuotes = 0;
    for (const market of this.markets().filter((m) => m.chainId === chainId)) {
      const pool = findPool(chain, market);
      const head = await client.getBlock();
      let inputCap =
        market.maxInput < (1n << 128n) - 1n
          ? market.maxInput
          : (1n << 128n) - 1n;
      if (this.settings.mode === "execute") {
        const [inventory, limits] = await Promise.all([
          client.readContract({
            address: market.baseToken,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [execution!.executor],
            blockNumber: head.number,
          }),
          client.readContract({
            address: execution!.executor,
            abi: executorAbi,
            functionName: "limits",
            args: [market.baseToken],
            blockNumber: head.number,
          }),
        ]);
        if (inventory < inputCap) inputCap = inventory;
        if (limits[0] < inputCap) inputCap = limits[0];
      }
      if (inputCap === 0n) {
        log("no_operating_inventory", { chainId, poolId: pool.poolId });
        continue;
      }
      const venues = await discover(client, chain, pool, head.number);
      const nativeCost =
        config.maxGasUnits * config.maxFeePerGas + config.l1FeeReserveWei;
      for (const external of venues) {
        const gasAsset = nativeCostForQuote(
          chain,
          config.wrappedNative,
          nativeCost,
        );
        const costInBase = same(gasAsset.token, market.baseToken)
          ? gasAsset.amount
          : await quoteV3(
              client,
              external.venue.quoter,
              config.gasConversionFee,
              gasAsset.token,
              market.baseToken,
              gasAsset.amount,
              head.number,
            );
        const gasCost = ceilDiv(
          costInBase * BigInt(config.gasCostBufferBps),
          10000n,
        );
        try {
          this.assertMarketApproval(market);
          const optimized = await this.aqua.optimize({
            chain,
            pool,
            market,
            external,
            network: this.settings.networkMode,
            maxInput: inputCap,
            gasBudget: gasCost,
            slippageBps: this.settings.slippageBps,
          });
          completedQuotes += optimized.searches.reduce(
            (sum, item) => sum + item.curveEvaluations,
            0,
          );
          log("automatic_sizing", {
            chainId,
            poolId: pool.poolId,
            externalPool: external.address,
            inputCap,
            blockNumber: optimized.blockNumber,
            searches: optimized.searches,
            excluded: optimized.excluded.map((item) => ({
              aquaFirst: item.aquaFirst,
              reason: safeError(new Error(item.reason)),
            })),
          });
          for (const candidate of optimized.candidates) {
            assertFresh(
              candidate,
              await client.getBlockNumber(),
              Date.now(),
              this.settings.maxQuoteAgeMs,
              this.settings.maxBlockLag,
            );
            if (
              (await client.getBlock({ blockNumber: candidate.blockNumber }))
                .hash !== candidate.quoteBlockHash
            )
              throw new Error("Sizing block reorganized");
            choices.push({
              kind: "v4",
              startToken: market.baseToken,
              candidate,
              market,
              pool,
              external,
            });
          }
        } catch (error) {
          quoteFailures++;
          log("sizing_rejected", {
            chainId,
            poolId: pool.poolId,
            venue: external.venue.name,
            error: safeError(error),
          });
        }
      }
    }
    const vmContext = this.swapVMCatalog
      ? {
          client,
          chain,
          settings: this.settings,
          aqua: this.aqua,
          catalog: this.swapVMCatalog,
          onEvent: log,
        }
      : undefined;
    if (vmContext) choices.push(...(await collectSwapVMChoices(vmContext)));
    this.metrics.candidates += choices.length;
    log("scan_complete", {
      chainId,
      candidates: choices.length,
      completedQuotes,
      quoteFailures,
      mode: this.settings.mode,
    });
    if (quoteFailures > 0 && choices.length === 0)
      throw new Error("Quote failures prevented a healthy scan");
    // Within the SAME starting token choose absolute net profit, not return percentage.
    // Across distinct unpriced assets only ROI is comparable; do not add incompatible raw units.
    choices.sort((a, b) => {
      if (same(a.startToken, b.startToken))
        return a.candidate.netProfit > b.candidate.netProfit
          ? -1
          : a.candidate.netProfit < b.candidate.netProfit
            ? 1
            : 0;
      const left = a.candidate.netProfit * b.candidate.trade.first.amountIn;
      const right = b.candidate.netProfit * a.candidate.trade.first.amountIn;
      return left > right ? -1 : left < right ? 1 : 0;
    });
    const choice = choices[0];
    if (!choice) return;
    let { candidate } = choice;
    log("opportunity", {
      chainId,
      baseToken: choice.startToken,
      venue: choice.kind,
      amount: candidate.trade.first.amountIn,
      conservativeNetProfit: candidate.netProfit,
      aquaFirst: candidate.aquaFirst,
    });
    if (this.settings.mode === "observe") return;
    if (!execution?.allowBroadcast)
      throw new Error("Broadcast disabled for chain");
    if (choice.kind === "aqua") {
      if (!vmContext) throw new Error("SwapVM catalog is not configured");
      const refreshed = await refreshSwapVMChoice(vmContext, choice);
      if (!refreshed) {
        log("opportunity_disappeared", { chainId, venue: "aqua" });
        return;
      }
      const hash = await submit(
        client,
        chain,
        this.settings,
        refreshed,
        this.journal,
        this.history,
        undefined,
        () => vmContext.catalog.assertApproved(choice.market, choice.policy),
      );
      this.metrics.submitted++;
      log("submitted", { chainId, hash, venue: "aqua" });
      return;
    }
    const { market, pool, external } = choice;
    // Discovery can take many blocks. Refresh the selected size and direction before reserving JIT backing.
    const fresh = await client.getBlock();
    const other = same(market.baseToken, pool.currency0)
      ? pool.currency1
      : pool.currency0;
    const nativeCost =
      config.maxGasUnits * config.maxFeePerGas + config.l1FeeReserveWei;
    const gasAsset = nativeCostForQuote(
      chain,
      config.wrappedNative,
      nativeCost,
    );
    const costInBase = same(gasAsset.token, market.baseToken)
      ? gasAsset.amount
      : await quoteV3(
          client,
          external.venue.quoter,
          config.gasConversionFee,
          gasAsset.token,
          market.baseToken,
          gasAsset.amount,
          fresh.number,
        );
    const refreshed = await findCandidates({
      base: market.baseToken,
      other,
      pool,
      router: chain.universalRouter,
      external: external.address,
      amounts: [candidate.trade.first.amountIn],
      slippageBps: this.settings.slippageBps,
      minNetProfit: market.minNetProfit,
      gasCost: ceilDiv(costInBase * BigInt(config.gasCostBufferBps), 10000n),
      blockNumber: fresh.number,
      timestamp: fresh.timestamp,
      quoteAqua: (input, amount) =>
        this.aqua.quote(chain, pool, market, input, amount),
      quoteExternal: (input, amount) =>
        quoteV3(
          client!,
          external.venue.quoter,
          external.fee,
          input,
          same(input, market.baseToken) ? other : market.baseToken,
          amount,
          fresh.number,
        ),
    });
    const selected = refreshed.find((c) => c.aquaFirst === candidate.aquaFirst);
    if (!selected) {
      log("opportunity_disappeared", { chainId });
      return;
    }
    candidate = selected;
    assertFresh(
      candidate,
      await client.getBlockNumber(),
      Date.now(),
      this.settings.maxQuoteAgeMs,
      this.settings.maxBlockLag,
    );
    const aquaLeg = candidate.aquaFirst
      ? candidate.trade.first
      : candidate.trade.second;
    this.assertMarketApproval(market);
    const auth = await this.aqua.authorize(
      chain,
      pool,
      market,
      aquaLeg.tokenIn,
      aquaLeg.amountIn,
    );
    aquaLeg.hookData = auth.hookData;
    candidate.trade.deadline =
      auth.deadline < candidate.trade.deadline
        ? auth.deadline
        : candidate.trade.deadline;
    const hash = await submit(
      client,
      chain,
      this.settings,
      candidate,
      this.journal,
      this.history,
      undefined,
      () => this.assertMarketApproval(market),
    );
    this.metrics.submitted++;
    log("submitted", { chainId, hash });
  }
}
