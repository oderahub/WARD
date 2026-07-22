import kleur from "kleur";
import { formatEther, isAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadEnv, publicClient, activeChain } from "../lib/env.js";

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
  "https://faucet.avax.network/",
  "https://core.app/tools/testnet-faucet/",
];

/** Check env, RPC, and wallet balance for Avalanche write readiness. */
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

  if (process.env.WARD_ORACLE && !isAddress(process.env.WARD_ORACLE)) {
    errors.push(`WARD_ORACLE=${process.env.WARD_ORACLE} is not a valid 0x-address.`);
  }
  if (process.env.WARD_QUEUE && !isAddress(process.env.WARD_QUEUE)) {
    errors.push(`WARD_QUEUE=${process.env.WARD_QUEUE} is not a valid 0x-address.`);
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
      const chain = activeChain();
      if (chainId !== chain.id) {
        warnings.push(
          `RPC returned chainId ${chainId}, expected ${chain.id} (${chain.name}). Wrong network?`,
        );
      }
      balanceWei = await pc.getBalance({ address });
      if (balanceWei < minBalance) {
        warnings.push(
          `Wallet balance ${formatEther(balanceWei)} AVAX is below the recommended ${formatEther(minBalance)} AVAX for a full live demo.`,
        );
      }
    } catch (e) {
      errors.push(`RPC call failed against ${env.rpc}: ${(e as Error).message}`);
    }
  }

  const ok = errors.length === 0;

  if (print) {
    console.log(kleur.bold().cyan("# ward preflight"));
    console.log(`  rpc            ${env.rpc}`);
    console.log(`  chainId        ${chainId ?? kleur.gray("(unknown)")}`);
    console.log(`  wallet         ${address ?? kleur.gray("(no PRIVATE_KEY set)")}`);
    console.log(
      `  balance        ${balanceWei !== undefined ? formatEther(balanceWei) + " AVAX" : kleur.gray("(not queried)")}`,
    );
    console.log(`  ward oracle  ${process.env.WARD_ORACLE ?? kleur.gray("(unset — deploy via script/Deploy.s.sol)")}`);
    console.log(`  ward queue   ${process.env.WARD_QUEUE ?? kleur.gray("(unset — optional; only needed for DELAYED/VETO_REQUIRED flows)")}`);

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
      console.log(kleur.yellow("  Fund this wallet via an Avalanche Fuji faucet:"));
      for (const f of FAUCET_LINKS) console.log(`    ${kleur.cyan(f)}`);
    }
    console.log("");
    console.log(ok ? kleur.green("  preflight: OK") : kleur.red("  preflight: NOT READY"));
  }

  return { ok, warnings, errors, address, balanceWei, chainId };
}
