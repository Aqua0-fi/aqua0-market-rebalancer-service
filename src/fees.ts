import {
  parseAbi,
  serializeTransaction,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { ceilDiv } from "./strategy.js";
import type { ChainConfig } from "./config.js";
const gasOracle = "0x420000000000000000000000000000000000000F";
const feeAbi = parseAbi([
  "function getL1Fee(bytes transaction) view returns (uint256)",
  "function getOperatorFee(uint256 gasUsed) view returns (uint256)",
]);
/** OP Stack charges fees outside the execution gas limit. Fail closed if the oracle is unavailable
 * or the buffered estimate is larger than the reserve already included in the profit floor. */
export async function assertAdditionalFeeReserve(
  client: PublicClient,
  chain: ChainConfig,
  tx: { to: Address; data: Hex; gas: bigint; gasPrice: bigint; nonce: number },
  reserve: bigint,
  bufferBps: number,
): Promise<void> {
  if (chain.feeModel === "gas-limit") return;
  const unsigned = serializeTransaction({
    ...tx,
    chainId: chain.chainId,
    type: "legacy",
  });
  const [l1, operator] = await Promise.all([
    client.readContract({
      address: gasOracle,
      abi: feeAbi,
      functionName: "getL1Fee",
      args: [unsigned],
    }),
    client.readContract({
      address: gasOracle,
      abi: feeAbi,
      functionName: "getOperatorFee",
      args: [tx.gas],
    }),
  ]);
  if (ceilDiv((l1 + operator) * BigInt(bufferBps), 10000n) > reserve)
    throw new Error("Additional network fees exceed reserved budget");
}
