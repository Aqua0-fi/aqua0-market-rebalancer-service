import type { PublicClient } from "viem";
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
  };
  private errors = new Map<number, number>();
  constructor(
    private readonly chains: ChainConfig[],
    private readonly settings: Settings,
    private readonly aqua: AquaClient,
    private readonly journal: Journal,
  ) {}
  async scan(): Promise<void> {
    for (const chainId of new Set(
      this.settings.markets.map((m) => m.chainId),
    )) {
      if (
        (this.errors.get(chainId) ?? 0) >= this.settings.maxConsecutiveErrors
      ) {
        log("circuit_open", { chainId });
        continue;
      }
      try {
        await this.scanChain(chainId);
        this.errors.set(chainId, 0);
        this.metrics.lastSuccess = Date.now();
      } catch (error) {
        this.metrics.errors++;
        this.errors.set(chainId, (this.errors.get(chainId) ?? 0) + 1);
        log("chain_error", { chainId, error: safeError(error) });
      }
    }
    this.metrics.scans++;
  }
  private async scanChain(chainId: number): Promise<void> {
    const chain = this.chains.find((c) => c.chainId === chainId);
    if (!chain) throw new Error("Unknown configured chain");
    let client = this.clients.get(chainId);
    if (!client) {
      client = clientFor(chain);
      this.clients.set(chainId, client);
    }
    if (!this.verified.has(chainId)) {
      await verifyChain(client, chain);
      this.verified.add(chainId);
    }
    const config = this.settings.execution[String(chainId)];
    if (!config)
      throw new Error(
        "Gas budget and wrapped-native configuration required even for observation",
      );
    const key = `${chainId}:${config.operator.toLowerCase()}`;
    if (!(await reconcile(client, chain, this.settings, this.journal))) {
      log("pending_transaction", { chainId });
      return;
    }
    if (this.journal.get(key).errors >= this.settings.maxConsecutiveErrors)
      throw new Error("Receipt failure circuit is open");
    const choices: {
      candidate: Candidate;
      market: Settings["markets"][number];
      pool: ReturnType<typeof findPool>;
      external: ExternalPool;
    }[] = [];
    let quoteFailures = 0,
      completedQuotes = 0;
    for (const market of this.settings.markets.filter(
      (m) => m.chainId === chainId,
    )) {
      const pool = findPool(chain, market);
      const head = await client.getBlock();
      const other = same(market.baseToken, pool.currency0)
        ? pool.currency1
        : pool.currency0;
      const venues = await discover(client, chain, pool, head.number);
      const nativeCost =
        config.maxGasUnits * config.maxFeePerGas + config.l1FeeReserveWei;
      for (const external of venues) {
        const costInBase = same(config.wrappedNative, market.baseToken)
          ? nativeCost
          : await quoteV3(
              client,
              external.venue.quoter,
              config.gasConversionFee,
              config.wrappedNative,
              market.baseToken,
              nativeCost,
              head.number,
            );
        const gasCost = ceilDiv(
          costInBase * BigInt(config.gasCostBufferBps),
          10000n,
        );
        const candidates = await findCandidates({
          base: market.baseToken,
          other,
          pool,
          router: chain.universalRouter,
          external: external.address,
          amounts: market.amounts,
          slippageBps: this.settings.slippageBps,
          minNetProfit: market.minNetProfit,
          gasCost,
          blockNumber: head.number,
          timestamp: head.timestamp,
          quoteAqua: async (input, amount) => {
            const q = await this.aqua.quote(chain, pool, market, input, amount);
            completedQuotes++;
            return q;
          },
          quoteExternal: async (input, amount) => {
            const q = await quoteV3(
              client!,
              external.venue.quoter,
              external.fee,
              input,
              same(input, market.baseToken) ? other : market.baseToken,
              amount,
              head.number,
            );
            completedQuotes++;
            return q;
          },
          onQuoteError: (error) => {
            quoteFailures++;
            log("quote_rejected", {
              chainId,
              venue: external.venue.name,
              error: safeError(error),
            });
          },
        });
        for (const candidate of candidates)
          choices.push({ candidate, market, pool, external });
      }
    }
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
    // Compare return on input, avoiding raw-unit comparisons between different base tokens.
    choices.sort((a, b) =>
      a.candidate.netProfit * b.candidate.trade.first.amountIn >
      b.candidate.netProfit * a.candidate.trade.first.amountIn
        ? -1
        : 1,
    );
    const choice = choices[0];
    if (!choice) return;
    let { candidate } = choice;
    const { market, pool, external } = choice;
    log("opportunity", {
      chainId,
      baseToken: market.baseToken,
      amount: candidate.trade.first.amountIn,
      conservativeNetProfit: candidate.netProfit,
      aquaFirst: candidate.aquaFirst,
    });
    if (this.settings.mode === "observe") return;
    if (!config.allowBroadcast) throw new Error("Broadcast disabled for chain");
    // Discovery can take many blocks. Refresh the selected size and direction before reserving JIT backing.
    const fresh = await client.getBlock();
    const other = same(market.baseToken, pool.currency0)
      ? pool.currency1
      : pool.currency0;
    const nativeCost =
      config.maxGasUnits * config.maxFeePerGas + config.l1FeeReserveWei;
    const costInBase = same(config.wrappedNative, market.baseToken)
      ? nativeCost
      : await quoteV3(
          client,
          external.venue.quoter,
          config.gasConversionFee,
          config.wrappedNative,
          market.baseToken,
          nativeCost,
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
    );
    this.metrics.submitted++;
    log("submitted", { chainId, hash });
  }
}
