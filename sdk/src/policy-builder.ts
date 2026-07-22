import { parseEther, toFunctionSelector, type Address, type Hex } from "viem";
import {
  TIER_IMMEDIATE,
  TIER_VETO_REQUIRED,
  TIER_NAMES,
  type PolicyInput,
  type SelectorRule,
  type Tier,
  type TierName,
} from "./types.js";

interface TargetSpec {
  target: Address;
  selectors: SelectorRule[];
}

/** ABI-width bounds mirrored from `compilePolicy`. */
const UINT32_MAX_BUILDER = (1n << 32n) - 1n;
const UINT256_MAX_BUILDER = (1n << 256n) - 1n;

/** Fluent builder for Ward `PolicyInput`. */
export class PolicyBuilder {
  private targets: TargetSpec[] = [];
  private current?: TargetSpec;
  private _dailySpendWeiCap: bigint = 0n;
  private _maxSlippageBps = 0;
  private _expiresAt: bigint = 0n;
  private _paused = false;

  target(addr: Address): this {
    this.current = { target: addr, selectors: [] };
    this.targets.push(this.current);
    return this;
  }

  selector(
    sigOrSelector: string | Hex,
    opts: {
      perCallCap?: string | bigint;
      tier?: TierName;
      delaySeconds?: number;
    } = {}
  ): this {
    if (!this.current) {
      throw new Error("PolicyBuilder: call .target() before .selector()");
    }
    const selector = isSelector(sigOrSelector)
      ? (sigOrSelector as Hex)
      : toFunctionSelector(sigOrSelector);
    const tierName: TierName = opts.tier ?? "IMMEDIATE";
    const tier: Tier = TIER_NAMES[tierName];
    const delay = opts.delaySeconds ?? 0;
    if (tier === TIER_IMMEDIATE && delay !== 0) {
      throw new Error("PolicyBuilder: IMMEDIATE tier cannot set delaySeconds");
    }
    if (tier === TIER_VETO_REQUIRED && delay !== 0) {
      throw new Error("PolicyBuilder: VETO_REQUIRED tier cannot set delaySeconds");
    }
    // `delaySeconds` is uint32 on-chain; reject overflow at the builder boundary.
    if (BigInt(delay) > UINT32_MAX_BUILDER) {
      throw new Error("PolicyBuilder: delaySeconds exceeds uint32 max (4294967295)");
    }
    const cap = opts.perCallCap ?? 0n;
    const valueCapPerCall =
      typeof cap === "bigint" ? cap : parseEtherFlexible(cap);
    // `valueCapPerCall` is uint256 on-chain.
    if (valueCapPerCall > UINT256_MAX_BUILDER) {
      throw new Error("PolicyBuilder: valueCapPerCall exceeds uint256 max");
    }
    this.current.selectors.push({
      selector,
      valueCapPerCall,
      tier,
      delaySeconds: delay,
    });
    return this;
  }

  dailyCap(amount: string | bigint): this {
    const value =
      typeof amount === "bigint" ? amount : parseEtherFlexible(amount);
    // `dailySpendWeiCap` is uint256 on-chain.
    if (value > UINT256_MAX_BUILDER) {
      throw new Error("PolicyBuilder: dailySpendWeiCap exceeds uint256 max");
    }
    this._dailySpendWeiCap = value;
    return this;
  }

  maxSlippageBps(bps: number): this {
    if (bps < 0 || bps > 10000) {
      throw new Error("PolicyBuilder: maxSlippageBps must be 0..10000");
    }
    this._maxSlippageBps = bps;
    return this;
  }

  expiresAt(unixSeconds: number | bigint): this {
    this._expiresAt = BigInt(unixSeconds);
    return this;
  }

  expiresInDays(days: number): this {
    const now = BigInt(Math.floor(Date.now() / 1000));
    this._expiresAt = now + BigInt(days * 86400);
    return this;
  }

  paused(p = true): this {
    this._paused = p;
    return this;
  }

  build(): PolicyInput {
    if (this.targets.length === 0) {
      throw new Error("PolicyBuilder: at least one target required");
    }
    if (this._expiresAt === 0n) {
      throw new Error("PolicyBuilder: expiresAt must be set");
    }
    return {
      targets: this.targets.map((t) => ({
        target: t.target,
        selectors: t.selectors,
      })),
      dailySpendWeiCap: this._dailySpendWeiCap,
      maxSlippageBps: this._maxSlippageBps,
      expiresAt: this._expiresAt,
      paused: this._paused,
    };
  }
}

function isSelector(s: string): boolean {
  return /^0x[0-9a-fA-F]{8}$/.test(s);
}

/** Suggest a canonical `N ether` spelling for close suffix typos without accepting other units. */
function suggestEtherFix(raw: string): string | null {
  const trimmed = raw.trim();
  const concat = /^(\d+(?:\.\d+)?)([A-Za-z]+)$/.exec(trimmed);
  const spaced = /^(\d+(?:\.\d+)?)\s+([A-Za-z]+)$/.exec(trimmed);
  const match = concat ?? spaced;
  if (!match) return null;
  const num = match[1];
  const suffix = match[2].toLowerCase();
  if (suffix === "ether") return null;
  // Keep suggestions narrow so unsupported real units like `wei` and `gwei` are not rewritten.
  const dist = levenshtein(suffix, "ether");
  if (suffix === "wei" || suffix === "gwei" || suffix === "finney") return null;
  if (dist <= 2) return `${num} ether`;
  return null;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = tmp;
    }
  }
  return dp[n];
}

/** Parse wei integers, hex wei, or `N ether`; hints on close `ether` typos. */
function parseEtherFlexible(input: string): bigint {
  const trimmed = input.trim();
  if (trimmed === "" || trimmed === "0") return 0n;
  if (/ether$/i.test(trimmed)) {
    const num = trimmed.replace(/\s*ether$/i, "").trim();
    return parseEther(num);
  }
  if (/^0x/.test(trimmed)) return BigInt(trimmed);
  // Catch near-miss typos before BigInt() throws a raw SyntaxError.
  const hint = suggestEtherFix(trimmed);
  if (hint !== null) {
    throw new Error(
      `Unrecognized unit in "${input}" — did you mean "${hint}"? (Supported: plain wei integer, or "N ether" for native STT.)`,
    );
  }
  return BigInt(trimmed);
}

export { parseEtherFlexible, suggestEtherFix };
