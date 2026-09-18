import {
  createWalletClient,
  http,
  keccak256,
  encodeFunctionData,
  type PublicClient,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { executorAbi } from "./abi.js";
import { rpcUrl, same, type ChainConfig, type Settings } from "./config.js";
import { assertFresh, ceilDiv, type Candidate } from "./strategy.js";
import { assertAdditionalFeeReserve } from "./fees.js";
import { Journal } from "./state.js";
export async function submit(
  client: PublicClient,
  chain: ChainConfig,
  settings: Settings,
  candidate: Candidate,
  journal: Journal,
): Promise<Hex> {
  const config = settings.execution[String(chain.chainId)];
  if (settings.mode !== "execute" || !config?.allowBroadcast)
    throw new Error("Broadcast disabled");
  const raw = process.env[config.privateKeyEnv];
  if (!raw || !/^0x[0-9a-fA-F]{64}$/.test(raw))
    throw new Error("Missing dedicated operator key");
  const account = privateKeyToAccount(raw as Hex);
  if (!same(account.address, config.operator))
    throw new Error("Operator key mismatch");
  const [paused, operator, router, hook, permit2, limit, extended] =
    await Promise.all([
      client.readContract({
        address: config.executor,
        abi: executorAbi,
        functionName: "paused",
      }),
      client.readContract({
        address: config.executor,
        abi: executorAbi,
        functionName: "operators",
        args: [account.address],
      }),
      client.readContract({
        address: config.executor,
        abi: executorAbi,
        functionName: "universalRouter",
      }),
      client.readContract({
        address: config.executor,
        abi: executorAbi,
        functionName: "aqua0Hook",
      }),
      client.readContract({
        address: config.executor,
        abi: executorAbi,
        functionName: "permit2",
      }),
      client.readContract({
        address: config.executor,
        abi: executorAbi,
        functionName: "limits",
        args: [candidate.trade.first.tokenIn],
      }),
      client.readContract({
        address: config.executor,
        abi: executorAbi,
        functionName: "extendedV4Encoding",
      }),
    ]);
  if (
    extended !== chain.extendedV4Encoding ||
    paused ||
    !operator ||
    !same(router, chain.universalRouter) ||
    !same(hook, chain.aqua0Hook) ||
    !same(permit2, chain.permit2)
  )
    throw new Error("Executor deployment mismatch or paused");
  if (
    candidate.trade.first.amountIn > limit[0] ||
    candidate.trade.minProfit < limit[1]
  )
    throw new Error("Onchain risk limit mismatch");
  if ((await client.getChainId()) !== chain.chainId)
    throw new Error("RPC chain changed before submission");
  const gasPrice = ceilDiv((await client.getGasPrice()) * 120n, 100n);
  if (gasPrice > config.maxFeePerGas) throw new Error("Gas price cap exceeded");
  const onchainGasCap = await client.readContract({
    address: config.executor,
    abi: executorAbi,
    functionName: "maxGasPrice",
  });
  if (gasPrice > onchainGasCap)
    throw new Error("Onchain gas price cap exceeded");
  const head = await client.getBlock();
  assertFresh(
    candidate,
    head.number,
    Date.now(),
    settings.maxQuoteAgeMs,
    settings.maxBlockLag,
  );
  if (candidate.trade.deadline <= head.timestamp + 5n)
    throw new Error("Authorization near expiry");
  candidate.trade.validUntilBlock =
    (await client.readContract({
      address: config.executor,
      abi: executorAbi,
      functionName: "executionBlockNumber",
      blockNumber: head.number,
    })) + 2n;
  // Simulate the entire atomic cycle, including the final balance-based profit assertion.
  await client.simulateContract({
    address: config.executor,
    abi: executorAbi,
    functionName: "execute",
    args: [candidate.trade],
    account,
    gasPrice,
    blockNumber: head.number,
  });
  const data = encodeFunctionData({
    abi: executorAbi,
    functionName: "execute",
    args: [candidate.trade],
  });
  const gas = ceilDiv(
    (await client.estimateGas({
      account,
      to: config.executor,
      data,
      gasPrice,
    })) * 120n,
    100n,
  );
  if (gas > config.maxGasUnits) throw new Error("Gas unit cap exceeded");

  const latest = await client.getBlock();
  assertFresh(
    candidate,
    latest.number,
    Date.now(),
    settings.maxQuoteAgeMs,
    settings.maxBlockLag,
  );
  if ((await client.getBlock({ blockNumber: head.number })).hash !== head.hash)
    throw new Error("Simulation block reorged");
  const nonce = await client.getTransactionCount({
    address: account.address,
    blockTag: "pending",
  });
  if (
    nonce !==
    (await client.getTransactionCount({
      address: account.address,
      blockTag: "latest",
    }))
  )
    throw new Error("Operator already has a pending nonce");
  await assertAdditionalFeeReserve(
    client,
    chain,
    { to: config.executor, data, gas, gasPrice, nonce },
    config.l1FeeReserveWei,
    config.gasCostBufferBps,
  );
  const signingHead = await client.getBlock();
  assertFresh(
    candidate,
    signingHead.number,
    Date.now(),
    settings.maxQuoteAgeMs,
    settings.maxBlockLag,
  );
  if (candidate.trade.deadline <= signingHead.timestamp + 5n)
    throw new Error("Authorization near expiry before signing");
  const wallet = createWalletClient({
    account,
    transport: http(rpcUrl(chain)),
  });
  const signed = await wallet.signTransaction({
    chain: null,
    chainId: chain.chainId,
    type: "legacy",
    to: config.executor,
    data,
    gas,
    gasPrice,
    nonce,
  });
  const hash = keccak256(signed);
  const journalKey = `${chain.chainId}:${account.address.toLowerCase()}`;
  // Persist the deterministic hash BEFORE broadcast. An uncertain response cannot cause a second send.
  journal.reserve(
    journalKey,
    hash,
    nonce,
    candidate.trade.id,
    gas * gasPrice + config.l1FeeReserveWei,
    config.maxDailyGasWei,
  );
  await client.sendRawTransaction({ serializedTransaction: signed });
  return hash;
}
export async function reconcile(
  client: PublicClient,
  chain: ChainConfig,
  settings: Settings,
  journal: Journal,
): Promise<boolean> {
  const config = settings.execution[String(chain.chainId)];
  if (!config) return true;
  const key = `${chain.chainId}:${config.operator.toLowerCase()}`;
  const e = journal.get(key);
  if (!e.pending) return true;
  try {
    const receipt = await client.getTransactionReceipt({
      hash: e.pending.hash as Hex,
    });
    const head = await client.getBlockNumber();
    if (head - receipt.blockNumber + 1n < BigInt(settings.confirmations))
      return false;
    const canonical = await client.getBlock({
      blockNumber: receipt.blockNumber,
    });
    if (canonical.hash !== receipt.blockHash) return false;
    const { pending: _, ...rest } = e;
    journal.set(key, {
      ...rest,
      errors: receipt.status === "success" ? 0 : e.errors + 1,
    });
    return true;
  } catch {
    return false;
  }
}
