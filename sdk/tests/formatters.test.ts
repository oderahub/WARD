import { describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import {
  formatSentryDecision,
  formatSentryUserMessage,
} from "../src/formatters.js";
import { preflight, type PreflightResult } from "../src/preflight.js";
import { REASON_CODES } from "../src/reason-codes.js";
import type { EvalIntent, EvalPolicy } from "../src/policy-eval.js";

const TARGET: Address = "0x1111111111111111111111111111111111111111";
const SELECTOR: Hex = "0x60fe47b1";
const POLICY_ID: Hex =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const result: PreflightResult = {
  ok: false,
  reason: REASON_CODES.SELECTOR_NOT_ALLOWED,
  reasonText: "The target is allowed, but this selector is not allowed.",
  source: "local",
};

const intent: EvalIntent = {
  agentId: 3n,
  requestId: 9n,
  target: TARGET,
  selector: SELECTOR,
  data: SELECTOR,
  value: 0n,
  promptHash:
    "0x0000000000000000000000000000000000000000000000000000000000000000",
  taskClass: 0,
};

const policy: EvalPolicy = {
  isTargetAllowed: {},
  isSelectorAllowed: {},
  valueCapPerCall: {},
  tier: {},
  delaySeconds: {},
  dailySpendWeiCap: 0n,
  expiresAt: 4_102_444_800n,
  paused: false,
};

describe("Sentry formatters", () => {
  it("formats a structured decision log", () => {
    expect(
      formatSentryDecision(result, {
        policyId: POLICY_ID,
        target: TARGET,
        selector: SELECTOR,
      }),
    ).toMatchObject({
      event: "sentry.decision",
      ok: false,
      reason: REASON_CODES.SELECTOR_NOT_ALLOWED,
      reasonText: result.reasonText,
      source: "local",
      policyId: POLICY_ID,
      target: TARGET,
      selector: SELECTOR,
    });
  });

  it("stringifies bigint ids for logs", () => {
    const log = formatSentryDecision(result, {
      requestId: 123n,
      agentId: 456n,
    });

    expect(log.requestId).toBe("123");
    expect(log.agentId).toBe("456");
  });

  it("omits optional context when absent", () => {
    const log = formatSentryDecision(result);

    expect(log.policyId).toBeUndefined();
    expect(log.target).toBeUndefined();
    expect(log.selector).toBeUndefined();
  });

  it("formats user messages from reason codes", () => {
    expect(formatSentryUserMessage(REASON_CODES.REQUIRES_DELAY)).toMatch(/queued/i);
  });

  it("falls back for unknown reason codes", () => {
    expect(
      formatSentryUserMessage(
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ),
    ).toMatch(/Unknown reason code/i);
  });

  it("preflight calls onSentryDecision with the returned result", async () => {
    const onSentryDecision = vi.fn();

    const returned = await preflight({
      source: { kind: "local", policy },
      intent,
      spentTodayWei: 0n,
      nowSec: 1_700_000_000n,
      onSentryDecision,
    });

    expect(onSentryDecision).toHaveBeenCalledWith(returned);
  });
});
