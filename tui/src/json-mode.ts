/** Stream backfilled and live store events as NDJSON for operator tooling. */
import {
  createEventStore,
  type StoreEvent,
} from "@ward/sdk";
import {
  resolveEnv,
  makePublicClient,
  WARD_ORACLE_DEPLOY_BLOCK,
  WARD_QUEUE_LOOKBACK_BLOCKS,
} from "./lib/env.js";

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export async function runJsonMode(): Promise<void> {
  const env = resolveEnv();
  const publicClient = makePublicClient(env.rpc);
  const store = createEventStore({
    publicClient,
    oracleAddress: env.oracleAddress,
    queueAddress: env.queueAddress,
    ...(WARD_ORACLE_DEPLOY_BLOCK !== undefined
      ? { oracleDeploymentBlock: WARD_ORACLE_DEPLOY_BLOCK }
      : {}),
    queueLookbackBlocks: WARD_QUEUE_LOOKBACK_BLOCKS,
    // Keep stdout pipe-safe; progress goes to stderr during long backfills.
    onProgress: ({ phase, current, total }) => {
      const pct = total > 0n ? ((Number(current) / Number(total)) * 100).toFixed(0) : "—";
      const line = `[backfill ${phase}] ${current}/${total} (${pct}%)`;
      if (process.stderr.isTTY) process.stderr.write(`\r${line}        `);
      else process.stderr.write(line + "\n");
    },
  });

  // Subscribe before init, then emit one historical dump before switching to live events.
  let liveStarted = false;
  store.subscribe((event: StoreEvent) => {
    if (!liveStarted) return;
    process.stdout.write(JSON.stringify(event, bigintReplacer) + "\n");
  });

  await store.init();
  if (process.stderr.isTTY) process.stderr.write("\n[live]\n");

  for (const e of store.recentEvents(99999)) {
    process.stdout.write(JSON.stringify(e, bigintReplacer) + "\n");
  }
  liveStarted = true;

  // viem poll watchers can briefly pin the event loop after unwatch().
  await new Promise<void>((resolve) => {
    const cleanup = () => {
      try {
        store.dispose();
      } finally {
        resolve();
        process.exit(0);
      }
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  });
}
