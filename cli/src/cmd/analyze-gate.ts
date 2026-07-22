import { readFileSync, existsSync, writeSync } from "node:fs";
import kleur from "kleur";

export interface GateFinding {
  severity: "warn";
  file: string;
  line: number;
  function: string;
  message: string;
}

export interface AnalyzeGateOptions {
  json?: boolean;
}

export interface AnalyzeGateResult {
  ok: boolean;
  findings: GateFinding[];
}

function writeJson(value: unknown): void {
  writeSync(1, `${JSON.stringify(value, null, 2)}\n`);
}

/** Conservative static analyzer for ungated dispatches in Ward agent contracts. */
export function analyzeGate(filePath: string, source: string): GateFinding[] {
  const stripped = stripCommentsAndStrings(source);
  const functions = extractFunctions(stripped);
  const findings: GateFinding[] = [];

  for (const fn of functions) {
    if (fn.isPure || fn.isView) continue;
    if (fn.modifiers.includes("onlyOwner")) continue;

    const body = stripped.slice(fn.bodyStart, fn.bodyEnd);
    const dispatchOffset = findDispatch(body);
    if (dispatchOffset < 0) continue;

    const preceding = body.slice(0, dispatchOffset);
    if (containsGate(preceding)) continue;

    // A dispatch through WardCall is already guarded.
    const dispatchSnippet = body.slice(dispatchOffset, Math.min(body.length, dispatchOffset + 200));
    if (/WardCall\s*\.\s*(check|guardedCall)\s*\(/.test(dispatchSnippet)) continue;

    const absOffset = fn.bodyStart + dispatchOffset;
    const line = lineOf(stripped, absOffset);
    findings.push({
      severity: "warn",
      file: filePath,
      line,
      function: fn.name,
      message: `dispatch in ${fn.name}(...) is not preceded by _gate(...) or WardCall.check(...)`,
    });
  }

  return findings;
}

export async function analyzeGateCmd(path: string, opts: AnalyzeGateOptions = {}): Promise<void> {
  if (!existsSync(path)) {
    if (opts.json) {
      writeJson({ ok: false, error: `file not found: ${path}`, findings: [] });
    } else {
      console.error(kleur.red(`analyze:gate: file not found: ${path}`));
    }
    process.exit(2);
  }

  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (e) {
    if (opts.json) {
      writeJson({ ok: false, error: (e as Error).message, findings: [] });
    } else {
      console.error(kleur.red(`analyze:gate: cannot read ${path}: ${(e as Error).message}`));
    }
    process.exit(2);
  }

  let findings: GateFinding[];
  try {
    findings = analyzeGate(path, source);
  } catch (e) {
    if (opts.json) {
      writeJson({ ok: false, error: (e as Error).message, findings: [] });
    } else {
      console.error(kleur.red(`analyze:gate: parse error in ${path}: ${(e as Error).message}`));
    }
    process.exit(2);
  }

  const result: AnalyzeGateResult = { ok: findings.length === 0, findings };

  if (opts.json) {
    writeJson(result);
  } else {
    console.log(kleur.bold().cyan("# ward analyze:gate"));
    if (findings.length === 0) {
      console.log(kleur.green("  OK · every dispatch is gated"));
    } else {
      for (const f of findings) {
        console.log(kleur.yellow(`${f.file}:${f.line} WARN ${f.function} ${f.message}`));
      }
    }
  }

  if (findings.length > 0) process.exit(1);
}

/** Preserve offsets while removing comments and string contents. */
function stripCommentsAndStrings(src: string): string {
  const out = src.split("");
  let i = 0;
  while (i < out.length) {
    const c = out[i];
    const n = out[i + 1];
    if (c === "/" && n === "/") {
      while (i < out.length && out[i] !== "\n") {
        out[i] = " ";
        i += 1;
      }
      continue;
    }
    if (c === "/" && n === "*") {
      while (i < out.length && !(out[i] === "*" && out[i + 1] === "/")) {
        if (out[i] !== "\n") out[i] = " ";
        i += 1;
      }
      if (i < out.length) {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      i += 1;
      while (i < out.length && out[i] !== quote) {
        if (out[i] === "\\" && i + 1 < out.length) {
          if (out[i] !== "\n") out[i] = " ";
          out[i + 1] = out[i + 1] === "\n" ? "\n" : " ";
          i += 2;
          continue;
        }
        if (out[i] !== "\n") out[i] = " ";
        i += 1;
      }
      if (i < out.length) {
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return out.join("");
}

interface FunctionSpan {
  name: string;
  bodyStart: number;
  bodyEnd: number;
  isView: boolean;
  isPure: boolean;
  modifiers: string[];
}

function extractFunctions(src: string): FunctionSpan[] {
  const fns: FunctionSpan[] = [];
  // Anonymous fallback/receive functions do not take a name and won't match.
  const re = /\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const name = m[1]!;
    const parenStart = m.index + m[0].length - 1;
    const parenEnd = matchParen(src, parenStart);
    if (parenEnd < 0) continue;
    const braceStart = src.indexOf("{", parenEnd + 1);
    const semi = src.indexOf(";", parenEnd + 1);
    if (braceStart < 0 || (semi >= 0 && semi < braceStart)) continue;
    const header = src.slice(parenEnd + 1, braceStart);
    const braceEnd = matchBrace(src, braceStart);
    if (braceEnd < 0) continue;
    fns.push({
      name,
      bodyStart: braceStart + 1,
      bodyEnd: braceEnd,
      isView: /\bview\b/.test(header),
      isPure: /\bpure\b/.test(header),
      modifiers: extractModifiers(header),
    });
  }
  return fns;
}

const SOLIDITY_RESERVED = new Set([
  "public",
  "external",
  "internal",
  "private",
  "pure",
  "view",
  "payable",
  "nonpayable",
  "virtual",
  "override",
  "returns",
]);

function extractModifiers(header: string): string[] {
  // Strip `returns(...)` so its inner identifiers don't look like modifiers.
  const cleaned = header.replace(/\breturns\s*\([^)]*\)/g, "");
  const ids = cleaned.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return ids.filter((id) => !SOLIDITY_RESERVED.has(id));
}

function matchParen(src: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < src.length; i += 1) {
    if (src[i] === "(") depth += 1;
    else if (src[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function matchBrace(src: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const DISPATCH_PATTERNS: RegExp[] = [
  // low-level call: foo.call(...), foo.call{value: x}(...)
  /\b[A-Za-z_][A-Za-z0-9_]*\s*\.\s*call\s*(?:\{[^}]*\})?\s*\(/,
  // value-out helpers
  /\bsafeTransferETH\s*\(/,
  /\bsendValue\s*\(/,
];

function findDispatch(body: string): number {
  let earliest = -1;
  for (const re of DISPATCH_PATTERNS) {
    const m = re.exec(body);
    if (m && (earliest < 0 || m.index < earliest)) earliest = m.index;
  }
  return earliest;
}

function containsGate(snippet: string): boolean {
  if (/\b_gate\s*\(/.test(snippet)) return true;
  if (/\bWardCall\s*\.\s*(check|guardedCall)\s*\(/.test(snippet)) return true;
  // Matches the WardAgentBase oracle check pattern.
  if (/\.\s*checkIntent\s*\(/.test(snippet)) return true;
  if (/\.\s*check\s*\(/.test(snippet) && /oracle/i.test(snippet)) return true;
  return false;
}

function lineOf(src: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i += 1) {
    if (src[i] === "\n") line += 1;
  }
  return line;
}
