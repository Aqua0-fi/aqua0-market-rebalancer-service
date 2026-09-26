import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { HistoryStore, historyQuerySchema } from "./history.js";
import type { SwapVMMarketCatalog } from "./swapvm-catalog.js";
import { MarketCatalog, marketPolicyInput } from "./market-catalog.js";

export interface ReportOptions {
  network: "mainnet" | "fork";
  token?: string | undefined;
  controlToken?: string | undefined;
  catalog?: MarketCatalog | undefined;
  swapVMCatalog?: SwapVMMarketCatalog | undefined;
  hostHealth?: (() => unknown) | undefined;
  history: HistoryStore;
  status: () => unknown;
  health: () => { healthy: boolean; metrics: unknown };
}
function send(res: ServerResponse, code: number, value: unknown): void {
  res.writeHead(code, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
}

/** Report reads and explicit policy writes use distinct credentials; neither can activate trading. */
export function createReportServer(options: ReportOptions) {
  if (
    options.token !== undefined &&
    (options.token.length < 32 || options.token.length > 512)
  )
    throw new Error(
      "Reporting token must contain at least 32 characters and at most 512",
    );
  const expected =
    options.token === undefined
      ? null
      : createHash("sha256").update(options.token).digest();
  const authorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization;
    if (!expected || !header?.startsWith("Bearer ")) return false;
    return timingSafeEqual(
      expected,
      createHash("sha256").update(header.slice(7)).digest(),
    );
  };
  if (
    options.controlToken !== undefined &&
    (options.controlToken.length < 32 || options.controlToken.length > 512)
  )
    throw new Error("Control token must contain 32 to 512 characters");
  if (options.controlToken && options.controlToken === options.token)
    throw new Error("Report and control credentials must be distinct");
  const controlHash = options.controlToken
    ? createHash("sha256").update(options.controlToken).digest()
    : null;
  const controlsAuthorized = (req: IncomingMessage) =>
    !!controlHash &&
    !!req.headers.authorization?.startsWith("Bearer ") &&
    timingSafeEqual(
      controlHash,
      createHash("sha256").update(req.headers.authorization.slice(7)).digest(),
    );
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const controlPath =
        /^\/v1\/(markets|aqua-markets)\/(\d+)\/(0x[0-9a-fA-F]{64})\/policy$/.exec(
          url.pathname,
        );
      const controlCatalog =
        controlPath?.[1] === "aqua-markets"
          ? options.swapVMCatalog
          : options.catalog;
      if (req.method === "POST" && controlPath && controlCatalog) {
        if (!controlsAuthorized(req)) {
          send(res, 401, {
            error: "Separate market-control authorization required",
          });
          return;
        }
        if (
          !req.headers["content-type"]
            ?.toLowerCase()
            .startsWith("application/json")
        ) {
          send(res, 415, { error: "JSON policy body required" });
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const part of req) {
          const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
          bytes += chunk.length;
          if (bytes > 8192) {
            send(res, 413, { error: "Policy request is too large" });
            return;
          }
          chunks.push(chunk);
        }
        const body = z
          .object({
            network: z.literal(options.network),
            actor: z.string().min(1).max(120),
            policy: marketPolicyInput,
          })
          .strict()
          .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        const chainId = Number(controlPath[2]);
        if (!Number.isSafeInteger(chainId) || chainId <= 0) {
          send(res, 400, { error: "Invalid chain" });
          return;
        }
        try {
          const policy = controlCatalog.setPolicy(
            chainId,
            controlPath[3]!,
            body.policy,
            body.actor,
          );
          send(res, 200, {
            version: 1,
            policy,
            executionActivationSupported: false,
          });
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.startsWith("Policy version conflict")
          ) {
            send(res, 409, { error: error.message });
            return;
          }
          if (
            error instanceof Error &&
            /^(Unknown discovered|Policy (base|class)|Market cannot)/.test(
              error.message,
            )
          ) {
            send(res, 400, { error: error.message });
            return;
          }
          throw error;
        }
        return;
      }
      if (req.method !== "GET") {
        send(res, 405, { error: "Read-only service" });
        return;
      }
      if (url.pathname === "/health") {
        const health = options.health();
        send(res, health.healthy ? 200 : 503, health.metrics);
        return;
      }
      if (!authorized(req)) {
        send(res, 401, { error: "Reporting authorization required" });
        return;
      }
      if (url.pathname === "/v1/markets") {
        if (!options.catalog) {
          send(res, 503, { error: "Public discovery is not configured" });
          return;
        }
        send(res, 200, {
          ...options.catalog.list(),
          controlConfigured: !!controlHash,
        });
        return;
      }
      if (url.pathname === "/v1/aqua-markets") {
        if (!options.swapVMCatalog) {
          send(res, 503, { error: "SwapVM discovery is not configured" });
          return;
        }
        send(res, 200, {
          ...options.swapVMCatalog.list(),
          controlConfigured: !!controlHash,
        });
        return;
      }
      if (url.pathname === "/v1/host-health") {
        send(
          res,
          200,
          options.hostHealth?.() ?? {
            available: false,
            reason: "Host watchdog is not configured",
          },
        );
        return;
      }
      if (url.pathname === "/v1/status") {
        send(res, 200, options.status());
        return;
      }
      if (url.pathname === "/v1/executions") {
        const supplied = Object.fromEntries(url.searchParams);
        if (supplied.network && supplied.network !== options.network) {
          send(res, 400, { error: "Reporting network mismatch" });
          return;
        }
        const query = historyQuerySchema.parse({
          ...supplied,
          network: options.network,
        });
        send(res, 200, options.history.list(query));
        return;
      }
      const match = /^\/v1\/executions\/(\d+)\/(0x[0-9a-fA-F]{64})$/.exec(
        url.pathname,
      );
      if (match) {
        const chainId = Number(match[1]);
        if (!Number.isSafeInteger(chainId) || chainId <= 0) {
          send(res, 400, { error: "Invalid chain" });
          return;
        }
        const record = options.history.get(options.network, chainId, match[2]!);
        send(
          res,
          record ? 200 : 404,
          record ? { version: 1, record } : { error: "Execution not found" },
        );
        return;
      }
      send(res, 404, { error: "Unknown reporting route" });
    } catch (error) {
      const invalid =
        error instanceof z.ZodError ||
        error instanceof SyntaxError ||
        (error instanceof Error &&
          error.message.startsWith("Invalid history cursor"));
      send(res, invalid ? 400 : 503, {
        error: invalid
          ? "Invalid reporting query"
          : "Execution history unavailable",
      });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}
