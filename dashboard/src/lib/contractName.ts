/**
 * Contract-name resolver. Given a (chainId, address), returns a friendly name
 * suitable for AddressChip display.
 *
 * Resolution order (cheapest → most expensive):
 *   1. Local hardcoded map — the Ward oracle + queue addresses. Resolved
 *      synchronously, no I/O.
 *   2. IndexedDB cache — prior explorer lookups within 24h. Survives reloads.
 *   3. Avalanche explorer (Blockscout) — Etherscan-style `getsourcecode`
 *      endpoint. Only consulted when an `explorerApiUrl` is provided. The
 *      Fuji Blockscout instance returns `ContractName` only for verified
 *      contracts; unverified contracts resolve to `source: "unknown"`.
 *
 * Negative caching: unknown / unverified results ARE persisted with a
 * shorter TTL (NEGATIVE_CACHE_TTL_MS, 1h) so AddressChip re-renders do not
 * re-spam the explorer for every viewed-but-unknown address. Positive hits
 * honor the longer POSITIVE_CACHE_TTL_MS (24h).
 *
 * The explorer fetch is best-effort: timeouts, network errors, and HTTP
 * non-200s all degrade to `{ name: null, source: "unknown" }`. The UI shows
 * the truncated hex address in that case.
 */
import type { Address } from "viem";
import { useEffect, useState } from "react";
import {
  loadContractName,
  saveContractName,
  type ContractNameRecord,
} from "./persistence";

export type { ContractNameRecord } from "./persistence";

/**
 * Hardcoded known contracts. Keys are `${chainId}:${lowercaseAddress}`.
 * Mirrors KNOWN_TARGETS in selector-display.ts but keyed by chain so the
 * same address on a different chain wouldn't accidentally inherit the name.
 */
const LOCAL = new Map<string, string>([
  ["43113:0x3c7bf90f243d670a01f512221d9546e09feacc9c", "WardOracle"],
  ["43113:0xfb715a37951fc8dcc920120768e91f7c8bba54c4", "WardQueue"],
  ["43113:0x68d4b045b24f8d1012974b9d34684ca5aed11ddf", "WardOracle (v1)"],
  ["43113:0x98a3f7c38d19edf1dda7e3bc38fa4b935ad590d5", "WardQueue (v1)"],
]);

const POSITIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — names rarely change
const NEGATIVE_CACHE_TTL_MS = 60 * 60 * 1000; // 1h — re-check unknowns hourly so
// newly-verified contracts surface without spamming the explorer on every
// re-render.

export interface ResolveContractNameOpts {
  chainId: number;
  address: Address;
  explorerApiUrl?: string;
}

/**
 * Module-level in-flight promise dedupe. When N AddressChips render the same
 * unknown address concurrently we want ONE explorer fetch, not N. Keyed by
 * `${chainId}:${lowercaseAddress}:${explorerApiUrl ?? "no-explorer"}` so
 * cross-chain lookups don't collide AND a default-off (no-explorer) caller
 * mid-flight doesn't suppress a concurrent opt-in caller that just enabled
 * `?explorerNames=1`. The IDB cache key stays invariant in explorerApiUrl
 * (once a name is fetched, it's a name) — only the in-flight dedupe needs
 * to split on the explorer setting.
 *
 * The promise is removed from the map in a `.finally`, so the next caller
 * after settlement starts fresh (and naturally goes through the IDB cache
 * path first).
 */
const inflight = new Map<string, Promise<ContractNameRecord>>();

/** @internal Test-only helper to reset the dedupe map between tests. */
export function __resetContractNameInflightForTests(): void {
  inflight.clear();
}

function cacheKey(chainId: number, address: Address): string {
  return `${chainId}:${address.toLowerCase()}`;
}

export async function resolveContractName(
  opts: ResolveContractNameOpts,
): Promise<ContractNameRecord> {
  const key =
    cacheKey(opts.chainId, opts.address) +
    ":" +
    (opts.explorerApiUrl ?? "no-explorer");
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = resolveContractNameInner(opts).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

async function resolveContractNameInner(
  opts: ResolveContractNameOpts,
): Promise<ContractNameRecord> {
  const key = cacheKey(opts.chainId, opts.address);
  const local = LOCAL.get(key);
  if (local) {
    return { name: local, verified: true, source: "local", fetchedAtMs: Date.now() };
  }

  const cached = await loadContractName(opts.chainId, opts.address);
  if (cached) {
    const age = Date.now() - cached.fetchedAtMs;
    // Positive hits (name !== null) honor the long 24h TTL.
    // Negative hits (name === null) honor a shorter 1h TTL so newly-verified
    // contracts surface within an hour without forcing a re-fetch on every
    // drawer open.
    const ttl = cached.name !== null ? POSITIVE_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
    if (age < ttl) {
      return cached;
    }
  }

  if (opts.explorerApiUrl) {
    try {
      const url = `${opts.explorerApiUrl}/api?module=contract&action=getsourcecode&address=${opts.address}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const json = (await res.json()) as {
          result?: Array<{ ContractName?: string; SourceCode?: string }>;
        };
        const item = json.result?.[0];
        const rawName = item?.ContractName?.trim();
        const name = rawName ? rawName : null;
        const verified = Boolean(name && item?.SourceCode);
        if (name) {
          const rec: ContractNameRecord = {
            name,
            verified,
            source: "explorer",
            fetchedAtMs: Date.now(),
          };
          await saveContractName(opts.chainId, opts.address, rec);
          return rec;
        }
      }
    } catch {
      // network error or timeout — fall through to unknown
    }
  }

  // Negative caching: persist the unknown result with a shorter TTL (see
  // NEGATIVE_CACHE_TTL_MS on the read side) so repeated AddressChip mounts
  // for the same unverified address don't spam the explorer. The 1h TTL
  // means a newly-verified contract still surfaces within an hour.
  //
  // We persist negatives ONLY when an explorer was actually consulted
  // (opts.explorerApiUrl set). If no explorer was provided (privacy gate
  // off), skip the cache write — otherwise we'd suppress the FIRST real
  // lookup the next time the user enables ?explorerNames=1 for that
  // address within the next hour.
  const rec: ContractNameRecord = {
    name: null,
    verified: false,
    source: "unknown",
    fetchedAtMs: Date.now(),
  };
  if (opts.explorerApiUrl) {
    await saveContractName(opts.chainId, opts.address, rec);
  }
  return rec;
}

export interface UseContractNameResult {
  name: string | null;
  source: ContractNameRecord["source"] | null;
  loading: boolean;
}

/**
 * React hook wrapper around resolveContractName. Re-resolves whenever
 * (chainId, address, explorerApiUrl) changes. Stale-result protection via a
 * `cancelled` flag so a fast remount doesn't overwrite the latest state with
 * an older in-flight resolution.
 */
export function useContractName(
  chainId: number,
  address: Address | undefined,
  explorerApiUrl?: string,
): UseContractNameResult {
  const [state, setState] = useState<UseContractNameResult>({
    name: null,
    source: null,
    loading: Boolean(address),
  });
  useEffect(() => {
    if (!address) {
      setState({ name: null, source: null, loading: false });
      return;
    }
    let cancelled = false;
    setState({ name: null, source: null, loading: true });
    resolveContractName({ chainId, address, explorerApiUrl })
      .then((rec) => {
        if (!cancelled) {
          setState({ name: rec.name, source: rec.source, loading: false });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ name: null, source: "unknown", loading: false });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [chainId, address, explorerApiUrl]);
  return state;
}
