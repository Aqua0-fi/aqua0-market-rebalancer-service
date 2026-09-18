import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { loadChains, loadSettings } from "./config.js";
import { AquaClient } from "./aqua.js";
import { Runner, log, safeError } from "./runner.js";
import { Journal, acquireLock } from "./state.js";
import { clientFor, verifyChain, discover } from "./venues.js";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string", default: "config/rebalancer.example.json" },
    chain: { type: "string" },
    registry: { type: "string", default: "config/chains.json" },
  },
});
const chains = loadChains(values.registry);
const command = positionals[0] ?? "scan";
if (command === "doctor") {
  let failures = 0;
  const selected = chains.filter(
    (c) => !values.chain || String(c.chainId) === values.chain,
  );
  if (selected.length === 0) throw new Error("Unknown chain selection");
  for (const chain of selected) {
    try {
      const client = clientFor(chain);
      await verifyChain(client, chain);
      const block = await client.getBlock();
      for (const pool of chain.pools)
        log("chain_verified", {
          chainId: chain.chainId,
          block: block.number,
          blockHash: block.hash,
          poolId: pool.poolId,
          externalPools: await discover(client, chain, pool, block.number),
        });
    } catch (error) {
      failures++;
      log("chain_unavailable", {
        chainId: chain.chainId,
        error: safeError(error),
      });
    }
  }
  process.exitCode = failures ? 1 : 0;
} else {
  if (command !== "scan" && command !== "run")
    throw new Error("Use doctor, scan, or run");
  const settings = loadSettings(values.config);
  const headers: Record<string, string> = {};
  if (process.env.AQUA0_API_KEY)
    headers["X-API-Key"] = process.env.AQUA0_API_KEY;
  if (process.env.AQUA0_CALLER_TOKEN)
    headers["X-Caller-Token"] = process.env.AQUA0_CALLER_TOKEN;
  const release = acquireLock("runtime/worker.lock");
  const runner = new Runner(
    chains,
    settings,
    new AquaClient(settings.apiUrl, headers),
    new Journal("runtime/journal.json"),
  );
  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
  });
  process.on("SIGTERM", () => {
    stopping = true;
  });
  const server =
    command === "run"
      ? createServer((req, res) => {
          if (req.url === "/health") {
            res.statusCode =
              Date.now() - runner.metrics.lastSuccess <
              Math.max(120000, settings.pollMs * 4)
                ? 200
                : 503;
            res.end(JSON.stringify(runner.metrics));
          } else {
            res.statusCode = 404;
            res.end();
          }
        }).listen(9091, "127.0.0.1")
      : undefined;
  try {
    do {
      await runner.scan();
      if (command === "scan" || stopping) break;
      await sleep(settings.pollMs);
    } while (!stopping);
  } finally {
    server?.close();
    release();
  }
}
