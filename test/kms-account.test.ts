import test from "node:test";
import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";
import {
  keccak256,
  recoverTransactionAddress,
  serializeTransaction,
  toBytes,
  type Hex,
  type TransactionSerialized,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  createKmsAccount,
  parseDerSignature,
  type KmsTransport,
} from "../src/kms-account.js";

const KEY =
  "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012";
const N = BigInt(
  "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
);
function integer(value: bigint): Buffer {
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let bytes = Buffer.from(hex, "hex");
  if (bytes[0]! & 128) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return Buffer.concat([Buffer.from([2, bytes.length]), bytes]);
}
function der(r: bigint, s: bigint): Uint8Array {
  const values = Buffer.concat([integer(r), integer(s)]);
  return Buffer.concat([Buffer.from([0x30, values.length]), values]);
}
function fixture(highS = false) {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const point = Buffer.from(wallet.publicKey.slice(4), "hex");
  const publicDer = createPublicKey({
    key: {
      kty: "EC",
      crv: "secp256k1",
      x: point.subarray(0, 32).toString("base64url"),
      y: point.subarray(32).toString("base64url"),
    },
    format: "jwk",
  }).export({ type: "spki", format: "der" });
  const calls: Hex[] = [];
  const transport: KmsTransport = {
    async publicKey(keyId) {
      assert.equal(keyId, KEY);
      return {
        keyId: KEY,
        keySpec: "ECC_SECG_P256K1",
        keyUsage: "SIGN_VERIFY",
        der: publicDer,
      };
    },
    async signDigest(keyId, digest) {
      assert.equal(keyId, KEY);
      assert.equal(digest.length, 32);
      const hash = `0x${Buffer.from(digest).toString("hex")}` as Hex;
      calls.push(hash);
      const sig = await wallet.sign({ hash });
      const r = BigInt(`0x${sig.slice(2, 66)}`),
        s = BigInt(`0x${sig.slice(66, 130)}`);
      return {
        keyId: KEY,
        algorithm: "ECDSA_SHA_256",
        der: der(r, highS ? N - s : s),
      };
    },
  };
  return { wallet, transport, calls };
}
const transaction = {
  type: "legacy" as const,
  chainId: 8453,
  nonce: 7,
  gas: 250000n,
  gasPrice: 1000000n,
  to: "0x0000000000000000000000000000000000000001" as const,
  value: 0n,
  data: "0x1234" as const,
};

test("KMS legacy transaction is byte-identical to the independent local signer and binds the chain", async () => {
  const f = fixture();
  const account = await createKmsAccount(
    {
      keyId: KEY,
      region: "us-east-1",
      address: f.wallet.address,
      chainId: 8453,
    },
    f.transport,
  );
  const actual = await account.signTransaction(transaction);
  assert.equal(actual, await f.wallet.signTransaction(transaction));
  assert.equal(
    await recoverTransactionAddress({
      serializedTransaction: actual as TransactionSerialized,
    }),
    f.wallet.address,
  );
  assert.deepEqual(f.calls, [keccak256(serializeTransaction(transaction))]);
  await assert.rejects(
    () => account.signTransaction({ ...transaction, chainId: 42161 }),
    /chain/i,
  );
  assert.equal(
    f.calls.length,
    1,
    "wrong-chain transaction must be refused before KMS signing",
  );
});
test("high-s KMS DER output normalizes without changing the recovered signer", async () => {
  const f = fixture(true);
  const account = await createKmsAccount(
    {
      keyId: KEY,
      region: "us-east-1",
      address: f.wallet.address,
      chainId: 8453,
    },
    f.transport,
  );
  assert.equal(
    await account.signTransaction(transaction),
    await f.wallet.signTransaction(transaction),
  );
  const typed = {
    chainId: 8453,
    type: "eip1559" as const,
    nonce: 8,
    gas: 250000n,
    maxFeePerGas: 3000000n,
    maxPriorityFeePerGas: 1000000n,
    to: transaction.to,
    value: 0n,
    data: "0xabcd" as const,
  };
  assert.equal(
    await account.signTransaction(typed),
    await f.wallet.signTransaction(typed),
  );
});
test("wrong wallet, region, algorithm, key identity and malformed DER fail closed", async () => {
  const f = fixture();
  const config = {
    keyId: KEY,
    region: "us-east-1",
    address: f.wallet.address,
    chainId: 8453,
  };
  await assert.rejects(
    () => createKmsAccount({ ...config, address: transaction.to }, f.transport),
    /address/i,
  );
  await assert.rejects(
    () =>
      createKmsAccount({ ...config, region: "ap-southeast-1" }, f.transport),
    /region/i,
  );
  await assert.rejects(
    () =>
      createKmsAccount(config, {
        ...f.transport,
        publicKey: async () => ({
          keyId: KEY,
          keySpec: "ECC_NIST_P256",
          keyUsage: "SIGN_VERIFY",
          der: new Uint8Array(),
        }),
      }),
    /key type/i,
  );
  const account = await createKmsAccount(config, {
    ...f.transport,
    signDigest: async () => ({
      keyId: `${KEY}x`,
      algorithm: "ECDSA_SHA_256",
      der: der(1n, 1n),
    }),
  });
  await assert.rejects(
    () => account.signTransaction(transaction),
    /key identity/i,
  );
  for (const malformed of [
    new Uint8Array(),
    toBytes("0x300602010102010100"),
    toBytes("0x3006020181020101"),
    toBytes("0x300702020001020101"),
    der(0n, 1n),
    der(1n, N),
  ])
    assert.throws(() => parseDerSignature(malformed));
  assert.deepEqual(parseDerSignature(der(1n, 2n)), { r: 1n, s: 2n });
});
test("the worker account cannot sign typed authorizations or arbitrary messages", async () => {
  const f = fixture();
  const account = await createKmsAccount(
    {
      keyId: KEY,
      region: "us-east-1",
      address: f.wallet.address,
      chainId: 8453,
    },
    f.transport,
  );
  await assert.rejects(
    () => account.signMessage({ message: "not a worker transaction" }),
    /not supported/i,
  );
  await assert.rejects(
    () =>
      account.signTypedData({
        types: { Test: [{ name: "value", type: "uint256" }] },
        primaryType: "Test",
        message: { value: 1n },
      }),
    /not supported/i,
  );
  assert.equal(f.calls.length, 0);
});
