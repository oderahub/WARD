/**
 * Agents catalog loader — 2-tier fallback (on-chain → IDB).
 *
 * Tier 1 (on-chain via SDK `findSentryAgents`):
 *   The authoritative source. Calls the SDK helper which walks
 *   `SentryAgentRegistry.agentsPaginated`. Empty result here is still
 *   written through to the cache (an empty snapshot is a fact, not a
 *   failure).
 *
 * Tier 2 (IDB cache, read-only):
 *   Last resort when the on-chain tier failed. Returns whatever was last
 *   written through by Tier 1 along with a `staleAgeMs`.
 *
 * NEVER throws. Every tier failure is captured in `result.errors[]` and a
 * result is always returned — empty if both tiers fail with no cache.
 *
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { isAddress } from "viem";
import type { Address, Hex, PublicClient } from "viem";

import { findSentryAgents } from "@sentry-somnia/sdk";
import { NETWORKS } from "./networks";
import { loadCachedAgents, saveCachedAgents } from "./persistence";

export type AgentsFreshness = "live" | "cached" | "empty";

export interface CatalogAgent {
  agent: Address;
  registrar: Address;
  oracle: Address;
  policyId: Hex;
  name: string;
  metadataURI: string;
  tags: string[];
  updatedAt: bigint;
  active: boolean;
}

export interface AgentsCatalogResult {
  agents: CatalogAgent[];
  freshness: AgentsFreshness;
  source: "chain" | "idb";
  fetchedAtMs: number;
  /** Set only when freshness === 'cached'. */
  staleAgeMs?: number;
  /** Always-present accumulator of tier failures. Empty on the happy path. */
  errors: string[];
}

export interface LoadAgentsCatalogOpts {
  publicClient: PublicClient;
  chainId: number;
  registryAddress: Address;
  /** When true, request only `active: true` agents from the on-chain tier. */
  onlyActive?: boolean;
  signal?: AbortSignal;
}

/**
 * Resolve the SentryAgentRegistry address for a given chain.
 *
 * Precedence: `VITE_SENTRY_AGENT_REGISTRY` (build-time override) → the
 * canonical `NETWORKS[chainId].registryAddress`. On a fresh clone with no
 * env file, this still resolves to the deployed registry so Tier 2 has
 * something to call.
 *
 * Returns `undefined` only if BOTH sources are empty for the given chain;
 * a one-shot console.warn fires per-session to surface that misconfiguration.
 */
let registryWarnedFor: number | undefined;
let registryInvalidWarnedFor: string | undefined;
export function resolveRegistryAddress(chainId: number): Address | undefined {
  const fromEnv = import.meta.env.VITE_SENTRY_AGENT_REGISTRY?.trim();
  if (fromEnv && fromEnv.length > 0) {
    if (isAddress(fromEnv)) return fromEnv as Address;
    if (registryInvalidWarnedFor !== fromEnv) {
      registryInvalidWarnedFor = fromEnv;
      // eslint-disable-next-line no-console
      console.warn(
        `[agents-catalog] VITE_SENTRY_AGENT_REGISTRY="${fromEnv}" is not a valid ` +
          `0x-prefixed 20-byte address; falling back to NETWORKS[chainId].`,
      );
    }
    // fall through to NETWORKS lookup below
  }
  const fromNetworks = NETWORKS[chainId]?.registryAddress;
  if (fromNetworks) return fromNetworks;
  if (registryWarnedFor !== chainId) {
    registryWarnedFor = chainId;
    // eslint-disable-next-line no-console
    console.warn(
      `[agents-catalog] No registry address resolved for chainId=${chainId}. ` +
        `Set VITE_SENTRY_AGENT_REGISTRY or add registryAddress to NETWORKS.`,
    );
  }
  return undefined;
}

const CHAIN_TIMEOUT_MS = 8_000;

type ChainTierResult =
  | { kind: "ok"; agents: CatalogAgent[] }
  | { kind: "error"; message: string };

async function fetchFromChain(
  publicClient: PublicClient,
  registryAddress: Address,
  onlyActive: boolean,
  signal: AbortSignal | undefined,
): Promise<ChainTierResult> {
  // The SDK helper throws ONLY on programmer errors (missing args) — the
  // catalog promises to never throw, so wrap defensively even though we
  // pass both args.
  //
  // viem's http() per-request timeout is per RPC call. findSentryAgents does
  // agentCount() plus one read per page, so a slow RPC could cost roughly
  // 8 * calls before Tier 3 cache is tried. We enforce a single tier-level
  // budget (CHAIN_TIMEOUT_MS) via Promise.race so the catalog returns
  // promptly even if viem keeps spinning on the underlying request.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CHAIN_TIMEOUT_MS);
  const externalAbortListener = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", externalAbortListener, { once: true });
  }

  let tierTimeoutId: ReturnType<typeof setTimeout> | undefined;
  const tierTimeoutPromise = new Promise<never>((_, reject) => {
    tierTimeoutId = setTimeout(
      () => reject(new Error("chain: tier timed out after 8s")),
      CHAIN_TIMEOUT_MS,
    );
  });

  try {
    const result = await Promise.race([
      findSentryAgents({
        publicClient,
        registryAddress,
        onlyActive,
        signal: controller.signal,
      }),
      tierTimeoutPromise,
    ]);
    if (!result.ok) {
      return { kind: "error", message: `chain: ${result.error}` };
    }
    // Materialize tags to mutable string[] (the SDK returns readonly).
    const agents: CatalogAgent[] = result.agents.map((a) => ({
      agent: a.agent,
      registrar: a.registrar,
      oracle: a.oracle,
      policyId: a.policyId,
      name: a.name,
      metadataURI: a.metadataURI,
      tags: [...a.tags],
      updatedAt: a.updatedAt,
      active: a.active,
    }));
    return { kind: "ok", agents };
  } catch (err) {
    return { kind: "error", message: `chain: ${(err as Error).message}` };
  } finally {
    clearTimeout(timeoutId);
    if (tierTimeoutId !== undefined) clearTimeout(tierTimeoutId);
    if (signal) signal.removeEventListener("abort", externalAbortListener);
  }
}

function deserializeCached(
  rec: NonNullable<Awaited<ReturnType<typeof loadCachedAgents>>>,
): CatalogAgent[] {
  return rec.agents.map((a) => ({
    agent: a.agent as Address,
    registrar: a.registrar as Address,
    oracle: a.oracle as Address,
    policyId: a.policyId as Hex,
    name: a.name,
    metadataURI: a.metadataURI,
    tags: [...a.tags],
    updatedAt: BigInt(a.updatedAt),
    active: a.active,
  }));
}

async function safeWriteThrough(
  chainId: number,
  registryAddress: Address,
  agents: CatalogAgent[],
  errors: string[],
): Promise<void> {
  try {
    await saveCachedAgents(chainId, registryAddress, agents, "chain");
  } catch (err) {
    // Write-through failures are non-fatal: the live tier already returned.
    errors.push(`idb-write: ${(err as Error).message}`);
  }
}

export async function loadAgentsCatalog(
  opts: LoadAgentsCatalogOpts,
): Promise<AgentsCatalogResult> {
  const { publicClient, chainId, registryAddress, signal } = opts;
  const onlyActive = opts.onlyActive ?? false;
  const errors: string[] = [];
  const now = () => Date.now();

  const chain = await fetchFromChain(publicClient, registryAddress, onlyActive, signal);
  if (chain.kind === "ok") {
    // Empty array is still a fact — write through and return live.
    await safeWriteThrough(chainId, registryAddress, chain.agents, errors);
    return {
      agents: chain.agents,
      freshness: "live",
      source: "chain",
      fetchedAtMs: now(),
      errors,
    };
  }
  errors.push(chain.message);

  try {
    const cached = await loadCachedAgents(chainId, registryAddress);
    if (cached) {
      const fetchedAt = now();
      return {
        agents: deserializeCached(cached),
        freshness: "cached",
        source: "idb",
        fetchedAtMs: fetchedAt,
        staleAgeMs: fetchedAt - cached.cachedAtMs,
        errors,
      };
    }
  } catch (err) {
    errors.push(`idb-read: ${(err as Error).message}`);
  }

  return {
    agents: [],
    freshness: "empty",
    source: "idb",
    fetchedAtMs: now(),
    errors,
  };
}

export interface UseAgentsCatalogOpts {
  publicClient: PublicClient | null | undefined;
  chainId: number;
  registryAddress: Address | undefined;
  onlyActive?: boolean;
}

export interface UseAgentsCatalogState {
  data: AgentsCatalogResult | null;
  freshness: AgentsFreshness | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * React wrapper. Re-runs when `chainId`/`registryAddress`/`onlyActive`
 * change, and exposes a `refetch()` for the UI's manual refresh button.
 * Aborts the in-flight load when the inputs change or the component unmounts.
 *
 * `publicClient` and `registryAddress` may be null/undefined during initial
 * render; the hook stays in the idle (`isLoading=false, data=null`) state
 * until both are resolved. This avoids a wasted fetch on the first paint
 * before wagmi has provisioned the client.
 */
export function useAgentsCatalog(opts: UseAgentsCatalogOpts): UseAgentsCatalogState {
  const { publicClient, chainId, registryAddress } = opts;
  const onlyActive = opts.onlyActive ?? false;

  const [data, setData] = useState<AgentsCatalogResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [refetchKey, setRefetchKey] = useState(0);

  const acRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!publicClient || !registryAddress) {
      // Inputs not ready yet — stay idle, don't fire.
      return;
    }
    acRef.current?.abort();
    const ac = new AbortController();
    acRef.current = ac;
    setIsLoading(true);
    setError(null);

    let cancelled = false;
    loadAgentsCatalog({
      publicClient,
      chainId,
      registryAddress,
      onlyActive,
      signal: ac.signal,
    })
      .then((result) => {
        if (cancelled || ac.signal.aborted) return;
        setData(result);
        setIsLoading(false);
      })
      .catch((err) => {
        // loadAgentsCatalog promises NEVER to throw; this branch exists only
        // to be defensive against future regressions.
        if (cancelled || ac.signal.aborted) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [publicClient, chainId, registryAddress, onlyActive, refetchKey]);

  const refetch = useCallback(() => {
    setRefetchKey((k) => k + 1);
  }, []);

  return {
    data,
    freshness: data?.freshness ?? null,
    isLoading,
    error,
    refetch,
  };
}
