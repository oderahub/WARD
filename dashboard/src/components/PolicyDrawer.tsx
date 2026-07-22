import { useCallback, useEffect, useMemo, useState } from "react";
import type { Address, Hex } from "viem";
import { formatEther, hexToBytes } from "viem";
import { usePublicClient } from "wagmi";

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useEventStore } from "../hooks/useEventStore";
import { useWallet } from "../hooks/useWallet";
import { useUrlState } from "../hooks/useUrlState";
import { SENTRY_ORACLE_ABI, type PolicyInput, type PolicyMeta, type StoreEvent } from "@sentry-somnia/sdk";
import { somniaTestnet } from "../main";
import { cacheRecoveredPolicy, readPublished } from "../lib/publishedCache";
import { recoverPolicyInputFromChainDeduped } from "../lib/policyRecovery";
import { isAsciiPrintable } from "../lib/policy-draft";
import { formatExpiresAtFull } from "../lib/policy-render";
import { formatSelector, humanizeTier, tierLabel } from "../lib/selector-display";
import { useContractName } from "../lib/contractName";
import { SOMNIA_CHAIN_ID, getNetwork } from "../lib/networks";
import PolicyActions from "./PolicyActions";
import { DrawerHeader } from "./primitives/DrawerHeader";
import { Row, AddressChip, SkeletonLines } from "./primitives";

interface Props {
  policyId: Hex;
  onClose?: () => void;
}

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

// Oracle deployment block on Shannon — mirrors the constant in useEventStore.
// The on-chain calldata recovery scan starts here and walks backward from
// head; the policy can't exist before its oracle did so this is a safe floor.
const ORACLE_DEPLOYMENT_BLOCK = 394474581n;

function truncate(value: string, head = 6, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/**
 * Decode a bytes32 label for display. Strips trailing nulls, attempts UTF-8
 * decode, then defers the printable-ASCII decision to `isAsciiPrintable` from
 * `policy-draft` (same helper as the publish-side schema). Non-printable
 * decodes fall back to raw hex with a tooltip rather than letting mojibake
 * through.
 *
 * The `kind` discriminator drives the React render: `text` is plain, `hex` is
 * rendered with the explanatory tooltip, sentinels ("(none)" / "(empty)") are
 * always safe text.
 */
type DecodedLabel =
  | { kind: "text"; value: string }
  | { kind: "hex"; value: Hex; reason: "non-ascii" | "decode-error" };

export function decodeLabel(label: Hex | undefined): DecodedLabel {
  if (!label) return { kind: "text", value: "(none)" };
  try {
    const bytes = hexToBytes(label);
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end -= 1;
    if (end === 0) return { kind: "text", value: "(empty)" };
    const slice = bytes.slice(0, end);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(slice);
    if (!isAsciiPrintable(decoded)) {
      return { kind: "hex", value: label, reason: "non-ascii" };
    }
    return { kind: "text", value: decoded };
  } catch {
    return { kind: "hex", value: label, reason: "decode-error" };
  }
}

interface PolicyHealth {
  paused: boolean;
  expiresAt: bigint;
}

function eventLabel(e: StoreEvent): string {
  switch (e.type) {
    case "PolicyPublished":
      return "Policy published";
    case "PolicyUpdated":
      return "Policy updated";
    case "OwnershipTransferStarted":
      return "Ownership transfer started";
    case "OwnershipTransferred":
      return "Ownership transferred";
    case "OwnershipTransferCancelled":
      return "Ownership transfer cancelled";
    case "Enqueued":
      return `Enqueued exec #${e.execId.toString()}`;
    case "Dispatched":
      return `Dispatched exec #${e.execId.toString()}`;
    case "Vetoed":
      return `Vetoed exec #${e.execId.toString()}`;
    case "Expired":
      return `Expired exec #${e.execId.toString()}`;
  }
}

function Section({ eyebrow, children }: { eyebrow: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-rule pt-4 mt-4 first:border-t-0 first:pt-0 first:mt-0">
      <div className="mb-3 text-[11px] font-medium uppercase tracking-[0.14em] text-text-muted">
        {eyebrow}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

/**
 * <option>-safe address label. The probe Target dropdown can't render an
 * <AddressChip> directly (option children must be plain text), so this helper
 * mirrors the chip's text layout: `<contract name> · <truncated 0x…>` when a
 * friendly name resolves, otherwise just the truncated hex. Resolution flows
 * through the same useContractName hook AddressChip uses, gated by the same
 * `?explorerNames=1` privacy opt-in, so the two surfaces never disagree.
 */
function ProbeTargetOption({
  address,
  selectorCount,
  value,
}: {
  address: Address;
  selectorCount: number;
  value: number;
}) {
  const { explorerNames } = useUrlState();
  const explorerApiUrl = explorerNames
    ? getNetwork(SOMNIA_CHAIN_ID)?.explorer
    : undefined;
  const { name } = useContractName(SOMNIA_CHAIN_ID, address, explorerApiUrl);
  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
  const head = name ? `${name} · ${short}` : short;
  const fnNoun = selectorCount === 1 ? "fn" : "fns";
  return <option value={value}>{`${head} · ${selectorCount} ${fnNoun}`}</option>;
}

export default function PolicyDrawer({ policyId, onClose }: Props) {
  const { store, snapshotKey } = useEventStore();
  const { address: walletAddress } = useWallet();
  const { setDrawer } = useUrlState();
  const publicClient = usePublicClient();

  // After a successful action via PolicyActions we bump this to re-run the
  // pendingOwner + health fetches without waiting for the next live event tick.
  // The event-store also picks up the write via its watcher, but that round-
  // trips through RPC; this guarantees the drawer reflects the new chain state
  // the instant the receipt mines.
  const [refetchTick, setRefetchTick] = useState(0);
  // Shannon's RPC occasionally returns stale state on the immediate read after
  // a tx receipt. A single delayed retry catches the propagated state without
  // turning this into a polling loop — by the time the timer fires the live
  // watcher has usually bumped snapshotKey anyway, but if it hasn't this is
  // the safety net.
  const [retryTick, setRetryTick] = useState(0);
  const onActionComplete = useCallback(() => {
    setRefetchTick((t) => t + 1);
  }, []);
  useEffect(() => {
    if (refetchTick === 0) return;
    const id = window.setTimeout(() => {
      setRetryTick((t) => t + 1);
    }, 2000);
    return () => window.clearTimeout(id);
  }, [refetchTick]);

  // Policy meta — store-first, then hydrate from oracle if missing.
  // meta.owner is kept current by the SDK via PolicyOwnershipTransferred
  // events (see event-store.applyOwnershipEvent), so we trust it as the
  // primary source of truth. hydratedOwner remains the fallback for policies
  // whose PolicyPublished event lives outside our backfill window.
  const cachedMeta: PolicyMeta | undefined = useMemo(() => {
    if (!store) return undefined;
    return store.getPolicy(policyId);
    // snapshotKey re-runs the memo so we pick up newly seen policies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, policyId, snapshotKey]);

  const [hydratedOwner, setHydratedOwner] = useState<Address | null>(null);
  const [hydrating, setHydrating] = useState(false);
  const [hydrateError, setHydrateError] = useState<string | null>(null);

  useEffect(() => {
    if (!store || cachedMeta || !publicClient) {
      setHydrating(false);
      return;
    }
    let cancelled = false;
    setHydrating(true);
    setHydrateError(null);

    publicClient
      .readContract({
        address: store.oracleClient.address,
        abi: SENTRY_ORACLE_ABI as never,
        functionName: "policyOwner",
        args: [policyId],
      })
      .then((owner) => {
        if (cancelled) return;
        setHydratedOwner(owner as Address);
      })
      .catch((err) => {
        if (cancelled) return;
        setHydrateError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setHydrating(false);
      });

    return () => {
      cancelled = true;
    };
  }, [store, policyId, cachedMeta, publicClient, refetchTick, retryTick]);

  // Pending owner — live chain read, seeded from meta.
  // The event-store tracks pendingOwner via PolicyOwnershipTransfer{Started,
  // Cancelled,Transferred} events on cached PolicyMeta records (the fast
  // path). We still mirror the live `pendingPolicyOwner(policyId)` view here
  // so the drawer works for policies outside backfill, and re-fetch on
  // refetchTick so owner-side actions (transfer/cancel/accept) refresh
  // immediately without waiting for the next live event tick.
  const [livePendingOwner, setLivePendingOwner] = useState<Address | null>(null);
  const [livePendingFetched, setLivePendingFetched] = useState(false);
  useEffect(() => {
    if (!store || !publicClient) return;
    let cancelled = false;
    setLivePendingFetched(false);
    publicClient
      .readContract({
        address: store.oracleClient.address,
        abi: SENTRY_ORACLE_ABI as never,
        functionName: "pendingPolicyOwner",
        args: [policyId],
      })
      .then((next) => {
        if (cancelled) return;
        const nextAddr = next as Address;
        setLivePendingOwner(nextAddr && nextAddr !== ZERO_ADDRESS ? nextAddr : null);
        setLivePendingFetched(true);
      })
      .catch(() => {
        if (cancelled) return;
        // Read errors leave pendingOwner falling back to whatever the
        // event-store has cached on meta.
        setLivePendingFetched(true);
      });
    return () => {
      cancelled = true;
    };
  }, [store, policyId, publicClient, snapshotKey, refetchTick, retryTick]);
  const pendingOwner: Address | null = livePendingFetched
    ? livePendingOwner
    : cachedMeta?.pendingOwner ?? null;

  const [health, setHealth] = useState<PolicyHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [nowSeconds, setNowSeconds] = useState<bigint>(() => BigInt(Math.floor(Date.now() / 1000)));

  useEffect(() => {
    const id = window.setInterval(() => {
      setNowSeconds(BigInt(Math.floor(Date.now() / 1000)));
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!store || !publicClient) return;
    let cancelled = false;
    setHealth(null);
    setHealthError(null);

    publicClient
      .readContract({
        address: store.oracleClient.address,
        abi: SENTRY_ORACLE_ABI as never,
        functionName: "policyHealth",
        args: [policyId],
      })
      .then((result) => {
        if (cancelled) return;
        const [paused, expiresAt] = result as readonly [boolean, bigint];
        setHealth({ paused, expiresAt });
      })
      .catch((err) => {
        if (cancelled) return;
        setHealthError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [store, policyId, publicClient, snapshotKey, refetchTick, retryTick]);

  // Cached PolicyInput body (same-browser publish cache).
  // Required by the management panel to construct pause/unpause/edit/extend
  // calls — `updatePolicy` is a full replace, not a partial. The reviver
  // mirrors useEventStore's: decimal strings without 'n' are NOT auto-bigint
  // here either, so we cast known bigint fields after parse.
  //
  // After the publishedCache IDB migration this is an async read, so it
  // moves from useMemo to a state + effect. While loading, `cachedInput`
  // remains null (PolicyActions already handles the null case as "body
  // unavailable for this browser"). A stale-response guard prevents an
  // out-of-order resolution from clobbering a newer policyId/oracle.
  const [cachedInput, setCachedInput] = useState<PolicyInput | null>(null);
  // True once the publishedCache read has settled — used to gate the
  // chain-recovery effect so it only fires after we've confirmed the
  // same-browser cache really is empty (avoids a spurious recovery probe
  // racing against the cache hit on a freshly mounted drawer).
  const [cacheRead, setCacheRead] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const oracleAddress = store?.oracleClient.address ?? ZERO_ADDRESS;
    setCachedInput(null);
    setCacheRead(false);
    (async () => {
      const entry = await readPublished(somniaTestnet.id, oracleAddress, policyId);
      if (cancelled) return;
      if (!entry || !entry.policyInputJSON) {
        setCachedInput(null);
        setCacheRead(true);
        return;
      }
      try {
        const reviver = (_k: string, v: unknown) =>
          typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v;
        const parsed = JSON.parse(entry.policyInputJSON, reviver) as Record<string, unknown>;
        const dailyCap = parsed.dailySpendWeiCap;
        const expiresAt = parsed.expiresAt;
        const targets = parsed.targets as Array<{ target: Address; selectors: Array<Record<string, unknown>> }> | undefined;
        const next: PolicyInput = {
          targets: (targets ?? []).map((t) => ({
            target: t.target,
            selectors: (t.selectors ?? []).map((s) => ({
              selector: s.selector as Hex,
              valueCapPerCall:
                typeof s.valueCapPerCall === "bigint"
                  ? s.valueCapPerCall
                  : BigInt((s.valueCapPerCall as string | number | bigint) ?? 0),
              tier: Number(s.tier) as PolicyInput["targets"][number]["selectors"][number]["tier"],
              delaySeconds: Number(s.delaySeconds),
            })),
          })),
          dailySpendWeiCap:
            typeof dailyCap === "bigint" ? dailyCap : BigInt((dailyCap as string | number | bigint) ?? 0),
          maxSlippageBps: Number(parsed.maxSlippageBps ?? 0),
          expiresAt:
            typeof expiresAt === "bigint" ? expiresAt : BigInt((expiresAt as string | number | bigint) ?? 0),
          paused: Boolean(parsed.paused),
        };
        if (!cancelled) {
          setCachedInput(next);
          setCacheRead(true);
        }
      } catch {
        if (!cancelled) {
          setCachedInput(null);
          setCacheRead(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // snapshotKey forces a re-read when the EventStore mutates (e.g. after
    // a pause/edit/extend rewrites the cache).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policyId, store, snapshotKey]);

  // Universal recovery from on-chain calldata.
  // When the same-browser publishedCache miss leaves cachedInput null but the
  // policy exists on chain (the common cross-browser / CLI-publish case),
  // decode the latest publish/update tx's calldata to reconstruct the full
  // PolicyInput. Successful recovery is written back into publishedCache via
  // cacheRecoveredPolicy so the next drawer open is instant — the read effect
  // above will rehydrate it on the next snapshotKey bump.
  //
  // We gate on `cacheRead` (not just `cachedInput === null`) so the effect
  // doesn't fire during the in-flight cache read on initial mount; otherwise
  // a slow IDB read could race the recovery probe and waste an RPC scan.
  const [recovered, setRecovered] = useState<PolicyInput | null>(null);
  const [recoveryState, setRecoveryState] = useState<"idle" | "recovering" | "failed">("idle");
  useEffect(() => {
    if (!cacheRead) return;
    if (cachedInput) return; // cache hit — no recovery needed
    if (!publicClient || !store) return;
    const oracleAddress = store.oracleClient.address;
    if (oracleAddress === ZERO_ADDRESS) return;
    // Existence gate: only burn an RPC scan when we have evidence the policy
    // actually exists on chain — either an EventStore meta record OR a
    // non-zero owner from the policyOwner() probe. A typo/stale URL leaves
    // both null and would otherwise trigger a full chain walk for a
    // nonexistent policy.
    const ownerKnown = hydratedOwner !== null && hydratedOwner !== ZERO_ADDRESS;
    if (!cachedMeta && !ownerKnown) return;
    let cancelled = false;
    setRecovered(null);
    setRecoveryState("recovering");
    recoverPolicyInputFromChainDeduped({
      chainId: somniaTestnet.id,
      publicClient,
      oracleAddress,
      policyId,
      fromBlock: ORACLE_DEPLOYMENT_BLOCK,
      // EventStore meta already carries publishedBlock when the policy
      // was seen during backfill — anchoring the walk there collapses the
      // worst-case 1M+ block crawl on Shannon. When meta is absent (out-
      // of-backfill policies) we fall back to the full deployment-block
      // floor and the scanner does its normal backward walk.
      publishedBlockHint: cachedMeta?.publishedBlock,
      // lastUpdatedBlock is tracked live by the event-watcher and always
      // populated on cachedMeta. When equal to publishedBlock the policy
      // has never been updated, so recovery short-circuits to a single
      // getLogs probe at the publish block — no chunked forward walk over
      // the ~head-publish gap (which is ~1M blocks for long-lived policies
      // on Shannon). When greater, the latest update lives at exactly
      // that block, again resolvable in one getLogs call.
      lastUpdatedBlockHint: cachedMeta?.lastUpdatedBlock,
    })
      .then(async (result) => {
        if (cancelled) return;
        if (!result) {
          setRecoveryState("failed");
          return;
        }
        setRecovered(result.policyInput);
        setRecoveryState("idle");
        // Best-effort write-through so the next open is instant. Failures
        // here are silent (matching cachePublished's IDB-unavailable path)
        // — the in-memory `recovered` state still unlocks owner actions
        // for this drawer instance. Publisher resolution order:
        //   1. cached meta owner (current owner per EventStore)
        //   2. hydrated owner from policyOwner() read
        //   3. tx.from of the recovered tx (always available — it's the
        //      address that actually signed the publish/update)
        // The fallback removes the dep on hydratedOwner from this effect
        // so we don't have to re-run the entire chain walk after the
        // owner-hydration round-trip completes.
        let publisherForCache: Address | null =
          (cachedMeta?.owner ?? hydratedOwner) as Address | null;
        if (!publisherForCache || publisherForCache === ZERO_ADDRESS) {
          try {
            const tx = await publicClient.getTransaction({ hash: result.txHash });
            publisherForCache = tx.from as Address;
          } catch {
            publisherForCache = null;
          }
        }
        if (cancelled) return;
        if (publisherForCache && publisherForCache !== ZERO_ADDRESS) {
          void cacheRecoveredPolicy({
            chainId: somniaTestnet.id,
            oracleAddress,
            policyId,
            policyInput: result.policyInput,
            txHash: result.txHash,
            publisher: publisherForCache,
          });
        }
      })
      .catch(() => {
        if (cancelled) return;
        // Recovery throws when a tx is found but decoding fails (older ABI
        // shape, multicall-wrapped publish, etc.). Surface as "failed" so
        // the actions panel can tell the user instead of crashing.
        setRecoveryState("failed");
      });
    return () => {
      cancelled = true;
    };
    // `hydratedOwner` is in deps because it's part of the existence gate:
    // when cachedMeta is null we need to re-run once the policyOwner() probe
    // resolves to know whether to attempt recovery at all. The dedupe layer
    // collapses any redundant scans into a single in-flight promise so a
    // re-run after hydration doesn't duplicate work. `cachedMeta?.owner` is
    // intentionally NOT a dep — owner-change events bumping cachedMeta would
    // otherwise re-trigger the entire scan; the publisher fallback to
    // tx.from inside the success branch covers the cache-write requirement.
    // `cachedMeta?.lastUpdatedBlock` is also intentionally NOT a dep — a
    // fresh update arriving mid-recovery would re-trigger the entire scan,
    // but the cache write-through on the new update will rehydrate
    // `cachedInput` and the next render's early-return prevents the redo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheRead, cachedInput, publicClient, store, policyId, cachedMeta?.publishedBlock, hydratedOwner]);

  const effectiveCachedInput = cachedInput ?? recovered;

  // Tier probe.
  // Driven by indices into the resolved policy body (cache → recovery), so the
  // operator picks from the policy's own enumerated targets/selectors instead
  // of typing 40+8 hex chars by hand. The probe call still hits the oracle's
  // `tierAndDelay` view — only the input UX changed.
  const [targetIdx, setTargetIdx] = useState(0);
  const [selectorIdx, setSelectorIdx] = useState(0);
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<{ tier: number; delaySeconds: number } | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  // Reset the selection when the underlying policy body changes (e.g. a fresh
  // recovery completed) so we don't leave a stale out-of-range index pointing
  // past the new targets array.
  useEffect(() => {
    setTargetIdx(0);
    setSelectorIdx(0);
    setProbeResult(null);
    setProbeError(null);
  }, [cachedInput, recovered]);

  const probeBody = cachedInput ?? recovered;
  const probeTarget = probeBody?.targets[targetIdx];
  const probeSelector = probeTarget?.selectors[selectorIdx];
  const probeDisabled = probing || !store || !probeTarget || !probeSelector;

  async function runProbe() {
    if (!store || !probeTarget || !probeSelector) return;
    setProbing(true);
    setProbeResult(null);
    setProbeError(null);
    try {
      const result = await store.oracleClient.tierAndDelay(
        policyId,
        probeTarget.target,
        probeSelector.selector,
      );
      setProbeResult(result);
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : String(err));
    } finally {
      setProbing(false);
    }
  }

  // Recent activity — queue events scoped to this policy.
  const recent = useMemo(() => {
    if (!store) return [] as StoreEvent[];
    return store
      .recentEvents(200)
      .filter((e) => e.policyId === policyId)
      .slice(-20)
      .reverse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, policyId, snapshotKey]);

  const meta = cachedMeta;
  const owner = meta?.owner ?? hydratedOwner;
  const notFound = !meta && !hydrating && hydratedOwner !== null && hydratedOwner === ZERO_ADDRESS;
  const isYou =
    walletAddress && owner && owner.toLowerCase() === walletAddress.toLowerCase();

  const close = () => {
    if (onClose) onClose();
    else setDrawer(null);
  };

  return (
    <Sheet open onOpenChange={(o) => { if (!o) close(); }}>
      <SheetContent
        side="right"
        aria-label="Policy details"
        // Sheet ships its own Close button at top-right; we keep DrawerHeader's
        // close affordance for visual continuity with the rest of the app, so
        // hide the built-in one. Also drop default p-6 since we manage padding
        // inside the header/body sections ourselves.
        className="flex h-full flex-col p-0 [&>button.absolute]:hidden"
      >
        <SheetTitle className="sr-only">Policy details</SheetTitle>
      <DrawerHeader
        eyebrow={
          <span className="flex items-center gap-2">
            <span>POLICY</span>
            <span
              className="font-mono tabular-nums text-text-subtle"
              title={policyId}
            >
              {truncate(policyId, 10, 8)}
            </span>
          </span>
        }
        title={(() => {
          const decoded = decodeLabel(meta?.label);
          if (meta?.labelRecovered === false || !meta?.label) {
            return (
              <span className="font-mono tabular-nums text-text-muted">
                {truncate(policyId, 10, 8)}
              </span>
            );
          }
          if (decoded.kind === "hex") {
            return (
              <span
                className="font-mono tabular-nums"
                title="Label contains non-ASCII bytes — showing hex for safety"
              >
                {decoded.value}
              </span>
            );
          }
          return <span>{decoded.value}</span>;
        })()}
        onClose={close}
      />

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {hydrating && !meta && <SkeletonLines count={4} />}
        {hydrateError && (
          <div role="alert" className="border-l-2 border-warn pl-3">
            <div className="text-sm text-text">Could not load policy owner.</div>
            <div className="mt-1 font-mono text-xs text-text-muted">{hydrateError}</div>
          </div>
        )}
        {notFound && (
          <div role="alert" className="border-l-2 border-warn pl-3">
            <div className="text-sm text-warn">Not found — no policy at this id.</div>
          </div>
        )}

        {(meta || (owner && owner !== ZERO_ADDRESS)) && (
          <Section eyebrow="IDENTITY">
            <Row label="Owner">
              <span className="inline-flex items-center gap-2">
                <AddressChip address={owner ?? undefined} />
                {isYou && (
                  <span className="text-xs text-accent">(you)</span>
                )}
              </span>
            </Row>
            <Row label="Label">
              {(() => {
                const decoded = decodeLabel(meta?.label);
                if (decoded.kind === "hex") {
                  return (
                    <span
                      className="font-mono tabular-nums text-xs text-text"
                      title="Label contains non-ASCII bytes — showing hex for safety"
                    >
                      {decoded.value}
                    </span>
                  );
                }
                return (
                  <span className="font-mono tabular-nums text-xs text-text">{decoded.value}</span>
                );
              })()}
            </Row>
            <Row label="Published">
              <span className="font-mono tabular-nums text-xs text-text">
                {meta?.publishedBlock !== undefined ? `block ${meta.publishedBlock.toString()}` : "(outside backfill)"}
              </span>
            </Row>
            <Row label="Last updated">
              <span className="font-mono tabular-nums text-xs text-text">
                {meta ? `block ${meta.lastUpdatedBlock.toString()}` : "—"}
              </span>
            </Row>
            {pendingOwner && (
              <Row label="Pending transfer">
                <span className="inline-flex items-center gap-2">
                  <AddressChip address={pendingOwner} />
                  {walletAddress &&
                    pendingOwner.toLowerCase() === walletAddress.toLowerCase() && (
                      <span className="text-xs text-accent">(you)</span>
                    )}
                </span>
              </Row>
            )}
          </Section>
        )}

        <Section eyebrow="HEALTH">
          {healthError && (
            <div role="alert">
              <div className="border-l-2 border-warn pl-3">
                <div className="text-sm text-text">Could not load policy health.</div>
                <div className="mt-1 font-mono text-xs text-text-muted">{healthError}</div>
              </div>
            </div>
          )}
          {!health && !healthError && <SkeletonLines count={3} />}
          {health && (
            <>
              <Row label="Paused">
                {health.paused ? (
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-warn">
                    paused
                  </span>
                ) : (
                  <span className="text-text text-xs">no</span>
                )}
              </Row>
              <Row label="Expires">
                {(() => {
                  const f = formatExpiresAtFull(health.expiresAt, nowSeconds);
                  if (f.status === "no-expiry") {
                    return <span className="text-text-subtle text-xs">no expiry</span>;
                  }
                  const relColor =
                    f.status === "expired" ? "text-danger" :
                    f.status === "imminent" ? "text-warn" :
                    "text-text-subtle";
                  return (
                    <span className="text-xs">
                      <span className="text-text" title={health.expiresAt.toString()}>{f.absolute}</span>
                      <span className={`ml-2 ${relColor}`}>({f.relative})</span>
                    </span>
                  );
                })()}
              </Row>
            </>
          )}
        </Section>

        {/* Policy targets — enumerate the (target, selector) pairs that
            the agent is allowed to call. Data comes from the same resolved
            policy body the probe and PolicyActions use (cache → recovery),
            so we surface the same loading / failure wording as those. */}
        <Section eyebrow={`TARGETS (${probeBody?.targets.length ?? 0})`}>
          {!probeBody && recoveryState === "recovering" && (
            <div className="text-sm text-text-subtle">Loading targets…</div>
          )}
          {!probeBody && recoveryState === "failed" && (
            <div className="text-sm text-warn">
              Targets unavailable — recovery failed.
            </div>
          )}
          {probeBody && probeBody.targets.length === 0 && (
            <div className="text-sm text-text-subtle">no targets configured</div>
          )}
          {probeBody?.targets.map((t, i) => (
            <div key={`${t.target}-${i}`} className="border-t border-rule pt-3 first:border-t-0 first:pt-0">
              <div className="flex items-baseline justify-between gap-2">
                <AddressChip address={t.target} />
                <span className="text-[11px] text-text-muted">
                  {t.selectors.length} selector{t.selectors.length === 1 ? "" : "s"}
                </span>
              </div>
              <ul className="mt-2 space-y-1">
                {t.selectors.map((s, j) => (
                  <li
                    key={`${s.selector}-${j}`}
                    className="flex items-baseline justify-between gap-2 border-t border-rule pt-1 first:border-t-0 first:pt-0"
                  >
                    <span
                      className="font-mono text-xs text-text truncate"
                      title={s.selector}
                    >
                      {formatSelector(s.selector)}
                    </span>
                    <span className="inline-flex items-center gap-2 shrink-0">
                      {/* Render the human label, but keep the raw enum name
                       * in the tooltip so a user pasting from the YAML still
                       * has the canonical token one hover away. */}
                      <span
                        className="font-mono text-[10px] uppercase tracking-[0.12em] text-accent"
                        title={tierLabel(s.tier)}
                      >
                        {humanizeTier(s.tier)}
                      </span>
                      <span className="text-[11px] text-text-subtle tabular-nums">
                        cap: {formatEther(s.valueCapPerCall)} STT
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Section>

        {/* Tier probe — kept as a <Card> since it is an interactive form
            whose elevation conveys "input surface" rather than just a section.
            Inputs are now driven by dropdowns sourced from the policy body
            itself, so the operator picks from what's actually allowed rather
            than typing addresses + selectors by hand. */}
        <section className="mt-4 pt-4 border-t border-rule">
          <div className="mb-3 text-[11px] font-medium uppercase tracking-[0.14em] text-text-muted">
            WOULD THIS CALL BE ALLOWED?
          </div>
          <div>
            {!probeBody && recoveryState === "recovering" && (
              <div className="text-sm text-text-muted">Loading targets…</div>
            )}
            {!probeBody && recoveryState === "failed" && (
              <div className="text-sm text-warn">
                Targets unavailable — recovery failed.
              </div>
            )}
            {probeBody && (
              <div className="space-y-3 text-sm">
                <label className="block">
                  <span className="block text-xs text-text-muted">Target</span>
                  <select
                    value={targetIdx}
                    onChange={(e) => {
                      setTargetIdx(Number(e.target.value));
                      setSelectorIdx(0);
                    }}
                    className="mt-1 w-full rounded border border-rule bg-surface px-2 py-1 font-mono tabular-nums text-xs text-text focus:border-accent focus:outline-none"
                  >
                    {probeBody.targets.map((t, i) => (
                      <ProbeTargetOption
                        key={`${t.target}-${i}`}
                        address={t.target}
                        selectorCount={t.selectors.length}
                        value={i}
                      />
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="block text-xs text-text-muted">Function</span>
                  <select
                    value={selectorIdx}
                    onChange={(e) => setSelectorIdx(Number(e.target.value))}
                    className="mt-1 w-full rounded border border-rule bg-surface px-2 py-1 font-mono tabular-nums text-xs text-text focus:border-accent focus:outline-none"
                  >
                    {probeTarget?.selectors.map((s, j) => (
                      <option key={`${s.selector}-${j}`} value={j}>
                        {`${formatSelector(s.selector)} (${humanizeTier(s.tier)})`}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={runProbe}
                  disabled={probeDisabled}
                  className="rounded border border-accent px-3 py-1 text-xs text-accent hover:bg-accent hover:text-white disabled:cursor-not-allowed disabled:border-rule disabled:text-text-subtle disabled:hover:bg-transparent disabled:hover:text-text-subtle"
                >
                  {probing ? "Probing…" : "Probe"}
                </button>
                {probeResult && (
                  <div className="mt-3 border-t border-rule pt-3 text-xs">
                    <div>
                      <span className="text-text-muted">Mode</span>{" "}
                      <span className="text-accent" title={tierLabel(probeResult.tier)}>
                        {humanizeTier(probeResult.tier)}
                      </span>
                    </div>
                    <div className="mt-1">
                      <span className="text-text-muted">Wait</span>{" "}
                      <span className="font-mono tabular-nums text-accent">{probeResult.delaySeconds}</span>
                    </div>
                  </div>
                )}
                {probeError && (
                  <div className="mt-2 text-xs text-warn">Couldn't check this call: {probeError}</div>
                )}
              </div>
            )}
          </div>
        </section>

        <Section eyebrow={`RECENT ACTIVITY (${recent.length})`}>
          {recent.length === 0 ? (
            <div className="text-sm text-text-subtle">no events for this policy in the recent log</div>
          ) : (
            <ul className="space-y-1 text-sm">
              {recent.map((e) => (
                <li
                  key={`${e.blockNumber.toString()}-${e.logIndex}-${e.type}`}
                  className="flex items-baseline justify-between gap-3 border-b border-rule pb-1 last:border-b-0"
                >
                  <span className="text-text">{eventLabel(e)}</span>
                  <span className="font-mono tabular-nums text-xs text-text-subtle">
                    blk {e.blockNumber.toString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {owner && owner !== ZERO_ADDRESS && (
          <PolicyActions
            policyId={policyId}
            policyOwner={owner}
            pendingOwner={pendingOwner}
            cachedInput={effectiveCachedInput}
            recoveryState={recoveryState}
            chainPaused={health?.paused}
            oracleAddress={store?.oracleClient.address ?? ZERO_ADDRESS}
            onActionComplete={onActionComplete}
          />
        )}
      </div>
      </SheetContent>
    </Sheet>
  );
}
