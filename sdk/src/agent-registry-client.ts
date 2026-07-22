import { type Address, type Hex, type PublicClient } from "viem";
import { WARD_AGENT_REGISTRY_ABI } from "./abi.js";

/** Field-for-field mirror of `WardAgentRegistry.Agent`; viem decodes uints as `bigint` and arrays as readonly. */
export interface RegistryAgent {
  agent: Address;
  registrar: Address;
  oracle: Address;
  policyId: Hex;
  name: string;
  metadataURI: string;
  tags: readonly string[];
  updatedAt: bigint;
  active: boolean;
}

type OnchainAgent = RegistryAgent;

export interface FindWardAgentsOpts {
  publicClient: PublicClient;
  registryAddress: Address;
  /** When true, filter out entries where `active === false`. Default false (return all). */
  onlyActive?: boolean;
  /** Page size for `agentsPaginated`. Default 200; clamped to [1, 500]. */
  pageSize?: number;
  /** Abort between page reads; viem does not accept an AbortSignal for the in-flight RPC. */
  signal?: AbortSignal;
}

export type FindWardAgentsResult =
  | { ok: true; registryAddress: Address; agents: RegistryAgent[]; totalCount: bigint; pagesRead: number }
  | { ok: false; error: string; agents?: RegistryAgent[]; pagesRead?: number };

const DEFAULT_PAGE_SIZE = 200;
const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 500;

/** Walk `agentsPaginated(offset, limit)` until `agentCount()` is exhausted. */
export async function findWardAgents(opts: FindWardAgentsOpts): Promise<FindWardAgentsResult> {
  const { publicClient, registryAddress, onlyActive, signal } = opts;
  if (!publicClient) throw new Error("find-ward-agents: publicClient required");
  if (!registryAddress) throw new Error("find-ward-agents: registryAddress required");

  const pageSize = Math.min(Math.max(opts.pageSize ?? DEFAULT_PAGE_SIZE, MIN_PAGE_SIZE), MAX_PAGE_SIZE);

  let totalCount: bigint;
  try {
    totalCount = (await publicClient.readContract({
      address: registryAddress,
      abi: WARD_AGENT_REGISTRY_ABI as never,
      functionName: "agentCount",
    })) as bigint;
  } catch (err) {
    return { ok: false, error: `find-ward-agents: agentCount() reverted: ${(err as Error).message}` };
  }

  if (totalCount === 0n) {
    return { ok: true, registryAddress, agents: [], totalCount: 0n, pagesRead: 0 };
  }

  const collected: RegistryAgent[] = [];
  let pagesRead = 0;
  let offset = 0n;

  while (offset < totalCount) {
    if (signal?.aborted) {
      return { ok: false, error: "find-ward-agents: aborted", agents: collected, pagesRead };
    }

    let page: readonly OnchainAgent[];
    try {
      page = (await publicClient.readContract({
        address: registryAddress,
        abi: WARD_AGENT_REGISTRY_ABI as never,
        functionName: "agentsPaginated",
        args: [offset, BigInt(pageSize)],
      })) as readonly OnchainAgent[];
    } catch (err) {
      return {
        ok: false,
        error: `find-ward-agents: agentsPaginated(${offset},${pageSize}) reverted: ${(err as Error).message}`,
        agents: collected,
        pagesRead,
      };
    }

    pagesRead++;

    // Empty pages before `totalCount` indicate registry state inconsistency, not normal pagination tail.
    if (page.length === 0) {
      return {
        ok: false,
        error: `find-ward-agents: agentsPaginated returned empty page at offset ${offset} with totalCount ${totalCount}`,
        agents: collected,
        pagesRead,
      };
    }

    for (const entry of page) collected.push(entry);
    offset += BigInt(page.length);
  }

  const agents = onlyActive ? collected.filter((a) => a.active) : collected;
  return { ok: true, registryAddress, agents, totalCount, pagesRead };
}
