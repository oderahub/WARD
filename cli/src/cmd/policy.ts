import { readFileSync } from "node:fs";
import { compilePolicy, policyIdFor, SENTRY_ORACLE_ABI, type PolicyInput } from "@sentry-somnia/sdk";
import kleur from "kleur";
import { stringToHex, type Hex } from "viem";
import {
  loadEnv,
  publicClient,
  walletClient,
  requireSentryOracle,
  requirePrivateKey,
} from "../lib/env.js";

export async function compileCmd(path: string): Promise<void> {
  const md = readFileSync(path, "utf-8");
  // Env gatekeeper addresses let the SDK reject self-targeting policies during CLI compiles.
  const env = loadEnv();
  const policy = compilePolicy(md, {
    oracleAddress: env.sentryOracle,
    queueAddress: env.sentryQueue,
  });
  console.log(kleur.bold().cyan("# compiled PolicyInput"));
  console.log(JSON.stringify(serialize(policy), null, 2));
}

export interface PushOptions {
  /** ASCII label up to 32 bytes; converted to `bytes32` via right-padding. */
  label: string;
}

export async function pushCmd(path: string, opts: PushOptions): Promise<void> {
  const env = loadEnv();
  const pk = requirePrivateKey(env);
  const oracle = requireSentryOracle(env);
  const md = readFileSync(path, "utf-8");
  // Mirror dashboard publish checks for reserved targets and label control bytes.
  const policy = compilePolicy(md, {
    oracleAddress: oracle,
    queueAddress: env.sentryQueue,
    label: opts.label,
  });
  const wallet = walletClient(pk, env.rpc);
  const client = publicClient(env.rpc);

  const label = encodeLabel(opts.label);
  const publisher = wallet.account.address;
  const policyId = policyIdFor(publisher, label);

  // Auto-detect publish vs update by reading on-chain ownership.
  const owner = (await client.readContract({
    address: oracle,
    abi: SENTRY_ORACLE_ABI as never,
    functionName: "policyOwner",
    args: [policyId],
  })) as `0x${string}`;

  const isUpdate = owner !== "0x0000000000000000000000000000000000000000";
  if (isUpdate && owner.toLowerCase() !== publisher.toLowerCase()) {
    throw new Error(
      `policyId ${policyId} is owned by ${owner}, not your wallet ${publisher}; pick a different --label`,
    );
  }

  // Simulate first so operators see the revert reason before paying gas.
  const functionName = isUpdate ? "updatePolicy" : "publishPolicy";
  const args = isUpdate ? [policyId, policy as never] : [label, policy as never];
  try {
    await client.simulateContract({
      address: oracle,
      abi: SENTRY_ORACLE_ABI as never,
      functionName,
      args,
      account: wallet.account,
    });
  } catch (err) {
    const reason = friendlyRevertReason(err);
    throw new Error(`${functionName} would revert: ${reason}`);
  }

  const hash = await wallet.writeContract({
    address: oracle,
    abi: SENTRY_ORACLE_ABI as never,
    functionName,
    args,
  });
  console.log(kleur.yellow(`${functionName} tx: ${hash}`));
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status === "success") {
    console.log(kleur.green(`OK · policyId = ${policyId}`));
    console.log(kleur.gray(`     reference this id in your agent contract; it is stable across updates`));
  } else {
    console.log(kleur.red("oracle push reverted"));
  }
}

/** Compute the policyId a (publisher, label) pair maps to. Pure — no RPC. */
export async function policyIdCmd(label: string, publisher?: string): Promise<void> {
  const env = loadEnv();
  let pubAddr: `0x${string}`;
  if (publisher) {
    pubAddr = publisher as `0x${string}`;
  } else {
    const pk = requirePrivateKey(env);
    const wallet = walletClient(pk, env.rpc);
    pubAddr = wallet.account.address;
  }
  const id = policyIdFor(pubAddr, encodeLabel(label));
  console.log(kleur.bold().cyan("# policyId"));
  console.log(`  publisher: ${pubAddr}`);
  console.log(`  label:     "${label}"`);
  console.log(`  id:        ${id}`);
}

/** Convert an ASCII label (≤ 32 bytes) to a right-padded bytes32. */
function encodeLabel(label: string): Hex {
  const bytes = new TextEncoder().encode(label);
  if (bytes.length > 32) {
    throw new Error(`label "${label}" is ${bytes.length} bytes; must be ≤ 32 bytes`);
  }
  return stringToHex(label, { size: 32 });
}

/** Pull the user-readable revert reason out of viem errors without dumping the full stack. */
export function friendlyRevertReason(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { shortMessage?: unknown; message?: unknown };
    if (typeof e.shortMessage === "string" && e.shortMessage.length > 0) return e.shortMessage;
    if (typeof e.message === "string" && e.message.length > 0) {
      // viem multi-line messages start with the short summary; keep only that.
      return e.message.split("\n")[0]!;
    }
  }
  return String(err);
}

function serialize(p: PolicyInput): unknown {
  return {
    targets: p.targets.map((t) => ({
      target: t.target,
      selectors: t.selectors.map((s) => ({
        selector: s.selector,
        valueCapPerCall: s.valueCapPerCall.toString(),
        tier: s.tier,
        delaySeconds: s.delaySeconds,
      })),
    })),
    dailySpendWeiCap: p.dailySpendWeiCap.toString(),
    maxSlippageBps: p.maxSlippageBps,
    expiresAt: p.expiresAt.toString(),
    paused: p.paused,
  };
}
