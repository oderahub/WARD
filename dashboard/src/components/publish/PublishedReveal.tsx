import { useState } from "react";
import { useChainId } from "wagmi";
import {
  ArrowSquareOut,
  CheckCircle,
  Copy as CopyIcon,
  DownloadSimple,
  Link as LinkIcon,
} from "@phosphor-icons/react";
import { AddressChip } from "../primitives";
import type { PublishedResult } from "./PublishButton";
import { WatchAgentBinding } from "./WatchAgentBinding";
import { serializeDeploymentParams, useUrlState } from "../../hooks/useUrlState";
import { SOMNIA_CHAIN_ID } from "../../lib/networks";
import type { PublishMode } from "./ModeToggle";
import type { OnChainPolicySnapshot } from "../../lib/onChainPolicyLookup";
import { formatExpiresAtForReveal, isLegacyZeroExpiry } from "../../lib/policy-render";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";

interface Props {
  result: PublishedResult;
  yamlText: string;
  mode: PublishMode;
  /**
   * JSON-serialized PolicyInput from the same compile that produced `result`.
   * Threaded into WatchAgentBinding so the watched entry captures the policy
   * at bind time (chain reconstruction is only a 7-day fallback).
   */
  policyInputJSON?: string;
  /**
   * Direct on-chain lookup result, populated when neither the localStorage
   * cache nor the EventStore had this policy (cross-browser revisit / stale
   * snapshot). Carries paused + expiresAt + recovered label + publish tx
   * so the metadata strip can render real values instead of placeholders.
   */
  chainSnapshot?: OnChainPolicySnapshot | null;
}

// `formatExpiresAt` lives in `lib/policy-render.ts` (`formatExpiresAtForReveal`)
// so the drawer, the diff modal, and this reveal agree on the legacy-0 wording
// ("expired (legacy 0 sentinel)") instead of silently calling it "never".

/**
 * Post-publish reveal. Hero treatment for the policyId (the artifact that
 * gets pasted into agent code), followed by a dedicated "paste this" panel
 * for enforce-mode or WatchAgentBinding for watch-mode, then a quiet
 * metadata strip, then actions.
 *
 * Bookmarkable: the parent (`PublishPage`) pushes the policyId to the URL
 * as `?revealed=…` and restores from localStorage cache on revisit, so this
 * component re-renders identically whether you just published or you opened
 * the URL again next week. When the tx hash is unknown (cross-browser
 * revisit via EventStore fallback), the tx affordance hides cleanly.
 */
export function PublishedReveal({ result, yamlText, mode, policyInputJSON, chainSnapshot }: Props) {
  const { rpc, oracle, queue } = useUrlState();
  const walletChainId = useChainId();
  const chainId = walletChainId || SOMNIA_CHAIN_ID;

  // Prefer the chainSnapshot's tx hash when result's is missing — the
  // on-chain lookup recovers it via topic-filtered getLogs.
  const effectiveTxHash =
    result.txHash && result.txHash !== "0x" && /^0x[0-9a-fA-F]{64}$/.test(result.txHash)
      ? result.txHash
      : chainSnapshot?.txHash && /^0x[0-9a-fA-F]{64}$/.test(chainSnapshot.txHash)
        ? chainSnapshot.txHash
        : null;
  const hasTx = effectiveTxHash !== null;
  const explorerTx = hasTx ? `https://shannon-explorer.somnia.network/tx/${effectiveTxHash}` : null;
  // Preserve non-default deployment params (rpc/oracle/queue/mode) so a
  // recipient on a different oracle/queue lands on the SAME deployment the
  // sender was using — otherwise the recipient silently falls back to the
  // Shannon defaults and may render "not found" or the wrong policy.
  //
  // Use the `mode` prop (the mode the policy was PUBLISHED under), NOT the
  // current URL mode — otherwise a watch-mode publish shared from an
  // enforce-mode session lands the recipient in enforce-mode.
  const shareUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}${window.location.pathname}?tab=publish&revealed=${result.policyId}${serializeDeploymentParams({ rpc, oracle, queue, mode })}`
      : "";

  return (
    <div className="space-y-4">
      {/* -------- Hero: the policyId, the artifact -------- */}
      <section className="rounded-lg border border-sentry-border bg-surface p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="inline-flex items-baseline gap-2 text-base font-semibold text-text-display">
            <CheckCircle
              size={16}
              weight="fill"
              className="self-center text-success"
              aria-hidden
            />
            Published
          </h2>
          {shareUrl && <ShareLinkButton url={shareUrl} />}
        </div>

        <div className="mt-4">
          <div className="text-[10px] font-medium uppercase tracking-wider text-text-muted">
            Policy id
          </div>
          <div className="mt-1 flex items-center gap-2">
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <code className="flex-1 break-all rounded-md bg-bg px-3 py-2 font-mono text-[13px] text-text-display tabular-nums">
                    {result.policyId}
                  </code>
                </TooltipTrigger>
                <TooltipContent side="top">
                  Click copy → paste into your agent contract
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <IconButton onCopy={result.policyId} label="Copy policy id" />
          </div>
        </div>
      </section>

      {/* -------- Next step (watch mode only): bind to one or more agents -------- */}
      {/* Enforce mode used to render a "paste this bytes32 constant into your   */}
      {/* agent contract" block here — that's the legacy hardcode-and-redeploy   */}
      {/* pattern. With late-binding (SentryAgentBase.setPolicyId), the          */}
      {/* PostPublishChecklist below makes the bind a single click + tx, with   */}
      {/* no source edits or redeploy. The constant snippet was redundant +      */}
      {/* actively confused users about which path to take.                      */}
      {mode === "watch" && (
        <section className="rounded-lg border border-accent/40 bg-accent/[0.06] p-4">
          <div className="text-[10px] font-medium uppercase tracking-wider text-accent">
            Next step
          </div>
          <p className="mt-1 text-sm text-text">
            Watch-only: no agent code changes needed. Bind one or more agent addresses below
            and the dashboard will start polling their on-chain calls against this policy.
          </p>
          <div className="mt-3">
            <WatchAgentBinding
              policyId={result.policyId}
              label={result.label}
              chainId={chainId}
              oracleAddress={oracle}
              policyInputJSON={policyInputJSON}
            />
          </div>
        </section>
      )}

      {/* -------- Metadata strip: label · publisher · tx -------- */}
      <section className="rounded-lg border border-sentry-border bg-surface p-4">
        <div className="grid grid-cols-[6rem_1fr] items-baseline gap-x-4 gap-y-3 text-xs">
          <MetaLabel>Label</MetaLabel>
          <MetaValue>
            <code className="font-mono text-text">{result.label}</code>
          </MetaValue>

          <MetaLabel>Publisher</MetaLabel>
          <MetaValue>
            <AddressChip address={result.publisher} />
          </MetaValue>

          {hasTx && (
            <>
              <MetaLabel>Tx</MetaLabel>
              <MetaValue>
                <div className="flex min-w-0 items-center gap-2">
                  <code className="min-w-0 flex-1 truncate font-mono text-text" title={effectiveTxHash!}>
                    {effectiveTxHash}
                  </code>
                  <IconButton onCopy={effectiveTxHash!} label="Copy tx hash" small />
                  <a
                    href={explorerTx!}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-sentry-border px-2 py-1 text-[11px] text-text-muted transition-colors hover:border-accent hover:text-accent"
                    style={{ transitionDuration: "var(--motion-feedback)" }}
                  >
                    <ArrowSquareOut size={12} />
                    explorer
                  </a>
                </div>
              </MetaValue>
            </>
          )}

          {chainSnapshot && (
            <>
              <MetaLabel>Status</MetaLabel>
              <MetaValue>
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider ${
                    chainSnapshot.paused
                      ? "border-warn bg-warn/15 text-warn"
                      : "border-success bg-success/15 text-success"
                  }`}
                >
                  {chainSnapshot.paused ? "Paused" : "Active"}
                </span>
              </MetaValue>

              <MetaLabel>Expires</MetaLabel>
              <MetaValue>
                <span
                  className={`font-mono ${
                    isLegacyZeroExpiry(chainSnapshot.expiresAt)
                      ? "text-danger"
                      : "text-text"
                  }`}
                >
                  {formatExpiresAtForReveal(chainSnapshot.expiresAt)}
                </span>
                {chainSnapshot.expiresAt > 0n && (
                  <span className="ml-2 text-text-subtle">
                    ({chainSnapshot.expiresAt < BigInt(Math.floor(Date.now() / 1000)) ? "expired" : "in the future"})
                  </span>
                )}
              </MetaValue>

              {chainSnapshot.publishBlock !== undefined && (
                <>
                  <MetaLabel>Published</MetaLabel>
                  <MetaValue>
                    <span className="font-mono text-text">block {chainSnapshot.publishBlock.toString()}</span>
                  </MetaValue>
                </>
              )}
            </>
          )}
        </div>

        {chainSnapshot && (
          <p className="mt-4 border-t border-sentry-border pt-3 text-[11px] text-text-subtle">
            Per-target details (selectors, tiers, caps, delays) aren't exposed via on-chain view methods —
            only the publisher, status, and expiry can be recovered. To see the full policy, open this URL
            in the browser where you published, or run{" "}
            <code className="font-mono text-text-muted">sentry compile your-POLICY.md</code> locally.
          </p>
        )}
      </section>

      {/* -------- Actions footer -------- */}
      <div className="flex flex-wrap items-center gap-3">
        {yamlText && <DownloadMarkdownButton label={result.label} yamlText={yamlText} />}
        {!hasTx && (
          <span className="text-[11px] text-text-subtle">
            Revisiting from URL. Original tx hash unavailable on this device.
          </span>
        )}
      </div>
    </div>
  );
}

/* ---------- atoms ---------- */

function MetaLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-medium uppercase tracking-wider text-text-muted">
      {children}
    </div>
  );
}

function MetaValue({ children }: { children: React.ReactNode }) {
  return <div className="min-w-0 text-text">{children}</div>;
}

interface IconButtonProps {
  onCopy: string;
  label: string;
  small?: boolean;
}

function IconButton({ onCopy, label, small }: IconButtonProps) {
  const [copied, setCopied] = useState(false);
  const size = small ? "h-7 w-7" : "h-8 w-8";
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(onCopy);
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              } catch {
                setCopied(false);
              }
            }}
            aria-label={label}
            className={`inline-flex ${size} shrink-0 items-center justify-center rounded-md border transition-colors ${
              copied
                ? "border-success bg-success/15 text-success"
                : "border-sentry-border text-text-muted hover:border-accent hover:text-accent"
            }`}
            style={{ transitionDuration: "var(--motion-feedback)" }}
          >
            {copied ? <CheckCircle size={14} weight="fill" /> : <CopyIcon size={14} />}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{copied ? "Copied" : label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ShareLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        } catch {
          setCopied(false);
        }
      }}
      title="Copy a bookmarkable URL to this reveal"
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] transition-colors ${
        copied
          ? "border-success bg-success/15 text-success"
          : "border-sentry-border text-text-muted hover:border-accent hover:text-accent"
      }`}
      style={{ transitionDuration: "var(--motion-feedback)" }}
    >
      <LinkIcon size={12} />
      {copied ? "Link copied" : "Copy share link"}
    </button>
  );
}

function DownloadMarkdownButton({ label, yamlText }: { label: string; yamlText: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        const blob = new Blob([yamlText], { type: "text/markdown" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${label || "policy"}.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }}
      className="inline-flex items-center gap-1.5 rounded-md border border-sentry-border px-3 py-1.5 text-xs text-text-muted transition-colors hover:border-accent hover:text-accent"
      style={{ transitionDuration: "var(--motion-feedback)" }}
    >
      <DownloadSimple size={13} />
      Download policy.md
    </button>
  );
}
