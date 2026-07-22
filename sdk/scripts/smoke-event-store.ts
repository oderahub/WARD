#!/usr/bin/env tsx
/** Side-effecting Shannon testnet smoke check for event-store backfill. */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, defineChain, http } from "viem";
import { createEventStore } from "../src/event-store.js";

(function loadDotenv() {
  const path = resolve(import.meta.dirname, "..", "..", ".env");
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = v;
  }
})();

const RPC = process.env.SOMNIA_TESTNET_RPC ?? "https://dream-rpc.somnia.network";
const ORACLE = (process.env.SENTRY_ORACLE ?? "0x3C7bF90f243d670a01f512221d9546e09fEaCC9c") as `0x${string}`;
const QUEUE = (process.env.SENTRY_QUEUE ?? "0xFB715A37951Fc8dcc920120768e91f7C8bbA54c4") as `0x${string}`;
const ORACLE_DEPLOY = 403805414n;

const somniaTestnet = defineChain({
  id: 50312,
  name: "Somnia Testnet",
  nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const publicClient = createPublicClient({ chain: somniaTestnet, transport: http(RPC) });

const store = createEventStore({
  publicClient,
  oracleAddress: ORACLE,
  queueAddress: QUEUE,
  oracleDeploymentBlock: ORACLE_DEPLOY,
  chunkSize: 1000n, // Shannon RPC caps getLogs at 1000-block range
  onProgress: ({ phase, current, total, message }) => {
    const pct = total > 0n ? ((Number(current) / Number(total)) * 100).toFixed(1) : "—";
    process.stdout.write(`\r[${phase.padEnd(18)}] ${current}/${total} (${pct}%) ${message ?? ""}      `);
  },
});

console.log(`smoke: backfilling against ${RPC}`);
console.log(`oracle: ${ORACLE}`);
console.log(`queue:  ${QUEUE}`);
console.log();

const t0 = Date.now();
await store.init();
const dt = Date.now() - t0;
console.log("\n");

const policies = store.listPolicies();
const records = store.listQueueRecords();
const pending = store.listPending();
console.log(`init complete in ${dt}ms`);
console.log(`  policies:        ${policies.length}`);
console.log(`  queue records:   ${records.length}`);
console.log(`  pending:         ${pending.length}`);
console.log(`  cursor:          ${store.cursor()}`);
console.log();

if (policies.length > 0) {
  console.log(`first 5 policies:`);
  for (const p of policies.slice(0, 5)) {
    console.log(`  - ${p.policyId.slice(0, 18)}… owner=${p.owner.slice(0, 10)}… published@${p.publishedBlock} lastUpdated@${p.lastUpdatedBlock}`);
  }
  console.log();
}

if (records.length > 0) {
  console.log(`first 5 queue records:`);
  for (const r of records.slice(0, 5)) {
    console.log(`  - policyId=${r.policyId.slice(0, 18)}… asker=${r.asker.slice(0, 10)}… tier=${r.tier} state=${r.state} earliest=${r.earliestCommitAt} deadline=${r.deadline}`);
  }
  console.log();
}

store.dispose();
console.log("disposed; exit");
process.exit(0);
