import test from "node:test";
import assert from "node:assert/strict";
import type { PublicClient } from "viem";
import { assertAdditionalFeeReserve } from "../src/fees.js";
import { loadChains } from "../src/config.js";
const chain = loadChains()[0]!;
const tx = {
  to: chain.universalRouter,
  data: "0x1234" as const,
  gas: 1000000n,
  gasPrice: 10000000n,
  nonce: 1,
};
test("OP fee check includes both L1 and operator fees with buffer", async () => {
  const client = {
    readContract: async (p: { functionName: string }) =>
      p.functionName === "getL1Fee" ? 100n : 20n,
  } as unknown as PublicClient;
  await assertAdditionalFeeReserve(client, chain, tx, 156n, 13000);
  await assert.rejects(
    () => assertAdditionalFeeReserve(client, chain, tx, 155n, 13000),
    /fees exceed/,
  );
});
test("fee oracle outage fails closed", async () => {
  const client = {
    readContract: async () => {
      throw new Error("unavailable");
    },
  } as unknown as PublicClient;
  await assert.rejects(() =>
    assertAdditionalFeeReserve(client, chain, tx, 1000n, 13000),
  );
});
