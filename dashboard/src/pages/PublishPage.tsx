import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useAccount, useChainId, usePublicClient } from "wagmi";
import { ArrowLeft } from "@phosphor-icons/react";
import { hexToString, type Address, type Hex } from "viem";
import { useEventStore } from "../hooks/useEventStore";
import { SkeletonLines } from "../components/primitives";
import { lookupPolicyOnChain, type OnChainPolicySnapshot } from "../lib/onChainPolicyLookup";
import { useUrlState } from "../hooks/useUrlState";
import { usePolicyDraft } from "../hooks/usePolicyDraft";
import { PolicyForm } from "../components/publish/PolicyForm";
import PolicyTemplates from "../components/publish/PolicyTemplates";
import AgentDiscovery from "../components/publish/AgentDiscovery";
import SourceAgentEntry from "../components/publish/SourceAgentEntry";
import { YamlPreview } from "../components/publish/YamlPreview";
import { PublishButton, type PublishedResult } from "../components/publish/PublishButton";
import { PublishedReveal } from "../components/publish/PublishedReveal";
import { IntentSimulator } from "../components/publish/IntentSimulator";
import { ResizableSplit } from "../components/primitives";
import { Separator } from "../components/ui/separator";
import { SOMNIA_CHAIN_ID } from "../lib/networks";
import type { PolicyDraft } from "../lib/policy-draft";
import { cachePublished, readPublished } from "../lib/publishedCache";

// Lazy-load the post-publish checklist — it pulls in the probe code, two
// dialogs, and the registry write helper that are ONLY reached after a
// successful publish (a rare branch). Splitting it out keeps the main
// PublishPage bundle small for the cold-load happy path.
const PostPublishChecklist = lazy(() =>
  import("../components/publish/PostPublishChecklist").then((m) => ({
    default: m.PostPublishChecklist,
  })),
);

const DASHBOARD_VERSION = "v0.10.0";

/**
 * The form is "empty" when it matches the shape emptyPolicyDraft() produces —
 * one blank target with one blank selector and no name/label. We only show
 * the template gallery in that state so it disappears as soon as the user (or
 * a template click) puts content in.
 */
function isDraftEmpty(draft: PolicyDraft): boolean {
  return (
    draft.name === "" &&
    draft.label === "" &&
    draft.targets.length === 1 &&
    draft.targets[0].target === "" &&
    draft.targets[0].selectors.length === 1 &&
    draft.targets[0].selectors[0].selector === ""
  );
}

/**
 * The non-dev publish surface. Lane B "document grade" treatment: front matter
 * + numbered sections (templates, policy form, POLICY.md preview,
 * publish + simulator) flanking the same usePolicyDraft / PublishButton
 * data flow as before. Same SDK compile path the CLI uses → identical
 * PolicyInput on-chain.
 */
export function PublishPage() {
  const { oracle, queue, mode, revealed, setRevealed } = useUrlState();
  const { address: walletAddress, isConnected } = useAccount();
  const walletChainId = useChainId();
  const chainId = walletChainId || SOMNIA_CHAIN_ID;
  const { store, snapshotKey, ready: storeReady } = useEventStore();
  const publicClient = usePublicClient();
  // Status of the on-chain `policyOwner(policyId)` fallback for the current
  // `revealed`. Tracks lookupPolicyOnChain's discriminated union so an RPC
  // failure ("rpc_error") is not collapsed into "not_found".
  const [chainProbeStatus, setChainProbeStatus] = useState<
    | { for: Hex; outcome: "not_found" }
    | { for: Hex; outcome: "rpc_error" }
    | null
  >(null);
  // Bumped to retrigger the probe effect for the same `revealed` value
  // (the URL param doesn't change on retry). Each bump clears
  // `chainProbeStatus` so the restoring-state UI shows while the retry
  // is in flight.
  const [probeRetryToken, setProbeRetryToken] = useState(0);
  // Health/snapshot fields fetched as a side-channel from chain when neither
  // cache nor EventStore had them. Threaded through to PublishedReveal so
  // the metadata strip can show paused/expires + a recovered tx hash even
  // for a cross-browser URL revisit.
  const [chainSnapshot, setChainSnapshot] = useState<OnChainPolicySnapshot | null>(null);
  const {
    draft,
    setDraft,
    yamlText,
    compileResult,
    shouldShowError,
    touch,
    markPublishAttempt,
  } = usePolicyDraft();
  const [published, setPublished] = useState<PublishedResult | null>(null);
  // Track the yamlText for the currently-revealed policy. On fresh publish
  // this is the live yamlText from the draft. On URL revisit, it's restored
  // from cache; if the cache misses (different browser), it stays empty and
  // the reveal renders in lightweight mode (no download-md affordance).
  const [revealedYaml, setRevealedYaml] = useState<string>("");
  const [revealedMode, setRevealedMode] = useState<"enforce" | "watch">("enforce");
  const [revealedPolicyInputJSON, setRevealedPolicyInputJSON] = useState<string | undefined>(undefined);

  // Head block for the front-matter "Indexed through" line. Mirrors the
  // pattern WatchedPage / StatusBar use — re-read on every snapshotKey++ so
  // the value tracks the live cursor.
  const [head, setHead] = useState<string>("—");
  useEffect(() => {
    if (!store) {
      setHead("—");
      return;
    }
    try {
      setHead(store.cursor().toString());
    } catch {
      setHead("—");
    }
  }, [store, snapshotKey]);

  // On mount or whenever `?revealed=` changes, restore the reveal panel.
  // Priority: in-memory `published` from a fresh publish > localStorage
  // cache > EventStore lightweight fallback. Without a hit anywhere we
  // strip the URL param so the form takes over.
  useEffect(() => {
    if (!revealed) {
      setPublished(null);
      setChainSnapshot(null);
      return;
    }
    // Already showing this exact policy from a fresh publish — leave it.
    if (published && published.policyId.toLowerCase() === revealed.toLowerCase()) return;

    let cancelled = false;
    // readPublished is now async (IDB-backed). The fallbacks still need to
    // run if the cache misses, so we await the read first, then either
    // populate from cache or fall through to the EventStore / on-chain
    // probe path. `cancelled` covers the full async flow.
    (async () => {
      const cached = await readPublished(chainId, oracle, revealed);
      if (cancelled) return;
      if (cached) {
        setPublished({
          policyId: cached.policyId,
          txHash: cached.txHash,
          publisher: cached.publisher,
          label: cached.label,
        });
        setRevealedYaml(cached.yamlText);
        setRevealedMode(cached.mode);
        setRevealedPolicyInputJSON(cached.policyInputJSON);
        // Cache restore path doesn't refresh paused/expiresAt — drop any
        // stale chainSnapshot left over from a prior revealed id so the
        // reveal's metadata strip doesn't show another policy's status.
        // A fresh chain-probe would re-populate this; here we just blank it.
        setChainSnapshot(null);
        return;
      }

      // EventStore fallback — has owner+label, not tx/yaml. Re-runs on
      // `snapshotKey` so we catch the policy after backfill indexes it.
      // `labelRecovered` is the discriminant; any defined `meta.label` is a
      // cache hit.
      const meta = store?.getPolicy(revealed);
      if (meta && meta.label !== undefined) {
        // Default to `true` for back-compat with snapshots persisted before
        // labelRecovered existed — those rows came from real PolicyPublished logs.
        const recovered = meta.labelRecovered ?? true;
        let labelStr = "";
        if (recovered) {
          try { labelStr = hexToString(meta.label, { size: 32 }).replace(/\0+$/, ""); }
          catch { labelStr = meta.label; }
        }
        setPublished({
          policyId: meta.policyId,
          txHash: "0x" as Hex, // unknown — reveal will hide the tx affordance
          publisher: meta.owner as Address,
          label: recovered ? labelStr : "(label not recoverable from chain)",
        });
        setRevealedYaml("");
        setRevealedMode("enforce");
        setRevealedPolicyInputJSON(undefined);
        // EventStore restore has no paused/expiresAt/tx of its own — drop
        // any stale chainSnapshot from a prior revealed id so the reveal's
        // metadata strip doesn't surface another policy's status.
        setChainSnapshot(null);
        return;
      }

      // Direct on-chain lookup fallback; keeps `not_found` and `rpc_error` distinct.
      if (!publicClient || !storeReady) return;
      if (
        chainProbeStatus &&
        chainProbeStatus.for.toLowerCase() === revealed.toLowerCase()
      ) {
        return;
      }
      const result = await lookupPolicyOnChain(publicClient, oracle, revealed);
      if (cancelled) return;
      if (result.kind === "not_found") {
        setChainProbeStatus({ for: revealed, outcome: "not_found" });
        return;
      }
      if (result.kind === "rpc_error") {
        setChainProbeStatus({ for: revealed, outcome: "rpc_error" });
        return;
      }
      const snapshot = result.policy;
      // `found-no-label` is a real cache hit — the policy exists on chain,
      // we just couldn't recover the label from the event log scan window.
      // Render with the "not recoverable" badge and persist a placeholder
      // labelHex alongside `labelRecovered: false` so the next reload sees
      // a defined `meta.label`, skips this probe entirely, and ALSO knows
      // (via the explicit flag) that the placeholder is not the real
      // value. The placeholder bytes are arbitrary — `labelRecovered` is
      // the source of truth, not the label value.
      const recovered = snapshot.kind === "found-with-label";
      const persistedLabelHex: Hex =
        snapshot.labelHex ??
        ("0x0000000000000000000000000000000000000000000000000000000000000000" as Hex);
      setPublished({
        policyId: snapshot.policyId,
        txHash: snapshot.txHash ?? ("0x" as Hex),
        publisher: snapshot.publisher,
        label: snapshot.label ?? "(label not recoverable from chain)",
      });
      setChainSnapshot(snapshot);
      setRevealedYaml("");
      setRevealedMode("enforce");
      setRevealedPolicyInputJSON(undefined);

      // Mirror the recovered policy into the EventStore so the Queue tab
      // (and anything else reading getPolicy/recentEvents) sees it after
      // a cross-browser bookmark revisit. Same shape pattern PublishButton
      // uses post-publish. The *AndPersist variants emit a snapshotUpdated
      // synthetic so the dashboard's IDB writer flushes the new policy
      // into the snapshot store — otherwise the recovered policy would
      // live only in memory and trigger the same on-chain probe on every
      // reload of the bookmark.
      //
      // publishBlock falls back to 0n when the event scan didn't find
      // the log within MAX_BACK_BLOCKS — the policy still hydrates so
      // getPolicy works, but the event row will sort at the very top.
      if (store) {
        const blk = snapshot.publishBlock ?? 0n;
        store.hydratePolicyAndPersist({
          policyId: snapshot.policyId,
          owner: snapshot.publisher,
          label: persistedLabelHex,
          labelRecovered: recovered,
          publishedBlock: blk,
          lastUpdatedBlock: blk,
        });
        store.hydrateEventAndPersist({
          type: "PolicyPublished",
          policyId: snapshot.policyId,
          owner: snapshot.publisher,
          label: persistedLabelHex,
          blockNumber: blk,
          // logIndex isn't recoverable from the snapshot and only matters
          // for live-emit dedupe, which hydrate bypasses.
          logIndex: 0,
          transactionHash: snapshot.txHash ?? ("0x" as Hex),
        });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealed, chainId, oracle, store, snapshotKey, published, storeReady, publicClient, probeRetryToken]);

  // Stringify PolicyInput with bigint replacer so dailySpendWeiCap / expiresAt
  // / valueCapPerCall / delaySeconds round-trip through JSON without throwing.
  // getCachedPolicyInput hydrates them back to bigint on the watcher side.
  const policyInputJSON = useMemo(() => {
    if (!compileResult.ok) return undefined;
    return JSON.stringify(compileResult.input, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
  }, [compileResult]);

  // The chain-probe outcome for the CURRENT `revealed` (only — a stale
  // outcome from a different bookmark must not gate the new id's UI).
  const probeOutcomeForRevealed =
    revealed &&
    chainProbeStatus &&
    chainProbeStatus.for.toLowerCase() === revealed.toLowerCase()
      ? chainProbeStatus.outcome
      : null;

  // URL has ?revealed= but lookup hasn't resolved yet (cache miss + store
  // still backfilling, OR store ready but the on-chain `policyOwner` probe
  // hasn't completed). Show a brief restoring state so we don't flash the
  // empty form while either pass catches up — much less confusing than
  // "I opened a bookmark and it showed me a blank form."
  if (
    revealed &&
    !published &&
    (!storeReady || probeOutcomeForRevealed === null)
  ) {
    return (
      <div className="mx-auto w-full max-w-[1100px] space-y-3 px-10 py-10 text-sm md:px-16">
        <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-text-muted">
          Restoring policy
        </div>
        <code className="block break-all border-t border-rule pt-3 font-mono text-[12px] text-text">
          {revealed}
        </code>
        <SkeletonLines count={3} />
        <p className="text-xs text-text-muted">
          Scanning recent oracle events. This usually takes a few seconds.
        </p>
      </div>
    );
  }

  // URL has ?revealed= and the `policyOwner` read threw (network blip,
  // CALL_EXCEPTION, RPC timeout). We CANNOT tell whether the policy
  // exists, so we explicitly do NOT render "policy not found" here.
  if (revealed && !published && probeOutcomeForRevealed === "rpc_error") {
    return (
      <div className="mx-auto w-full max-w-[1100px] space-y-3 px-10 py-10 text-sm md:px-16">
        <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-warn">
          Cannot reach the chain right now
        </div>
        <code className="block break-all border-t border-rule pt-3 font-mono text-[12px] text-text">
          {revealed}
        </code>
        <p className="text-xs text-text-muted">
          The oracle read for this policy id failed. This is usually a transient RPC
          issue — try again in a moment.
        </p>
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => {
              setChainProbeStatus(null);
              // Drop any stale chainSnapshot so the retried probe owns the
              // status/expiry/tx the reveal renders.
              setChainSnapshot(null);
              setProbeRetryToken((n) => n + 1);
            }}
            className="text-xs text-accent hover:underline"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={() => setRevealed(null)}
            className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text"
          >
            <ArrowLeft size={12} weight="regular" /> back to publish form
          </button>
        </div>
      </div>
    );
  }

  // URL has ?revealed= and BOTH the store finished AND we already attempted
  // the on-chain `policyOwner` fallback for this id and the chain confirmed
  // no such policy. Either the policy was published outside the backfill
  // window AND doesn't exist on this oracle, or the URL is wrong. RPC
  // failures take the dedicated branch above instead of being rolled into
  // this state.
  if (revealed && !published && probeOutcomeForRevealed === "not_found") {
    return (
      <div className="mx-auto w-full max-w-[1100px] space-y-3 px-10 py-10 text-sm md:px-16">
        <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-warn">
          No policy at this ID
        </div>
        <code className="block break-all border-t border-rule pt-3 font-mono text-[12px] text-text">
          {revealed}
        </code>
        <p className="text-xs text-text-muted">
          We scanned this oracle and didn't see a publish event for that id. It may have been
          published against a different oracle than{" "}
          <code className="font-mono text-[11px] text-text">{oracle}</code>, or never
          published — paste a different id or publish to start fresh.
        </p>
        <button
          type="button"
          onClick={() => setRevealed(null)}
          className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text"
        >
          <ArrowLeft size={12} weight="regular" /> back to publish form
        </button>
      </div>
    );
  }

  if (published) {
    // If this is a URL revisit (revealed set, not a fresh publish), the
    // cached yaml/mode/policyInputJSON took over via the effect above.
    // For a fresh publish, prefer the values threaded back from the button
    // (compiled at click-time) over the parent's render-time memos so the
    // reveal always mirrors what actually went on-chain. Fall back to the
    // memo only if the result didn't carry them (older code paths).
    const isRevisit =
      revealed !== null && revealed.toLowerCase() === published.policyId.toLowerCase();
    const freshYaml = published.yamlText ?? yamlText;
    const freshPolicyInputJSON = published.policyInputJSON ?? policyInputJSON;
    return (
      <div className="mx-auto w-full max-w-[1100px] space-y-4 px-10 py-10 md:px-16">
        <PublishedReveal
          result={published}
          yamlText={isRevisit ? revealedYaml : freshYaml}
          mode={isRevisit ? revealedMode : mode}
          policyInputJSON={isRevisit ? revealedPolicyInputJSON : freshPolicyInputJSON}
          chainSnapshot={isRevisit ? chainSnapshot : null}
        />
        {/* Post-publish operator checklist — bind to deployed agent +
            register in the catalog. Mounts BELOW PublishedReveal so it can't
            collide with the reveal's own state. Lazy-loaded; the Suspense
            fallback is null because the published branch is already a
            rendered surface and a flash of empty space is less jarring
            than a spinner. */}
        <Suspense fallback={null}>
          <PostPublishChecklist
            policyId={published.policyId}
            label={published.label}
            prefilledAgentAddress={
              draft.bindAgentAddress as Address | undefined
            }
          />
        </Suspense>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text"
          onClick={() => {
            setPublished(null);
            setRevealed(null);
            // Drop chainSnapshot so revisiting a different policy via cache
            // /EventStore doesn't pick up the previous one's status strip.
            setChainSnapshot(null);
          }}
        >
          <ArrowLeft size={12} weight="regular" /> publish another
        </button>
      </div>
    );
  }

  // Deep-merge so a second Apply doesn't blow away the targets the
  // user already configured. Naive { ...draft, ...partial } would
  // replace the targets array wholesale, dropping prior tiers/caps.
  const applyDiscoveryDraft = (partial: Partial<PolicyDraft>) => {
    const next: PolicyDraft = { ...draft, ...partial };
    if (partial.targets) {
      const merged = [...draft.targets];
      for (const incoming of partial.targets) {
        const idx = merged.findIndex(
          (t) => t.target.toLowerCase() === incoming.target.toLowerCase(),
        );
        if (idx === -1) {
          merged.push(incoming);
          continue;
        }
        // Existing target: append only NEW selectors (dedupe by
        // selector string). User-edited tiers/caps on existing
        // selectors are preserved as-is.
        const seenSels = new Set(merged[idx].selectors.map((s) => s.selector));
        const newSels = incoming.selectors.filter((s) => !seenSels.has(s.selector));
        merged[idx] = {
          ...merged[idx],
          selectors: [...merged[idx].selectors, ...newSels],
        };
      }
      next.targets = merged;
    }
    // Carry the agent-first entry's bindAgentAddress forward so the
    // PostPublishChecklist can pre-fill BindStep without a second paste.
    // Only overwrite when the partial actually provides one (don't blank
    // an existing value on a non-bind-capable second Apply).
    if (partial.bindAgentAddress !== undefined) {
      next.bindAgentAddress = partial.bindAgentAddress;
    }
    setDraft(next);
  };

  const form = (
    <PolicyForm
      draft={draft}
      setDraft={setDraft}
      compileResult={compileResult}
      shouldShowError={shouldShowError}
      touch={touch}
    />
  );

  const leftPane = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <DocumentFrontMatter
          oracle={oracle}
          chainId={chainId}
          head={head}
          walletAddress={walletAddress}
          mode={mode}
        />

        {mode === "watch" ? (
          <>
            <Section number="" title="Bind an existing agent">
              <p className="mb-4 text-[13px] text-text-muted">
                Watch mode publishes a policy for an already-deployed agent and
                receives violation alerts as the agent transacts. It never
                blocks the call.
              </p>
              <AgentDiscovery onApplyDraft={applyDiscoveryDraft} />
            </Section>

            <Section number="" title="Policy">
              {form}
            </Section>

            {isDraftEmpty(draft) && (
              <Section number="" title="Start from a template instead">
                <PolicyTemplates onPick={setDraft} />
              </Section>
            )}
          </>
        ) : (
          <>
            <Section number="" title="Source agent">
              <SourceAgentEntry onApplyDraft={applyDiscoveryDraft} />
            </Section>

            {isDraftEmpty(draft) && (
              <Section number="" title="Templates">
                <PolicyTemplates onPick={setDraft} />
              </Section>
            )}

            <Section number="" title="Policy">
              {form}
            </Section>
          </>
        )}

        <Section number="" title="Publish">
          {!isConnected && (
            <p className="mb-4 border-l-2 border-warn pl-3 text-[12px] text-warn">
              Connect your wallet (top right) to publish. The connected
              address becomes the policy publisher.
            </p>
          )}
          <PublishButton
            oracleAddress={oracle}
            queueAddress={queue}
            label={draft.label}
            draft={draft}
            yamlText={yamlText}
            compileResult={compileResult}
            onPublished={(result) => {
              // Use the FRESH yamlText / policyInputJSON the button compiled
              // at click-time (threaded back via the result). The parent's
              // render-time memo could be stale if the form drifted between
              // the last render and the publish click — the tx args are
              // fresh, so the reveal + cache must mirror them. Fall back to
              // the render-time values if the fresh ones are missing (only
              // happens on non-publish PublishedResult constructions, which
              // never reach this callback).
              const freshYaml = result.yamlText ?? yamlText;
              const freshPolicyInputJSON = result.policyInputJSON ?? policyInputJSON;
              // Fire-and-forget the IDB write — the reveal panel renders
              // from local state on the same tick; the cache is only needed
              // for the NEXT visit / drawer-open. Errors are already
              // swallowed inside cachePublished.
              void cachePublished(chainId, oracle, {
                policyId: result.policyId,
                txHash: result.txHash,
                publisher: result.publisher,
                label: result.label,
                yamlText: freshYaml,
                mode,
                policyInputJSON: freshPolicyInputJSON,
                publishedAtMs: Date.now(),
              });
              setRevealedYaml(freshYaml);
              setRevealedMode(mode);
              setRevealedPolicyInputJSON(freshPolicyInputJSON);
              // Fresh publish has no chain-probed snapshot yet (paused/expiry
              // come from the publish input itself). Blank any stale snapshot
              // so the reveal's metadata strip doesn't carry over a prior
              // bookmark's status/expiry/tx into the just-published policy.
              setChainSnapshot(null);
              setPublished(result);
              setRevealed(result.policyId);
            }}
            markPublishAttempt={markPublishAttempt}
          />
          <IntentSimulator input={compileResult.ok ? compileResult.input : null} />
        </Section>

        <div className="h-12" aria-hidden />
      </div>
    </div>
  );

  return (
    <ResizableSplit
      storageKey="sentry-publish-split"
      defaultLeftPct={55}
      minPaneWidth={360}
      className="h-full"
      left={leftPane}
      right={
        <div className="flex h-full min-h-0 flex-col">
          <YamlPreview yamlText={yamlText} result={compileResult} />
        </div>
      }
    />
  );
}

interface FrontMatterProps {
  oracle: Address;
  chainId: number;
  head: string;
  walletAddress: Address | undefined;
  mode: "enforce" | "watch";
}

function DocumentFrontMatter({
  oracle,
  chainId,
  head,
  walletAddress,
  mode,
}: FrontMatterProps) {
  return (
    <section className="px-10 pt-10 pb-8 md:px-12">
      <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-text-muted">
        Policy Manifest · Document {DASHBOARD_VERSION}
      </div>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-text md:text-4xl">
        Publish a policy
      </h1>

      <dl className="mt-6 grid max-w-[640px] grid-cols-[140px_1fr] gap-y-1.5 gap-x-6 text-[13px]">
        <dt className="text-text-muted">Publisher</dt>
        <dd className="font-mono text-[12px] text-text">
          {walletAddress ?? <span className="text-text-muted">not connected</span>}
        </dd>
        <dt className="text-text-muted">Namespace</dt>
        <dd className="text-text">
          Somnia Shannon
          <span className="ml-2 font-mono text-[12px] text-text-muted">
            chain id {chainId}
          </span>
        </dd>
        <dt className="text-text-muted">SentryOracle</dt>
        <dd className="font-mono text-[12px] text-text">{oracle}</dd>
        <dt className="text-text-muted">Indexed through</dt>
        <dd className="font-mono text-[12px] text-text">block {head}</dd>
        <dt className="text-text-muted">Mode</dt>
        <dd className="font-mono text-[12px] uppercase tracking-[0.12em] text-accent">
          {mode}
        </dd>
      </dl>
    </section>
  );
}

interface SectionProps {
  number: string;
  title: string;
  children: React.ReactNode;
}

function Section({ number, title, children }: SectionProps) {
  return (
    <section className="px-10 pt-10 md:px-12">
      <h2 className="pb-2 text-[19px] font-semibold tracking-tight text-text">
        <span className="mr-2 text-text-muted">{number}</span>
        {title}
      </h2>
      <Separator />
      <div className="pt-5">{children}</div>
    </section>
  );
}
