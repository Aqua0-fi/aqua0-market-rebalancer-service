import {
  createWalletClient,
  http,
  keccak256,
  encodeFunctionData,
  type PublicClient,
  type Hex,
} from "viem";
import { workerAccount } from "./worker-account.js";
import type { KmsTransport } from "./kms-account.js";
import { executorAbi } from "./abi.js";
import { rpcUrl, same, type ChainConfig, type Settings } from "./config.js";
import { assertFresh, ceilDiv, type Candidate } from "./strategy.js";
import { assertAdditionalFeeReserve } from "./fees.js";
import { Journal } from "./state.js";
import { HistoryStore } from "./history.js";
import { preparedExecution, executionReceipt } from "./execution-history.js";
export async function submit(
  client: PublicClient,
  chain: ChainConfig,
  settings: Settings,
  candidate: Candidate,
  journal: Journal,
  history?: HistoryStore,
  kmsTransport?: KmsTransport,
  beforeBroadcast?: () => void,
): Promise<Hex> {
  const config = settings.execution[String(chain.chainId)];
  if (settings.mode !== "execute" || !config?.allowBroadcast)
    throw new Error("Broadcast disabled");
  if (!chain.executionReviewed || chain.feeModel === "unsupported")
    throw new Error("Chain execution capability is not reviewed");
  const account = await workerAccount(
    chain.chainId,
    config,
    process.env,
    kmsTransport,
  );
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
  if (candidate.swapVM) {
    const venue = candidate.swapVM;
    const capability = await client.readContract({
      address: config.executor,
      abi: executorAbi,
      functionName: "supportsAquaSwapVM",
    });
    if (!capability)
      throw new Error("This executor version has no SwapVM support");
    const key = await client.readContract({
      address: config.executor,
      abi: executorAbi,
      functionName: "swapVMStrategyKey",
      args: [venue.router, venue.maker, venue.stableStrategyId],
    });
    const [routerPolicy, strategyPolicy] = await Promise.all([
      client.readContract({
        address: config.executor,
        abi: executorAbi,
        functionName: "swapVMRouters",
        args: [venue.router],
      }),
      client.readContract({
        address: config.executor,
        abi: executorAbi,
        functionName: "swapVMStrategies",
        args: [key],
      }),
    ]);
    if (
      !routerPolicy[3] ||
      !strategyPolicy[3] ||
      !same(routerPolicy[0], venue.aqua) ||
      routerPolicy[2] !== venue.slices ||
      strategyPolicy[2] !== venue.classId
    )
      throw new Error(
        "SwapVM execution is not owner-approved for this strategy/router",
      );
  }
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
  beforeBroadcast?.();
  const hash = keccak256(signed);
  const journalKey = `${chain.chainId}:${account.address.toLowerCase()}`;
  // Persist the deterministic hash BEFORE broadcast. An uncertain response cannot cause a second send.
  history?.prepare(preparedExecution(chain, settings, candidate, hash));
  journal.reserve(
    journalKey,
    hash,
    nonce,
    candidate.trade.id,
    gas * gasPrice + config.l1FeeReserveWei,
    config.maxDailyGasWei,
    history !== undefined,
  );
  await client.sendRawTransaction({ serializedTransaction: signed });
  history?.acknowledgeBroadcast(settings.networkMode, chain.chainId, hash);
  return hash;
}
export async function reconcile(
  client: PublicClient,
  chain: ChainConfig,
  settings: Settings,
  journal: Journal,
  history?: HistoryStore,
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
    // A failed history write keeps the pending hash locked for reconciliation on the next scan.
    const prepared = history?.get(
      settings.networkMode,
      chain.chainId,
      e.pending.hash,
    );
    if (e.pending.historyRequired && !prepared)
      throw new Error("Required execution history is missing");
    if (prepared && history) {
      history.settle(
        settings.networkMode,
        chain.chainId,
        e.pending.hash,
        receipt.status === "success" ? "confirmed" : "reverted",
        executionReceipt(prepared, receipt, canonical.timestamp, chain),
      );
    }
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
