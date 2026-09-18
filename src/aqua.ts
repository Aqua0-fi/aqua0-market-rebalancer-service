import { z } from "zod";
import {
  address,
  hex,
  positive,
  uint,
  same,
  type ChainConfig,
  type Market,
  type Pool,
} from "./config.js";
import type { Address, Hex } from "viem";
export const MIN_SQRT = 4295128740n;
export const MAX_SQRT = 1461446703485210103287273052203988822378723970341n;
const quoteSchema = z.object({
  quote: z.object({
    amountIn: positive,
    amountOut: positive,
    amountInToken: address,
    amountOutToken: address,
    execution: z.object({
      requestedAmountIn: positive,
      authorizedAmountIn: positive,
      authorizedAmountOut: positive,
      fullySupported: z.boolean(),
      wasClamped: z.boolean(),
    }),
  }),
});
const authSchema = z.object({
  hookData: hex,
  authorization: z.object({
    executor: address,
    deadline: positive,
    poolId: hex,
    classId: uint,
    nonce: uint,
  }),
});
export function validateQuote(
  raw: unknown,
  input: Address,
  output: Address,
  amount: bigint,
): bigint {
  const { quote: q } = quoteSchema.parse(raw);
  if (
    !q.execution.fullySupported ||
    q.execution.wasClamped ||
    q.amountIn !== amount ||
    q.execution.requestedAmountIn !== amount ||
    q.execution.authorizedAmountIn !== amount ||
    !same(q.amountInToken, input) ||
    !same(q.amountOutToken, output)
  )
    throw new Error("Aqua0 partial fill or token mismatch");
  return q.amountOut < q.execution.authorizedAmountOut
    ? q.amountOut
    : q.execution.authorizedAmountOut;
}
export class AquaClient {
  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
  ) {}
  private async post(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(new URL(path, this.url), {
      method: "POST",
      headers: { "content-type": "application/json", ...this.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Aqua0 ${path} HTTP ${response.status}`);
    return response.json();
  }
  private body(
    chain: ChainConfig,
    pool: Pool,
    market: Market,
    input: Address,
    amount: bigint,
  ) {
    const zeroForOne = same(input, pool.currency0);
    return {
      venue: "v4",
      chainId: chain.chainId,
      poolId: pool.poolId,
      classId: market.classId.toString(),
      token0: pool.currency0,
      token1: pool.currency1,
      tickSpacing: pool.tickSpacing,
      swapDirection: zeroForOne ? "zeroForOne" : "oneForZero",
      tradeType: "exactIn",
      ...(zeroForOne
        ? { requestedAmount0: amount.toString() }
        : { requestedAmount1: amount.toString() }),
    };
  }
  async quote(
    chain: ChainConfig,
    pool: Pool,
    market: Market,
    input: Address,
    amount: bigint,
  ): Promise<bigint> {
    const out = same(input, pool.currency0) ? pool.currency1 : pool.currency0;
    return validateQuote(
      await this.post(
        "/api/swap/quote",
        this.body(chain, pool, market, input, amount),
      ),
      input,
      out,
      amount,
    );
  }
  async authorize(
    chain: ChainConfig,
    pool: Pool,
    market: Market,
    input: Address,
    amount: bigint,
  ): Promise<{ hookData: Hex; deadline: bigint }> {
    const raw = await this.post("/api/swap/authorize", {
      ...this.body(chain, pool, market, input, amount),
      amountSpecified: (-amount).toString(),
      sqrtPriceLimitX96: (same(input, pool.currency0)
        ? MIN_SQRT
        : MAX_SQRT
      ).toString(),
    });
    const auth = authSchema.parse(raw);
    if (
      !same(auth.authorization.executor, chain.universalRouter) ||
      !same(auth.authorization.poolId, pool.poolId) ||
      auth.authorization.classId !== market.classId ||
      auth.hookData.length < 66
    )
      throw new Error("Aqua0 authorization binding mismatch");
    return { hookData: auth.hookData, deadline: auth.authorization.deadline };
  }
}
