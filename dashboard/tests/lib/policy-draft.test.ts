import { describe, it, expect } from "vitest";
import { compilePolicy } from "@ward/sdk";
import {
  PolicyDraftSchema,
  SelectorDraftSchema,
  emptyPolicyDraft,
  isAsciiPrintable,
  renderPolicyMarkdown,
  sanitizeNameForMarkdown,
  selectorToBytes4OrNull,
  simulateIntent,
  slugifyLabel,
} from "../../src/lib/policy-draft";

const VALID_TARGET = "0xA1601891Da4b60c9311B3A024e3E03C5136460e4";

const valid = {
  name: "Ward Counter e2e policy",
  description: "Test policy for the dashboard publish flow.",
  label: "ward-counter-e2e",
  dailySpendWeiCap: "0",
  expiresAtISO: "2026-11-29T00:00:00.000Z",
  paused: false,
  targets: [
    {
      target: VALID_TARGET,
      selectors: [
        { selector: "bump(uint256)", tier: "IMMEDIATE" as const, valueCapPerCall: "0", delaySeconds: 0 },
      ],
    },
  ],
};

describe("PolicyDraftSchema", () => {
  it("accepts a valid draft", () => {
    expect(() => PolicyDraftSchema.parse(valid)).not.toThrow();
  });

  it("rejects non-hex addresses", () => {
    const bad = { ...valid, targets: [{ ...valid.targets[0], target: "not-an-address" }] };
    expect(() => PolicyDraftSchema.parse(bad)).toThrow(/40-hex/);
  });

  it("rejects malformed selector signatures", () => {
    const r = SelectorDraftSchema.safeParse({
      selector: "bump uint256",
      tier: "IMMEDIATE",
      valueCapPerCall: "0",
      delaySeconds: 0,
    });
    expect(r.success).toBe(false);
  });

  it("rejects labels longer than 32 UTF-8 bytes", () => {
    const bad = { ...valid, label: "x".repeat(33) };
    expect(() => PolicyDraftSchema.parse(bad)).toThrow(/32 bytes/);
  });

  it("rejects DELAYED selectors with delaySeconds=0 ... actually that's allowed; rejects IMMEDIATE with delay>0", () => {
    const r = SelectorDraftSchema.safeParse({
      selector: "x()",
      tier: "IMMEDIATE",
      valueCapPerCall: "0",
      delaySeconds: 60,
    });
    expect(r.success).toBe(false);
  });

  it("accepts `1 ether` shorthand", () => {
    const r = SelectorDraftSchema.safeParse({
      selector: "x()",
      tier: "IMMEDIATE",
      valueCapPerCall: "1 ether",
      delaySeconds: 0,
    });
    expect(r.success).toBe(true);
  });

  // Audit follow-up: typo on the `ether` suffix used to surface as a
  // generic "wei integer or `N ether` shorthand" message that didn't tell
  // the user what they had wrong. Confirm the schema now emits a
  // "did you mean … ether" hint for the per-call cap.
  it("rejects `0.5ethe` with a 'did you mean \"0.5 ether\"' hint", () => {
    const r = SelectorDraftSchema.safeParse({
      selector: "x()",
      tier: "IMMEDIATE",
      valueCapPerCall: "0.5ethe",
      delaySeconds: 0,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.map((i) => i.message).join("\n");
      expect(msg).toMatch(/Did you mean "0\.5 ether"/);
    }
  });

  it("rejects `1 eth` with a 'did you mean \"1 ether\"' hint", () => {
    const r = SelectorDraftSchema.safeParse({
      selector: "x()",
      tier: "IMMEDIATE",
      valueCapPerCall: "1 eth",
      delaySeconds: 0,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.map((i) => i.message).join("\n");
      expect(msg).toMatch(/Did you mean "1 ether"/);
    }
  });

  it("rejects `100 gwei` WITHOUT an 'ether' suggestion (gwei is not supported)", () => {
    const r = SelectorDraftSchema.safeParse({
      selector: "x()",
      tier: "IMMEDIATE",
      valueCapPerCall: "100 gwei",
      delaySeconds: 0,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.map((i) => i.message).join("\n");
      expect(msg).not.toMatch(/did you mean/);
      // Still tells the user what shape IS accepted.
      expect(msg).toMatch(/N ether|wei integer/);
    }
  });
});

describe("PolicyDraftSchema — dailySpendWeiCap typo hint", () => {
  const draftWithDaily = (cap: string) => ({
    name: "x",
    description: "",
    label: "x",
    dailySpendWeiCap: cap,
    expiresAtISO: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    paused: false,
    targets: [
      {
        target: VALID_TARGET,
        selectors: [
          { selector: "x()", tier: "IMMEDIATE" as const, valueCapPerCall: "0", delaySeconds: 0 },
        ],
      },
    ],
  });

  it("rejects daily cap `0.5ethe` with a 'did you mean' hint", () => {
    const r = PolicyDraftSchema.safeParse(draftWithDaily("0.5ethe"));
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.map((i) => i.message).join("\n");
      expect(msg).toMatch(/Did you mean "0\.5 ether"/);
    }
  });

  it("preserves the canonical `1 ether` daily cap", () => {
    const r = PolicyDraftSchema.safeParse(draftWithDaily("1 ether"));
    expect(r.success).toBe(true);
  });
});

describe("renderPolicyMarkdown", () => {
  it("emits a single ```policy fenced block", () => {
    const md = renderPolicyMarkdown(valid);
    const fences = md.match(/```policy/g);
    expect(fences?.length).toBe(1);
    expect(md.match(/```\s*$/m)).not.toBeNull();
  });

  it("round-trips through the SDK compiler (parity with `ward compile`)", () => {
    const md = renderPolicyMarkdown(valid);
    const compiled = compilePolicy(md);
    // Same shape the CLI produces; selector hashed to its 4-byte id.
    expect(compiled.targets).toHaveLength(1);
    expect(compiled.targets[0].target.toLowerCase()).toBe(VALID_TARGET.toLowerCase());
    expect(compiled.targets[0].selectors).toHaveLength(1);
    expect(compiled.targets[0].selectors[0].selector).toBe("0xb20eb4c4"); // keccak256("bump(uint256)")[:4]
    expect(compiled.targets[0].selectors[0].tier).toBe(0); // IMMEDIATE
    expect(compiled.dailySpendWeiCap).toBe(0n);
    expect(compiled.paused).toBe(false);
  });

  it("preserves description as markdown body, not inside the fence", () => {
    const md = renderPolicyMarkdown(valid);
    const fenceStart = md.indexOf("```policy");
    expect(md.indexOf(valid.description)).toBeGreaterThan(0);
    expect(md.indexOf(valid.description)).toBeLessThan(fenceStart);
  });

  it("strips triple-backticks from description to prevent fence collision (CP51)", () => {
    const malicious = {
      ...valid,
      description: "innocent text ```policy\nversion: 0.0\n``` more text",
    };
    const md = renderPolicyMarkdown(malicious);
    // Only the generated fence should be present.
    expect(md.match(/```policy/g)?.length).toBe(1);
    // Compile must still succeed (no premature fence).
    expect(() => compilePolicy(md)).not.toThrow();
  });

  it("handles multiple targets + selectors", () => {
    const multi = {
      ...valid,
      targets: [
        {
          target: VALID_TARGET,
          selectors: [
            { selector: "bump(uint256)", tier: "IMMEDIATE" as const, valueCapPerCall: "0", delaySeconds: 0 },
            { selector: "tick()", tier: "DELAYED" as const, valueCapPerCall: "0", delaySeconds: 60 },
          ],
        },
        {
          // Non-precompile placeholder — 0x01..0x0a and 0x100 are reserved by
          // the SDK's `buildReservedSet` (precompile mirror of the dashboard's
          // RESERVED_TARGETS), so we use 0xbeef… instead to keep this test
          // exercising "second target compiles" rather than reserved-target
          // rejection.
          target: "0x000000000000000000000000000000000000beef",
          selectors: [
            { selector: "ping()", tier: "VETO_REQUIRED" as const, valueCapPerCall: "0", delaySeconds: 0 },
          ],
        },
      ],
    };
    const compiled = compilePolicy(renderPolicyMarkdown(multi));
    expect(compiled.targets).toHaveLength(2);
    expect(compiled.targets[0].selectors).toHaveLength(2);
    expect(compiled.targets[0].selectors[1].delaySeconds).toBe(60);
    expect(compiled.targets[1].selectors[0].tier).toBe(2); // VETO_REQUIRED
  });
});

describe("PolicyDraftSchema — Wave 2 #4 (5y expiry cap)", () => {
  it("rejects expiry more than 5 years out", () => {
    const tooFar = new Date(Date.now() + 6 * 365 * 24 * 60 * 60 * 1000).toISOString();
    const bad = { ...valid, expiresAtISO: tooFar };
    expect(() => PolicyDraftSchema.parse(bad)).toThrow(/Max 5 years/);
  });

  it("accepts expiry just under the 5y cap", () => {
    const justUnder = new Date(Date.now() + 4 * 365 * 24 * 60 * 60 * 1000).toISOString();
    const ok = { ...valid, expiresAtISO: justUnder };
    expect(() => PolicyDraftSchema.parse(ok)).not.toThrow();
  });
});

describe("PolicyDraftSchema — Wave 2 #14 (dedup)", () => {
  it("rejects duplicate target addresses (case-insensitive)", () => {
    // Same address as VALID_TARGET, lowercased — the case-insensitive dedup
    // must collapse both forms to the same key.
    const lowered = "0x" + VALID_TARGET.slice(2).toLowerCase();
    const dupe = {
      ...valid,
      targets: [
        valid.targets[0],
        { ...valid.targets[0], target: lowered },
      ],
    };
    const r = PolicyDraftSchema.safeParse(dupe);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => /Duplicate target/.test(i.message))).toBe(true);
    }
  });

  it("rejects duplicate selectors within a target by bytes4 (signature collision with hex)", () => {
    const dupe = {
      ...valid,
      targets: [
        {
          target: VALID_TARGET,
          selectors: [
            { selector: "approve(address,uint256)", tier: "IMMEDIATE" as const, valueCapPerCall: "0", delaySeconds: 0 },
            // 0x095ea7b3 = keccak256("approve(address,uint256)")[:4]
            { selector: "0x095ea7b3", tier: "IMMEDIATE" as const, valueCapPerCall: "0", delaySeconds: 0 },
          ],
        },
      ],
    };
    // Note: this uses SemanticSchema-only behavior; the publish-form display
    // schema rejects raw hex selectors. We exercise via the semantic helper
    // since the dedup pass runs on the semantic layer.
    const r = PolicyDraftSchema.safeParse(dupe);
    expect(r.success).toBe(false);
    if (!r.success) {
      // Hex selector also trips the display rule, but the dedup message must
      // be present somewhere in the issue set.
      expect(r.error.issues.some((i) => /Duplicate selector/.test(i.message))).toBe(true);
    }
  });
});

describe("selectorToBytes4OrNull", () => {
  it("returns the lowercase 4-byte hex for a signature", () => {
    // keccak256("transfer(address,uint256)")[:4]
    expect(selectorToBytes4OrNull("transfer(address,uint256)")).toBe("0xa9059cbb");
  });

  it("returns the lowercase 4-byte hex for a hex selector (idempotent on case)", () => {
    expect(selectorToBytes4OrNull("0xA9059CBB")).toBe("0xa9059cbb");
  });

  it("returns null for a malformed signature", () => {
    expect(selectorToBytes4OrNull("not a sig")).toBeNull();
  });

  it("returns null for a malformed hex selector", () => {
    expect(selectorToBytes4OrNull("0xnothex")).toBeNull();
  });
});

describe("isAsciiPrintable", () => {
  it("accepts pure ASCII text", () => {
    expect(isAsciiPrintable("trading-bot-v1")).toBe(true);
  });

  it("accepts a label with a space (space is 0x20, the lower bound)", () => {
    expect(isAsciiPrintable("trading v1")).toBe(true);
  });

  it("rejects a label with an emoji (above 0x7e)", () => {
    expect(isAsciiPrintable("rocket")).toBe(true);
    expect(isAsciiPrintable("rocket\u{1F680}")).toBe(false);
  });

  it("rejects a label containing NUL (below 0x20)", () => {
    expect(isAsciiPrintable("ok\u0000bad")).toBe(false);
  });
});

describe("sanitizeNameForMarkdown (Wave 3 LOW #2 defense-in-depth)", () => {
  it("passes through an ordinary name unchanged", () => {
    expect(sanitizeNameForMarkdown("DEX swapper v1")).toBe("DEX swapper v1");
  });

  it("collapses newlines (\\n and \\r\\n) into a single space", () => {
    expect(sanitizeNameForMarkdown("line one\nline two")).toBe("line one line two");
    expect(sanitizeNameForMarkdown("line one\r\nline two")).toBe("line one line two");
  });

  it("replaces triple-backtick runs with two apostrophes", () => {
    expect(sanitizeNameForMarkdown("name ```fence``` end")).toBe("name ''fence'' end");
  });

  it("strips C0 control bytes (NUL, tab, DEL)", () => {
    expect(sanitizeNameForMarkdown("ok 	end")).toBe("okend");
  });

  it("strips BOM and zero-width chars", () => {
    expect(sanitizeNameForMarkdown("a﻿b​c‍d")).toBe("abcd");
  });

  it("strips U+2028 line separator (Wave 3.5 LOW #1)", () => {
    expect(sanitizeNameForMarkdown("line\u{2028}break")).toBe("linebreak");
  });

  it("strips U+2029 paragraph separator (Wave 3.5 LOW #1)", () => {
    expect(sanitizeNameForMarkdown("para\u{2029}break")).toBe("parabreak");
  });

  it("strips U+2003 em space (Wave 3.6 LOW #1 — full Zs except U+0020)", () => {
    // EM SPACE renders as whitespace indistinguishable from a regular space
    // but parses as a different byte — same spoofing surface as NBSP.
    expect(sanitizeNameForMarkdown("em\u{2003}space")).toBe("emspace");
  });
});

describe("PolicyDraftSchema name validation (Wave 3 LOW #1)", () => {
  const validBase = {
    name: "ok",
    description: "",
    label: "ok-label",
    dailySpendWeiCap: "0",
    expiresAtISO: "2026-11-29T00:00:00.000Z",
    paused: false,
    targets: [
      {
        target: VALID_TARGET,
        selectors: [
          { selector: "bump(uint256)", tier: "IMMEDIATE" as const, valueCapPerCall: "0", delaySeconds: 0 },
        ],
      },
    ],
  };

  it("rejects names containing a tab", () => {
    const bad = { ...validBase, name: "foo\tbar" };
    const r = PolicyDraftSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it("rejects names containing a BOM", () => {
    const bad = { ...validBase, name: "foo﻿bar" };
    const r = PolicyDraftSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it("rejects names containing zero-width chars", () => {
    const bad = { ...validBase, name: "foo​bar" };
    const r = PolicyDraftSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it("accepts names with regular spaces", () => {
    const ok = { ...validBase, name: "Trading bot v1" };
    expect(() => PolicyDraftSchema.parse(ok)).not.toThrow();
  });

  it("rejects names containing NBSP (U+00A0, Wave 3.5 LOW #1)", () => {
    // NBSP looks identical to a regular space but parses as a different byte —
    // the same spoofing surface as the zero-width chars above.
    const bad = { ...validBase, name: "foo\u{00A0}bar" };
    const r = PolicyDraftSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it("rejects names containing U+3000 ideographic space (Wave 3.6 LOW #1)", () => {
    // IDEOGRAPHIC SPACE is a Unicode Zs separator that renders as whitespace
    // indistinguishable from a regular space — same spoofing surface as NBSP.
    const bad = { ...validBase, name: "foo\u{3000}bar" };
    const r = PolicyDraftSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });
});

describe("emptyPolicyDraft", () => {
  it("returns a structurally valid skeleton (top-level shape only; fields blank)", () => {
    const blank = emptyPolicyDraft();
    expect(blank.targets).toHaveLength(1);
    expect(blank.targets[0].selectors).toHaveLength(1);
    // Top-level schema parses won't succeed (blank fields), but the structure is sound.
    expect(typeof blank.expiresAtISO).toBe("string");
    expect(Date.parse(blank.expiresAtISO)).toBeGreaterThan(Date.now());
  });
});

describe("simulateIntent (Wave 3.9 — PolicyLib parity)", () => {
  // Selector for `bump(uint256)` per the `valid` draft above.
  const BUMP_SELECTOR = "0xb20eb4c4";
  // Use a contract that isn't in the policy to exercise NO_TARGET.
  const UNKNOWN_TARGET = "0x000000000000000000000000000000000000dEaD";

  function makeInput(opts: { dailyCapWei: bigint; valueCapWei: bigint }) {
    return {
      targets: [
        {
          target: VALID_TARGET as `0x${string}`,
          selectors: [
            {
              selector: BUMP_SELECTOR as `0x${string}`,
              valueCapPerCall: opts.valueCapWei,
              tier: 0 as const,
              delaySeconds: 0,
            },
          ],
        },
      ],
      dailySpendWeiCap: opts.dailyCapWei,
      maxSlippageBps: 0,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 86_400),
      paused: false,
    };
  }

  it("dailySpendWeiCap=0 + value>0 → DAILY_CAP_EXCEEDED (PolicyLib parity)", () => {
    const input = makeInput({ dailyCapWei: 0n, valueCapWei: 10n ** 18n });
    const r = simulateIntent(input, {
      target: VALID_TARGET,
      selector: "bump(uint256)",
      value: "1",
    });
    expect(r).toEqual({ allowed: false, reason: "DAILY_CAP_EXCEEDED" });
  });

  it("dailySpendWeiCap=0 + value=0 → allowed (no native spend, no daily check needed)", () => {
    const input = makeInput({ dailyCapWei: 0n, valueCapWei: 0n });
    const r = simulateIntent(input, {
      target: VALID_TARGET,
      selector: "bump(uint256)",
      value: "0",
    });
    expect(r.allowed).toBe(true);
  });

  it("precedence: unknown target against a 0-cap policy → NO_TARGET (not DAILY_CAP_EXCEEDED)", () => {
    // PolicyLib's order (contracts/src/PolicyLib.sol) is:
    //   paused → expired → target → selector → valueCap → daily.
    // With paused=false and no nowSec override, target matching runs before
    // the daily ledger, so NO_TARGET fires even though `value=1` would also
    // trip the zero-cap daily check.
    const input = makeInput({ dailyCapWei: 0n, valueCapWei: 10n ** 18n });
    const r = simulateIntent(input, {
      target: UNKNOWN_TARGET,
      selector: "bump(uint256)",
      value: "1",
    });
    expect(r).toEqual({ allowed: false, reason: "NO_TARGET" });
  });

  it("precedence: PAUSED dominates unknown target", () => {
    // PolicyLib checks `paused` first, so an unknown target must still
    // surface PAUSED rather than NO_TARGET.
    const input = { ...makeInput({ dailyCapWei: 10n ** 18n, valueCapWei: 10n ** 18n }), paused: true };
    const r = simulateIntent(input, {
      target: UNKNOWN_TARGET,
      selector: "bump(uint256)",
      value: "0",
    });
    expect(r).toEqual({ allowed: false, reason: "PAUSED" });
  });

  it("precedence: PAUSED dominates EXPIRED", () => {
    // Even with `nowSec > expiresAt`, PAUSED beats EXPIRED.
    const input = { ...makeInput({ dailyCapWei: 10n ** 18n, valueCapWei: 10n ** 18n }), paused: true };
    const r = simulateIntent(
      input,
      { target: VALID_TARGET, selector: "bump(uint256)", value: "0" },
      { nowSec: input.expiresAt + 1n },
    );
    expect(r).toEqual({ allowed: false, reason: "PAUSED" });
  });

  it("precedence: EXPIRED dominates unknown target", () => {
    // Expiry is checked before target matching, so an expired policy with
    // an unknown target must surface EXPIRED rather than NO_TARGET.
    const input = makeInput({ dailyCapWei: 10n ** 18n, valueCapWei: 10n ** 18n });
    const r = simulateIntent(
      input,
      { target: UNKNOWN_TARGET, selector: "bump(uint256)", value: "0" },
      { nowSec: input.expiresAt + 1n },
    );
    expect(r).toEqual({ allowed: false, reason: "EXPIRED" });
  });

  it("precedence: EXPIRED dominates DAILY_CAP_EXCEEDED (0-cap policy)", () => {
    // With dailySpendWeiCap=0 and value>0 the daily check would normally
    // fire, but expiry runs first so EXPIRED must surface instead.
    const input = makeInput({ dailyCapWei: 0n, valueCapWei: 10n ** 18n });
    const r = simulateIntent(
      input,
      { target: VALID_TARGET, selector: "bump(uint256)", value: "1" },
      { nowSec: input.expiresAt + 1n },
    );
    expect(r).toEqual({ allowed: false, reason: "EXPIRED" });
  });
});

describe("slugifyLabel — auto-derive short id from policy name", () => {
  it("lowercases + replaces non-alnum runs with single dashes", () => {
    expect(slugifyLabel("My Trading Bot Policy")).toBe("my-trading-bot-policy");
  });

  it("collapses adjacent non-alnum runs (spaces + punctuation) to one dash", () => {
    expect(slugifyLabel("foo   bar !!! baz")).toBe("foo-bar-baz");
  });

  it("strips leading/trailing dashes", () => {
    expect(slugifyLabel("  --- hello world ---  ")).toBe("hello-world");
  });

  it("returns the literal 'policy' fallback for empty / whitespace / all-junk input", () => {
    expect(slugifyLabel("")).toBe("policy");
    expect(slugifyLabel("   ")).toBe("policy");
    expect(slugifyLabel("!!!---???")).toBe("policy");
  });

  it("caps the result at 32 chars and trims any trailing dash that survives the slice", () => {
    // 35 chars worth of "a-" so the 32-char slice ends mid-dash and must be re-trimmed.
    const out = slugifyLabel("a a a a a a a a a a a a a a a a a a a a a a a a a a a a a a");
    expect(out.length).toBeLessThanOrEqual(32);
    expect(out.endsWith("-")).toBe(false);
    expect(out.startsWith("a-")).toBe(true);
  });

  it("preserves numbers + keeps the slug stable across whitespace variation", () => {
    expect(slugifyLabel("Trading Bot v2")).toBe("trading-bot-v2");
    expect(slugifyLabel("trading\tbot\nv2")).toBe("trading-bot-v2");
  });

  it("matches the labelSlugRegex publish-gate pattern so auto-fill never produces an invalid label", () => {
    const labelSlugRegex = /^[a-zA-Z0-9._-]+$/;
    for (const name of [
      "My Bot",
      "Quick Brown Fox",
      "TRADING-V1",
      "foo!@#$%bar",
      "  edges  ",
      "1-2-3",
    ]) {
      expect(slugifyLabel(name)).toMatch(labelSlugRegex);
    }
  });
});

describe("PolicyDraftSchema — bindAgentAddress (agent-first entry)", () => {
  it("accepts a draft with a valid bindAgentAddress passthrough field", () => {
    const draft = {
      ...valid,
      bindAgentAddress: "0x000000000000000000000000000000000000beef",
    };
    expect(() => PolicyDraftSchema.parse(draft)).not.toThrow();
  });

  it("accepts a draft without bindAgentAddress (greenfield, no agent pasted)", () => {
    // The field is .optional() — an undefined / absent value is the default
    // path for operators who haven't deployed their agent yet.
    expect(() => PolicyDraftSchema.parse(valid)).not.toThrow();
    const parsed = PolicyDraftSchema.parse(valid);
    expect(parsed.bindAgentAddress).toBeUndefined();
  });

  it("rejects a bindAgentAddress that isn't a 0x-40-hex address", () => {
    const bad = { ...valid, bindAgentAddress: "not-an-address" };
    expect(() => PolicyDraftSchema.parse(bad)).toThrow();
  });

  it("does NOT serialize bindAgentAddress into POLICY.md (UI-draft-only)", () => {
    // The chain has no slot for this — the bind step writes setPolicyId on
    // the deployed agent, not into the policy struct. Make sure the rendered
    // markdown stays bit-identical to the no-agent case so the CLI / SDK
    // round-trip remains unchanged.
    const draftWith = {
      ...valid,
      bindAgentAddress: "0x000000000000000000000000000000000000beef",
    } as Parameters<typeof renderPolicyMarkdown>[0];
    const md = renderPolicyMarkdown(draftWith);
    expect(md).not.toMatch(/bindAgentAddress/i);
    expect(md).not.toMatch(/0x000000000000000000000000000000000000beef/i);
  });
});
