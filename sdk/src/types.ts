import type { Address, Hex } from "viem";

export const TIER_IMMEDIATE = 0 as const;
export const TIER_DELAYED = 1 as const;
export const TIER_VETO_REQUIRED = 2 as const;
export type Tier =
  | typeof TIER_IMMEDIATE
  | typeof TIER_DELAYED
  | typeof TIER_VETO_REQUIRED;

export const TIER_NAMES = {
  IMMEDIATE: TIER_IMMEDIATE,
  DELAYED: TIER_DELAYED,
  VETO_REQUIRED: TIER_VETO_REQUIRED,
} as const;
export type TierName = keyof typeof TIER_NAMES;

export interface SelectorRule {
  selector: Hex; // 4-byte selector, "0x..."
  valueCapPerCall: bigint;
  tier: Tier;
  delaySeconds: number;
}

export interface TargetRule {
  target: Address;
  selectors: SelectorRule[];
}

export interface PolicyInput {
  targets: TargetRule[];
  dailySpendWeiCap: bigint;
  maxSlippageBps: number;
  expiresAt: bigint; // unix seconds
  paused: boolean;
}

export interface Intent {
  agentId: bigint;
  requestId: bigint;
  target: Address;
  selector: Hex;
  data: Hex;
  value: bigint;
  promptHash: Hex;
  taskClass: number;
}

