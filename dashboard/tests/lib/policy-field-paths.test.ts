import { describe, it, expect } from "vitest";
import { humanizeErrorPath } from "../../src/lib/policy-field-paths";

describe("policy-field-paths.humanizeErrorPath", () => {
  it("returns '(top-level)' for an empty path", () => {
    expect(humanizeErrorPath([])).toBe("(top-level)");
  });

  it("maps top-level fields via FIELD_HUMAN_LABELS", () => {
    expect(humanizeErrorPath(["dailySpendWeiCap"])).toBe(
      "Daily native (AVAX) spend cap",
    );
    expect(humanizeErrorPath(["expiresAt"])).toBe("Valid until");
    expect(humanizeErrorPath(["paused"])).toBe("Paused");
  });

  it("renders a target leaf as 'Contract #N → Address' (1-indexed)", () => {
    expect(humanizeErrorPath(["targets", 0, "target"])).toBe(
      "Contract #1 → Address",
    );
    expect(humanizeErrorPath(["targets", 2, "target"])).toBe(
      "Contract #3 → Address",
    );
  });

  it("renders a selector leaf as 'Contract #N → Function #M → <leaf>'", () => {
    expect(
      humanizeErrorPath(["targets", 1, "selectors", 0, "valueCapPerCall"]),
    ).toBe("Contract #2 → Function #1 → Per-call native cap");
    expect(
      humanizeErrorPath(["targets", 0, "selectors", 0, "tier"]),
    ).toBe("Contract #1 → Function #1 → Approval mode");
    expect(
      humanizeErrorPath(["targets", 0, "selectors", 1, "selector"]),
    ).toBe("Contract #1 → Function #2 → Function signature");
    expect(
      humanizeErrorPath(["targets", 3, "selectors", 4, "delaySeconds"]),
    ).toBe("Contract #4 → Function #5 → Delay");
  });

  it("renders a bare target index as 'Contract #N'", () => {
    expect(humanizeErrorPath(["targets", 0])).toBe("Contract #1");
  });

  it("renders a bare selector index as 'Contract #N → Function #M'", () => {
    expect(humanizeErrorPath(["targets", 0, "selectors", 2])).toBe(
      "Contract #1 → Function #3",
    );
  });

  it("falls back to a dot-joined raw path for unknown shapes", () => {
    expect(humanizeErrorPath(["mysteryField"])).toBe("mysteryField");
    expect(humanizeErrorPath(["targets", 0, "unknownLeaf"])).toBe(
      "targets.0.unknownLeaf",
    );
    expect(
      humanizeErrorPath(["targets", 0, "selectors", 0, "unknownLeaf"]),
    ).toBe("targets.0.selectors.0.unknownLeaf");
  });
});
