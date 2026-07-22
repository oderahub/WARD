// Intent encoding parity test.
//
// This test pins the TypeScript `Intent` interface (sdk/src/types.ts) to the
// Solidity `Intent` struct (contracts/src/PolicyTypes.sol) through the only
// artifact both sides actually share at runtime: the ABI-encoded wire bytes
// that viem produces.
//
// HOW THIS TEST GUARDS PARITY:
//
//   - `tsTupleSpec` below is a HAND-MIRROR of the TS Intent interface. If
//     anyone reorders, renames, retypes, adds, or removes a field in
//     sdk/src/types.ts, they MUST also update `tsTupleSpec` in this test,
//     or these assertions will fail. That friction is intentional.
//
//   - `abiTupleSpec` is sliced directly out of the auto-generated
//     SENTRY_ORACLE_ABI (extracted from PolicyTypes.sol via
//     sdk/scripts/extract-abis.ts). If anyone edits PolicyTypes.sol and
//     re-runs extract-abis, the resulting drift will fail these assertions
//     unless `tsTupleSpec` is updated to match.
//
// Why a hand-mirror and not a type-derived spec? viem's AbiParameters spec
// uses string type tags ("uint256", "bytes4") that don't appear in the TS
// interface (which uses bigint, Hex). A type-level derivation would be
// lossy. A hand-mirror is honest about the boundary.
//
// Why not a committed hex fixture? A fixture is a third artifact that
// itself silently drifts and needs regenerating. Round-tripping viem
// against the ABI it ships with proves direct shape parity instead.

import { describe, it, expect } from "vitest";
import {
  encodeAbiParameters,
  decodeAbiParameters,
  type AbiParameter,
} from "viem";
import { SENTRY_ORACLE_ABI } from "../src/abi.js";
import type { Intent } from "../src/types.js";

// (1) Literal mirror of the TS Intent interface, in declared field order.
//     Update this if you change sdk/src/types.ts Intent.
const tsTupleSpec = [
  { name: "agentId", type: "uint256" },
  { name: "requestId", type: "uint256" },
  { name: "target", type: "address" },
  { name: "selector", type: "bytes4" },
  { name: "data", type: "bytes" },
  { name: "value", type: "uint256" },
  { name: "promptHash", type: "bytes32" },
  { name: "taskClass", type: "uint8" },
] as const satisfies readonly { name: string; type: string }[];

// (2) ABI tuple spec sliced out of the auto-generated Solidity ABI.
function getAbiIntentComponents(): readonly AbiParameter[] {
  const checkIntent = SENTRY_ORACLE_ABI.find(
    (item) => item.type === "function" && item.name === "checkIntent",
  );
  if (!checkIntent || checkIntent.type !== "function") {
    throw new Error("checkIntent not found in SENTRY_ORACLE_ABI");
  }
  const intentParam = checkIntent.inputs[1];
  if (
    !intentParam ||
    intentParam.type !== "tuple" ||
    !("components" in intentParam) ||
    !intentParam.components
  ) {
    throw new Error("checkIntent.inputs[1] is not a tuple with components");
  }
  return intentParam.components as readonly AbiParameter[];
}

const abiTupleSpec = getAbiIntentComponents();

// Sample Intent values chosen so any field-pair swap of compatible types
// (e.g. agentId <-> requestId, both uint256) produces different output bytes.
const sampleIntent: Intent = {
  agentId: 7n,
  requestId: 99n,
  target: "0x1111111111111111111111111111111111111111",
  selector: "0xaabbccdd",
  data: "0xdeadbeef",
  value: 12345n,
  promptHash:
    "0x2222222222222222222222222222222222222222222222222222222222222222",
  taskClass: 3,
};

// Tuple form viem expects (positional, in field-declaration order).
const intentTuple = [
  sampleIntent.agentId,
  sampleIntent.requestId,
  sampleIntent.target,
  sampleIntent.selector,
  sampleIntent.data,
  sampleIntent.value,
  sampleIntent.promptHash,
  sampleIntent.taskClass,
] as const;

describe("Intent TS<->Solidity encoding parity", () => {
  it("ABI tuple has the same number of components as the TS mirror", () => {
    expect(abiTupleSpec.length).toBe(tsTupleSpec.length);
  });

  it("ABI tuple field names match the TS mirror, in order", () => {
    for (let i = 0; i < tsTupleSpec.length; i++) {
      expect(abiTupleSpec[i]!.name).toBe(tsTupleSpec[i]!.name);
    }
  });

  it("ABI tuple field types match the TS mirror, in order", () => {
    for (let i = 0; i < tsTupleSpec.length; i++) {
      expect(abiTupleSpec[i]!.type).toBe(tsTupleSpec[i]!.type);
    }
  });

  it("encodes to identical bytes via TS-mirror spec and ABI spec", () => {
    const tsBytes = encodeAbiParameters(
      [{ type: "tuple", components: tsTupleSpec as readonly AbiParameter[] }],
      [intentTuple],
    );
    const solBytes = encodeAbiParameters(
      [{ type: "tuple", components: abiTupleSpec }],
      [intentTuple],
    );
    expect(tsBytes).toBe(solBytes);
  });

  it("round-trips: decoding the ABI-spec bytes returns the original fields", () => {
    const encoded = encodeAbiParameters(
      [{ type: "tuple", components: abiTupleSpec }],
      [intentTuple],
    );
    const [decoded] = decodeAbiParameters(
      [{ type: "tuple", components: abiTupleSpec }],
      encoded,
    ) as readonly [
      {
        agentId: bigint;
        requestId: bigint;
        target: string;
        selector: string;
        data: string;
        value: bigint;
        promptHash: string;
        taskClass: number;
      },
    ];

    expect(decoded.agentId).toBe(sampleIntent.agentId);
    expect(decoded.requestId).toBe(sampleIntent.requestId);
    expect(decoded.target.toLowerCase()).toBe(sampleIntent.target.toLowerCase());
    expect(decoded.selector.toLowerCase()).toBe(
      sampleIntent.selector.toLowerCase(),
    );
    expect(decoded.data.toLowerCase()).toBe(sampleIntent.data.toLowerCase());
    expect(decoded.value).toBe(sampleIntent.value);
    expect(decoded.promptHash.toLowerCase()).toBe(
      sampleIntent.promptHash.toLowerCase(),
    );
    expect(decoded.taskClass).toBe(sampleIntent.taskClass);
  });
});
