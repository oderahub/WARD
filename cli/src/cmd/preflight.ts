import kleur from "kleur";
import { formatEther, isAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadEnv, publicClient, somniaTestnet } from "../lib/env.js";

export interface PreflightOptions {
  minBalance?: bigint;
}

export interface PreflightResult {
  ok: boolean;
  warnings: string[];
  errors: string[];
  address?: Address;
  balanceWei?: bigint;
  chainId?: number;
}

const DEFAULT_MIN_BALANCE_WEI = 500_000_000_000_000_000n;

const FAUCET_LINKS = [
  "https://testnet.somnia.network/",
  "https://faucet.somnia.network/",
];

const REAL_PLATFORM = "0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776".toLowerCase();
const REAL_AGENT_ID = "12847293847561029384";

/** Check env, RPC, and wallet balance for Somnia testnet write readiness. */
export async function preflightCmd(
  opts: PreflightOptions = {},
  print = true,
): Promise<PreflightResult> {
  const env = loadEnv();
  const minBalance = opts.minBalance ?? DEFAULT_MIN_BALANCE_WEI;
  const warnings: string[] = [];
  const errors: string[] = [];

  const pkFromEnv =
    (process.env.PRIVATE_KEY as `0x${string}` | undefined) ??
    (process.env.DEPLOYER_PK as `0x${string}` | undefined);
  const cliPk = env.privateKey;
  const pk = cliPk ?? pkFromEnv;

  if (!pk) {
    errors.push(
      "PRIVATE_KEY (or DEPLOYER_PK) is not set. Copy .env.example to .env and paste your funded wallet's key.",
    );
  } else if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    errors.push("PRIVATE_KEY is set but is not a 0x-prefixed 32-byte hex string.");
  }

  if (process.env.PRIVATE_KEY && process.env.DEPLOYER_PK && process.env.PRIVATE_KEY !== process.env.DEPLOYER_PK) {
    warnings.push(
      "PRIVATE_KEY and DEPLOYER_PK are both set but differ — forge scripts and the CLI will use different wallets.",
    );
  }

  const platform = (process.env.SOMNIA_AGENT_PLATFORM ?? "").toLowerCase();
  if (!platform) {
    warnings.push("SOMNIA_AGENT_PLATFORM is empty; falling back to scripts' defaults.");
  } else if (platform !== REAL_PLATFORM) {
    warnings.push(
      `SOMNIA_AGENT_PLATFORM=${platform} differs from the canonical testnet platform ${REAL_PLATFORM}.`,
    );
  }
  const agentId = process.env.LLM_INFERENCE_AGENT_ID ?? "";
  if (!agentId) {
    warnings.push("LLM_INFERENCE_AGENT_ID is empty; required by any deploy script that wires in the real LLM Inference agent.");
  } else if (agentId !== REAL_AGENT_ID) {
    warnings.push(
      `LLM_INFERENCE_AGENT_ID=${agentId} differs from the canonical id ${REAL_AGENT_ID}.`,
    );
  }

  if (process.env.SENTRY_ORACLE && !isAddress(process.env.SENTRY_ORACLE)) {
    errors.push(`SENTRY_ORACLE=${process.env.SENTRY_ORACLE} is not a valid 0x-address.`);
  }
  if (process.env.SENTRY_QUEUE && !isAddress(process.env.SENTRY_QUEUE)) {
    errors.push(`SENTRY_QUEUE=${process.env.SENTRY_QUEUE} is not a valid 0x-address.`);
  }

  let address: Address | undefined;
  let balanceWei: bigint | undefined;
  let chainId: number | undefined;

  if (errors.length === 0 && pk) {
    const account = privateKeyToAccount(pk);
    address = account.address;
    const pc = publicClient(env.rpc);
    try {
      chainId = await pc.getChainId();
      if (chainId !== somniaTestnet.id) {
        warnings.push(
          `RPC returned chainId ${chainId}, expected ${somniaTestnet.id} (Somnia testnet). Wrong network?`,
        );
      }
      balanceWei = await pc.getBalance({ address });
      if (balanceWei < minBalance) {
        warnings.push(
          `Wallet balance ${formatEther(balanceWei)} STT is below the recommended ${formatEther(minBalance)} STT for a full live demo.`,
        );
      }
    } catch (e) {
      errors.push(`RPC call failed against ${env.rpc}: ${(e as Error).message}`);
    }
  }

  const ok = errors.length === 0;

  if (print) {
    console.log(kleur.bold().cyan("# sentry preflight"));
    console.log(`  rpc            ${env.rpc}`);
    console.log(`  chainId        ${chainId ?? kleur.gray("(unknown)")}`);
    console.log(`  wallet         ${address ?? kleur.gray("(no PRIVATE_KEY set)")}`);
    console.log(
      `  balance        ${balanceWei !== undefined ? formatEther(balanceWei) + " STT" : kleur.gray("(not queried)")}`,
    );
    console.log(`  platform       ${process.env.SOMNIA_AGENT_PLATFORM ?? kleur.gray("(unset)")}`);
    console.log(`  agentId        ${process.env.LLM_INFERENCE_AGENT_ID ?? kleur.gray("(unset)")}`);
    console.log(`  sentry oracle  ${process.env.SENTRY_ORACLE ?? kleur.gray("(unset — deploy via script/Deploy.s.sol)")}`);
    console.log(`  sentry queue   ${process.env.SENTRY_QUEUE ?? kleur.gray("(unset — optional; only needed for DELAYED/VETO_REQUIRED flows)")}`);

    if (errors.length > 0) {
      console.log("");
      for (const e of errors) console.log(kleur.red(`  ERROR   ${e}`));
    }
    if (warnings.length > 0) {
      console.log("");
      for (const w of warnings) console.log(kleur.yellow(`  WARN    ${w}`));
    }
    if (balanceWei !== undefined && balanceWei < minBalance) {
      console.log("");
      console.log(kleur.yellow("  Fund this wallet via a Somnia testnet faucet:"));
      for (const f of FAUCET_LINKS) console.log(`    ${kleur.cyan(f)}`);
    }
    console.log("");
    console.log(ok ? kleur.green("  preflight: OK") : kleur.red("  preflight: NOT READY"));
  }

  return { ok, warnings, errors, address, balanceWei, chainId };
}
