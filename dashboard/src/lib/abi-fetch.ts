import { autoload, loaders } from "@shazow/whatsabi";
import { toFunctionSelector, type Hex, type PublicClient } from "viem";

/**
 * Function surface of a contract that the policy author may want to govern.
 *
 * Selectors are derived from the function name + canonical input types. When
 * the upstream ABI came from bytecode disassembly the signature is best-effort
 * (recovered from openchain.xyz's 4byte database), so the human-readable name
 * may be wrong or missing. We always emit a stable 4-byte selector regardless.
 *
 * `ambiguousCandidates` is populated when openchain returns more than one
 * signature for the same 4-byte selector. The chosen `signature` is the first
 * candidate; the full list (including the chosen one) is exposed here so the
 * UI can warn the policy author that the name may be misleading.
 */
export type FunctionSource =
  | "verified"
  | "bytecode"
  | "verified-via-proxy"
  | "bytecode-via-proxy";

export type ProxyKind = "eip1967" | "beacon" | "eip1167";

export interface ProxyInfo {
  kind: ProxyKind;
  implementation: `0x${string}`;
  original: `0x${string}`;
}

export interface FunctionInfo {
  selector: `0x${string}`;
  signature: string;
  stateMutability: "pure" | "view" | "nonpayable" | "payable";
  suggestedTier: "IMMEDIATE" | "DELAYED" | "VETO_REQUIRED";
  suggestedCapWei: string;
  source: FunctionSource;
  ambiguousCandidates?: string[];
}

export type FetchResult =
  | {
      ok: true;
      functions: FunctionInfo[];
      source: FunctionSource;
      proxyInfo?: ProxyInfo;
    }
  | { ok: false; error: string };

interface FetchOpts {
  publicClient: PublicClient;
  chainId: number;
  signal?: AbortSignal;
}

/** Function names that touch privileged state and should require a veto. */
const VETO_NAME_REGEX =
  /^(upgrade|pause|unpause|withdraw|migrate|destroy|renounceOwnership|transferOwnership|acceptOwnership)/i;
/**
 * setX setters need a veto, but only when "set" is followed by an UpperCase
 * letter. "settle" must NOT match. Plain ASCII check, no unicode classes.
 */
const SET_REGEX = /^set[A-Z]/;

function suggestTier(
  name: string,
  stateMutability: FunctionInfo["stateMutability"],
): { tier: FunctionInfo["suggestedTier"]; capWei: string } {
  if (stateMutability === "payable") return { tier: "VETO_REQUIRED", capWei: "0" };
  if (SET_REGEX.test(name) || VETO_NAME_REGEX.test(name)) {
    return { tier: "VETO_REQUIRED", capWei: "0" };
  }
  return { tier: "IMMEDIATE", capWei: "0" };
}

function buildSignature(name: string, inputs: ReadonlyArray<{ type: string }>): string {
  return `${name}(${inputs.map((i) => i.type).join(",")})`;
}

// Standard EIP-1967 storage slots. Values are fixed by the spec
// (keccak256("eip1967.proxy.implementation") - 1, etc.) so we hardcode them.
const EIP1967_IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;
const EIP1967_BEACON_SLOT =
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50" as const;

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

const BEACON_ABI = [
  {
    type: "function",
    name: "implementation",
    inputs: [],
    outputs: [{ type: "address" }],
    stateMutability: "view",
  },
] as const;

function addressFromSlot(slot: string | null | undefined): `0x${string}` | null {
  if (!slot || typeof slot !== "string") return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(slot)) return null;
  const addr = ("0x" + slot.slice(-40)).toLowerCase() as `0x${string}`;
  if (addr === ZERO_ADDR) return null;
  return addr;
}

/**
 * Detect proxy patterns and resolve to the implementation address.
 *
 * Order: EIP-1967 impl slot, then EIP-1967 beacon slot (+ beacon.implementation()),
 * then EIP-1167 minimal-proxy bytecode signature. First hit wins. Order matters
 * because EIP-1167 clones have no SLOAD — the EIP-1967 slot is always empty for
 * them — so checking EIP-1967 first never false-positives on clones.
 *
 * Every RPC call is wrapped in try/catch — a failing storage read or revert
 * means "not this kind of proxy", not a hard error. Callers should treat null
 * results as "scan the original address as-is".
 *
 * KNOWN LIMITATIONS (acceptable for v1, callers should be aware):
 * - **Single-level resolution only.** If the resolved implementation is itself
 *   another proxy (proxy-of-proxy, rare), we scan the intermediate shell and
 *   surface its functions, not the eventual target. Bound-recurse to depth 2-3
 *   if this becomes a real-world problem.
 * - **EIP-2535 Diamond proxies are NOT detected.** Diamonds dispatch via
 *   `facets()` / `facetFunctionSelectors()` rather than a storage slot — pasting
 *   a diamond address surfaces only `diamondCut` / fallback, not the facets.
 *   Detecting diamonds requires calling the loupe interface; deferred.
 * - **EIP-1167 variants** (push-optimized clones produced by some OZ Clones
 *   versions / Solidity compiler outputs) use slightly different bytecode
 *   prefixes (e.g. `0x3d602d80…`). Only the canonical 45-byte form is matched.
 */
export async function resolveProxyTarget(
  address: string,
  publicClient: PublicClient,
): Promise<{ implementation: `0x${string}` | null; proxyKind: ProxyKind | null }> {
  const addr = address as `0x${string}`;

  // (a) EIP-1967 implementation slot.
  try {
    const slot = await publicClient.getStorageAt({ address: addr, slot: EIP1967_IMPL_SLOT });
    const impl = addressFromSlot(slot);
    if (impl) return { implementation: impl, proxyKind: "eip1967" };
  } catch {
    // fall through
  }

  // (b) EIP-1967 beacon slot -> beacon.implementation().
  try {
    const beaconSlot = await publicClient.getStorageAt({
      address: addr,
      slot: EIP1967_BEACON_SLOT,
    });
    const beacon = addressFromSlot(beaconSlot);
    if (beacon) {
      try {
        const impl = (await publicClient.readContract({
          address: beacon,
          abi: BEACON_ABI,
          functionName: "implementation",
        })) as `0x${string}`;
        if (impl && impl.toLowerCase() !== ZERO_ADDR) {
          return { implementation: impl.toLowerCase() as `0x${string}`, proxyKind: "beacon" };
        }
      } catch {
        // beacon present but unreadable — give up on beacon path
      }
    }
  } catch {
    // fall through
  }

  // (c) EIP-1167 minimal proxy. Bytecode is exactly 45 bytes:
  //     0x363d3d373d3d3d363d73 <20-byte impl> 5af43d82803e903d91602b57fd5bf3
  try {
    const code = (await publicClient.getCode({ address: addr })) as Hex | undefined;
    if (code && code.length === 92) {
      const lower = code.toLowerCase();
      if (lower.startsWith("0x363d3d373d3d3d363d73")) {
        const impl = ("0x" + lower.slice(22, 62)) as `0x${string}`;
        if (impl !== ZERO_ADDR) {
          return { implementation: impl, proxyKind: "eip1167" };
        }
      }
    }
  } catch {
    // fall through
  }

  return { implementation: null, proxyKind: null };
}

/**
 * Fetch the writable function surface of `address` on the chain identified by
 * `opts.chainId`. The publicClient must already be bound to that same chain —
 * we don't double-check, but a mismatch will silently return empty bytecode
 * and a misleading "verified=false" result.
 *
 * 3-tier fallback (delegated to whatsabi.autoload):
 *   1. Verified ABI from Sourcify (per `chainId`).
 *   2. Bytecode disassembly to recover 4-byte selectors.
 *   3. openchain.xyz signature lookup to name those selectors. When openchain
 *      returns multiple candidates for one selector, all are surfaced via
 *      `FunctionInfo.ambiguousCandidates` so the UI can flag the collision.
 *
 * View / pure functions are filtered out at the top of the per-function loop —
 * Ward policies only cover state-changing calls. Each remaining function
 * gets a suggested tier heuristic the caller can override before publishing.
 */
export async function fetchContractFunctions(
  address: string,
  opts: FetchOpts,
): Promise<FetchResult> {
  try {
    // Resolve proxy first so the autoload runs against the implementation,
    // not the proxy shell. Without this, mainnet ERC20 proxies (USDC etc.)
    // would surface upgradeTo/admin instead of transfer/approve.
    const proxy = await resolveProxyTarget(address, opts.publicClient);
    const scanAddress = proxy.implementation ?? address;

    const result = await autoload(scanAddress, {
      provider: opts.publicClient,
      abiLoader: new loaders.SourcifyABILoader({ chainId: opts.chainId }),
      signatureLookup: new loaders.OpenChainSignatureLookup(),
    });

    if (opts.signal?.aborted) {
      return { ok: false, error: "aborted" };
    }

    const loadedFromName = result.abiLoadedFrom?.name ?? "";
    const baseSource: "verified" | "bytecode" = /sourcify|etherscan/i.test(loadedFromName)
      ? "verified"
      : "bytecode";
    const source: FunctionSource = proxy.proxyKind
      ? (`${baseSource}-via-proxy` as FunctionSource)
      : baseSource;

    const functions: FunctionInfo[] = [];
    for (const item of result.abi) {
      // Filter view/pure here, exactly once, before any other work. The
      // suggestTier heuristic relies on this — payable funcs can't slip
      // through as "view" and view funcs can't slip through to tier logic.
      if (item.type !== "function") continue;
      const stateMutability = (item.stateMutability ?? "nonpayable") as FunctionInfo["stateMutability"];
      if (stateMutability === "view" || stateMutability === "pure") continue;

      const name = item.name ?? "";
      const inputs = (item.inputs ?? []) as ReadonlyArray<{ type: string }>;
      const signature = buildSignature(name, inputs);

      let selector: `0x${string}`;
      if (item.selector && /^0x[0-9a-fA-F]{8}$/.test(item.selector)) {
        selector = item.selector.toLowerCase() as `0x${string}`;
      } else {
        try {
          selector = toFunctionSelector(signature);
        } catch {
          // Recovered signatures from bytecode can be malformed (e.g. unknown
          // selector with no name). Skip rather than crash the whole listing.
          continue;
        }
      }

      // whatsabi populates `sigAlts` with extra openchain candidates when the
      // selector collides. The chosen one is in `sig`; the alternates are in
      // `sigAlts`. We expose the full list (chosen first) so the UI can warn.
      const sig = (item as { sig?: string }).sig;
      const sigAlts = (item as { sigAlts?: string[] }).sigAlts;
      const ambiguousCandidates =
        sigAlts && sigAlts.length > 0 && sig ? [sig, ...sigAlts] : undefined;

      const { tier, capWei } = suggestTier(name, stateMutability);
      functions.push({
        selector,
        signature,
        stateMutability,
        suggestedTier: tier,
        suggestedCapWei: capWei,
        source,
        ...(ambiguousCandidates ? { ambiguousCandidates } : {}),
      });
    }

    const proxyInfo: ProxyInfo | undefined =
      proxy.proxyKind && proxy.implementation
        ? {
            kind: proxy.proxyKind,
            implementation: proxy.implementation,
            original: address as `0x${string}`,
          }
        : undefined;

    return proxyInfo
      ? { ok: true, functions, source, proxyInfo }
      : { ok: true, functions, source };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

// WardAgentBase derivatives expose their immutable target via a view named
// after the role: the canonical CounterAgent example has counter(); other
// agents will expose router() / tokenIn() / echoTarget() / etc. There's no
// shared interface — the ABI itself is the source of truth. We enumerate
// view/pure parameter-less functions that return a single address and let the
// caller readContract each one to recover the target addresses.
//
// Kept as a sibling export rather than widening fetchContractFunctions so the
// existing return type doesn't grow optional fields that 99% of callers will
// never touch.
export interface AddressViewInfo {
  /** Function name as it appears in the ABI (e.g. `"counter"`, `"router"`). */
  name: string;
  /** 4-byte selector for the parameter-less getter. */
  selector: `0x${string}`;
  /** Provenance — verified ABI vs bytecode disassembly, with / without proxy. */
  source: FunctionSource;
}

export type AddressViewsResult =
  | { ok: true; views: AddressViewInfo[]; source: FunctionSource; proxyInfo?: ProxyInfo }
  | { ok: false; error: string };

/**
 * Enumerate parameter-less view/pure functions on `address` that return a
 * single `address`. Same proxy-resolution + ABI-loading path as
 * `fetchContractFunctions`, different filter:
 *   - `stateMutability` ∈ {view, pure}
 *   - `inputs.length === 0`
 *   - `outputs.length === 1`
 *   - `outputs[0].type === "address"`
 *
 * Overloaded same-name views are returned as separate entries; the selector
 * is computed from the canonical signature so each one is uniquely keyed.
 */
export async function fetchContractAddressViews(
  address: string,
  opts: FetchOpts,
): Promise<AddressViewsResult> {
  try {
    const proxy = await resolveProxyTarget(address, opts.publicClient);
    const scanAddress = proxy.implementation ?? address;

    const result = await autoload(scanAddress, {
      provider: opts.publicClient,
      abiLoader: new loaders.SourcifyABILoader({ chainId: opts.chainId }),
      signatureLookup: new loaders.OpenChainSignatureLookup(),
    });

    if (opts.signal?.aborted) {
      return { ok: false, error: "aborted" };
    }

    const loadedFromName = result.abiLoadedFrom?.name ?? "";
    const baseSource: "verified" | "bytecode" = /sourcify|etherscan/i.test(loadedFromName)
      ? "verified"
      : "bytecode";
    const source: FunctionSource = proxy.proxyKind
      ? (`${baseSource}-via-proxy` as FunctionSource)
      : baseSource;

    const views: AddressViewInfo[] = [];
    for (const item of result.abi) {
      if (item.type !== "function") continue;
      const stateMutability = (item.stateMutability ?? "nonpayable") as FunctionInfo["stateMutability"];
      if (stateMutability !== "view" && stateMutability !== "pure") continue;

      const inputs = (item.inputs ?? []) as ReadonlyArray<{ type: string }>;
      if (inputs.length !== 0) continue;

      const outputs = (item.outputs ?? []) as ReadonlyArray<{ type: string }>;
      if (outputs.length !== 1) continue;
      if (outputs[0].type !== "address") continue;

      const name = item.name ?? "";
      if (name.length === 0) continue;
      const signature = buildSignature(name, inputs);

      let selector: `0x${string}`;
      if (item.selector && /^0x[0-9a-fA-F]{8}$/.test(item.selector)) {
        selector = item.selector.toLowerCase() as `0x${string}`;
      } else {
        try {
          selector = toFunctionSelector(signature);
        } catch {
          continue;
        }
      }

      views.push({ name, selector, source });
    }

    // Bytecode-source fallback. whatsabi's bytecode disassembly recovers
    // selectors + (sometimes via openchain) names, but it cannot infer
    // stateMutability or outputs[].type — the strict filter above rejects
    // every candidate. Probe each parameter-less function via eth_call on
    // the ORIGINAL pasted address (not scanAddress: for proxies, view
    // execution must run through the proxy where storage + delegatecall
    // context live). Keep entries that return a 32-byte word with the
    // canonical address-padding shape (upper 12 bytes zero, lower 20 =
    // address). Reverts / non-address-shaped returns skip silently.
    //
    // Gated on `baseSource === "bytecode"` (not `source ===`) so the
    // bytecode-via-proxy variant is covered. Gated on `views.length === 0`
    // so verified-ABI consumers don't pay 20+ eth_calls per discovery.
    if (views.length === 0 && baseSource === "bytecode") {
      const callAddress = address as `0x${string}`;
      for (const item of result.abi) {
        if (item.type !== "function") continue;
        const inputs = (item.inputs ?? []) as ReadonlyArray<{ type: string }>;
        if (inputs.length !== 0) continue;
        const name = item.name ?? "";
        if (name.length === 0) continue;

        let selector: `0x${string}`;
        if (item.selector && /^0x[0-9a-fA-F]{8}$/.test(item.selector)) {
          selector = item.selector.toLowerCase() as `0x${string}`;
        } else {
          try {
            selector = toFunctionSelector(buildSignature(name, inputs));
          } catch {
            continue;
          }
        }

        if (opts.signal?.aborted) return { ok: false, error: "aborted" };

        try {
          const data = await opts.publicClient.call({
            to: callAddress,
            data: selector,
          });
          if (opts.signal?.aborted) return { ok: false, error: "aborted" };
          const ret = data.data;
          if (
            ret &&
            ret.length === 66 &&
            ret.startsWith("0x000000000000000000000000")
          ) {
            views.push({ name, selector, source });
          }
        } catch {
          // Not an address-returning parameter-less getter. Skip silently.
        }
      }
    }

    const proxyInfo: ProxyInfo | undefined =
      proxy.proxyKind && proxy.implementation
        ? {
            kind: proxy.proxyKind,
            implementation: proxy.implementation,
            original: address as `0x${string}`,
          }
        : undefined;

    return proxyInfo
      ? { ok: true, views, source, proxyInfo }
      : { ok: true, views, source };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
