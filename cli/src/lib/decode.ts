import { decodeFunctionData, type Hex } from "viem";
import { SENTRY_ORACLE_ABI, ERC20_ABI } from "@sentry-somnia/sdk/abi";

// Decode against the CLI's bundled ABIs only; project-specific targets should
// be decoded by caller tooling.
export interface DecodedCall {
  abiSource?: string;
  functionName?: string;
  args?: readonly unknown[];
  selector: Hex;
  raw: Hex;
}

const SOURCES: Array<{ name: string; abi: readonly unknown[] }> = [
  { name: "SentryOracle", abi: SENTRY_ORACLE_ABI },
  { name: "ERC20", abi: ERC20_ABI },
];

export function tryDecode(data: Hex): DecodedCall {
  const selector = (data.length >= 10 ? data.slice(0, 10) : "0x00000000") as Hex;
  for (const src of SOURCES) {
    try {
      const decoded = decodeFunctionData({ abi: src.abi as never, data });
      return {
        abiSource: src.name,
        functionName: decoded.functionName,
        args: decoded.args as readonly unknown[],
        selector,
        raw: data,
      };
    } catch {
    }
  }
  return { selector, raw: data };
}
