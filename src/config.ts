import { readFileSync } from "node:fs";
import { z } from "zod";
import { getAddress, type Address } from "viem";

export const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((x) => getAddress(x.toLowerCase()));
export const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .transform(BigInt);
export const positive = uint.refine((x) => x > 0n);
export const hex = z
  .string()
  .regex(/^0x(?:[0-9a-fA-F]{2})*$/)
  .transform((x) => x as `0x${string}`);
export const poolSchema = z.object({
  poolId: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .transform((x) => x as `0x${string}`),
  currency0: address,
  currency1: address,
  fee: z.number().int().min(0).max(16777215),
  tickSpacing: z.number().int().positive(),
  hooks: address,
});
const venueSchema = z.object({
  name: z.string(),
  factory: address,
  quoter: address,
  fees: z.array(z.number().int().positive().max(1000000)).min(1).max(8),
});
export const chainSchema = z.object({
  chainId: z.number().int().positive(),
  feeModel: z.enum(["op-stack", "gas-limit"]),
  name: z.string(),
  rpcEnv: z.string(),
  publicRpc: z.url(),
  poolManager: address,
  universalRouter: address,
  permit2: address,
  aqua0Hook: address,
  extendedV4Encoding: z.boolean(),
  pools: z.array(poolSchema),
  venues: z.array(venueSchema),
});
export type ChainConfig = z.infer<typeof chainSchema>;
export type Pool = z.infer<typeof poolSchema>;
export type Venue = z.infer<typeof venueSchema>;
const marketSchema = z.object({
  chainId: z.number().int().positive(),
  poolId: poolSchema.shape.poolId,
  classId: positive,
  baseToken: address,
  amounts: z.array(positive).min(1).max(8),
  minNetProfit: positive,
  maxInput: positive,
});
export type Market = z.infer<typeof marketSchema>;
export const settingsSchema = z.object({
  mode: z.enum(["observe", "execute"]).default("observe"),
  apiUrl: z.url(),
  pollMs: z.number().int().min(1000).default(15000),
  slippageBps: z.number().int().min(0).max(100).default(10),
  maxQuoteAgeMs: z.number().int().min(500).max(60000).default(10000),
  maxBlockLag: z.number().int().min(0).max(20).default(8),
  confirmations: z.number().int().min(1).default(2),
  maxConsecutiveErrors: z.number().int().positive().default(5),
  markets: z.array(marketSchema).min(1),
  execution: z
    .record(
      z.string(),
      z.object({
        executor: address,
        operator: address,
        privateKeyEnv: z.string(),
        allowBroadcast: z.boolean().default(false),
        maxGasUnits: positive,
        maxFeePerGas: positive,
        l1FeeReserveWei: uint,
        maxDailyGasWei: positive,
        // Conversion is priced through a real V3 quoter; it is not a floating point USD assumption.
        wrappedNative: address,
        gasConversionFee: z.number().int().positive(),
        gasCostBufferBps: z.number().int().min(10000).max(30000).default(13000),
      }),
    )
    .default({}),
});
export type Settings = z.infer<typeof settingsSchema>;
export function loadChains(path = "config/chains.json"): ChainConfig[] {
  const parsed = z
    .object({ chains: z.array(chainSchema) })
    .parse(JSON.parse(readFileSync(path, "utf8")));
  if (
    new Set(parsed.chains.map((c) => c.chainId)).size !== parsed.chains.length
  )
    throw new Error("Duplicate chain");
  return parsed.chains;
}
export function loadSettings(path: string): Settings {
  const settings = settingsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  for (const m of settings.markets)
    if (m.amounts.some((a) => a > m.maxInput))
      throw new Error("Sample exceeds market maxInput");
  return settings;
}
export function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
export function rpcUrl(chain: ChainConfig): string {
  return process.env[chain.rpcEnv] ?? chain.publicRpc;
}
export function findPool(chain: ChainConfig, market: Market): Pool {
  const pool = chain.pools.find((p) => same(p.poolId, market.poolId));
  if (
    !pool ||
    !same(pool.hooks, chain.aqua0Hook) ||
    (!same(market.baseToken, pool.currency0) &&
      !same(market.baseToken, pool.currency1))
  )
    throw new Error("Market is not an Aqua0 registry pool");
  return pool;
}
export const zero = "0x0000000000000000000000000000000000000000" as Address;
