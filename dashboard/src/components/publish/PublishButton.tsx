import { useEffect, useRef, useState } from "react";
import { useAccount, usePublicClient, useWriteContract, useChainId } from "wagmi";
import { decodeEventLog, stringToHex, type Hex } from "viem";
import { Upload } from "@phosphor-icons/react";
import { toast } from "sonner";
import { compilePolicy, policyIdFor, WARD_ORACLE_ABI } from "@ward/sdk";
import type { CompileResult } from "../../hooks/usePolicyDraft";
import { useEventStore } from "../../hooks/useEventStore";
import { useWrongNetwork } from "../../hooks/useWrongNetwork";
import { Alert, Button, ExplorerLink } from "../primitives";
import { humanizeWeb3Error } from "../../lib/humanizeError";
import { PolicyDraftSchema, type PolicyDraft } from "../../lib/policy-draft";
import { simulateAndWritePublish, type WriteContractAsync } from "../../lib/writes";
import { ACTIVE_CHAIN_ID, NETWORKS } from "../../lib/networks";

interface Props {
  oracleAddress: `0x${string}`;
  queueAddress: `0x${string}`;
  label: string;
  draft: PolicyDraft;
  yamlText: string;
  compileResult: CompileResult;
  onPublished: (result: PublishedResult) => void;
  /** Called once on click, before the wallet flow opens, so the draft hook
   *  can flip hasAttemptedPublish=true and start rendering all field errors. */
  markPublishAttempt?: () => void;
}

export interface PublishedResult {
  policyId: Hex;
  txHash: Hex;
  publisher: `0x${string}`;
  label: string;
  /** Yaml that was compiled at click-time (fresh, not the render-time memo).
   *  Threaded up so the post-success reveal + localStorage cache reflect
   *  exactly what went on-chain, even if the draft form drifted between the
   *  last memo and the click. Optional because URL-revisit / EventStore /
   *  on-chain fallback paths construct PublishedResult without a fresh
   *  compile — those flows pull yaml from the cache instead. */
  yamlText?: string;
  /** Stringified PolicyInput (with bigint→string replacer) for the same
   *  fresh compileResult that the tx used — keeps the reveal/cache aligned
   *  with the on-chain args. Optional for the same reason as `yamlText`. */
  policyInputJSON?: string;
}

type State =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "mining"; txHash: Hex }
  | { kind: "verifying"; txHash: Hex }
  | { kind: "error"; humanized: { headline: string; detail?: string } };

export function PublishButton({
  oracleAddress,
  queueAddress,
  label,
  draft,
  yamlText,
  compileResult,
  onPublished,
  markPublishAttempt,
}: Props) {
  const { address: publisher, isConnected } = useAccount();
  const { wrong: rawWrong, current: currentChainId, expected: expectedChainId } = useWrongNetwork();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { store } = useEventStore();
  const walletChainId = useChainId();
  const [state, setState] = useState<State>({ kind: "idle" });

  // Existing publish flow gated wrong-network on `isConnected` so the warning
  // doesn't render before the user has connected anything. Keep the same gate
  // when consuming the centralized hook.
  const wrongNetwork = isConnected && rawWrong;

  // Lock publisher account at preview. Capture the FIRST non-null
  // address as the "previewed" account; if the user switches wallets between
  // previewing the form and clicking publish, we surface a warning and abort
  // before the wallet popup so the policy isn't published from the wrong
  // signer. We never auto-refresh — only the "Re-check" button resets the
  // captured value (so a silent wallet switch can't be hidden by a re-render).
  const accountAtPreviewRef = useRef<`0x${string}` | null>(null);
  const [accountDriftWarning, setAccountDriftWarning] = useState<string | null>(null);
  useEffect(() => {
    if (publisher && accountAtPreviewRef.current === null) {
      accountAtPreviewRef.current = publisher;
    }
  }, [publisher]);

  const labelHex = label ? (stringToHex(label, { size: 32 }) as Hex) : null;
  const predictedId = publisher && labelHex ? policyIdFor(publisher, labelHex) : null;

  async function onClick() {
    // Flip hasAttemptedPublish FIRST so error gating reveals any blocking
    // field errors even if we bail on the guard below.
    markPublishAttempt?.();
    if (!publisher || !labelHex || !publicClient || !compileResult.ok) return;

    // If the user switched wallets between the initial preview and now, abort
    // before submitting so the policy isn't
    // signed by an unexpected address. The "Re-check" button (below) is the
    // only way to refresh the captured value, so a silent switch can't slip
    // through across re-renders.
    if (accountAtPreviewRef.current && accountAtPreviewRef.current.toLowerCase() !== publisher.toLowerCase()) {
      setAccountDriftWarning(
        `Connected account changed since the preview. Reload to publish from ${publisher}.`,
      );
      return;
    }

    setState({ kind: "submitting" });
    try {
      // Submit-time re-validation: compileResult was computed on the last
      // draft mutation. If the form has been open across an
      // expiry boundary (or any other check that depends on `Date.now()`),
      // the memo is stale and could publish a tx the contract will revert.
      // Re-run BOTH the schema parse AND the SDK compile against the
      // current draft/yaml and use the fresh PolicyInput downstream.
      const reparsed = PolicyDraftSchema.safeParse(draft);
      if (!reparsed.success) {
        setState({
          kind: "error",
          humanized: {
            headline: "Your form drifted out of validity. Please review.",
            detail: reparsed.error.issues
              .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
              .join("; "),
          },
        });
        return;
      }
      let policyInput;
      try {
        policyInput = compilePolicy(yamlText, {
          oracleAddress,
          queueAddress,
          label: draft.label,
        });
      } catch (compileErr) {
        setState({
          kind: "error",
          humanized: {
            headline: "Your form drifted out of validity. Please review.",
            detail: (compileErr as Error).message,
          },
        });
        return;
      }
      // `simulateAndWritePublish` calls `simulateContract` before
      // `writeContractAsync` so any on-chain revert
      // (policyId taken, EIP-55 mismatch, validation failure) surfaces in the
      // catch below BEFORE the wallet popup opens, instead of after the user
      // pays gas. The helper also threads the chainId override so wagmi
      // aborts at the network boundary if the wallet's on the wrong chain.
      const { txHash } = await simulateAndWritePublish({
        publicClient,
        // wagmi's writeContractAsync has a stricter generic signature than the
        // structural `WriteContractAsync` writes.ts declares — same cast
        // rationale as the policy-management modals (see PauseConfirmModal).
        writeContractAsync: writeContractAsync as WriteContractAsync,
        oracleAddress,
        account: publisher,
        labelHex,
        policyInput,
        chainId: expectedChainId,
      });
      setState({ kind: "mining", txHash });

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

      // Find the PolicyPublished log and confirm it matches our prediction.
      // If the on-chain id ≠ the precomputed one, something is wrong with
      // label encoding — surface it loudly rather than swallow.
      setState({ kind: "verifying", txHash });
      let onChainId: Hex | undefined;
      for (const log of receipt.logs) {
        try {
          const parsed = decodeEventLog({
            abi: WARD_ORACLE_ABI,
            data: log.data,
            topics: log.topics,
          });
          if (parsed.eventName === "PolicyPublished") {
            onChainId = (parsed.args as { policyId: Hex }).policyId;
            break;
          }
        } catch {
          // not a WardOracle event; skip
        }
      }
      if (!onChainId) {
        throw new Error("PolicyPublished event not found in receipt");
      }
      if (predictedId && onChainId.toLowerCase() !== predictedId.toLowerCase()) {
        throw new Error(
          `published policyId ${onChainId} ≠ precomputed ${predictedId}; label encoding mismatch`,
        );
      }

      // Inject the publish into the EventStore so Queue / getPolicy see it
      // immediately, without waiting for the live-watch tick (which has been
      // observed to occasionally miss the publish entirely on Fuji). The
      // *AndPersist variants emit a snapshotUpdated synthetic so the
      // dashboard's IDB writer flushes the new policy + event into the
      // snapshot store — without persistence, a reload between publish and
      // the next live-watch tick would lose the freshly-published entry and
      // force a wasteful on-chain probe via lookupPolicyOnChain. Replaces a
      // prior hydratePolicy + hydrateEvent + bumpSnapshot trio that updated
      // in-memory state and re-rendered subscribers but never persisted.
      if (store) {
        store.hydratePolicyAndPersist({
          policyId: onChainId,
          owner: publisher,
          label: labelHex,
          publishedBlock: receipt.blockNumber,
          lastUpdatedBlock: receipt.blockNumber,
        });
        store.hydrateEventAndPersist({
          type: "PolicyPublished",
          policyId: onChainId,
          owner: publisher,
          label: labelHex,
          blockNumber: receipt.blockNumber,
          // logIndex isn't surfaced by the verification loop and isn't load-
          // bearing for hydration (the SDK only uses (blockNumber, logIndex)
          // for live-emit dedupe, which hydrate bypasses).
          logIndex: 0,
          transactionHash: txHash,
        });
      }

      // Serialize the fresh policyInput (the one passed to writeContractAsync)
      // so the reveal/cache reflect what was actually published — the parent's
      // render-time compileResult.input could be stale if the form drifted
      // between the last render and this click.
      const freshPolicyInputJSON = JSON.stringify(policyInput, (_k, v) =>
        typeof v === "bigint" ? v.toString() : v,
      );
      onPublished({
        policyId: onChainId,
        txHash,
        publisher,
        label,
        yamlText,
        policyInputJSON: freshPolicyInputJSON,
      });
      // Transient confirmation as a toast (the on-page reveal is the
      // authoritative artifact). Action links to the chain explorer for the
      // publish tx so operators can verify on-chain without leaving the page.
      const explorerBase =
        NETWORKS[walletChainId || ACTIVE_CHAIN_ID]?.explorer ??
        NETWORKS[ACTIVE_CHAIN_ID]?.explorer;
      toast.success(`Policy published. id ${onChainId.slice(0, 10)}…`, {
        action: explorerBase
          ? {
              label: "view on explorer",
              onClick: () => {
                window.open(`${explorerBase}/tx/${txHash}`, "_blank", "noopener,noreferrer");
              },
            }
          : undefined,
      });
      setState({ kind: "idle" });
    } catch (e) {
      // Pass the raw error (not a string) into humanizeWeb3Error so the
      // BaseError → ContractFunctionRevertedError branch can fire — otherwise
      // contract reverts surface as opaque "Transaction failed." instead of
      // their decoded shortMessage / data.errorName.
      const humanized = humanizeWeb3Error(e);
      toast.error(`Publish failed: ${humanized.headline}`);
      setState({ kind: "error", humanized });
    }
  }

  const accountDrifted =
    accountAtPreviewRef.current !== null &&
    publisher !== undefined &&
    accountAtPreviewRef.current.toLowerCase() !== publisher.toLowerCase();

  const disabled =
    !publisher ||
    !labelHex ||
    !compileResult.ok ||
    wrongNetwork ||
    accountDrifted ||
    state.kind === "submitting" ||
    state.kind === "mining" ||
    state.kind === "verifying";

  const humanized = state.kind === "error" ? state.humanized : null;

  function recheckAccount() {
    accountAtPreviewRef.current = publisher ?? null;
    setAccountDriftWarning(null);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
        <span className="text-text-muted">policy id</span>
        <code className="break-all font-mono text-[12px] tabular-nums text-text">
          {predictedId ??
            (!publisher
              ? "(connect wallet to preview id)"
              : !labelHex
                ? "(enter a short id to preview)"
                : null)}
        </code>
      </div>

      {wrongNetwork && (
        <Alert variant="warn" title="Wrong network">
          {`Connected to chain ${currentChainId ?? "?"}. Switch to Avalanche Fuji (${expectedChainId}) before submitting.`}
        </Alert>
      )}

      {(accountDrifted || accountDriftWarning) && (
        <Alert variant="warn" title="Connected account changed">
          <div className="space-y-2">
            <div>
              {accountDriftWarning ??
                `Connected account changed since the preview. Reload to publish from ${publisher}.`}
            </div>
            <Button variant="ghost" size="sm" onClick={recheckAccount}>
              Re-check with current account
            </Button>
          </div>
        </Alert>
      )}

      <Button
        variant="accent"
        size="md"
        disabled={disabled}
        onClick={onClick}
        className="inline-flex w-full items-center justify-center gap-1.5"
      >
        {(state.kind === "idle" || state.kind === "error") && (
          <Upload size={14} weight="regular" aria-hidden />
        )}
        {state.kind === "submitting" && "submit … confirm in wallet"}
        {state.kind === "mining" && "mining tx …"}
        {state.kind === "verifying" && "verifying policyId …"}
        {(state.kind === "idle" || state.kind === "error") &&
          (publisher ? "publish policy" : "connect wallet to publish")}
      </Button>

      {(state.kind === "mining" || state.kind === "verifying") && (
        <div className="mt-3 border-t border-rule pt-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-text-muted">{state.kind === 'mining' ? 'Mining publishPolicy…' : 'Verifying policyId…'}</span>
            <ExplorerLink txHash={state.txHash} />
          </div>
          <div className="mt-1 break-all font-mono text-[12px] tabular-nums text-text">{state.txHash}</div>
        </div>
      )}

      {state.kind === "error" && humanized && (
        <Alert variant="danger" title="Publish failed">
          <div>{humanized.headline}</div>
          {humanized.detail && (
            <div className="mt-1 font-mono text-[11px] text-text-muted break-all">{humanized.detail}</div>
          )}
        </Alert>
      )}
    </div>
  );
}
