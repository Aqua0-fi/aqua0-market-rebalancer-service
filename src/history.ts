import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";

const addr = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((v) => v.toLowerCase());
const hash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((v) => v.toLowerCase());
const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(80);
const sint = z
  .string()
  .regex(/^-?(0|[1-9][0-9]*)$/)
  .max(81);
const timestamp = z.iso
  .datetime()
  .transform((value) => new Date(value).toISOString());
const swapVMIdentitySchema = z.object({
  stableStrategyId: hash,
  classId: uint,
  orderHash: hash,
  router: addr,
  maker: addr,
  aqua: addr,
});
const swapVMReceiptSchema = z.object({
  strategyId: hash,
  classId: uint,
  orderHash: hash,
  router: addr,
  maker: addr,
  tokenIn: addr,
  tokenOut: addr,
  amountIn: uint,
  amountOut: uint,
  logIndex: z.number().int().nonnegative(),
});
export const receiptSchema = z.object({
  swapVM: swapVMReceiptSchema.optional(),
  blockNumber: uint,
  blockHash: hash,
  blockTimestamp: timestamp,
  checkedAt: timestamp,
  logIndex: z.number().int().nonnegative().nullable(),
  grossProfit: uint.nullable(),
  executionGasNative: uint,
  additionalGasNative: uint.nullable(),
  totalGasNative: uint.nullable(),
  settlements: z
    .array(
      z.object({
        swapId: hash,
        classId: uint,
        logIndex: z.number().int().nonnegative(),
        token0: addr,
        delta0: sint,
        token1: addr,
        delta1: sint,
      }),
    )
    .max(500),
});
export const executionSchema = z
  .object({
    version: z.literal(1),
    network: z.enum(["mainnet", "fork"]),
    chainId: z.number().int().positive().safe(),
    transactionHash: hash,
    tradeId: hash,
    executor: addr,
    operator: addr,
    venue: z.enum(["v4", "aqua"]).optional(),
    poolId: hash.nullable(),
    swapVM: swapVMIdentitySchema.optional(),
    aqua0Hook: addr,
    tokenIn: addr,
    tokenOut: addr,
    amountIn: uint,
    minimumProfit: uint,
    quotedNetProfit: sint,
    aquaFirst: z.boolean(),
    preparedAt: timestamp,
    status: z.enum(["pending", "confirmed", "reverted"]),
    broadcastAcknowledged: z.boolean(),
    receipt: receiptSchema.nullable(),
  })
  .refine(
    (r) =>
      r.venue === "aqua"
        ? r.poolId === null && !!r.swapVM
        : r.poolId !== null && !r.swapVM,
    "Venue identity mismatch",
  )
  .refine(
    (r) => (r.status === "pending" ? r.receipt === null : r.receipt !== null),
    "Receipt/state mismatch",
  );
export type ExecutionRecord = z.infer<typeof executionSchema>;
export const historyQuerySchema = z
  .object({
    network: z.enum(["mainnet", "fork"]),
    chainId: z.coerce.number().int().positive().safe().optional(),
    token: addr.optional(),
    poolId: hash.optional(),
    status: z.enum(["pending", "confirmed", "reverted"]).optional(),
    from: timestamp.optional(),
    to: timestamp.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().max(512).optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, "Invalid time window");
export type HistoryQuery = z.input<typeof historyQuerySchema>;
export interface HistoryPage {
  version: 1;
  items: ExecutionRecord[];
  nextCursor: string | null;
  matchedCount: number;
  generatedAt: string;
}

function immutable(r: ExecutionRecord): string {
  const { status: _, broadcastAcknowledged: __, receipt: ___, ...identity } = r;
  return JSON.stringify(identity);
}
function fingerprint(q: z.infer<typeof historyQuerySchema>): string {
  const { cursor: _, limit: __, ...filters } = q;
  return createHash("sha256").update(JSON.stringify(filters)).digest("hex");
}

/** One embedded file, not another database service. FULL synchronous commits precede broadcasting. */
export class HistoryStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS executions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, network TEXT NOT NULL, chain_id INTEGER NOT NULL,
        transaction_hash TEXT NOT NULL, token_in TEXT NOT NULL, token_out TEXT NOT NULL,
        pool_id TEXT NOT NULL, status TEXT NOT NULL, prepared_at TEXT NOT NULL, payload TEXT NOT NULL,
        UNIQUE(network, chain_id, transaction_hash)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS executions_chain ON executions(network,chain_id,seq DESC);
      CREATE INDEX IF NOT EXISTS executions_status ON executions(network,status,seq DESC);
      CREATE INDEX IF NOT EXISTS executions_pair ON executions(network,pool_id,seq DESC);`);
  }
  close(): void {
    this.db.close();
  }
  get(
    network: string,
    chainId: number,
    transactionHash: string,
  ): ExecutionRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT payload FROM executions WHERE network=? AND chain_id=? AND transaction_hash=?",
      )
      .get(network, chainId, transactionHash.toLowerCase());
    return row
      ? executionSchema.parse(JSON.parse(String(row.payload)))
      : undefined;
  }
  prepare(input: ExecutionRecord): void {
    const r = executionSchema.parse(input);
    const existing = this.get(r.network, r.chainId, r.transactionHash);
    if (existing) {
      if (immutable(existing) !== immutable(r))
        throw new Error("Execution identity conflict");
      return;
    }
    if (r.status !== "pending")
      throw new Error("New history must be prepared before broadcast");
    this.db
      .prepare(
        `INSERT INTO executions(network,chain_id,transaction_hash,token_in,token_out,pool_id,status,prepared_at,payload)
      VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        r.network,
        r.chainId,
        r.transactionHash,
        r.tokenIn,
        r.tokenOut,
        r.poolId ?? r.swapVM!.stableStrategyId,
        r.status,
        r.preparedAt,
        JSON.stringify(r),
      );
  }
  acknowledgeBroadcast(network: string, chainId: number, tx: string): void {
    const r = this.get(network, chainId, tx);
    if (!r) throw new Error("Missing prepared history");
    this.write({ ...r, broadcastAcknowledged: true });
  }
  settle(
    network: string,
    chainId: number,
    tx: string,
    status: "confirmed" | "reverted",
    receipt: z.infer<typeof receiptSchema>,
  ): void {
    const r = this.get(network, chainId, tx);
    if (!r) throw new Error("Missing prepared history");
    if (
      r.receipt &&
      (r.receipt.blockHash !== receipt.blockHash || r.status !== status)
    )
      throw new Error(
        "Canonical receipt changed; manual reconciliation required",
      );
    this.write(executionSchema.parse({ ...r, status, receipt }));
  }
  private write(r: ExecutionRecord): void {
    const result = this.db
      .prepare(
        "UPDATE executions SET status=?, payload=? WHERE network=? AND chain_id=? AND transaction_hash=?",
      )
      .run(
        r.status,
        JSON.stringify(r),
        r.network,
        r.chainId,
        r.transactionHash,
      );
    if (result.changes !== 1) throw new Error("History update did not persist");
  }
  list(input: HistoryQuery): HistoryPage {
    const q = historyQuerySchema.parse(input);
    const predicates = ["network=?"];
    const values: SQLInputValue[] = [q.network];
    if (q.chainId !== undefined) {
      predicates.push("chain_id=?");
      values.push(q.chainId);
    }
    if (q.poolId) {
      predicates.push("pool_id=?");
      values.push(q.poolId);
    }
    if (q.token) {
      predicates.push("(token_in=? OR token_out=?)");
      values.push(q.token, q.token);
    }
    if (q.status) {
      predicates.push("status=?");
      values.push(q.status);
    }
    if (q.from) {
      predicates.push("prepared_at>=?");
      values.push(q.from);
    }
    if (q.to) {
      predicates.push("prepared_at<=?");
      values.push(q.to);
    }
    const where = predicates.join(" AND ");
    const matchedCount = Number(
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM executions WHERE ${where}`)
        .get(...values)?.n ?? 0,
    );
    if (q.cursor) {
      let c: { seq: number; filter: string };
      try {
        c = JSON.parse(Buffer.from(q.cursor, "base64url").toString("utf8"));
      } catch {
        throw new Error("Invalid history cursor");
      }
      if (
        !c ||
        typeof c !== "object" ||
        !Number.isSafeInteger(c.seq) ||
        c.seq <= 0 ||
        c.filter !== fingerprint(q)
      )
        throw new Error("Invalid history cursor for filters");
      predicates.push("seq<?");
      values.push(c.seq);
    }
    const rows = this.db
      .prepare(
        `SELECT seq,payload FROM executions WHERE ${predicates.join(" AND ")} ORDER BY seq DESC LIMIT ?`,
      )
      .all(...values, q.limit + 1);
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      version: 1,
      items: page.map((r) =>
        executionSchema.parse(JSON.parse(String(r.payload))),
      ),
      matchedCount,
      nextCursor:
        rows.length > q.limit && last
          ? Buffer.from(
              JSON.stringify({ seq: Number(last.seq), filter: fingerprint(q) }),
            ).toString("base64url")
          : null,
      generatedAt: new Date().toISOString(),
    };
  }
}
