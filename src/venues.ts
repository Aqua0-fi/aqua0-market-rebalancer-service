import {
  createPublicClient,
  http,
  zeroAddress,
  type Address,
  type PublicClient,
} from "viem";
import { factoryAbi, quoterAbi, v3Abi, routerAbi, hookAbi } from "./abi.js";
import {
  same,
  rpcUrl,
  type ChainConfig,
  type Pool,
  type Venue,
} from "./config.js";
export function clientFor(chain: ChainConfig): PublicClient {
  return createPublicClient({
    cacheTime: 0,
    transport: http(rpcUrl(chain), { timeout: 12000, retryCount: 1 }),
  });
}
export type ExternalPool = { address: Address; fee: number; venue: Venue };
export async function verifyChain(
  client: PublicClient,
  chain: ChainConfig,
): Promise<void> {
  if ((await client.getChainId()) !== chain.chainId)
    throw new Error("RPC chain ID mismatch");
  for (const address of [
    chain.poolManager,
    chain.universalRouter,
    chain.permit2,
    chain.aqua0Hook,
  ])
    if (((await client.getCode({ address }))?.length ?? 0) <= 2)
      throw new Error("Registry contract has no bytecode");
  const manager = await client.readContract({
    address: chain.universalRouter,
    abi: routerAbi,
    functionName: "poolManager",
  });
  const hookManager = await client.readContract({
    address: chain.aqua0Hook,
    abi: hookAbi,
    functionName: "poolManager",
  });
  if (
    !same(manager, chain.poolManager) ||
    !same(hookManager, chain.poolManager)
  )
    throw new Error("PoolManager binding mismatch");
}
export async function discover(
  client: PublicClient,
  chain: ChainConfig,
  pool: Pick<Pool, "currency0" | "currency1">,
  blockNumber: bigint,
): Promise<ExternalPool[]> {
  const found: ExternalPool[] = [];
  for (const venue of chain.venues)
    for (const fee of venue.fees) {
      const address = await client.readContract({
        address: venue.factory,
        abi: factoryAbi,
        functionName: "getPool",
        args: [pool.currency0, pool.currency1, fee],
        blockNumber,
      });
      if (address === zeroAddress) continue;
      const [t0, t1, actualFee, liquidity] = await Promise.all([
        client.readContract({
          address,
          abi: v3Abi,
          functionName: "token0",
          blockNumber,
        }),
        client.readContract({
          address,
          abi: v3Abi,
          functionName: "token1",
          blockNumber,
        }),
        client.readContract({
          address,
          abi: v3Abi,
          functionName: "fee",
          blockNumber,
        }),
        client.readContract({
          address,
          abi: v3Abi,
          functionName: "liquidity",
          blockNumber,
        }),
      ]);
      if (
        !same(t0, pool.currency0) ||
        !same(t1, pool.currency1) ||
        actualFee !== fee
      )
        throw new Error("External pool binding mismatch");
      if (liquidity > 0n) found.push({ address, fee, venue });
    }
  return found;
}
export async function quoteV3(
  client: PublicClient,
  quoter: Address,
  fee: number,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  blockNumber: bigint,
): Promise<bigint> {
  const { result } = await client.simulateContract({
    address: quoter,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
    blockNumber,
  });
  if (result[0] === 0n) throw new Error("Empty V3 quote");
  return result[0];
}
