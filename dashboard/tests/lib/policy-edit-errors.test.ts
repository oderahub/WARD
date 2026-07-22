import { describe, it, expect } from "vitest";
import type { PolicyInput } from "@ward/sdk";
import {
  errorPathSet,
  humanizeErrorPath,
  humanizeSchemaErrors,
  patchDraftForPartialCompile,
} from "../../src/lib/policy-edit-errors";
import type { PolicyDraft } from "../../src/lib/policy-draft";

const baseDraft: PolicyDraft = {
  name: "Test",
  description: "",
  label: "test",
  dailySpendWeiCap: "1 ether",
  expiresAtISO: "2027-01-01T00:00:00.000Z",
  paused: false,
  targets: [
    {
      target: "0xA1601891Da4b60c9311B3A024e3E03C5136460e4",
      selectors: [
        {
          selector: "transfer(address,uint256)",
          tier: "IMMEDIATE",
          valueCapPerCall: "0",
          delaySeconds: 0,
        },
        {
          // Empty cap — what the user's screenshot shows.
          selector: "bump(uint256)",
          tier: "IMMEDIATE",
          valueCapPerCall: "",
          delaySeconds: 0,
        },
      ],
    },
  ],
};

describe("humanizeErrorPath", () => {
  it("maps top-level scalar paths to friendly labels", () => {
    expect(humanizeErrorPath("name", baseDraft)).toBe("Policy name");
    expect(humanizeErrorPath("label", baseDraft)).toBe("Short id");
    expect(humanizeErrorPath("dailySpendWeiCap", baseDraft)).toBe(
      "Daily native (AVAX) spend cap",
    );
    expect(humanizeErrorPath("expiresAtISO", baseDraft)).toBe("Valid until");
    expect(humanizeErrorPath("paused", baseDraft)).toBe("Paused");
  });

  it("maps targets root to a readable label", () => {
    expect(humanizeErrorPath("targets", baseDraft)).toBe("Targets");
  });

  it("uses 1-based contract numbering for target-level paths", () => {
    expect(humanizeErrorPath("targets.0.target", baseDraft)).toBe("Contract 1");
    expect(humanizeErrorPath("targets.0", baseDraft)).toBe("Contract 1");
  });

  it("flags the empty selectors array under a target", () => {
    expect(humanizeErrorPath("targets.0.selectors", baseDraft)).toBe(
      "Contract 1 → functions",
    );
  });

  it("uses the typed function signature when available", () => {
    expect(
      humanizeErrorPath("targets.0.selectors.1.valueCapPerCall", baseDraft),
    ).toBe("Contract 1 → bump(uint256) → per-call native cap");
  });

  it("falls back to a placeholder when the selector text is empty", () => {
    const draft: PolicyDraft = {
      ...baseDraft,
      targets: [
        {
          target: baseDraft.targets[0].target,
          selectors: [
            {
              selector: "",
              tier: "IMMEDIATE",
              valueCapPerCall: "0",
              delaySeconds: 0,
            },
          ],
        },
      ],
    };
    expect(humanizeErrorPath("targets.0.selectors.0.selector", draft)).toBe(
      "Contract 1 → function 1 → function signature",
    );
  });

  it("humanizes a hex-only selector via the known-signature map", () => {
    const draft: PolicyDraft = {
      ...baseDraft,
      targets: [
        {
          target: baseDraft.targets[0].target,
          selectors: [
            {
              selector: "0xa9059cbb",
              tier: "IMMEDIATE",
              valueCapPerCall: "0",
              delaySeconds: 0,
            },
          ],
        },
      ],
    };
    expect(humanizeErrorPath("targets.0.selectors.0.tier", draft)).toBe(
      "Contract 1 → transfer(address,uint256) → approval mode",
    );
  });

  it("returns the raw path for unrecognized prefixes", () => {
    expect(humanizeErrorPath("weird.unknown.path", baseDraft)).toBe(
      "weird.unknown.path",
    );
  });
});

describe("humanizeSchemaErrors", () => {
  it("parses path:message strings and dedupes by path", () => {
    const out = humanizeSchemaErrors(
      [
        "targets.0.selectors.1.valueCapPerCall: cap required (use `0` for no value)",
        // duplicate path — first message wins
        "targets.0.selectors.1.valueCapPerCall: another message",
        "label: label required",
      ],
      baseDraft,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      path: "targets.0.selectors.1.valueCapPerCall",
      label: "Contract 1 → bump(uint256) → per-call native cap",
      message: "cap required (use `0` for no value)",
    });
    expect(out[1]).toMatchObject({
      path: "label",
      label: "Short id",
      message: "label required",
    });
  });

  it("skips entries that have no colon (malformed)", () => {
    const out = humanizeSchemaErrors(["no-colon-here"], baseDraft);
    expect(out).toEqual([]);
  });
});

describe("errorPathSet", () => {
  it("collects the dotted paths from the humanized list", () => {
    const set = errorPathSet([
      { path: "label", message: "x", label: "Short id" },
      { path: "targets.0.target", message: "y", label: "Contract 1" },
    ]);
    expect(set.has("label")).toBe(true);
    expect(set.has("targets.0.target")).toBe(true);
    expect(set.size).toBe(2);
  });
});

const currentInput: PolicyInput = {
  dailySpendWeiCap: 10n ** 18n, // 1 ether
  maxSlippageBps: 0,
  expiresAt: BigInt(Math.floor(Date.UTC(2027, 0, 1) / 1000)),
  paused: false,
  targets: [
    {
      target: "0xA1601891Da4b60c9311B3A024e3E03C5136460e4",
      selectors: [
        {
          selector: "0xa9059cbb",
          tier: 0,
          valueCapPerCall: 0n,
          delaySeconds: 0,
        },
        {
          selector: "0x12345678",
          tier: 0,
          valueCapPerCall: 5n * 10n ** 17n, // 0.5 ether
          delaySeconds: 0,
        },
      ],
    },
  ],
};

const helpers = {
  fmtWeiForDraft: (wei: bigint) => (wei === 0n ? "0" : wei.toString()),
  expiresToISO: (e: bigint) => new Date(Number(e) * 1000).toISOString(),
  selectorToDraftString: (s: `0x${string}`) => s.toLowerCase(),
  tierName: (t: number): "IMMEDIATE" | "DELAYED" | "VETO_REQUIRED" =>
    t === 1 ? "DELAYED" : t === 2 ? "VETO_REQUIRED" : "IMMEDIATE",
};

describe("patchDraftForPartialCompile", () => {
  it("reverts a single invalid selector cap back to the on-chain value", () => {
    const errorPaths = new Set(["targets.0.selectors.1.valueCapPerCall"]);
    const patched = patchDraftForPartialCompile(
      baseDraft,
      currentInput,
      errorPaths,
      helpers,
    );
    // The invalid selector cap is replaced with the current on-chain value.
    expect(patched.targets[0].selectors[1].valueCapPerCall).toBe(
      (5n * 10n ** 17n).toString(),
    );
    // The other (valid) selector is untouched.
    expect(patched.targets[0].selectors[0].valueCapPerCall).toBe("0");
    // Scalars unchanged.
    expect(patched.dailySpendWeiCap).toBe("1 ether");
  });

  it("reverts a scalar daily cap when its path errors", () => {
    const errorPaths = new Set(["dailySpendWeiCap"]);
    const draft: PolicyDraft = { ...baseDraft, dailySpendWeiCap: "" };
    const patched = patchDraftForPartialCompile(
      draft,
      currentInput,
      errorPaths,
      helpers,
    );
    expect(patched.dailySpendWeiCap).toBe((10n ** 18n).toString());
  });

  it("falls back to a default selector when no current counterpart exists", () => {
    const draft: PolicyDraft = {
      ...baseDraft,
      targets: [
        {
          target: baseDraft.targets[0].target,
          selectors: [
            {
              // A brand-new selector added by the user with empty signature.
              selector: "",
              tier: "IMMEDIATE",
              valueCapPerCall: "0",
              delaySeconds: 0,
            },
          ],
        },
      ],
    };
    const slimCurrent: PolicyInput = { ...currentInput, targets: [{
      target: currentInput.targets[0].target,
      selectors: [], // no selector at index 0 in current
    }]};
    const patched = patchDraftForPartialCompile(
      draft,
      slimCurrent,
      new Set(["targets.0.selectors.0.selector"]),
      helpers,
    );
    // Substituted with the known-good default so a downstream compile still parses.
    expect(patched.targets[0].selectors[0].selector).toBe(
      "transfer(address,uint256)",
    );
  });

  it("keeps untouched valid fields verbatim", () => {
    const patched = patchDraftForPartialCompile(
      baseDraft,
      currentInput,
      new Set(),
      helpers,
    );
    expect(patched).toEqual(baseDraft);
  });

  it("reverts a target address when it errors", () => {
    const draft: PolicyDraft = {
      ...baseDraft,
      targets: [
        {
          ...baseDraft.targets[0],
          target: "not-an-address",
        },
      ],
    };
    const patched = patchDraftForPartialCompile(
      draft,
      currentInput,
      new Set(["targets.0.target"]),
      helpers,
    );
    expect(patched.targets[0].target).toBe(currentInput.targets[0].target);
  });
});
