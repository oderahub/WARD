import { describe, it, expect } from "vitest";
import { policyIdFor } from "../src/oracle-client.js";

describe("oracle-client", () => {
  it("policyIdFor mirrors the on-chain `keccak256(abi.encode(address, bytes32))` derivation", () => {
    // Reference vector computed via `cast call wardOracle policyIdFor(...)` against the
    // live Fuji testnet deployment in CP35.
    const publisher = "0x000000000000000000000000000000000000dEaD" as const;
    const label = ("0x" + "00".repeat(31) + "78") as `0x${string}`; // 0x...78 = ascii 'x'
    const expected = "0x9611a5e450f26b6f4884e44af599629f71281c664507dc84866a88e854375bb4";
    expect(policyIdFor(publisher, label)).toBe(expected);
  });

  it("policyIdFor is deterministic and address-cased-insensitive", () => {
    const a = "0x0a3C305cC7645241AEdE654C75341a3b98aF7d66" as const;
    const aLower = "0x0a3c305cc7645241aede654c75341a3b98af7d66" as const;
    const label = ("0x" + "0".repeat(63) + "1") as `0x${string}`;
    expect(policyIdFor(a, label)).toBe(policyIdFor(aLower, label));
  });

  it("policyIdFor returns different ids for different labels", () => {
    const a = "0x0a3C305cC7645241AEdE654C75341a3b98aF7d66" as const;
    const l1 = ("0x" + "11".repeat(32)) as `0x${string}`;
    const l2 = ("0x" + "22".repeat(32)) as `0x${string}`;
    expect(policyIdFor(a, l1)).not.toBe(policyIdFor(a, l2));
  });
});
