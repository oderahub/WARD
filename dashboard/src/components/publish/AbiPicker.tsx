import { useCallback, useEffect, useRef, useState } from "react";
import { useChainId, usePublicClient } from "wagmi";
import type { PublicClient } from "viem";
import {
  ArrowsClockwise as ArrowsClockwiseIcon,
  MagnifyingGlass as MagnifyingGlassIcon,
} from "@phosphor-icons/react";
import { Alert, Button } from "../primitives";
import type { SelectorDraft, Tier } from "../../lib/policy-draft";
import { ACTIVE_CHAIN_ID } from "../../lib/networks";
import {
  fetchContractFunctions,
  type FunctionInfo,
  type FunctionSource,
  type ProxyInfo,
} from "../../lib/abi-fetch";

interface Props {
  address: string;
  onAddSelectors: (sels: SelectorDraft[]) => void;
  /**
   * Selectors already present on the parent target. Used to suppress
   * duplicate-add when the user re-scans and re-selects an existing entry.
   * Match is by canonical signature (the string we store as `selector`).
   */
  existingSelectors: SelectorDraft[];
}

// NOTE on EIP-55 checksum: we intentionally do NOT enforce checksum on the
// input address. Wallets and explorers commonly normalize addresses to
// lowercase, and rejecting those would block legitimate flows. The on-chain
// contracts treat addresses case-insensitively; lowercasing is sufficient.
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

type State =
  | { kind: "idle" }
  | { kind: "scanning" }
  | {
      kind: "results";
      functions: FunctionInfo[];
      source: FunctionSource;
      proxyInfo?: ProxyInfo;
    }
  | { kind: "error"; message: string };

function tierBadgeClasses(tier: Tier): string {
  switch (tier) {
    case "VETO_REQUIRED":
      return "text-warn border-warn bg-warn/20";
    case "DELAYED":
      return "text-accent border-accent bg-accent/20";
    case "IMMEDIATE":
      return "text-text-muted border-ward-border bg-surface-elev";
  }
}

/**
 * Some signatures recovered from bytecode resolve to multiple plausible
 * names via openchain.xyz. The helper may expose those as an optional
 * `ambiguousCandidates` field; we render a badge + tooltip when present
 * without making the field required on FunctionInfo.
 */
function ambiguousCandidatesOf(fn: FunctionInfo): string[] | undefined {
  const candidates = (fn as FunctionInfo & { ambiguousCandidates?: string[] })
    .ambiguousCandidates;
  return candidates && candidates.length > 1 ? candidates : undefined;
}

export function AbiPicker({ address, onAddSelectors, existingSelectors }: Props) {
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const [state, setState] = useState<State>({ kind: "idle" });
  const [checked, setChecked] = useState<Set<string>>(new Set());
  // Cosmetic cycling through ambiguous candidates per signature. The stored
  // signature (used as `selector` in the draft) is always the first one.
  const [candidateIndex, setCandidateIndex] = useState<Record<string, number>>({});

  // Track the address the active scan was started for. If `address` changes
  // (or another scan kicks off) before the request resolves, we drop the stale
  // response on the floor — without this, switching contracts mid-scan would
  // show stale functions under the new address.
  const inFlightFor = useRef<string | null>(null);

  // Set of normalized addresses we've already auto-scanned in this component
  // lifetime. Keeps the auto-scan effect from re-firing on rerenders, but
  // doesn't interfere with `inFlightFor`'s stale-response protection or with
  // the manual "Retry scan" button.
  const autoScannedFor = useRef<Set<string>>(new Set());

  // Reset on address change so a new contract never inherits the previous
  // contract's results or selected checkboxes.
  useEffect(() => {
    setState({ kind: "idle" });
    setChecked(new Set());
    setCandidateIndex({});
    inFlightFor.current = null;
  }, [address]);

  const addressValid = ADDRESS_RE.test(address);
  const scanDisabled = !addressValid || state.kind === "scanning" || !publicClient;
  const onWrongChain = chainId !== ACTIVE_CHAIN_ID;
  const normalizedAddress = address.toLowerCase();

  const onScan = useCallback(async () => {
    if (!publicClient) {
      setState({ kind: "error", message: "no RPC client available (wagmi public client missing)" });
      return;
    }
    const target = address;
    inFlightFor.current = target;
    setState({ kind: "scanning" });

    const controller = new AbortController();
    const result = await fetchContractFunctions(target, {
      publicClient: publicClient as PublicClient,
      chainId,
      signal: controller.signal,
    });
    if (inFlightFor.current !== target) return;

    if (!result.ok) {
      setState({ kind: "error", message: result.error });
      return;
    }
    if (result.functions.length === 0) {
      setState({ kind: "error", message: "no state-changing functions found" });
      return;
    }
    setState({
      kind: "results",
      functions: result.functions,
      source: result.source,
      proxyInfo: result.proxyInfo,
    });
  }, [address, publicClient, chainId]);

  // Auto-scan when the operator pastes a valid contract address. The manual
  // "Scan functions" / "Retry scan" button stays available, so this just
  // removes a click on the happy path. Dedup by normalized address so
  // rerenders don't re-fire, and skip if we're wrong-chain or already mid-flight.
  useEffect(() => {
    if (!addressValid || !publicClient || onWrongChain) return;
    if (state.kind !== "idle") return;
    if (autoScannedFor.current.has(normalizedAddress)) return;
    autoScannedFor.current.add(normalizedAddress);
    void onScan();
  }, [addressValid, normalizedAddress, publicClient, onWrongChain, state.kind, onScan]);

  function toggle(signature: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(signature)) next.delete(signature);
      else next.add(signature);
      return next;
    });
  }

  function cycleCandidate(signature: string, total: number) {
    setCandidateIndex((prev) => ({
      ...prev,
      [signature]: ((prev[signature] ?? 0) + 1) % total,
    }));
  }

  function onAdd() {
    if (state.kind !== "results") return;
    const existing = new Set(existingSelectors.map((s) => s.selector));
    const drafts: SelectorDraft[] = state.functions
      .filter((fn) => checked.has(fn.signature))
      .filter((fn) => !existing.has(fn.signature))
      .map((fn) => ({
        selector: fn.signature,
        tier: fn.suggestedTier,
        valueCapPerCall: fn.suggestedCapWei,
        delaySeconds: 0,
      }));
    if (drafts.length === 0) return;
    onAddSelectors(drafts);
    setChecked(new Set());
  }

  return (
    <div className="border-t border-ward-border pt-3 mt-3 space-y-2">
      {onWrongChain && (
        <div className="inline-flex items-center gap-1 rounded-full border border-warn bg-warn/20 px-2 py-0.5 text-[11px] text-warn">
          Wallet is on chainId {chainId} — scanning that chain, not Avalanche
        </div>
      )}

      {state.kind === "idle" && (
        <button
          type="button"
          aria-label="Scan ABI for callable functions"
          title="Scan ABI for callable functions"
          className="inline-flex h-8 items-center gap-2 rounded-md border border-ward-border px-3 text-[12px] text-text-muted hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-30 active:scale-[0.98] transition-transform"
          disabled={scanDisabled}
          onClick={onScan}
        >
          <MagnifyingGlassIcon size={14} weight="regular" aria-hidden="true" />
          <span>Scan functions</span>
        </button>
      )}

      {state.kind === "scanning" && (
        <div className="flex items-center gap-2 text-[11px] text-text-subtle">
          <div className="h-3 w-32 animate-pulse rounded bg-surface-elev" />
          <span>Scanning...</span>
        </div>
      )}

      {state.kind === "error" && (
        <>
          <Alert variant="danger" title="Couldn't scan functions">
            {state.message}
          </Alert>
          <button
            type="button"
            aria-label="Retry scanning ABI for callable functions"
            title="Retry scan"
            className="inline-flex h-8 items-center gap-2 rounded-md border border-ward-border px-3 text-[12px] text-text-muted hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-30 active:scale-[0.98] transition-transform"
            disabled={scanDisabled}
            onClick={onScan}
          >
            <ArrowsClockwiseIcon size={14} weight="regular" aria-hidden="true" />
            <span>Retry scan</span>
          </button>
        </>
      )}

      {state.kind === "results" && (
        <>
          <div className="flex items-baseline justify-between">
            <span className="text-[11px] uppercase tracking-wider text-text-subtle">
              auto-discovered functions ({state.functions.length})
            </span>
            <span className="text-[10px] text-text-subtle">
              source: {state.source}
              {state.proxyInfo ? ` via ${state.proxyInfo.kind}` : ""}
              {state.source.startsWith("bytecode") ? " · signatures via openchain.xyz" : ""}
            </span>
          </div>
          {state.proxyInfo && (
            <div className="font-mono text-[11px] text-text-subtle">
              Proxy detected: implementation at {state.proxyInfo.implementation.slice(0, 6)}…
              {state.proxyInfo.implementation.slice(-4)}
            </div>
          )}

          <div className="space-y-1">
            {state.functions.map((fn) => {
              const id = `abipick-${fn.selector}-${fn.signature}`;
              const isChecked = checked.has(fn.signature);
              const candidates = ambiguousCandidatesOf(fn);
              const idx = candidateIndex[fn.signature] ?? 0;
              const displaySignature = candidates ? candidates[idx] : fn.signature;
              return (
                <label
                  key={fn.signature}
                  htmlFor={id}
                  className="flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-surface-elev cursor-pointer rounded-md"
                  onClick={(e) => {
                    if (!candidates) return;
                    // Only cycle when clicking the row chrome, not the checkbox itself.
                    const target = e.target as HTMLElement;
                    if (target.tagName === "INPUT") return;
                    cycleCandidate(fn.signature, candidates.length);
                  }}
                >
                  <input
                    id={id}
                    type="checkbox"
                    className="h-3 w-3 accent-accent"
                    checked={isChecked}
                    onChange={() => toggle(fn.signature)}
                  />
                  <span className="flex-1 font-mono text-xs">{displaySignature}</span>
                  {candidates && (
                    <span
                      className="rounded-full border border-warn bg-warn/20 px-2 py-0.5 text-[11px] text-warn"
                      title={candidates.join("\n")}
                    >
                      ambiguous · {candidates.length} candidates
                    </span>
                  )}
                  <span className="text-[11px] text-text-subtle">{fn.stateMutability}</span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[11px] uppercase ${tierBadgeClasses(
                      fn.suggestedTier,
                    )}`}
                  >
                    {fn.suggestedTier}
                  </span>
                </label>
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            <Button variant="accent" size="sm" disabled={checked.size === 0} onClick={onAdd}>
              Add {checked.size} selected
            </Button>
            <button
              type="button"
              aria-label="Re-scan ABI for callable functions"
              title="Re-scan"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-ward-border text-text-muted hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-30 active:scale-[0.98] transition-transform"
              disabled={scanDisabled}
              onClick={onScan}
            >
              <ArrowsClockwiseIcon size={14} weight="regular" aria-hidden="true" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// TargetRow already imports this as a default; expose both named and default
// so neither call site has to change.
export default AbiPicker;
