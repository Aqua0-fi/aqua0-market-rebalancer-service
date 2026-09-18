/** Local EVM integration for the real offchain signing, simulation, submission and journal path.
 * The mainnet protocol integration is separately covered by contracts/test/MarketRebalancer.fork.t.sol. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeAbiParameters,
  parseAbiParameters,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type Abi,
  erc20Abi,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { submit, reconcile } from "../src/execution.js";
import { executorAbi } from "../src/abi.js";
import { settingsSchema, loadChains, type ChainConfig } from "../src/config.js";
import { Journal } from "../src/state.js";
import type { Candidate } from "../src/strategy.js";

test("offchain worker simulates, signs, sends, accounts for receipt and prevents duplicate sends", async () => {
  const port = Number(process.env.TEST_ANVIL_PORT ?? 18547);
  const url = `http://127.0.0.1:${port}`;
  const anvil = spawn(
    "anvil",
    [
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--chain-id",
      "31337",
      "--silent",
    ],
    { stdio: "ignore" },
  );
  const dir = mkdtempSync(join(tmpdir(), "rebalancer-integration-"));
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const client = createPublicClient({
    transport: http(url, { retryCount: 0 }),
    cacheTime: 0,
  });
  const wallet = createWalletClient({ account, transport: http(url) });
  async function rpc(method: string, params: unknown[]) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const d = (await r.json()) as { error?: unknown };
    if (d.error) throw new Error("Local RPC failed");
  }
  function artifact(name: string) {
    return JSON.parse(
      readFileSync(
        `out/${name === "MarketRebalancer" ? "MarketRebalancer.sol" : "MarketRebalancer.t.sol"}/${name}.json`,
        "utf8",
      ),
    ) as { abi: Abi; bytecode: { object: Hex } };
  }
  async function deploy(
    name: string,
    args: readonly unknown[] = [],
  ): Promise<Address> {
    const a = artifact(name);
    const hash = await wallet.deployContract({
      chain: null,
      abi: a.abi,
      bytecode: a.bytecode.object,
      args,
    });
    const r = await client.waitForTransactionReceipt({ hash });
    assert(r.contractAddress);
    return r.contractAddress;
  }
  async function write(
    name: string,
    address: Address,
    functionName: string,
    args: readonly unknown[] = [],
  ) {
    const hash = await wallet.writeContract({
      chain: null,
      address,
      abi: artifact(name).abi,
      functionName,
      args,
    });
    assert.equal(
      (await client.waitForTransactionReceipt({ hash })).status,
      "success",
    );
  }
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        assert.equal(await client.getChainId(), 31337);
        ready = true;
        break;
      } catch {
        await sleep(50);
      }
    }
    assert(ready, "Anvil did not start");
    await rpc("anvil_setBalance", [account.address, toHex(100n * 10n ** 18n)]);
    const tokens = [await deploy("Token"), await deploy("Token")].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    );
    const [token0, token1] = tokens as [Address, Address];
    const permit = await deploy("Permit");
    const router = await deploy("Router", [permit]);
    const pool = await deploy("V3", [token0, token1]);
    const bot = await deploy("MarketRebalancer", [
      account.address,
      router,
      permit,
      token0,
      false,
    ]);
    const key = {
      currency0: token0,
      currency1: token1,
      fee: 3000,
      tickSpacing: 60,
      hooks: token0,
    };
    await write("MarketRebalancer", bot, "setOperator", [
      account.address,
      true,
    ]);
    await write("MarketRebalancer", bot, "setLimits", [
      token0,
      1000n * 10n ** 18n,
      1n,
    ]);
    await write("MarketRebalancer", bot, "setAquaPool", [key, true]);
    await write("MarketRebalancer", bot, "setV3Pool", [pool, true]);
    await write("MarketRebalancer", bot, "setGasPriceLimit", [10000000000n]);
    await write("MarketRebalancer", bot, "setPaused", [false]);
    await write("Token", token0, "mint", [bot, 1000n * 10n ** 18n]);
    const source = loadChains()[0]!;
    const chain: ChainConfig = {
      ...source,
      chainId: 31337,
      feeModel: "gas-limit",
      rpcEnv: "REBALANCER_TEST_RPC",
      publicRpc: url,
      universalRouter: router,
      permit2: permit,
      aqua0Hook: token0,
    };
    process.env.REBALANCER_TEST_RPC = url;
    process.env.REBALANCER_TEST_KEY = privateKey;
    const config = settingsSchema.parse({
      mode: "execute",
      apiUrl: url,
      confirmations: 1,
      maxBlockLag: 8,
      markets: [
        {
          chainId: 31337,
          poolId: source.pools[0]!.poolId,
          classId: "1",
          baseToken: token0,
          amounts: ["100"],
          maxInput: "1000",
          minNetProfit: "1",
        },
      ],
      execution: {
        31337: {
          executor: bot,
          operator: account.address,
          privateKeyEnv: "REBALANCER_TEST_KEY",
          allowBroadcast: true,
          maxGasUnits: "2000000",
          maxFeePerGas: "10000000000",
          l1FeeReserveWei: "0",
          maxDailyGasWei: "100000000000000000",
          wrappedNative: token0,
          gasConversionFee: 500,
        },
      },
    });
    const head = await client.getBlock();
    const candidate: Candidate = {
      quotedAt: Date.now(),
      blockNumber: head.number,
      quotedProfit: 14n * 10n ** 18n,
      netProfit: 14n * 10n ** 18n,
      aquaFirst: true,
      trade: {
        id: keccak256(toHex("integration")),
        deadline: head.timestamp + 60n,
        validUntilBlock: head.number + 2n,
        minProfit: 1n,
        first: {
          venue: 0,
          target: router,
          tokenIn: token0,
          tokenOut: token1,
          amountIn: 100n * 10n ** 18n,
          minOut: 190n * 10n ** 18n,
          pool: key,
          hookData: encodeAbiParameters(parseAbiParameters("bytes32"), [
            keccak256(toHex("AQUA0_JIT_PAYLOAD")),
          ]),
        },
        second: {
          venue: 1,
          target: pool,
          tokenIn: token1,
          tokenOut: token0,
          amountIn: 190n * 10n ** 18n,
          minOut: 101n * 10n ** 18n,
          pool: key,
          hookData: "0x",
        },
      },
    };
    const journal = new Journal(join(dir, "journal.json"));
    const hash = await submit(client, chain, config, candidate, journal);
    const jkey = `31337:${account.address.toLowerCase()}`;
    assert.equal(
      new Journal(join(dir, "journal.json")).get(jkey).pending?.hash,
      hash,
    );
    assert.equal(
      (await client.waitForTransactionReceipt({ hash })).status,
      "success",
    );
    assert.equal(
      await client.readContract({
        address: token0,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [bot],
      }),
      1014n * 10n ** 18n,
    );
    assert(await reconcile(client, chain, config, journal));
    assert.equal(journal.get(jkey).pending, undefined);
    assert(BigInt(journal.get(jkey).reservedWei) > 0n);
    await assert.rejects(() =>
      submit(client, chain, config, candidate, journal),
    );
    const observe = { ...config, mode: "observe" as const };
    await assert.rejects(
      () => submit(client, chain, observe, candidate, journal),
      /Broadcast disabled/,
    );
    assert.equal(
      await client.readContract({
        address: bot,
        abi: executorAbi,
        functionName: "executionBlockNumber",
      }),
      await client.getBlockNumber(),
    );
  } finally {
    delete process.env.REBALANCER_TEST_KEY;
    delete process.env.REBALANCER_TEST_RPC;
    anvil.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
});
