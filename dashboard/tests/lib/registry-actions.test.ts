import { describe, it, expect } from "vitest";

import * as registryActions from "../../src/lib/registry-actions";
import { simulateAndWriteRegisterAgent } from "../../src/lib/registry-actions";

describe("registry-actions module surface", () => {
  it("re-exports simulateAndWriteRegisterAgent from writes.ts", () => {
    // Importing the helper is the contract — if the re-export breaks the
    // test will fail at module load. Spot-check the binding here so a
    // misspelled re-export is caught.
    expect(typeof simulateAndWriteRegisterAgent).toBe("function");
  });

  it("does NOT export a simulateAndWriteRegistryUpdate helper", () => {
    // RegisterStep deliberately always calls register() for both new and
    // same-registrar re-register flows (the registry's register() is
    // idempotent for the original registrar and overwrites every field).
    // A separate update helper was shipped earlier but had zero production
    // callers — it has been removed to keep the registry-actions surface
    // honest. This test guards against accidental re-introduction.
    expect(
      (registryActions as Record<string, unknown>).simulateAndWriteRegistryUpdate,
    ).toBeUndefined();
  });
});
