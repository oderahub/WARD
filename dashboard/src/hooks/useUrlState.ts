import { useCallback, useEffect, useState } from "react";
import type { Address, Hex } from "viem";
import { NETWORKS, getNetwork, ACTIVE_CHAIN_ID, AVALANCHE_FUJI_CHAIN_ID } from "../lib/networks";

/**
 * Default Ward deployment for the active chain (Fuji unless
 * VITE_WARD_CHAIN selects another). Each can be overridden via
 * `?rpc=…&oracle=…&queue=…`. Addresses are sourced from the NETWORKS registry
 * so adding a chain doesn't require editing this file.
 */
const DEFAULT_CHAIN_ID = ACTIVE_CHAIN_ID;
const DEFAULT_NETWORK =
  getNetwork(DEFAULT_CHAIN_ID) ?? NETWORKS[AVALANCHE_FUJI_CHAIN_ID];
export const DEFAULT_RPC = DEFAULT_NETWORK.rpc;
export const DEFAULT_ORACLE: Address = DEFAULT_NETWORK.oracleAddress;
export const DEFAULT_QUEUE: Address = DEFAULT_NETWORK.queueAddress;

export type DrawerState =
  | { kind: "exec"; execId: bigint }
  | { kind: "policy"; policyId: Hex }
  | null;

export type TabKind = "queue" | "publish" | "watched" | "watch-wizard";

export type ModeKind = "enforce" | "watch";

export interface UrlState {
  rpc: string;
  oracle: Address;
  queue: Address;
  drawer: DrawerState;
  tab: TabKind;
  mode: ModeKind;
  /** policyId currently being revealed on the Publish tab. Bookmarkable; the
   *  publish-success panel re-renders from cache (or EventStore fallback) when
   *  the user revisits the URL later. */
  revealed: Hex | null;
  /**
   * Off by default to avoid leaking the user's viewed addresses to the
   * Avalanche explorer (each AddressChip would otherwise fire a
   * `getsourcecode` lookup keyed by the address being viewed). Enable
   * per-session via `?explorerNames=1`. With the flag unset, only the
   * hardcoded LOCAL map and the IDB cache populate names; unknown
   * addresses render as their truncated hex.
   */
  explorerNames: boolean;
  setDrawer: (next: DrawerState) => void;
  setTab: (next: TabKind) => void;
  setMode: (next: ModeKind) => void;
  setRevealed: (next: Hex | null) => void;
}

/**
 * Custom event used to broadcast in-tab URL changes. `popstate` only fires for
 * back/forward navigation, so `replaceState` doesn't notify other listeners by
 * itself — we synthesize a `popstate` so every `useUrlState` consumer re-reads.
 */
const URL_CHANGE_EVENT = "popstate";

function readParams(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

function parseDrawer(value: string | null): DrawerState {
  if (!value) return null;
  const idx = value.indexOf(":");
  if (idx <= 0) return null;
  const kind = value.slice(0, idx);
  const rest = value.slice(idx + 1);
  if (!rest) return null;

  if (kind === "exec") {
    try {
      return { kind: "exec", execId: BigInt(rest) };
    } catch {
      return null;
    }
  }
  if (kind === "policy") {
    if (!/^0x[0-9a-fA-F]{64}$/.test(rest)) return null;
    return { kind: "policy", policyId: rest as Hex };
  }
  return null;
}

function serializeDrawer(d: DrawerState): string | null {
  if (!d) return null;
  return d.kind === "exec" ? `exec:${d.execId.toString()}` : `policy:${d.policyId}`;
}

function readAddressParam(params: URLSearchParams, key: string, fallback: Address): Address {
  const v = params.get(key);
  if (v && /^0x[0-9a-fA-F]{40}$/.test(v)) return v as Address;
  return fallback;
}

function readRpc(params: URLSearchParams): string {
  const v = params.get("rpc");
  if (v && (v.startsWith("http://") || v.startsWith("https://") || v.startsWith("ws://") || v.startsWith("wss://"))) {
    return v;
  }
  return DEFAULT_RPC;
}

function parseTab(value: string | null): TabKind {
  if (value === "queue") return "queue";
  if (value === "publish") return "publish";
  if (value === "watched") return "watched";
  if (value === "watch-wizard") return "watch-wizard";
  return "publish";
}

function parseMode(value: string | null): ModeKind {
  return value === "watch" ? "watch" : "enforce";
}

function parseRevealed(value: string | null): Hex | null {
  if (!value) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) return null;
  return value as Hex;
}

function parseExplorerNames(value: string | null): boolean {
  // Strict opt-in: only "1" enables. Anything else (including "true", "yes",
  // empty, missing) stays off so a typo doesn't silently leak addresses.
  return value === "1";
}

/**
 * Build a query-string fragment carrying ONLY the deployment params that
 * differ from the defaults (rpc, oracle, queue, mode). Used by the share-link
 * builder so a recipient lands on the SAME oracle/queue/rpc/mode the sender
 * was using — otherwise a user on a non-default deployment who shares a
 * `?revealed=…` link would have the recipient silently fall back to the
 * Fuji defaults and either render the wrong policy or render "not found".
 *
 * Returns a string starting with `&` (so callers can append it after their
 * own params) when any non-default is set, or `""` when everything matches
 * defaults. Caller is responsible for the leading `?` and their own params.
 *
 * `mode` defaults to "enforce"; we only emit it when set to "watch".
 */
export function serializeDeploymentParams(opts: {
  rpc: string;
  oracle: Address;
  queue: Address;
  mode: ModeKind;
}): string {
  const parts: string[] = [];
  if (opts.rpc !== DEFAULT_RPC) parts.push(`rpc=${encodeURIComponent(opts.rpc)}`);
  if (opts.oracle.toLowerCase() !== DEFAULT_ORACLE.toLowerCase()) {
    parts.push(`oracle=${opts.oracle}`);
  }
  if (opts.queue.toLowerCase() !== DEFAULT_QUEUE.toLowerCase()) {
    parts.push(`queue=${opts.queue}`);
  }
  if (opts.mode === "watch") parts.push("mode=watch");
  return parts.length === 0 ? "" : `&${parts.join("&")}`;
}

function snapshot(): Omit<UrlState, "setDrawer" | "setTab" | "setMode" | "setRevealed"> {
  if (typeof window === "undefined") {
    return {
      rpc: DEFAULT_RPC,
      oracle: DEFAULT_ORACLE,
      queue: DEFAULT_QUEUE,
      drawer: null,
      tab: "queue",
      mode: "enforce",
      revealed: null,
      explorerNames: false,
    };
  }
  const params = readParams();
  return {
    rpc: readRpc(params),
    oracle: readAddressParam(params, "oracle", DEFAULT_ORACLE),
    queue: readAddressParam(params, "queue", DEFAULT_QUEUE),
    drawer: parseDrawer(params.get("drawer")),
    tab: parseTab(params.get("tab")),
    mode: parseMode(params.get("mode")),
    revealed: parseRevealed(params.get("revealed")),
    explorerNames: parseExplorerNames(params.get("explorerNames")),
  };
}

export function useUrlState(): UrlState {
  const [state, setState] = useState(snapshot);

  useEffect(() => {
    const onChange = () => setState(snapshot());
    window.addEventListener(URL_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(URL_CHANGE_EVENT, onChange);
  }, []);

  const setDrawer = useCallback((next: DrawerState) => {
    const params = readParams();
    const encoded = serializeDrawer(next);
    if (encoded) {
      params.set("drawer", encoded);
    } else {
      params.delete("drawer");
    }
    const qs = params.toString();
    const url = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
    window.history.replaceState(window.history.state, "", url);
    // `replaceState` doesn't fire popstate; synthesize so peers re-read.
    window.dispatchEvent(new PopStateEvent(URL_CHANGE_EVENT));
  }, []);

  const setTab = useCallback((next: TabKind) => {
    const params = readParams();
    if (next === "publish") params.delete("tab");
    else params.set("tab", next);
    // Switching tabs should close any open drawer to avoid mismatched context.
    params.delete("drawer");
    const qs = params.toString();
    const url = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
    window.history.replaceState(window.history.state, "", url);
    window.dispatchEvent(new PopStateEvent(URL_CHANGE_EVENT));
  }, []);

  const setMode = useCallback((next: ModeKind) => {
    const params = readParams();
    if (next === "enforce") params.delete("mode");
    else params.set("mode", next);
    const qs = params.toString();
    const url = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
    window.history.replaceState(window.history.state, "", url);
    window.dispatchEvent(new PopStateEvent(URL_CHANGE_EVENT));
  }, []);

  const setRevealed = useCallback((next: Hex | null) => {
    const params = readParams();
    if (next && /^0x[0-9a-fA-F]{64}$/.test(next)) {
      params.set("revealed", next);
    } else {
      params.delete("revealed");
    }
    const qs = params.toString();
    const url = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
    window.history.replaceState(window.history.state, "", url);
    window.dispatchEvent(new PopStateEvent(URL_CHANGE_EVENT));
  }, []);

  return { ...state, setDrawer, setTab, setMode, setRevealed };
}
