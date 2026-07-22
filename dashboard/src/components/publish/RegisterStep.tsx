/**
 * Writes the (agent -> policyId) row to WardAgentRegistry for downstream
 * discovery. BindStep is enough for late-bindable agents to gate calls.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { Upload, Info, Copy } from "@phosphor-icons/react";
import { toast } from "sonner";

import {
  WARD_AGENT_REGISTRY_ABI,
  type RegistryAgent,
} from "@ward/sdk";

import { AddressChip, Alert, Input } from "../primitives";
import { TxStatusPanel, type TxState } from "../write/TxStatusPanel";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import { simulateAndWriteRegisterAgent } from "../../lib/registry-actions";
import type { WriteContractAsync } from "../../lib/writes";
import { humanizeWeb3Error } from "../../lib/humanizeError";
import { useWrongNetwork } from "../../hooks/useWrongNetwork";
import { buildWatchedAgentHref } from "./postPublishChecklistState";

export interface RegisterStepProps {
  /** Agent address validated in Step 1. Required — without it there's nothing
   *  to register. */
  agent: Address;
  /** The policyId just published. Pinned onto register() so an existing entry
   *  for the same registrar gets repointed to the freshly-published policy
   *  (the yellow "REPOINT" strip surfaces this explicitly — see
   *  `policyMismatchWarning` below). */
  publishedPolicyId: Hex;
  /** WardAgentRegistry contract address for the current chain. */
  registryAddress: Address;
  /** WardOracle contract address — recorded on the registry row so a
   *  reader can resolve the right policy lookup target. */
  oracleAddress: Address;
  /** Fired when the user clicks Skip OR when the register tx is mined OK.
   *  Lets the orchestrator advance its checklist without prescribing how. */
  onDone?: (outcome: "skipped" | "registered" | "rebound") => void;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_POLICY_ID =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

// Keep the dashboard registration source distinguishable from CLI / SDK flows.
const DEFAULT_TAG = "ward-publish-checklist";

/**
 * Parses a free-form comma-separated tag input into a deduplicated string[],
 * preserving the operator's order. Empty entries are dropped. Always merges
 * in `DEFAULT_TAG` at the end so the source-of-registration is recoverable
 * from a registry walk.
 */
function parseTags(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(",")) {
    const t = raw.trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  if (!seen.has(DEFAULT_TAG)) out.push(DEFAULT_TAG);
  return out;
}

function short(hex: string): string {
  if (hex.length <= 12) return hex;
  return `${hex.slice(0, 10)}…${hex.slice(-6)}`;
}

type EntryState =
  | { kind: "loading" }
  | { kind: "unregistered" }
  | { kind: "registered-by-me"; entry: RegistryAgent }
  | { kind: "registered-by-other"; entry: RegistryAgent }
  | { kind: "rpc-error"; message: string };

export function RegisterStep({
  agent,
  publishedPolicyId,
  registryAddress,
  oracleAddress,
  onDone,
}: RegisterStepProps) {
  const publicClient = usePublicClient();
  const { address: connected, isConnected } = useAccount();
  const { wrong: wrongNetwork, current: currentChainId, expected: expectedChainId } =
    useWrongNetwork();
  const { writeContractAsync } = useWriteContract();

  // Split into two effects so that swapping the connected wallet does NOT
  // re-issue the registry RPC — getAgent(agent) returns the same row
  // regardless of who's connected. Only the by-me / by-other CLASSIFICATION
  // depends on the connected wallet, and that is pure compute over the row
  // we already cached in `fetchedRow`.

  /** Raw row from registry.getAgent. null sentinel = "registry returned a
   *  zero-registrar entry, treat as unregistered". undefined = "still
   *  loading or RPC errored — see fetchError". */
  const [fetchedRow, setFetchedRow] = useState<RegistryAgent | null | undefined>(
    undefined,
  );
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFetchedRow(undefined);
    setFetchError(null);
    if (!publicClient) return;
    (async () => {
      try {
        const row = (await publicClient.readContract({
          address: registryAddress,
          abi: WARD_AGENT_REGISTRY_ABI,
          functionName: "getAgent",
          args: [agent],
        })) as RegistryAgent;
        if (cancelled) return;
        // Zero-registrar means no row exists — registry's `register` reverts
        // when registrar is zero so any legit entry has a non-zero value.
        if (!row || !row.registrar || row.registrar.toLowerCase() === ZERO_ADDRESS) {
          setFetchedRow(null);
          return;
        }
        setFetchedRow(row);
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        setFetchError(message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, registryAddress, agent]);

  // Pure derivation: classify the cached row against the connected wallet.
  // This re-runs synchronously on wallet swaps without any RPC traffic.
  const entryState = useMemo<EntryState>(() => {
    if (fetchError !== null) return { kind: "rpc-error", message: fetchError };
    if (fetchedRow === undefined) return { kind: "loading" };
    if (fetchedRow === null) return { kind: "unregistered" };
    // When disconnected we conservatively render the entry as "by other" —
    // the register button is already disabled when !isConnected, so the
    // classification is purely informational.
    if (!connected) return { kind: "registered-by-other", entry: fetchedRow };
    if (fetchedRow.registrar.toLowerCase() === connected.toLowerCase()) {
      return { kind: "registered-by-me", entry: fetchedRow };
    }
    return { kind: "registered-by-other", entry: fetchedRow };
  }, [fetchedRow, fetchError, connected]);

  const [name, setName] = useState<string>("");
  const [tagsInput, setTagsInput] = useState<string>("");
  const [metadataURI, setMetadataURI] = useState<string>("");
  // Tracks whether the user has manually edited each field, so a late-arriving
  // pre-fill (the registry read resolves AFTER the user already typed) does
  // not blow away their input. A ref (not state) — we only read this inside
  // the pre-fill effect and the onChange handlers, never in render.
  const userEditedRef = useRef<{
    name: boolean;
    tags: boolean;
    metadataURI: boolean;
  }>({ name: false, tags: false, metadataURI: false });

  useEffect(() => {
    if (entryState.kind !== "registered-by-me") return;
    const e = entryState.entry;
    if (!userEditedRef.current.name) setName(e.name);
    if (!userEditedRef.current.tags) setTagsInput(e.tags.join(", "));
    if (!userEditedRef.current.metadataURI) setMetadataURI(e.metadataURI);
  }, [entryState]);

  const nameError = useMemo<string | null>(() => {
    if (name.trim().length === 0) return "Name is required.";
    return null;
  }, [name]);

  const metadataURIError = useMemo<string | null>(() => {
    if (metadataURI.length === 0) return null;
    try {
      const u = new URL(metadataURI);
      if (u.protocol !== "https:" && u.protocol !== "http:" && u.protocol !== "ipfs:") {
        return "Use an http(s):// or ipfs:// URL (or leave blank).";
      }
      return null;
    } catch {
      return "Doesn't look like a URL (or leave blank).";
    }
  }, [metadataURI]);

  const [tx, setTx] = useState<TxState>({ kind: "idle" });

  const txInFlight =
    tx.kind === "awaiting-signature" ||
    tx.kind === "broadcasting" ||
    tx.kind === "mining";

  // Surface same-registrar repoints so an older policy is not silently rebound.
  const policyMismatchWarning = useMemo<
    | { oldPolicyId: Hex }
    | null
  >(() => {
    if (entryState.kind !== "registered-by-me") return null;
    const oldId = entryState.entry.policyId;
    if (oldId === ZERO_POLICY_ID) return null;
    if (oldId.toLowerCase() === publishedPolicyId.toLowerCase()) return null;
    return { oldPolicyId: oldId };
  }, [entryState, publishedPolicyId]);

  const disabled =
    !isConnected ||
    wrongNetwork ||
    nameError !== null ||
    metadataURIError !== null ||
    entryState.kind === "registered-by-other" ||
    entryState.kind === "loading" ||
    txInFlight ||
    (tx.kind === "mined" && tx.ok);

  const parsedTags = useMemo(() => parseTags(tagsInput), [tagsInput]);

  const onClickRegister = useCallback(async () => {
    if (!publicClient || !connected) return;
    if (nameError || metadataURIError) return;
    setTx({ kind: "awaiting-signature" });
    const tags = parsedTags;
    try {
      const { txHash } = await simulateAndWriteRegisterAgent({
        publicClient,
        writeContractAsync: writeContractAsync as WriteContractAsync,
        registryAddress,
        account: connected,
        agent,
        oracleAddress,
        policyId: publishedPolicyId,
        name: name.trim(),
        metadataURI,
        tags,
        chainId: expectedChainId,
      });
      setTx({ kind: "mining", hash: txHash });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      const ok = receipt.status === "success";
      setTx({ kind: "mined", hash: txHash, ok });
      if (ok) {
        const rebound = entryState.kind === "registered-by-me";
        // Include a sonner action that links to the agent on the Watched
        // tab so the operator has a one-click jump from the toast to the
        // catalog row they just created — same target the breadcrumb in
        // the orchestrator points at.
        toast.success(rebound ? "Registry entry updated" : "Agent registered", {
          action: {
            label: "View on Watched",
            onClick: () => {
              window.location.href = buildWatchedAgentHref(agent);
            },
          },
        });
        onDone?.(rebound ? "rebound" : "registered");
      } else {
        toast.error("Register reverted", {
          description: "Transaction mined but reverted on-chain.",
        });
      }
    } catch (e) {
      const humanized = humanizeWeb3Error(e, { functionName: "register" });
      setTx({
        kind: "error",
        message: humanized.headline,
        raw: humanized.detail,
      });
      toast.error("Register failed", { description: humanized.headline });
    }
  }, [
    publicClient,
    connected,
    nameError,
    metadataURIError,
    parsedTags,
    writeContractAsync,
    registryAddress,
    agent,
    oracleAddress,
    publishedPolicyId,
    name,
    metadataURI,
    expectedChainId,
    entryState,
    onDone,
  ]);

  const onClickSkip = useCallback(() => {
    onDone?.("skipped");
  }, [onDone]);

  // Register is an optional follow-up — late-bindable agents work fine with
  // just the bind step. Wrap the whole form in a <details> so the dense
  // "Pinned fields + Name/Tags/Metadata + Register button" block doesn't
  // dominate the post-publish surface for operators who only need on-chain
  // gating. Default-collapsed; tx state (mining/error) auto-opens the panel
  // so a re-render after a failed submit doesn't hide the failure.
  const autoOpen = tx.kind === "mining" || tx.kind === "error";

  return (
    <TooltipProvider delayDuration={150}>
      <details className="group space-y-4" open={autoOpen}>
        <summary className="cursor-pointer list-none">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <h3 className="text-[15px] font-medium text-text group-open:underline">
              Register on WardAgentRegistry
            </h3>
            <span className="text-[11px] uppercase tracking-wider text-text-subtle">
              optional · click to expand
            </span>
          </div>
          <p className="mt-1 text-[12px] text-text-muted">
            Late-bindable agents work fine with just Step 1 (bind). Register if you
            want this agent discoverable in the Watched catalog + by indexers.
          </p>
        </summary>

        <PreCheckBanner state={entryState} />

        {policyMismatchWarning && (
          <Alert variant="warn" title="Existing binding will be REPOINTED">
            <div className="space-y-1">
              <div>
                This agent is already registered by you against{" "}
                <span className="font-mono">
                  {short(policyMismatchWarning.oldPolicyId)}
                </span>
                . Confirming will overwrite the binding to{" "}
                <span className="font-mono">{short(publishedPolicyId)}</span>.
              </div>
              <div className="text-text-muted">
                Skip if you want to keep the existing policy bound on the
                registry row.
              </div>
            </div>
          </Alert>
        )}

        <PinnedFields
          agent={agent}
          publishedPolicyId={publishedPolicyId}
          oracleAddress={oracleAddress}
        />

        <FormFields
          name={name}
          nameError={nameError}
          metadataURI={metadataURI}
          metadataURIError={metadataURIError}
          tagsInput={tagsInput}
          parsedTags={parsedTags}
          disabled={
            entryState.kind === "registered-by-other" ||
            entryState.kind === "loading"
          }
          onNameChange={(v) => {
            setName(v);
            userEditedRef.current.name = true;
          }}
          onTagsChange={(v) => {
            setTagsInput(v);
            userEditedRef.current.tags = true;
          }}
          onMetadataURIChange={(v) => {
            setMetadataURI(v);
            userEditedRef.current.metadataURI = true;
          }}
        />

        {!isConnected && (
          <Alert variant="warn" title="Wallet not connected">
            Connect a wallet from the top bar to register the agent.
          </Alert>
        )}

        {wrongNetwork && (
          <Alert variant="warn" title="Wrong network">
            Connected to chain {currentChainId ?? "?"}. Switch to Somnia
            Shannon ({expectedChainId}) before submitting.
          </Alert>
        )}

        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2 pt-1">
          <RegisterDialog
            disabled={disabled}
            tx={tx}
            rebind={entryState.kind === "registered-by-me"}
            name={name.trim()}
            agent={agent}
            publishedPolicyId={publishedPolicyId}
            onConfirm={onClickRegister}
          />
          <button
            type="button"
            onClick={onClickSkip}
            className="text-sm text-text-muted hover:text-text hover:underline"
          >
            Skip this step
          </button>
        </div>

        <TxStatusPanel tx={tx} miningVerb="register" />
      </details>
    </TooltipProvider>
  );
}

interface PreCheckBannerProps {
  state: EntryState;
}

function PreCheckBanner({ state }: PreCheckBannerProps) {
  if (state.kind === "loading") {
    return (
      <div className="text-[12px] text-text-muted">
        Reading WardAgentRegistry.getAgent…
      </div>
    );
  }
  if (state.kind === "rpc-error") {
    return (
      <Alert variant="warn" title="Couldn't read registry">
        <div className="space-y-1">
          <div>The registry lookup failed: {state.message}</div>
          <div className="text-text-muted">
            You can still attempt to register — simulate will surface
            NotRegistrar if the agent is already registered by another wallet.
          </div>
        </div>
      </Alert>
    );
  }
  if (state.kind === "unregistered") {
    return (
      <div className="text-[12px] text-text-muted">
        No existing registry row for this agent — this will be a fresh
        register().
      </div>
    );
  }
  if (state.kind === "registered-by-me") {
    return (
      <div className="text-[12px] text-text-muted">
        Already registered by you. Form is pre-filled from the existing row;
        confirming overwrites it (including name) with the values below.
      </div>
    );
  }
  // registered-by-other
  return (
    <Alert variant="danger" title="Registered by another wallet">
      <div className="space-y-1">
        <div>
          The registry row was created by{" "}
          <AddressChip address={state.entry.registrar} />. Only that wallet
          can overwrite it (the registry reverts with NotRegistrar). Skip
          this step — the agent is already discoverable.
        </div>
        <div className="text-text-muted">
          Existing policyId:{" "}
          <span className="font-mono">{short(state.entry.policyId)}</span>
        </div>
      </div>
    </Alert>
  );
}

interface PinnedFieldsProps {
  agent: Address;
  publishedPolicyId: Hex;
  oracleAddress: Address;
}

function PinnedFields({ agent, publishedPolicyId, oracleAddress }: PinnedFieldsProps) {
  return (
    <div className="rounded-md border border-ward-border bg-surface p-3">
      <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
        Pinned from Step 1 + publish
      </div>
      <dl className="mt-2 grid grid-cols-[110px_1fr] gap-y-1.5 gap-x-3 text-[12px]">
        <dt className="text-text-muted">Agent</dt>
        <dd className="font-mono break-all text-text">
          {agent}{" "}
          <CopyInline value={agent} label="agent" />
        </dd>
        <dt className="text-text-muted">Policy id</dt>
        <dd className="font-mono break-all text-text">
          {publishedPolicyId}{" "}
          <CopyInline value={publishedPolicyId} label="policyId" />
        </dd>
        <dt className="text-text-muted">Oracle</dt>
        <dd className="font-mono break-all text-text">{oracleAddress}</dd>
      </dl>
    </div>
  );
}

interface FormFieldsProps {
  name: string;
  nameError: string | null;
  metadataURI: string;
  metadataURIError: string | null;
  tagsInput: string;
  parsedTags: string[];
  disabled: boolean;
  onNameChange: (v: string) => void;
  onTagsChange: (v: string) => void;
  onMetadataURIChange: (v: string) => void;
}

function FormFields({
  name,
  nameError,
  metadataURI,
  metadataURIError,
  tagsInput,
  parsedTags,
  disabled,
  onNameChange,
  onTagsChange,
  onMetadataURIChange,
}: FormFieldsProps) {
  return (
    <div className="space-y-3">
      <div>
        <label
          htmlFor="register-name"
          className="block text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted"
        >
          Name <span className="text-danger">*</span>
        </label>
        <Input
          id="register-name"
          value={name}
          disabled={disabled}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="e.g. Treasury rebalancer"
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? "register-name-error" : undefined}
          className="mt-1 w-full max-w-2xl"
        />
        {nameError && (
          <p id="register-name-error" className="mt-1 text-[12px] text-danger">
            {nameError}
          </p>
        )}
      </div>

      <div>
        <label
          htmlFor="register-tags"
          className="block text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted"
        >
          Tags{" "}
          <InfoTip>
            Comma-separated. `{DEFAULT_TAG}` is appended automatically so the
            source of this registration is recoverable from a registry walk.
          </InfoTip>
        </label>
        <Input
          id="register-tags"
          value={tagsInput}
          disabled={disabled}
          onChange={(e) => onTagsChange(e.target.value)}
          placeholder="e.g. defi, treasury, mainnet-ops"
          className="mt-1 w-full max-w-2xl"
        />
        <p className="mt-1 text-[11px] text-text-muted">
          Will be saved as:{" "}
          <span className="font-mono">{JSON.stringify(parsedTags)}</span>
        </p>
      </div>

      <div>
        <label
          htmlFor="register-metadata"
          className="block text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted"
        >
          Metadata URI{" "}
          <InfoTip>
            Optional. http(s):// or ipfs:// URL pointing to a manifest /
            README / spec. Indexers may surface this in the agent panel.
          </InfoTip>
        </label>
        <Input
          id="register-metadata"
          value={metadataURI}
          disabled={disabled}
          onChange={(e) => onMetadataURIChange(e.target.value)}
          placeholder="https://… or ipfs://… (optional)"
          aria-invalid={metadataURIError ? true : undefined}
          aria-describedby={
            metadataURIError ? "register-metadata-error" : undefined
          }
          className="mt-1 w-full max-w-2xl font-mono"
        />
        {metadataURIError && (
          <p id="register-metadata-error" className="mt-1 text-[12px] text-danger">
            {metadataURIError}
          </p>
        )}
      </div>
    </div>
  );
}

interface RegisterDialogProps {
  disabled: boolean;
  tx: TxState;
  rebind: boolean;
  name: string;
  agent: Address;
  publishedPolicyId: Hex;
  onConfirm: () => void;
}

function RegisterDialog({
  disabled,
  tx,
  rebind,
  name,
  agent,
  publishedPolicyId,
  onConfirm,
}: RegisterDialogProps) {
  const buttonLabel = (() => {
    switch (tx.kind) {
      case "awaiting-signature":
        return "confirm in wallet…";
      case "broadcasting":
        return "broadcasting…";
      case "mining":
        return "mining…";
      case "mined":
        if (tx.ok) return rebind ? "registry updated" : "agent registered";
        return rebind ? "Re-register" : "Register agent";
      default:
        return rebind ? "Update registry entry" : "Register agent";
    }
  })();

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline disabled:cursor-not-allowed disabled:text-text-muted disabled:no-underline"
        >
          <Upload size={14} weight="regular" aria-hidden />
          {buttonLabel}
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {rebind ? "Update registry entry" : "Register agent"}
          </DialogTitle>
          <DialogDescription>
            Signs a WardAgentRegistry.register transaction. Your wallet
            will pop up to confirm.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[90px_1fr] gap-y-1.5 gap-x-3 text-[12px]">
          <dt className="text-text-muted">Name</dt>
          <dd className="break-all text-text">{name}</dd>
          <dt className="text-text-muted">Agent</dt>
          <dd className="font-mono break-all text-text">{agent}</dd>
          <dt className="text-text-muted">Policy id</dt>
          <dd className="font-mono break-all text-text">{publishedPolicyId}</dd>
        </dl>
        <DialogFooter>
          <DialogClose asChild>
            <button
              type="button"
              className="text-sm text-text-muted hover:underline"
            >
              Cancel
            </button>
          </DialogClose>
          <DialogClose asChild>
            <button
              type="button"
              onClick={onConfirm}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline"
            >
              <Upload size={14} weight="regular" aria-hidden />
              {rebind ? "Confirm update" : "Confirm register"}
            </button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface InfoTipProps {
  children: React.ReactNode;
}

function InfoTip({ children }: InfoTipProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="More info"
          className="inline-flex items-center text-text-muted hover:text-accent align-middle"
        >
          <Info size={12} weight="regular" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[260px] text-[12px] leading-snug">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}

interface CopyInlineProps {
  value: string;
  label: string;
}

function CopyInline({ value, label }: CopyInlineProps) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard unavailable; swallow silently
    }
  }, [value]);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onCopy}
          aria-label={`Copy ${label}`}
          className="inline-flex items-center text-text-muted hover:text-accent align-middle"
        >
          <Copy size={12} weight="regular" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : `Copy ${label}`}</TooltipContent>
    </Tooltip>
  );
}
