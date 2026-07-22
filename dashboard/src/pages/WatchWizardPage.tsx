/**
 * Watch Wizard — 60-second flow for setting up Slack alerts (and optional
 * registry registration) for a Somnia agent.
 *
 * 3 steps:
 *   1. Paste address → validate → discover (read-only RPC probe).
 *   2. Discovery report on the left, 3 deterministic policy tiers on the
 *      right (CONSERVATIVE / BALANCED / AGGRESSIVE). Operator picks a tier.
 *   3. Publish policy → register agent → save Slack webhook (IDB only) →
 *      send a clearly-marked test alert.
 *
 * Scope honesty: when the agent is NOT Ward-aware (no WardOracle /
 * WardQueue interaction in the lookback window AND no registry row), the
 * wizard renders the "observation mode" banner — alerts will fire AFTER the
 * fact, NOT in real time. Real-time gating only works for Ward-aware
 * agents that call WardOracle.checkIntent themselves.
 *
 * Registrar honesty: when the agent is already registered under a DIFFERENT
 * wallet, Sub-cards A (publish) and B (register) are gated off — the
 * operator can still subscribe to Slack alerts bound to the EXISTING
 * registry policyId, but they cannot bind a new policy from their wallet.
 * The Done banner in that path says "observation-only subscription saved".
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  decodeEventLog,
  formatEther,
  getAddress,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import {
  Bookmark,
  Lightning,
  MagnifyingGlass,
  PaperPlaneTilt,
  Scales,
  ShieldCheck,
  Upload,
  BellSimple,
  Copy,
  Info,
} from "@phosphor-icons/react";
import { toast } from "sonner";

import {
  policyIdFor,
  WARD_ORACLE_ABI,
  TIER_DELAYED,
  TIER_IMMEDIATE,
  TIER_VETO_REQUIRED,
  type PolicyInput,
} from "@ward/sdk";

import {
  AddressChip,
  Alert,
  ExplorerLink,
  Input,
  SkeletonLines,
} from "../components/primitives";
import { Spinner } from "../components/write/Spinner";
import { TxStatusPanel, type TxState } from "../components/write/TxStatusPanel";

import { useUrlState } from "../hooks/useUrlState";
import { useWrongNetwork } from "../hooks/useWrongNetwork";
import { humanizeWeb3Error } from "../lib/humanizeError";
import { SOMNIA_CHAIN_ID, getNetwork } from "../lib/networks";
import {
  discoverAgent,
  type DiscoveryReport,
} from "../lib/discovery";
import {
  recommendPolicies,
  type RecommendationResult,
  type TierName,
  type TierRecommendation,
} from "../lib/policy-recommender";
import {
  loadWatchSubscription,
  saveWatchSubscription,
} from "../lib/persistence";
import {
  maskWebhookUrl,
  sendTestAlert,
  validateWebhookUrl,
  type SendTestAlertResult,
} from "../lib/slack";
import {
  maskBotToken,
  sendTestAlertTelegram,
  validateBotToken,
  validateChatId,
  type SendTestAlertTelegramResult,
} from "../lib/telegram";
import {
  simulateAndWritePublish,
  simulateAndWriteRegisterAgent,
  type WriteContractAsync,
} from "../lib/writes";

import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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

const DASHBOARD_VERSION = "v0.10.0";

type Step = 1 | 2 | 3;

type DiscoveryState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; report: DiscoveryReport }
  | { kind: "error"; message: string };

// SlackState is the post-test-alert state regardless of channel — the
// channel-agnostic name is `AlertSendState` but we keep the original alias
// to minimize churn in downstream prop types. The `message` is already
// generic.
type SlackState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "ok"; sentAt: number }
  | { kind: "error"; message: string };

/** Which alert channel the operator picked on Step 3. Only one channel is
 *  saved per subscription, per spec. */
type AlertChannel = "slack" | "telegram";

interface WizardState {
  step: Step;
  addressInput: string;
  addressError: string | null;
  validatedAddress: Address | null;
  label: string;
  discovery: DiscoveryState;
  chosenTier: TierName | null;
  recommendations: RecommendationResult | null;
  /** Which channel the operator selected for this subscription. Defaults
   *  to slack so an operator who never touches the toggle gets the v0.10.x
   *  path unchanged. */
  alertChannel: AlertChannel;
  webhookInput: string;
  webhookError: string | null;
  /** Telegram bot token + chat_id inputs (both operator secrets). Rendered
   *  as <input type="password"> in SubSectionC. Independent from
   *  webhookInput because the operator may toggle channels mid-flow. */
  telegramBotTokenInput: string;
  telegramChatIdInput: string;
  telegramBotTokenError: string | null;
  telegramChatIdError: string | null;
  /** True iff the operator has saved EITHER a Slack webhook or a Telegram
   *  binding for the current subscription. Named after the historical
   *  Slack-only flow to keep the prop surface stable. */
  webhookSaved: boolean;
  webhookSkipped: boolean;
  publishPolicy: TxState;
  publishedPolicyId: Hex | null;
  registerAgent: TxState;
  saveWebhook:
    | { kind: "idle" }
    | { kind: "saving" }
    | { kind: "saved"; sentAt: number }
    | { kind: "error"; message: string };
  sendTestAlertState: SlackState;
  startedAtMs: number;
}

const RESERVED_PRECOMPILES = new Set<string>([
  "0x0000000000000000000000000000000000000000",
  "0x0000000000000000000000000000000000000001",
  "0x0000000000000000000000000000000000000002",
  "0x0000000000000000000000000000000000000003",
  "0x0000000000000000000000000000000000000004",
  "0x0000000000000000000000000000000000000005",
  "0x0000000000000000000000000000000000000006",
  "0x0000000000000000000000000000000000000007",
  "0x0000000000000000000000000000000000000008",
  "0x0000000000000000000000000000000000000009",
  "0x000000000000000000000000000000000000000a",
]);

// 32-byte UTF-8 cap with NUL/control-byte rejection — mirrors
// `compilePolicy`'s label guard so the previewed policyId matches the
// post-publish value.
function validateLabel(label: string): string | null {
  if (label.length === 0) return "Enter a short label for the policy.";
  let byteLen = 0;
  for (let i = 0; i < label.length; i++) {
    const code = label.charCodeAt(i);
    if (code === 0 || (code > 0 && code < 0x20)) {
      return "Label cannot contain control characters (e.g. NUL, tab).";
    }
    if (code < 0x80) byteLen += 1;
    else if (code < 0x800) byteLen += 2;
    else byteLen += 3;
  }
  if (byteLen > 32) return "Label is longer than 32 UTF-8 bytes.";
  return null;
}

function shortenForLabel(addr: Address, len = 8): string {
  return addr.slice(2, 2 + len).toLowerCase();
}

function relativeFromNow(unixSec: bigint, nowMs: number): string {
  const targetMs = Number(unixSec) * 1000;
  const deltaSec = Math.round((targetMs - nowMs) / 1000);
  if (deltaSec < 60) return `in ${deltaSec}s`;
  if (deltaSec < 3600) return `in ${Math.round(deltaSec / 60)}m`;
  if (deltaSec < 86400) return `in ${Math.round(deltaSec / 3600)}h`;
  return `in ${Math.round(deltaSec / 86400)}d`;
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

const TIER_LABEL: Record<TierName, string> = {
  conservative: "CONSERVATIVE",
  balanced: "BALANCED",
  aggressive: "AGGRESSIVE",
};

function tierEnumName(tier: number): string {
  if (tier === TIER_IMMEDIATE) return "IMMEDIATE";
  if (tier === TIER_DELAYED) return "DELAYED";
  if (tier === TIER_VETO_REQUIRED) return "VETO_REQUIRED";
  return `TIER_${tier}`;
}

interface SectionProps {
  number: string;
  title: string;
  meta?: ReactNode;
  children: ReactNode;
}

function Section({ number, title, meta, children }: SectionProps) {
  return (
    <section className="mx-auto w-full max-w-[1100px] px-10 pt-10 md:px-16">
      <div className="flex items-baseline justify-between gap-3 border-b border-rule pb-2">
        <h2 className="text-[19px] font-semibold tracking-tight text-text">
          <span className="mr-2 text-text-muted">{number}</span>
          {title}
        </h2>
        {meta && (
          <span className="text-[11px] text-text-muted">{meta}</span>
        )}
      </div>
      <div className="pt-5">{children}</div>
    </section>
  );
}

interface MetaRowProps {
  label: string;
  children: ReactNode;
  mono?: boolean;
}

interface CopyButtonProps {
  value: string;
  label: string;
}

function CopyButton({ value, label }: CopyButtonProps) {
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
          className="inline-flex items-center text-text-muted hover:text-accent"
        >
          <Copy size={12} weight="regular" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : `Copy ${label}`}</TooltipContent>
    </Tooltip>
  );
}

interface HelpTipProps {
  children: ReactNode;
}

function HelpTip({ children }: HelpTipProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="More info"
          className="inline-flex items-center text-text-muted hover:text-accent"
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

function MetaRow({ label, children, mono }: MetaRowProps) {
  return (
    <>
      <dt className="text-text-muted">{label}</dt>
      <dd className={mono ? "font-mono text-[12px] text-text" : "text-text"}>
        {children}
      </dd>
    </>
  );
}

export function WatchWizardPage() {
  const network = getNetwork(SOMNIA_CHAIN_ID)!;
  const oracleAddress = network.oracleAddress;
  const queueAddress = network.queueAddress;
  const registryAddress = network.registryAddress!;

  const { setTab } = useUrlState();
  const publicClient = usePublicClient();
  const { address: publisher, isConnected } = useAccount();
  const {
    wrong: rawWrong,
    current: currentChainId,
    expected: expectedChainId,
  } = useWrongNetwork();
  const wrongNetwork = isConnected && rawWrong;
  const { writeContractAsync } = useWriteContract();

  const [state, setState] = useState<WizardState>(() => ({
    step: 1,
    addressInput: "",
    addressError: null,
    validatedAddress: null,
    label: "",
    discovery: { kind: "idle" },
    chosenTier: null,
    recommendations: null,
    alertChannel: "slack",
    webhookInput: "",
    webhookError: null,
    telegramBotTokenInput: "",
    telegramChatIdInput: "",
    telegramBotTokenError: null,
    telegramChatIdError: null,
    webhookSaved: false,
    webhookSkipped: false,
    publishPolicy: { kind: "idle" },
    publishedPolicyId: null,
    registerAgent: { kind: "idle" },
    saveWebhook: { kind: "idle" },
    sendTestAlertState: { kind: "idle" },
    startedAtMs: Date.now(),
  }));

  const patch = useCallback((next: Partial<WizardState>) => {
    setState((prev) => ({ ...prev, ...next }));
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const preset = params.get("address");
    if (preset) patch({ addressInput: preset });
    // Run-once: this effect deliberately ignores changes to ?address after
    // mount — wizard step state lives in local React state, not the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Return a discriminated union: viem `Address` is a branded string subtype,
  // so `typeof result === "string"` is true for BOTH branches at runtime — a
  // `Address | string` return would collapse the two cases and silently route
  // every valid address through the error path. The discriminator avoids that.
  const validateAddressInput = useCallback((): { ok: true; address: Address } | { ok: false; error: string } => {
    const raw = state.addressInput.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
      return { ok: false, error: "Enter a 0x-prefixed 40-hex address." };
    }
    let checksummed: Address;
    try {
      checksummed = getAddress(raw);
    } catch {
      return { ok: false, error: "Address checksum invalid. Paste the exact checksummed form, or paste it in all-lowercase." };
    }
    const lower = checksummed.toLowerCase();
    if (lower === oracleAddress.toLowerCase()) {
      return { ok: false, error: "This is the Ward oracle address itself. Watching it would be circular." };
    }
    if (lower === queueAddress.toLowerCase()) {
      return { ok: false, error: "This is the Ward queue address itself. Watching it would be circular." };
    }
    if (lower === registryAddress.toLowerCase()) {
      return { ok: false, error: "This is the Ward registry address itself. Watching it would be circular." };
    }
    if (RESERVED_PRECOMPILES.has(lower)) {
      return { ok: false, error: "Reserved address; cannot watch." };
    }
    return { ok: true, address: checksummed };
  }, [state.addressInput, oracleAddress, queueAddress, registryAddress]);

  const runDiscovery = useCallback(
    async (address: Address) => {
      // Re-click guard — bail if a discovery is already in flight rather than
      // racing two concurrent RPC fan-outs against the same address. The
      // Discover button is also disabled in this state, but defence-in-depth
      // (other call sites: retry-discovery in Step 2) keeps the invariant
      // local to this callback.
      if (state.discovery.kind === "loading") return;
      if (!publicClient) {
        patch({
          discovery: {
            kind: "error",
            message: "Public RPC client is not ready. Refresh the page.",
          },
        });
        return;
      }
      patch({ discovery: { kind: "loading" } });
      try {
        const report = await discoverAgent({ publicClient, address });
        // Pin nowSec to the wizard's startedAtMs so retries within the same
        // session produce byte-identical recommendations — matches the
        // determinism contract documented on RecommendOpts in
        // policy-recommender.ts.
        const recs = recommendPolicies(report, {
          nowSec: BigInt(Math.floor(state.startedAtMs / 1000)),
        });
        setState((prev) => ({
          ...prev,
          discovery: { kind: "ok", report },
          recommendations: recs,
          // Pre-pick the recommended tier so the operator has a default —
          // they still have to click "Continue" to advance.
          chosenTier: prev.chosenTier ?? recs.defaultTier,
        }));
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "Discovery failed for an unknown reason.";
        patch({ discovery: { kind: "error", message } });
      }
    },
    [publicClient, patch, state.discovery.kind, state.startedAtMs],
  );

  const onClickDiscover = useCallback(() => {
    const result = validateAddressInput();
    if (!result.ok) {
      patch({ addressError: result.error });
      return;
    }
    const addr = result.address;
    const defaultLabel = `watch-${shortenForLabel(addr)}`;
    patch({
      addressError: null,
      validatedAddress: addr,
      label: state.label || defaultLabel,
      step: 2,
    });
    runDiscovery(addr);
  }, [validateAddressInput, patch, runDiscovery, state.label]);

  const onClickPasteMyWallet = useCallback(() => {
    if (publisher) {
      patch({ addressInput: publisher, addressError: null });
    }
  }, [publisher, patch]);

  const discoveryOk =
    state.discovery.kind === "ok" ? state.discovery.report : null;
  const recommendations = state.recommendations;

  // alreadyRegistered + ownership check (drives gating of Sub-cards A / B).
  // When the wallet is disconnected we genuinely don't know who registered
  // the agent, so we deliberately do NOT short-circuit to true here — that
  // would falsely lock unconnected users out of the observation-mode flow.
  // The publish/register sub-cards are independently gated on walletConnected,
  // so leaving this false-by-default is safe.
  const alreadyRegisteredByOther = useMemo(() => {
    if (!discoveryOk || !discoveryOk.alreadyRegistered.registered) return false;
    if (!publisher) return false;
    return (
      discoveryOk.alreadyRegistered.entry.registrar.toLowerCase() !==
      publisher.toLowerCase()
    );
  }, [discoveryOk, publisher]);

  const alreadyRegisteredByMe = useMemo(() => {
    if (!discoveryOk || !discoveryOk.alreadyRegistered.registered) return false;
    if (!publisher) return false;
    return (
      discoveryOk.alreadyRegistered.entry.registrar.toLowerCase() ===
      publisher.toLowerCase()
    );
  }, [discoveryOk, publisher]);

  // RPC-timeout sentinel for the registry probe.
  const registryRpcTimeout = useMemo(() => {
    if (!discoveryOk) return false;
    return discoveryOk.errors.some((e) => e.probe === "registry-getAgent");
  }, [discoveryOk]);

  // labelHex is derived here (before the policyId derivations) because the
  // observation-mode synthesized policyId below depends on it.
  const labelHex = useMemo(
    () => (state.label ? (stringToHex(state.label, { size: 32 }) as Hex) : null),
    [state.label],
  );

  // Bind the subscription to the EXISTING registry entry.policyId whenever
  // the agent is already registered — regardless of who registered it. The
  // operator might be:
  //   - watching someone else's agent (alreadyRegisteredByOther), or
  //   - updating Slack alerts on an agent they themselves registered
  //     (alreadyRegisteredByMe).
  // Either way the canonical policyId lives in the registry entry.
  const registeredEntryPolicyId: Hex | null = useMemo(() => {
    if (!discoveryOk?.alreadyRegistered.registered) return null;
    return discoveryOk.alreadyRegistered.entry.policyId;
  }, [discoveryOk]);

  // Observation-mode fallback for unregistered agents: synthesize a
  // deterministic policyId from (publisher-or-validatedAddress, labelHex)
  // using the SDK's policyIdFor helper. This unblocks the wizard for the
  // common path where the agent has never been registered AND the operator
  // can't (or won't) publish a fresh policy. The synthesized id is the same
  // one a future publish from this wallet+label would produce, so subscriptions
  // saved against it stay valid once the policy is published for real.
  const synthesizedObservationPolicyId: Hex | null = useMemo(() => {
    if (registeredEntryPolicyId) return null; // not needed
    if (!labelHex) return null;
    const pub = publisher ?? state.validatedAddress;
    if (!pub) return null;
    return policyIdFor(pub, labelHex);
  }, [registeredEntryPolicyId, labelHex, publisher, state.validatedAddress]);

  // Effective policyId for binding the subscription / sending the test alert.
  // Precedence:
  //   1. publishedPolicyId  — freshly published in this session.
  //   2. registeredEntryPolicyId — existing on-chain registry binding.
  //   3. synthesizedObservationPolicyId — deterministic fallback so the
  //      observation-mode path is never a dead-end.
  const effectivePolicyId: Hex | null =
    state.publishedPolicyId ??
    registeredEntryPolicyId ??
    synthesizedObservationPolicyId;

  const predictedPolicyId = useMemo(() => {
    if (!publisher || !labelHex) return null;
    return policyIdFor(publisher, labelHex);
  }, [publisher, labelHex]);

  // Build a publish-ready PolicyInput from the chosen tier. Requires
  // `recommendations[tier].policy` to be populated — only true when discovery
  // resolved real targets from the registry-bound policy. In every other
  // observation-mode case, the wizard CANNOT publish a policy (no real
  // targets) — Sub-card A is gated off and the wizard saves an
  // observation-only subscription bound to the existing entry.policyId.
  const publishablePolicy: PolicyInput | null = useMemo(() => {
    if (!state.chosenTier || !recommendations) return null;
    const rec: TierRecommendation = recommendations[state.chosenTier];
    return rec.policy ?? null;
  }, [state.chosenTier, recommendations]);

  const labelError = useMemo(() => validateLabel(state.label), [state.label]);

  const onClickPublishPolicy = useCallback(async () => {
    if (!publicClient || !publisher || !labelHex || !publishablePolicy) return;
    if (labelError) return;
    patch({ publishPolicy: { kind: "awaiting-signature" } });
    try {
      const { txHash } = await simulateAndWritePublish({
        publicClient,
        writeContractAsync: writeContractAsync as WriteContractAsync,
        oracleAddress,
        account: publisher,
        labelHex,
        policyInput: publishablePolicy,
        chainId: expectedChainId,
      });
      patch({ publishPolicy: { kind: "mining", hash: txHash } });

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      });

      // Decode PolicyPublished to capture the canonical policyId — matches
      // the PublishButton verification path.
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

      const ok = receipt.status === "success" && onChainId !== undefined;
      patch({
        publishPolicy: { kind: "mined", hash: txHash, ok },
        publishedPolicyId: onChainId ?? null,
      });
      if (ok) {
        toast.success("Policy published", {
          description: onChainId ? `policyId ${onChainId.slice(0, 10)}…` : undefined,
        });
      } else {
        toast.error("Publish reverted", {
          description: "Transaction mined but did not emit PolicyPublished.",
        });
      }
    } catch (e) {
      const humanized = humanizeWeb3Error(e);
      patch({
        publishPolicy: {
          kind: "error",
          message: humanized.headline,
          raw: humanized.detail,
        },
      });
      toast.error("Publish failed", { description: humanized.headline });
    }
  }, [
    publicClient,
    publisher,
    labelHex,
    publishablePolicy,
    labelError,
    patch,
    writeContractAsync,
    oracleAddress,
    expectedChainId,
  ]);

  const onClickRegisterAgent = useCallback(async () => {
    if (!publicClient || !publisher || !state.validatedAddress) return;
    if (!state.publishedPolicyId) return;
    patch({ registerAgent: { kind: "awaiting-signature" } });
    try {
      const { txHash } = await simulateAndWriteRegisterAgent({
        publicClient,
        writeContractAsync: writeContractAsync as WriteContractAsync,
        registryAddress,
        account: publisher,
        agent: state.validatedAddress,
        oracleAddress,
        policyId: state.publishedPolicyId,
        name: state.label,
        metadataURI: "",
        tags: ["ward-watch-wizard"],
        chainId: expectedChainId,
      });
      patch({ registerAgent: { kind: "mining", hash: txHash } });
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      });
      const ok = receipt.status === "success";
      patch({
        registerAgent: {
          kind: "mined",
          hash: txHash,
          ok,
        },
      });
      if (ok) {
        toast.success("Agent registered");
      } else {
        toast.error("Register reverted", {
          description: "Transaction mined but reverted on-chain.",
        });
      }
    } catch (e) {
      const humanized = humanizeWeb3Error(e);
      patch({
        registerAgent: {
          kind: "error",
          message: humanized.headline,
          raw: humanized.detail,
        },
      });
      toast.error("Register failed", { description: humanized.headline });
    }
  }, [
    publicClient,
    publisher,
    state.validatedAddress,
    state.publishedPolicyId,
    state.label,
    patch,
    writeContractAsync,
    registryAddress,
    oracleAddress,
    expectedChainId,
  ]);

  const onChangeWebhook = useCallback(
    (next: string) => {
      patch({
        webhookInput: next,
        webhookError: null,
        // Re-typing after a save resets the "saved" badge so the operator
        // sees the new value will replace the old.
        webhookSaved: false,
      });
    },
    [patch],
  );

  const onBlurWebhook = useCallback(() => {
    if (state.webhookInput.length === 0) return;
    if (!validateWebhookUrl(state.webhookInput)) {
      patch({
        webhookError:
          "Doesn't look like a Slack incoming-webhook URL. Expected https://hooks.slack.com/services/T…/B…/…",
      });
    }
  }, [state.webhookInput, patch]);

  const onChangeAlertChannel = useCallback(
    (next: AlertChannel) => {
      // Toggling the channel must clear ALL stale per-channel state:
      // input values, errors, the saved/skipped flags, and any stale
      // test-alert result. Without this, an operator who saves a Slack
      // webhook then toggles to Telegram could see the "Send test alert"
      // button enabled before they save the Telegram binding. The save in
      // IDB is left in place (it's keyed by (chainId, agent) and survives
      // a channel change; the next save will overwrite it).
      patch({
        alertChannel: next,
        webhookInput: "",
        webhookError: null,
        telegramBotTokenInput: "",
        telegramChatIdInput: "",
        telegramBotTokenError: null,
        telegramChatIdError: null,
        webhookSaved: false,
        webhookSkipped: false,
        saveWebhook: { kind: "idle" },
        sendTestAlertState: { kind: "idle" },
      });
    },
    [patch],
  );

  const onChangeTelegramBotToken = useCallback(
    (next: string) => {
      patch({
        telegramBotTokenInput: next,
        telegramBotTokenError: null,
        webhookSaved: false,
      });
    },
    [patch],
  );

  const onChangeTelegramChatId = useCallback(
    (next: string) => {
      patch({
        telegramChatIdInput: next,
        telegramChatIdError: null,
        webhookSaved: false,
      });
    },
    [patch],
  );

  const onBlurTelegramBotToken = useCallback(() => {
    if (state.telegramBotTokenInput.length === 0) return;
    if (!validateBotToken(state.telegramBotTokenInput)) {
      patch({
        telegramBotTokenError:
          "Doesn't look like a Telegram bot token. Expected <bot-id>:<secret> from @BotFather.",
      });
    }
  }, [state.telegramBotTokenInput, patch]);

  const onBlurTelegramChatId = useCallback(() => {
    if (state.telegramChatIdInput.length === 0) return;
    if (!validateChatId(state.telegramChatIdInput)) {
      patch({
        telegramChatIdError:
          "Expected a numeric chat_id (e.g. 123456789 or -1001234567890) or @username.",
      });
    }
  }, [state.telegramChatIdInput, patch]);

  const onClickSaveWebhook = useCallback(async () => {
    if (!state.validatedAddress) return;
    if (!effectivePolicyId) return;
    if (!state.chosenTier) return;

    if (state.alertChannel === "slack") {
      if (!validateWebhookUrl(state.webhookInput)) {
        patch({
          webhookError:
            "Doesn't look like a Slack incoming-webhook URL. Expected https://hooks.slack.com/services/T…/B…/…",
        });
        return;
      }
      patch({ saveWebhook: { kind: "saving" } });
      try {
        await saveWatchSubscription({
          chainId: SOMNIA_CHAIN_ID,
          agent: state.validatedAddress,
          policyId: effectivePolicyId,
          slackWebhookUrl: state.webhookInput,
          tier: state.chosenTier,
        });
        // Wipe the in-memory URL — UI re-renders the masked form via
        // maskWebhookUrl on the saved value pulled back from IDB on demand.
        patch({
          webhookSaved: true,
          webhookInput: "",
          saveWebhook: { kind: "saved", sentAt: Date.now() },
        });
        toast.success("Webhook saved", {
          description: "Stored in this browser's IndexedDB only.",
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        patch({ saveWebhook: { kind: "error", message } });
        toast.error("Could not save webhook", { description: message });
      }
      return;
    }

    // Telegram channel: validate both inputs before save.
    const tokenOk = validateBotToken(state.telegramBotTokenInput);
    const chatOk = validateChatId(state.telegramChatIdInput);
    if (!tokenOk || !chatOk) {
      patch({
        telegramBotTokenError: tokenOk
          ? null
          : "Doesn't look like a Telegram bot token. Expected <bot-id>:<secret> from @BotFather.",
        telegramChatIdError: chatOk
          ? null
          : "Expected a numeric chat_id (e.g. 123456789 or -1001234567890) or @username.",
      });
      return;
    }
    patch({ saveWebhook: { kind: "saving" } });
    try {
      await saveWatchSubscription({
        chainId: SOMNIA_CHAIN_ID,
        agent: state.validatedAddress,
        policyId: effectivePolicyId,
        telegram: {
          botToken: state.telegramBotTokenInput,
          chatId: state.telegramChatIdInput,
        },
        tier: state.chosenTier,
      });
      // Wipe both secrets from React state — IDB is the only place that
      // retains them, masked back into the UI by SubSectionC.
      patch({
        webhookSaved: true,
        telegramBotTokenInput: "",
        telegramChatIdInput: "",
        saveWebhook: { kind: "saved", sentAt: Date.now() },
      });
      toast.success("Telegram binding saved", {
        description: "Stored in this browser's IndexedDB only.",
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      patch({ saveWebhook: { kind: "error", message } });
      toast.error("Could not save Telegram binding", { description: message });
    }
  }, [
    state.validatedAddress,
    state.alertChannel,
    state.webhookInput,
    state.telegramBotTokenInput,
    state.telegramChatIdInput,
    state.chosenTier,
    effectivePolicyId,
    patch,
  ]);

  const onClickSkipSlack = useCallback(() => {
    patch({ webhookSkipped: true, webhookSaved: false });
  }, [patch]);

  const sendTestCooldownRef = useRef<number>(0);
  const [testCooldown, setTestCooldown] = useState(false);

  const onClickSendTestAlert = useCallback(async () => {
    if (!state.validatedAddress) return;
    if (!effectivePolicyId) return;
    if (!state.chosenTier || !recommendations) return;
    if (testCooldown) return;

    // Re-read the webhook URL from IDB so the in-memory value isn't retained.
    let loaded;
    try {
      loaded = await loadWatchSubscription(
        SOMNIA_CHAIN_ID,
        state.validatedAddress,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      patch({
        sendTestAlertState: {
          kind: "error",
          message: `Couldn't read the saved webhook from IndexedDB: ${message}`,
        },
      });
      return;
    }
    if (!loaded) {
      patch({
        sendTestAlertState: {
          kind: "error",
          message:
            "No saved alert channel found for this agent. Save one first.",
        },
      });
      return;
    }

    const rec = recommendations[state.chosenTier];
    const reasonText = rec.reasoningBullets.join("; ");

    patch({ sendTestAlertState: { kind: "sending" } });
    setTestCooldown(true);
    sendTestCooldownRef.current = window.setTimeout(() => {
      setTestCooldown(false);
    }, 2000);

    // Branch on whichever channel is configured in the loaded subscription.
    // `saveWatchSubscription` enforces exactly-one-channel, so at runtime
    // these branches are mutually exclusive. We do NOT default to Slack
    // when both fields are absent — that would silently swallow a corrupt
    // record; surface the error instead.
    let result: SendTestAlertResult | SendTestAlertTelegramResult;
    try {
      if (loaded.slackWebhookUrl) {
        result = await sendTestAlert({
          webhookUrl: loaded.slackWebhookUrl,
          agent: state.validatedAddress,
          policyId: effectivePolicyId,
          tier: state.chosenTier,
          recommendationReason: reasonText,
          chainId: SOMNIA_CHAIN_ID,
        });
      } else if (loaded.telegram) {
        result = await sendTestAlertTelegram({
          botToken: loaded.telegram.botToken,
          chatId: loaded.telegram.chatId,
          agent: state.validatedAddress,
          policyId: effectivePolicyId,
          tier: state.chosenTier,
          recommendationReason: reasonText,
          chainId: SOMNIA_CHAIN_ID,
        });
      } else {
        patch({
          sendTestAlertState: {
            kind: "error",
            message: "Saved subscription has no alert channel configured.",
          },
        });
        return;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      patch({
        sendTestAlertState: { kind: "error", message },
      });
      toast.error("Test alert failed", { description: message });
      return;
    }
    if (result.ok) {
      patch({
        sendTestAlertState: { kind: "ok", sentAt: result.sentAt },
      });
      toast.success(
        loaded.slackWebhookUrl
          ? "Slack accepted test alert"
          : "Telegram accepted test alert",
      );
    } else {
      const channelLabel = loaded.slackWebhookUrl ? "Slack" : "Telegram";
      const message =
        result.errorMessage ?? `${channelLabel} rejected the test alert.`;
      patch({
        sendTestAlertState: { kind: "error", message },
      });
      toast.error(`${channelLabel} rejected test alert`, { description: message });
    }
  }, [
    state.validatedAddress,
    state.chosenTier,
    recommendations,
    effectivePolicyId,
    patch,
    testCooldown,
  ]);

  useEffect(
    () => () => {
      if (sendTestCooldownRef.current) {
        window.clearTimeout(sendTestCooldownRef.current);
      }
    },
    [],
  );

  // When publish is blocked (no resolved targets OR alreadyRegisteredByOther),
  // the wizard is in observation-only mode. publish/register are not required
  // to consider the wizard "done" — saving the subscription + sending the
  // test alert (or explicitly skipping) is enough.
  const observationOnlyMode =
    alreadyRegisteredByOther || (publishablePolicy === null);

  const publishDone =
    state.publishPolicy.kind === "mined" && state.publishPolicy.ok;
  const registerAgentSkipped = observationOnlyMode || alreadyRegisteredByMe;
  const registerOk =
    registerAgentSkipped ||
    (state.registerAgent.kind === "mined" && state.registerAgent.ok);
  const slackOk =
    state.webhookSkipped ||
    (state.webhookSaved && state.sendTestAlertState.kind === "ok");
  const done = observationOnlyMode
    ? slackOk
    : publishDone && registerOk && slackOk;

  return (
    <TooltipProvider delayDuration={150}>
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-bg text-text">
      <DocumentFrontMatter
        step={state.step}
        startedAtMs={state.startedAtMs}
        publisher={publisher}
        isConnected={isConnected}
        validatedAddress={state.validatedAddress}
        onBackToStep1={() => {
          // Soft reset — keep the discovery cache so revisiting doesn't
          // re-spend the RPC budget unless the address changes.
          patch({ step: 1 });
        }}
      />

      {state.step === 1 && (
        <Section number="" title="Paste a Somnia agent address">
          <Step1Body
            value={state.addressInput}
            error={state.addressError}
            onChange={(v) => patch({ addressInput: v, addressError: null })}
            onBlur={() => {
              // Only validate non-empty inputs on blur — keep first-paint quiet.
              if (state.addressInput.trim().length === 0) return;
              const res = validateAddressInput();
              if (!res.ok) patch({ addressError: res.error });
            }}
            onDiscover={onClickDiscover}
            onPasteWallet={onClickPasteMyWallet}
            walletAddress={publisher}
            walletConnected={isConnected}
            discovering={state.discovery.kind === "loading"}
          />
        </Section>
      )}

      {state.step === 2 && (
        <Step2Sections
          discovery={state.discovery}
          recommendations={recommendations}
          chosenTier={state.chosenTier}
          validatedAddress={state.validatedAddress}
          connectedWallet={publisher}
          isConnected={isConnected}
          registryRpcTimeout={registryRpcTimeout}
          onChooseTier={(t) => patch({ chosenTier: t })}
          onRetryDiscovery={() => {
            if (state.validatedAddress) {
              runDiscovery(state.validatedAddress);
            }
          }}
          onContinue={() => patch({ step: 3 })}
        />
      )}

      {state.step === 3 && state.validatedAddress && state.chosenTier && recommendations && (
        <Step3Sections
          validatedAddress={state.validatedAddress}
          chosenTier={state.chosenTier}
          recommendations={recommendations}
          label={state.label}
          labelHex={labelHex}
          labelError={labelError}
          onLabelChange={(v) => patch({ label: v })}
          predictedPolicyId={predictedPolicyId}
          walletConnected={isConnected}
          wrongNetwork={wrongNetwork}
          currentChainId={currentChainId}
          expectedChainId={expectedChainId}
          publishablePolicy={publishablePolicy}
          alreadyRegisteredByOther={alreadyRegisteredByOther}
          alreadyRegisteredByMe={alreadyRegisteredByMe}
          registrar={
            discoveryOk?.alreadyRegistered.registered
              ? discoveryOk.alreadyRegistered.entry.registrar
              : null
          }
          registryRpcTimeout={registryRpcTimeout}
          publishPolicy={state.publishPolicy}
          publishedPolicyId={state.publishedPolicyId}
          registerAgent={state.registerAgent}
          saveWebhook={state.saveWebhook}
          webhookInput={state.webhookInput}
          webhookError={state.webhookError}
          webhookSaved={state.webhookSaved}
          webhookSkipped={state.webhookSkipped}
          sendTestAlertState={state.sendTestAlertState}
          effectivePolicyId={effectivePolicyId}
          testCooldown={testCooldown}
          alertChannel={state.alertChannel}
          telegramBotTokenInput={state.telegramBotTokenInput}
          telegramChatIdInput={state.telegramChatIdInput}
          telegramBotTokenError={state.telegramBotTokenError}
          telegramChatIdError={state.telegramChatIdError}
          onChangeAlertChannel={onChangeAlertChannel}
          onChangeTelegramBotToken={onChangeTelegramBotToken}
          onChangeTelegramChatId={onChangeTelegramChatId}
          onBlurTelegramBotToken={onBlurTelegramBotToken}
          onBlurTelegramChatId={onBlurTelegramChatId}
          onClickPublishPolicy={onClickPublishPolicy}
          onClickRegisterAgent={onClickRegisterAgent}
          onChangeWebhook={onChangeWebhook}
          onBlurWebhook={onBlurWebhook}
          onClickSaveWebhook={onClickSaveWebhook}
          onClickSkipSlack={onClickSkipSlack}
          onClickSendTestAlert={onClickSendTestAlert}
          onBackToStep2={() => patch({ step: 2 })}
          done={done}
          observationOnlyMode={observationOnlyMode}
          startedAtMs={state.startedAtMs}
          goToWatched={() => {
            // Deep-link into the Subscriptions section of the Watched tab
            // so the operator lands on the row they just saved (rendered
            // by the Subscriptions panel on WatchedPage).
            setTab("watched");
            if (typeof window !== "undefined") {
              window.location.hash = "subscriptions";
            }
          }}
        />
      )}
    </div>
    </TooltipProvider>
  );
}

interface FrontMatterProps {
  step: Step;
  startedAtMs: number;
  publisher: Address | undefined;
  isConnected: boolean;
  validatedAddress: Address | null;
  onBackToStep1: () => void;
}

function DocumentFrontMatter({
  step,
  startedAtMs,
  publisher,
  isConnected,
  validatedAddress,
  onBackToStep1,
}: FrontMatterProps) {
  const net = getNetwork(SOMNIA_CHAIN_ID);
  const [, force] = useState(0);
  // Tick once a second so the elapsed counter ticks without a heavyweight
  // animation loop. setInterval is cheap and unmounts cleanly.
  useEffect(() => {
    const id = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  const elapsedSec = Math.max(0, Math.round((Date.now() - startedAtMs) / 1000));

  const stepDefs: Array<{ n: Step; label: string }> = [
    { n: 1, label: "Paste address" },
    { n: 2, label: "Discover & recommend" },
    { n: 3, label: "Publish & subscribe" },
  ];

  return (
    <section className="mx-auto w-full max-w-[1100px] px-10 pt-10 pb-8 md:px-16">
      <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-text-muted">
        Watch wizard · Document {DASHBOARD_VERSION}
      </div>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-text md:text-4xl">
        Discover, recommend, subscribe
      </h1>

      <dl className="mt-6 grid max-w-[640px] grid-cols-[140px_1fr] gap-y-1.5 gap-x-6 text-[13px]">
        <MetaRow label="Registry contract" mono>
          {net?.registryAddress ?? "—"}
        </MetaRow>
        <MetaRow label="Network">
          {net?.name ?? "—"}
          <span className="ml-2 font-mono text-[12px] text-text-muted">
            chain id {SOMNIA_CHAIN_ID}
          </span>
        </MetaRow>
        <MetaRow label="Your wallet">
          {isConnected && publisher ? (
            <span className="font-mono text-[12px] text-text">{publisher}</span>
          ) : (
            <span className="text-text-muted">not connected</span>
          )}
        </MetaRow>
        {validatedAddress && (
          <MetaRow label="Target agent" mono>
            {validatedAddress}
          </MetaRow>
        )}
        <MetaRow label="Elapsed">
          <span className="font-mono tabular-nums text-[12px]">{elapsedSec}s</span>
        </MetaRow>
      </dl>

      <Separator className="mt-6" />
      <ol
        role="list"
        aria-label="Wizard progress"
        className="mt-4 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-[12px]"
      >
        {stepDefs.map((s) => {
          const active = step === s.n;
          return (
            <li
              key={s.n}
              aria-current={active ? "step" : undefined}
              aria-label={`Step ${s.n} of 3: ${s.label}`}
              className={
                active
                  ? "border-b-2 border-accent pb-1 font-medium text-text"
                  : "border-b-2 border-transparent pb-1 text-text-muted"
              }
            >
              <span className="font-mono tabular-nums">{s.n}</span>
              <span className="ml-2">{s.label}</span>
            </li>
          );
        })}
        {step > 1 && (
          <li className="ml-auto pb-1">
            <button
              type="button"
              onClick={onBackToStep1}
              className="inline-flex items-center gap-1 text-[12px] text-accent hover:underline"
            >
              ← Restart
            </button>
          </li>
        )}
      </ol>
    </section>
  );
}

interface Step1BodyProps {
  value: string;
  error: string | null;
  onChange: (next: string) => void;
  onBlur: () => void;
  onDiscover: () => void;
  onPasteWallet: () => void;
  walletAddress: Address | undefined;
  walletConnected: boolean;
  discovering: boolean;
}

function Step1Body({
  value,
  error,
  onChange,
  onBlur,
  onDiscover,
  onPasteWallet,
  walletAddress,
  walletConnected,
  discovering,
}: Step1BodyProps) {
  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-sm text-text-muted">
        We&rsquo;ll look it up on {getNetwork(SOMNIA_CHAIN_ID)?.name ?? "Shannon"}{" "}
        (chain {SOMNIA_CHAIN_ID}) and
        recommend three deterministic policy tiers. No transactions yet
        &mdash; just read-only RPC calls.
      </p>

      <div>
        <label
          htmlFor="wizard-address"
          className="block text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted"
        >
          Agent address
        </label>
        <Input
          id="wizard-address"
          value={value}
          placeholder="0x…"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "wizard-address-error" : undefined}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (!discovering) onDiscover();
            }
          }}
          className="mt-2 w-full font-mono"
        />
      </div>

      {error && (
        <p id="wizard-address-error" className="text-[12px] text-danger">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 pt-2">
        <button
          type="button"
          onClick={onDiscover}
          disabled={discovering}
          title={discovering ? "Discovery in progress…" : undefined}
          className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline disabled:cursor-wait disabled:opacity-60"
        >
          <MagnifyingGlass size={14} weight="regular" aria-hidden />
          {discovering ? "Discovering…" : "Discover"}
        </button>
        <button
          type="button"
          onClick={onPasteWallet}
          disabled={!walletConnected || !walletAddress}
          title={
            walletConnected && walletAddress
              ? `Use ${walletAddress}`
              : "Connect a wallet to use this shortcut"
          }
          className="text-sm text-accent hover:underline disabled:cursor-not-allowed disabled:text-text-muted disabled:no-underline"
        >
          Paste my own wallet
        </button>
      </div>

      <p className="pt-2 text-[12px] text-text-muted">
        You&rsquo;ll connect a wallet to publish the policy in Step 3.
      </p>
    </div>
  );
}

interface Step2SectionsProps {
  discovery: DiscoveryState;
  recommendations: RecommendationResult | null;
  chosenTier: TierName | null;
  validatedAddress: Address | null;
  connectedWallet: Address | undefined;
  isConnected: boolean;
  registryRpcTimeout: boolean;
  onChooseTier: (t: TierName) => void;
  onRetryDiscovery: () => void;
  onContinue: () => void;
}

function Step2Sections({
  discovery,
  recommendations,
  chosenTier,
  validatedAddress,
  connectedWallet,
  isConnected,
  registryRpcTimeout,
  onChooseTier,
  onRetryDiscovery,
  onContinue,
}: Step2SectionsProps) {
  if (discovery.kind === "loading") {
    return (
      <>
        <Section number="" title="Discovery">
          <div className="flex items-center gap-2 text-[12px] text-text-muted">
            <Spinner />
            reading WardAgentRegistry + WardQueue…
          </div>
          <div className="mt-4">
            <SkeletonLines count={6} />
          </div>
        </Section>
        <Section number="" title="Tier recommendations">
          <SkeletonLines count={9} />
        </Section>
      </>
    );
  }

  if (discovery.kind === "error") {
    return (
      <Section number="" title="Discovery">
        <Alert variant="danger" title="Discovery failed">
          <div className="space-y-2">
            <div>{discovery.message}</div>
            <button
              type="button"
              onClick={onRetryDiscovery}
              className="text-[13px] text-accent hover:underline"
            >
              Retry discovery →
            </button>
          </div>
        </Alert>
      </Section>
    );
  }

  if (discovery.kind === "idle" || !recommendations || !validatedAddress) {
    return null;
  }

  const report = discovery.report;
  const wardAware = report.wardAware.wardAware;
  const alreadyRegisteredByOther =
    report.alreadyRegistered.registered &&
    (!connectedWallet ||
      report.alreadyRegistered.entry.registrar.toLowerCase() !==
        connectedWallet.toLowerCase());
  const alreadyRegisteredByMe =
    report.alreadyRegistered.registered &&
    !!connectedWallet &&
    report.alreadyRegistered.entry.registrar.toLowerCase() ===
      connectedWallet.toLowerCase();

  return (
    <>
      <Section number="" title="Mode">
        <ModePanel
          wardAware={wardAware}
          evidence={
            wardAware ? report.wardAware : null
          }
        />
        {registryRpcTimeout && (
          <div className="mt-4 border-t border-rule pt-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-warn">
              Couldn&rsquo;t confirm registry status
            </p>
            <p className="mt-1 text-[13px] text-text-muted">
              Could not confirm registry status (RPC timeout). If you see a
              NotRegistrar error in Step 3, the agent is already registered by
              another wallet.
            </p>
          </div>
        )}
        {report.alreadyRegistered.registered && alreadyRegisteredByOther && (
          <div className="mt-4 border-t border-rule pt-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-warn">
              Already registered by another wallet
            </p>
            <p className="mt-1 text-[13px] text-text-muted">
              Registered by{" "}
              <AddressChip address={report.alreadyRegistered.entry.registrar} />.
              You can still observe it via Slack, but you cannot bind a new
              policy from this wallet. The wizard will skip the publish and
              register steps.
            </p>
            <p className="mt-1 text-[12px] text-text-muted">
              Existing policyId:{" "}
              <span className="break-all font-mono text-[11px] text-text">
                {report.alreadyRegistered.entry.policyId}
              </span>{" "}
              <CopyButton
                value={report.alreadyRegistered.entry.policyId}
                label="policyId"
              />
            </p>
          </div>
        )}
        {report.alreadyRegistered.registered && alreadyRegisteredByMe && (
          <div className="mt-4 border-t border-rule pt-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
              Already registered by you
            </p>
            <p className="mt-1 text-[13px] text-text-muted">
              This agent is already in the registry under your wallet. Step 3
              will skip the register step; you can still update the Slack
              subscription and re-send a test alert.
            </p>
          </div>
        )}
      </Section>

      <Section number="" title="Agent">
        <dl className="grid max-w-[640px] grid-cols-[140px_1fr] gap-y-1.5 gap-x-6 text-[13px]">
          <MetaRow label="Address" mono>
            {validatedAddress}
          </MetaRow>
          <MetaRow label="Kind" mono>
            {report.kind}
          </MetaRow>
          <MetaRow label="Bytecode" mono>
            {report.hasCode ? `${report.codeSize} bytes` : "EOA (no code)"}
          </MetaRow>
          <MetaRow label="Nonce" mono>
            {report.nonce}
          </MetaRow>
          <MetaRow label="Balance" mono>
            {formatEther(report.balanceWei)} STT
          </MetaRow>
          {report.tokenFingerprint && (
            <MetaRow label="Token">
              {report.tokenFingerprint.symbol ?? "?"}
              {report.tokenFingerprint.decimals !== undefined
                ? ` (decimals ${report.tokenFingerprint.decimals})`
                : ""}
              {report.tokenFingerprint.supports721 ? " · ERC-721" : ""}
            </MetaRow>
          )}
          <MetaRow label="RPC calls" mono>
            {report.rpcCallsUsed}
          </MetaRow>
          {report.lateBinding && (
            <MetaRow label="POLICY_ID" mono>
              {report.lateBinding.policyId ===
              "0x0000000000000000000000000000000000000000000000000000000000000000" ? (
                <span className="text-warn">
                  unset — agent is ungated (calls run without Ward)
                </span>
              ) : (
                <span className="break-all">
                  Currently bound to{" "}
                  <span className="text-text">
                    {report.lateBinding.policyId.slice(0, 10)}…
                    {report.lateBinding.policyId.slice(-6)}
                  </span>{" "}
                  <CopyButton
                    value={report.lateBinding.policyId}
                    label="POLICY_ID"
                  />
                </span>
              )}
            </MetaRow>
          )}
        </dl>
        {report.warnings.length > 0 && (
          <details className="mt-4 text-[12px] text-text-muted">
            <summary className="cursor-pointer">
              {report.warnings.length} probe warning
              {report.warnings.length === 1 ? "" : "s"}
            </summary>
            <ul className="ml-4 list-disc space-y-0.5 pt-1 font-mono text-[11px]">
              {report.warnings.map((w, i) => (
                <li key={i} className="break-all">
                  {w}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Section>

      <Section
        number=""
        title="Tier recommendations"
        meta={
          <>
            recommended:{" "}
            <span className="font-medium text-text">
              {TIER_LABEL[recommendations.defaultTier]}
            </span>
          </>
        }
      >
        <p className="mb-4 text-[13px] text-text-muted">
          {recommendations.defaultTierReason}
        </p>
        <ol className="border-t border-rule">
          {(["conservative", "balanced", "aggressive"] as const).map((t) => (
            <TierRow
              key={t}
              tier={t}
              recommendation={recommendations[t]}
              chosen={chosenTier === t}
              recommended={recommendations.defaultTier === t}
              onChoose={() => onChooseTier(t)}
            />
          ))}
        </ol>

        {!isConnected && (
          <p className="mt-4 text-[12px] text-text-muted">
            Connect your wallet to proceed to Step 3.
          </p>
        )}

        <div className="mt-6 flex items-baseline justify-between border-t border-rule pt-4">
          <span className="text-[12px] text-text-muted">
            {chosenTier === null
              ? "Select a tier to continue."
              : `Selected: ${TIER_LABEL[chosenTier]}`}
          </span>
          <button
            type="button"
            onClick={onContinue}
            disabled={chosenTier === null}
            className="text-sm font-medium text-accent hover:underline disabled:cursor-not-allowed disabled:text-text-muted disabled:no-underline"
          >
            Continue to publish &amp; alert →
          </button>
        </div>
      </Section>
    </>
  );
}

interface ModePanelProps {
  wardAware: boolean;
  evidence: DiscoveryReport["wardAware"] | null;
}

function ModePanel({ wardAware, evidence }: ModePanelProps) {
  // Preflight mode: discovery saw the agent registered with the
  // `preflight-only` tag. The agent isn't Ward-aware on chain (no oracle
  // calls) but the operator has opted in to FE-side gating via the SDK's
  // `preflight()`. Informational only; doesn't change publish/register.
  const preflightOnly =
    evidence &&
    evidence.wardAware === true &&
    evidence.evidence.kind === "registry" &&
    evidence.evidence.tags.some((t) => t.toLowerCase() === "preflight-only");

  if (preflightOnly) {
    return (
      <div className="border-t border-rule pt-3">
        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-accent">
          ◈ Preflight mode (FE SDK)
        </p>
        <p className="mt-1 text-[13px] text-text-muted">
          This agent isn't Ward-aware on chain. Gate calls in your FE using
          {" "}
          <code className="font-mono text-[12px]">preflight()</code> from{" "}
          <code className="font-mono text-[12px]">@ward/sdk</code>.
          See SKILL.md Path D.
        </p>
      </div>
    );
  }

  if (wardAware && evidence && evidence.wardAware === true) {
    return (
      <div className="border-t border-rule pt-3">
        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-success">
          ◆ Real-time gating mode
        </p>
        <p className="mt-1 text-[13px] text-text-muted">
          Evidence:{" "}
          {evidence.evidence.kind === "registry"
            ? "registry"
            : `queue (block ${evidence.evidence.blockNumber.toString()})`}
          . WardOracle.checkIntent can block matching calls before they
          execute.
        </p>
      </div>
    );
  }
  return (
    <div className="border-t border-rule pt-3">
      <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-warn">
        ◇ Observation mode
      </p>
      <p className="mt-1 text-[13px] text-text-muted">
        No WardOracle/Queue interaction found in the last 5,000 blocks. Slack
        alerts will fire after concerning events, but Ward cannot block calls
        in real time. To enable real-time gating, the agent must call
        WardOracle.checkIntent itself.
      </p>
    </div>
  );
}

interface TierRowProps {
  tier: TierName;
  recommendation: TierRecommendation;
  chosen: boolean;
  recommended: boolean;
  onChoose: () => void;
}

function TierRow({
  tier,
  recommendation,
  chosen,
  recommended,
  onChoose,
}: TierRowProps) {
  const params = recommendation.parameters;
  const nowMs = Date.now();
  const expiresIso = new Date(Number(params.expiresAt) * 1000).toISOString();
  return (
    <li className="border-b border-rule py-4">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-2">
          {tier === "conservative" && (
            <ShieldCheck size={14} weight="regular" aria-hidden className="text-text-subtle" />
          )}
          {tier === "balanced" && (
            <Scales size={14} weight="regular" aria-hidden className="text-text-subtle" />
          )}
          {tier === "aggressive" && (
            <Lightning size={14} weight="regular" aria-hidden className="text-text-subtle" />
          )}
          <h4 className="text-[15px] font-medium text-text">
            {TIER_LABEL[tier]}
          </h4>
          <HelpTip>
            {tier === "conservative" &&
              "Tightest caps, shortest expiry. Use when the agent is unfamiliar or holds high-value approvals."}
            {tier === "balanced" &&
              "Middle-ground caps and expiry. Good default for active agents with predictable spend patterns."}
            {tier === "aggressive" &&
              "Loosest caps, longest expiry. Use only for trusted agents you don't want to re-publish often."}
          </HelpTip>
          {recommended && (
            <span className="text-[11px] text-accent">recommended</span>
          )}
          {chosen && (
            <span className="text-[11px] text-text-muted">· selected</span>
          )}
        </div>
        <button
          type="button"
          onClick={onChoose}
          className="text-[13px] text-accent hover:underline"
        >
          {chosen ? "Selected" : "Choose →"}
        </button>
      </div>

      <dl className="mt-3 grid max-w-[560px] grid-cols-[140px_1fr] gap-y-1.5 gap-x-6 text-[12px]">
        <MetaRow label="Tier" mono>
          {tierEnumName(params.tier)}
        </MetaRow>
        <MetaRow label="Per-call cap" mono>
          {formatEther(params.valueCapPerCall)} STT
        </MetaRow>
        <MetaRow label="Daily cap" mono>
          {formatEther(params.dailySpendWeiCap)} STT
        </MetaRow>
        <MetaRow label="Expires">
          <span title={expiresIso}>
            {relativeFromNow(params.expiresAt, nowMs)}
          </span>
        </MetaRow>
      </dl>

      <div className="mt-3">
        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
          Why this tier
        </p>
        <ul className="mt-1 ml-4 list-disc space-y-0.5 text-[12px] text-text-muted">
          {recommendation.reasoningBullets.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
      </div>

      {recommendation.policy === undefined && (
        <p className="mt-2 text-[11px] text-text-muted">
          Publishable PolicyInput unavailable for this agent — the wizard will
          save an observation-only subscription in Step 3.
        </p>
      )}

      <details className="mt-3 text-[11px] text-text-muted">
        <summary className="cursor-pointer">Show parameters JSON</summary>
        <pre className="mt-1 overflow-x-auto border border-rule bg-bg p-2 font-mono text-[10px] text-text">
          {JSON.stringify(params, bigintReplacer, 2)}
        </pre>
      </details>
    </li>
  );
}

interface Step3SectionsProps {
  validatedAddress: Address;
  chosenTier: TierName;
  recommendations: RecommendationResult;
  label: string;
  labelHex: Hex | null;
  labelError: string | null;
  onLabelChange: (v: string) => void;
  predictedPolicyId: Hex | null;
  walletConnected: boolean;
  wrongNetwork: boolean;
  currentChainId: number | undefined;
  expectedChainId: number;
  publishablePolicy: PolicyInput | null;
  alreadyRegisteredByOther: boolean;
  alreadyRegisteredByMe: boolean;
  registrar: Address | null;
  registryRpcTimeout: boolean;
  publishPolicy: TxState;
  publishedPolicyId: Hex | null;
  registerAgent: TxState;
  saveWebhook:
    | { kind: "idle" }
    | { kind: "saving" }
    | { kind: "saved"; sentAt: number }
    | { kind: "error"; message: string };
  webhookInput: string;
  webhookError: string | null;
  webhookSaved: boolean;
  webhookSkipped: boolean;
  sendTestAlertState: SlackState;
  effectivePolicyId: Hex | null;
  testCooldown: boolean;
  alertChannel: AlertChannel;
  telegramBotTokenInput: string;
  telegramChatIdInput: string;
  telegramBotTokenError: string | null;
  telegramChatIdError: string | null;
  onChangeAlertChannel: (next: AlertChannel) => void;
  onChangeTelegramBotToken: (v: string) => void;
  onChangeTelegramChatId: (v: string) => void;
  onBlurTelegramBotToken: () => void;
  onBlurTelegramChatId: () => void;
  onClickPublishPolicy: () => void;
  onClickRegisterAgent: () => void;
  onChangeWebhook: (v: string) => void;
  onBlurWebhook: () => void;
  onClickSaveWebhook: () => void;
  onClickSkipSlack: () => void;
  onClickSendTestAlert: () => void;
  onBackToStep2: () => void;
  done: boolean;
  observationOnlyMode: boolean;
  startedAtMs: number;
  goToWatched: () => void;
}

function Step3Sections(props: Step3SectionsProps) {
  const {
    validatedAddress,
    chosenTier,
    recommendations,
    label,
    labelError,
    onLabelChange,
    predictedPolicyId,
    walletConnected,
    wrongNetwork,
    currentChainId,
    expectedChainId,
    publishablePolicy,
    alreadyRegisteredByOther,
    alreadyRegisteredByMe,
    registrar,
    publishPolicy,
    publishedPolicyId,
    registerAgent,
    saveWebhook,
    webhookInput,
    webhookError,
    webhookSaved,
    webhookSkipped,
    sendTestAlertState,
    effectivePolicyId,
    testCooldown,
    alertChannel,
    telegramBotTokenInput,
    telegramChatIdInput,
    telegramBotTokenError,
    telegramChatIdError,
    onChangeAlertChannel,
    onChangeTelegramBotToken,
    onChangeTelegramChatId,
    onBlurTelegramBotToken,
    onBlurTelegramChatId,
    onClickPublishPolicy,
    onClickRegisterAgent,
    onChangeWebhook,
    onBlurWebhook,
    onClickSaveWebhook,
    onClickSkipSlack,
    onClickSendTestAlert,
    onBackToStep2,
    done,
    observationOnlyMode,
    startedAtMs,
    goToWatched,
  } = props;

  const rec = recommendations[chosenTier];
  const elapsedSec = Math.max(
    0,
    Math.round((Date.now() - startedAtMs) / 1000),
  );

  // Sub-card A: publish gated off when observationOnlyMode (no real targets
  // OR registered-by-other). Sub-card B: register gated off when
  // observationOnlyMode OR alreadyRegisteredByMe.
  const publishGatedOff = observationOnlyMode || alreadyRegisteredByMe;
  const registerGatedOff = observationOnlyMode || alreadyRegisteredByMe;

  return (
    <>
      <Section
        number=""
        title="Selection recap"
        meta={
          <button
            type="button"
            onClick={onBackToStep2}
            className="text-accent hover:underline"
          >
            ← Change selection
          </button>
        }
      >
        <dl className="grid max-w-[640px] grid-cols-[140px_1fr] gap-y-1.5 gap-x-6 text-[13px]">
          <MetaRow label="Agent" mono>
            {validatedAddress}
          </MetaRow>
          <MetaRow label="Chosen tier" mono>
            {TIER_LABEL[chosenTier]} ({tierEnumName(rec.parameters.tier)})
          </MetaRow>
          <MetaRow label="Per-call cap" mono>
            {formatEther(rec.parameters.valueCapPerCall)} STT
          </MetaRow>
          <MetaRow label="Daily cap" mono>
            {formatEther(rec.parameters.dailySpendWeiCap)} STT
          </MetaRow>
        </dl>

        {wrongNetwork && (
          <div className="mt-4 border-t border-rule pt-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-warn">
              Wrong network
            </p>
            <p className="mt-1 text-[13px] text-text-muted">
              Connected to chain {currentChainId ?? "?"}. Switch to Somnia
              Shannon ({expectedChainId}) before submitting.
            </p>
          </div>
        )}

        {!walletConnected && (
          <div className="mt-4 border-t border-rule pt-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-warn">
              Wallet not connected
            </p>
            <p className="mt-1 text-[13px] text-text-muted">
              Connect a wallet from the top bar to publish the policy and
              register the agent.
            </p>
          </div>
        )}
      </Section>

      <Section
        number=""
        title="Publish policy"
        meta={<span className="font-mono">writes to WardOracle</span>}
      >
        <SubSectionA
          label={label}
          labelError={labelError}
          onLabelChange={onLabelChange}
          predictedPolicyId={predictedPolicyId}
          walletConnected={walletConnected}
          wrongNetwork={wrongNetwork}
          publishablePolicy={publishablePolicy}
          publishGatedOff={publishGatedOff}
          publishPolicy={publishPolicy}
          publishedPolicyId={publishedPolicyId}
          alreadyRegisteredByMe={alreadyRegisteredByMe}
          alreadyRegisteredByOther={alreadyRegisteredByOther}
          registrar={registrar}
          onClickPublishPolicy={onClickPublishPolicy}
        />
      </Section>

      <Section
        number=""
        title="Register agent"
        meta={<span className="font-mono">writes to WardAgentRegistry</span>}
      >
        <SubSectionB
          label={label}
          publishedPolicyId={publishedPolicyId}
          walletConnected={walletConnected}
          wrongNetwork={wrongNetwork}
          registerGatedOff={registerGatedOff}
          registerAgent={registerAgent}
          alreadyRegisteredByMe={alreadyRegisteredByMe}
          alreadyRegisteredByOther={alreadyRegisteredByOther}
          registrar={registrar}
          onClickRegisterAgent={onClickRegisterAgent}
        />
      </Section>

      <Section
        number=""
        title="Save alert channel"
        meta={<span>stored in your browser only</span>}
      >
        <SubSectionC
          alertChannel={alertChannel}
          webhookInput={webhookInput}
          webhookError={webhookError}
          telegramBotTokenInput={telegramBotTokenInput}
          telegramChatIdInput={telegramChatIdInput}
          telegramBotTokenError={telegramBotTokenError}
          telegramChatIdError={telegramChatIdError}
          webhookSaved={webhookSaved}
          webhookSkipped={webhookSkipped}
          saveWebhook={saveWebhook}
          effectivePolicyId={effectivePolicyId}
          validatedAddress={validatedAddress}
          onChangeAlertChannel={onChangeAlertChannel}
          onChangeWebhook={onChangeWebhook}
          onBlurWebhook={onBlurWebhook}
          onChangeTelegramBotToken={onChangeTelegramBotToken}
          onChangeTelegramChatId={onChangeTelegramChatId}
          onBlurTelegramBotToken={onBlurTelegramBotToken}
          onBlurTelegramChatId={onBlurTelegramChatId}
          onClickSaveWebhook={onClickSaveWebhook}
          onClickSkipSlack={onClickSkipSlack}
        />
      </Section>

      <Section
        number=""
        title="Send test alert"
        meta={<span>POSTs to your selected alert channel</span>}
      >
        <SubSectionD
          webhookSaved={webhookSaved}
          webhookSkipped={webhookSkipped}
          sendTestAlertState={sendTestAlertState}
          testCooldown={testCooldown}
          onClickSendTestAlert={onClickSendTestAlert}
        />
      </Section>

      {done && (
        <Section number="" title="Done">
          <p className="text-[13px] text-text">
            {observationOnlyMode
              ? "Observation-only subscription saved."
              : "Watch wizard complete."}
          </p>
          <dl className="mt-3 grid max-w-[640px] grid-cols-[140px_1fr] gap-y-1.5 gap-x-6 text-[13px]">
            <MetaRow label="Agent" mono>
              {validatedAddress}
            </MetaRow>
            {effectivePolicyId && (
              <MetaRow label="Policy id" mono>
                <span className="break-all">{effectivePolicyId}</span>{" "}
                <CopyButton value={effectivePolicyId} label="policyId" />
              </MetaRow>
            )}
            {publishPolicy.kind === "mined" && (
              <MetaRow label="Publish tx">
                <ExplorerLink txHash={publishPolicy.hash} />
              </MetaRow>
            )}
            {registerAgent.kind === "mined" && (
              <MetaRow label="Register tx">
                <ExplorerLink txHash={registerAgent.hash} />
              </MetaRow>
            )}
            <MetaRow label="Elapsed">
              <span className="font-mono tabular-nums text-[12px]">
                {elapsedSec}s
              </span>
            </MetaRow>
          </dl>
          <div className="mt-4">
            <button
              type="button"
              onClick={goToWatched}
              className="text-sm font-medium text-accent hover:underline"
            >
              View on Watched tab →
            </button>
          </div>
        </Section>
      )}

      <Section number="" title="Audit">
        <details className="text-[12px] text-text-muted">
          <summary className="cursor-pointer">
            Show full PolicyInput &amp; reasoning for the chosen tier
          </summary>
          <div className="mt-2 space-y-2">
            {publishablePolicy ? (
              <pre className="overflow-x-auto border border-rule bg-bg p-2 font-mono text-[10px] text-text">
                {JSON.stringify(publishablePolicy, bigintReplacer, 2)}
              </pre>
            ) : (
              <p>
                No publishable PolicyInput — discovery did not resolve real
                targets[] from a registry-bound policy, so the wizard cannot
                synthesize a publish payload. Only the observation-only
                subscription is in scope for this tier.
              </p>
            )}
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
                Why this tier (deterministic rule output)
              </p>
              <ul className="ml-4 list-disc space-y-0.5">
                {rec.reasoningBullets.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            </div>
          </div>
        </details>
      </Section>
    </>
  );
}

interface SubSectionAProps {
  label: string;
  labelError: string | null;
  onLabelChange: (v: string) => void;
  predictedPolicyId: Hex | null;
  walletConnected: boolean;
  wrongNetwork: boolean;
  publishablePolicy: PolicyInput | null;
  publishGatedOff: boolean;
  publishPolicy: TxState;
  publishedPolicyId: Hex | null;
  alreadyRegisteredByMe: boolean;
  alreadyRegisteredByOther: boolean;
  registrar: Address | null;
  onClickPublishPolicy: () => void;
}

function SubSectionA(props: SubSectionAProps) {
  const {
    label,
    labelError,
    onLabelChange,
    predictedPolicyId,
    walletConnected,
    wrongNetwork,
    publishablePolicy,
    publishGatedOff,
    publishPolicy,
    publishedPolicyId,
    alreadyRegisteredByMe,
    alreadyRegisteredByOther,
    registrar,
    onClickPublishPolicy,
  } = props;

  const txInFlight =
    publishPolicy.kind === "awaiting-signature" ||
    publishPolicy.kind === "broadcasting" ||
    publishPolicy.kind === "mining";

  const disabled =
    !walletConnected ||
    wrongNetwork ||
    publishGatedOff ||
    publishablePolicy === null ||
    labelError !== null ||
    label.length === 0 ||
    txInFlight ||
    (publishPolicy.kind === "mined" && publishPolicy.ok);

  if (alreadyRegisteredByOther && registrar) {
    return (
      <div>
        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-warn">
          Skipping publish
        </p>
        <p className="mt-1 text-[13px] text-text-muted">
          This agent is registered by <AddressChip address={registrar} />, so
          the wizard binds the existing registry policyId for the Slack
          subscription instead of publishing a new one.
        </p>
      </div>
    );
  }

  if (alreadyRegisteredByMe) {
    return (
      <div>
        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
          Skipping publish
        </p>
        <p className="mt-1 text-[13px] text-text-muted">
          You already have a registered policy for this agent. Continue to           to update the Slack subscription.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <label
          htmlFor="wizard-label"
          className="block text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted"
        >
          Policy label (bytes32)
        </label>
        <Input
          id="wizard-label"
          value={label}
          onChange={(e) => onLabelChange(e.target.value)}
          placeholder="e.g. watch-1234abcd"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={labelError ? true : undefined}
          aria-describedby={labelError ? "wizard-label-error" : undefined}
          className="mt-2 w-full max-w-2xl font-mono"
        />
        {labelError && (
          <p id="wizard-label-error" className="mt-1 text-[12px] text-danger">
            {labelError}
          </p>
        )}
      </div>

      {predictedPolicyId && (
        <dl className="grid max-w-[640px] grid-cols-[140px_1fr] gap-y-1.5 gap-x-6 text-[13px]">
          <MetaRow label="Predicted policy id" mono>
            <span className="break-all">{predictedPolicyId}</span>{" "}
            <CopyButton value={predictedPolicyId} label="predicted policyId" />
          </MetaRow>
        </dl>
      )}

      {publishablePolicy === null && (
        <div className="border-t border-rule pt-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-warn">
            Publish unavailable
          </p>
          <p className="mt-1 text-[13px] text-text-muted">
            The chosen tier doesn&rsquo;t have a publish-ready PolicyInput for
            this agent. Discovery did not resolve real targets[] from a
            registry-bound policy, so the wizard cannot synthesize one without
            selector picks. You can still continue with the observation-only
            Slack subscription ().
          </p>
        </div>
      )}

      <div>
        <Dialog>
          <DialogTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline disabled:cursor-not-allowed disabled:text-text-muted disabled:no-underline"
            >
              <Upload size={14} weight="regular" aria-hidden />
              {publishPolicy.kind === "awaiting-signature" && "confirm in wallet…"}
              {publishPolicy.kind === "broadcasting" && "broadcasting…"}
              {publishPolicy.kind === "mining" && "mining…"}
              {publishPolicy.kind === "mined" && publishPolicy.ok &&
                "policy published"}
              {(publishPolicy.kind === "idle" || publishPolicy.kind === "error" ||
                (publishPolicy.kind === "mined" && !publishPolicy.ok)) &&
                "Publish policy"}
            </button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Publish policy</DialogTitle>
              <DialogDescription>
                Signs a WardOracle.publishPolicy transaction with the
                deterministic PolicyInput for the chosen tier. Your wallet will
                pop up to confirm.
              </DialogDescription>
            </DialogHeader>
            {predictedPolicyId && (
              <p className="text-[12px] text-text-muted">
                Predicted policyId:{" "}
                <span className="break-all font-mono text-[11px] text-text">
                  {predictedPolicyId}
                </span>
              </p>
            )}
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
                  onClick={onClickPublishPolicy}
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline"
                >
                  <Upload size={14} weight="regular" aria-hidden />
                  Confirm publish
                </button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <TxStatusPanel tx={publishPolicy} miningVerb="publishPolicy" />

      {publishPolicy.kind === "mined" && publishPolicy.ok && publishedPolicyId && (
        <dl className="grid max-w-[640px] grid-cols-[140px_1fr] gap-y-1.5 gap-x-6 text-[13px]">
          <MetaRow label="Published policy id" mono>
            <span className="break-all">{publishedPolicyId}</span>{" "}
            <CopyButton value={publishedPolicyId} label="published policyId" />
          </MetaRow>
        </dl>
      )}
    </div>
  );
}

interface SubSectionBProps {
  label: string;
  publishedPolicyId: Hex | null;
  walletConnected: boolean;
  wrongNetwork: boolean;
  registerGatedOff: boolean;
  registerAgent: TxState;
  alreadyRegisteredByMe: boolean;
  alreadyRegisteredByOther: boolean;
  registrar: Address | null;
  onClickRegisterAgent: () => void;
}

function SubSectionB(props: SubSectionBProps) {
  const {
    label,
    publishedPolicyId,
    walletConnected,
    wrongNetwork,
    registerGatedOff,
    registerAgent,
    alreadyRegisteredByMe,
    alreadyRegisteredByOther,
    registrar,
    onClickRegisterAgent,
  } = props;

  const txInFlight =
    registerAgent.kind === "awaiting-signature" ||
    registerAgent.kind === "broadcasting" ||
    registerAgent.kind === "mining";

  const disabled =
    !walletConnected ||
    wrongNetwork ||
    registerGatedOff ||
    publishedPolicyId === null ||
    txInFlight ||
    (registerAgent.kind === "mined" && registerAgent.ok);

  if (alreadyRegisteredByOther && registrar) {
    return (
      <div>
        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-warn">
          Skipping register
        </p>
        <p className="mt-1 text-[13px] text-text-muted">
          Already registered by <AddressChip address={registrar} />. Only that
          wallet can update the registry binding.
        </p>
      </div>
    );
  }

  if (alreadyRegisteredByMe) {
    return (
      <div>
        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
          Already registered by you
        </p>
        <p className="mt-1 text-[13px] text-text-muted">
          The registry already has this agent under your wallet. The wizard
          will skip this step.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <dl className="grid max-w-[640px] grid-cols-[140px_1fr] gap-y-1.5 gap-x-6 text-[13px]">
        <MetaRow label="Name" mono>
          {label || "(set in )"}
        </MetaRow>
        <MetaRow label="Metadata URI" mono>
          <span className="text-text-muted">(empty)</span>
        </MetaRow>
        <MetaRow label="Tags" mono>
          ["ward-watch-wizard"]
        </MetaRow>
      </dl>

      <div>
        <Dialog>
          <DialogTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline disabled:cursor-not-allowed disabled:text-text-muted disabled:no-underline"
            >
              <Bookmark size={14} weight="regular" aria-hidden />
              {registerAgent.kind === "awaiting-signature" && "confirm in wallet…"}
              {registerAgent.kind === "broadcasting" && "broadcasting…"}
              {registerAgent.kind === "mining" && "mining…"}
              {registerAgent.kind === "mined" && registerAgent.ok &&
                "agent registered"}
              {(registerAgent.kind === "idle" || registerAgent.kind === "error" ||
                (registerAgent.kind === "mined" && !registerAgent.ok)) &&
                "Register agent"}
            </button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Register agent</DialogTitle>
              <DialogDescription>
                Signs a WardAgentRegistry.registerAgent transaction binding
                this agent to the policy you just published. Your wallet will
                pop up to confirm.
              </DialogDescription>
            </DialogHeader>
            {publishedPolicyId && (
              <p className="text-[12px] text-text-muted">
                Binding policyId:{" "}
                <span className="break-all font-mono text-[11px] text-text">
                  {publishedPolicyId}
                </span>
              </p>
            )}
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
                  onClick={onClickRegisterAgent}
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline"
                >
                  <Bookmark size={14} weight="regular" aria-hidden />
                  Confirm register
                </button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {publishedPolicyId === null && (
        <p className="text-[12px] text-text-muted">
          Publish a policy in first — register needs the policyId.
        </p>
      )}

      <TxStatusPanel tx={registerAgent} miningVerb="register" />
    </div>
  );
}

interface SubSectionCProps {
  alertChannel: AlertChannel;
  webhookInput: string;
  webhookError: string | null;
  telegramBotTokenInput: string;
  telegramChatIdInput: string;
  telegramBotTokenError: string | null;
  telegramChatIdError: string | null;
  webhookSaved: boolean;
  webhookSkipped: boolean;
  saveWebhook:
    | { kind: "idle" }
    | { kind: "saving" }
    | { kind: "saved"; sentAt: number }
    | { kind: "error"; message: string };
  effectivePolicyId: Hex | null;
  validatedAddress: Address;
  onChangeAlertChannel: (next: AlertChannel) => void;
  onChangeWebhook: (v: string) => void;
  onBlurWebhook: () => void;
  onChangeTelegramBotToken: (v: string) => void;
  onChangeTelegramChatId: (v: string) => void;
  onBlurTelegramBotToken: () => void;
  onBlurTelegramChatId: () => void;
  onClickSaveWebhook: () => void;
  onClickSkipSlack: () => void;
}

function SubSectionC(props: SubSectionCProps) {
  const {
    alertChannel,
    webhookInput,
    webhookError,
    telegramBotTokenInput,
    telegramChatIdInput,
    telegramBotTokenError,
    telegramChatIdError,
    webhookSaved,
    webhookSkipped,
    saveWebhook,
    effectivePolicyId,
    validatedAddress,
    onChangeAlertChannel,
    onChangeWebhook,
    onBlurWebhook,
    onChangeTelegramBotToken,
    onChangeTelegramChatId,
    onBlurTelegramBotToken,
    onBlurTelegramChatId,
    onClickSaveWebhook,
    onClickSkipSlack,
  } = props;

  // After save resolves, re-read the saved record from IDB and stash the
  // masked form for display. This mirrors the same "don't retain the
  // secret in memory" pattern used by onClickSendTestAlert, so the only
  // place that ever sees the full secret is the masking helper itself.
  // The displayed label branches on whichever channel was saved.
  const [savedMaskedLabel, setSavedMaskedLabel] = useState<string | null>(null);
  useEffect(() => {
    if (saveWebhook.kind !== "saved") {
      setSavedMaskedLabel(null);
      return;
    }
    let cancelled = false;
    void loadWatchSubscription(SOMNIA_CHAIN_ID, validatedAddress).then(
      (record) => {
        if (cancelled) return;
        if (!record) {
          setSavedMaskedLabel(null);
          return;
        }
        if (record.slackWebhookUrl) {
          setSavedMaskedLabel(`Slack · ${maskWebhookUrl(record.slackWebhookUrl)}`);
        } else if (record.telegram) {
          setSavedMaskedLabel(`Telegram · ${maskBotToken(record.telegram.botToken)}`);
        } else {
          setSavedMaskedLabel(null);
        }
      },
      () => {
        if (!cancelled) setSavedMaskedLabel(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [saveWebhook.kind, validatedAddress]);

  const slackInputValid = validateWebhookUrl(webhookInput);
  const telegramInputsValid =
    validateBotToken(telegramBotTokenInput) &&
    validateChatId(telegramChatIdInput);
  const inputValid =
    alertChannel === "slack" ? slackInputValid : telegramInputsValid;

  const disabled =
    effectivePolicyId === null ||
    webhookSaved ||
    saveWebhook.kind === "saving" ||
    !inputValid;

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-text-muted">
        Alert-channel credentials are operator secrets. They are stored in
        IndexedDB on this browser, never sent to any backend.
      </p>

      {!webhookSaved && (
        <fieldset className="space-y-2">
          <legend className="text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
            Alert channel
          </legend>
          <div className="flex items-center gap-6 text-[13px]">
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                name="wizard-alert-channel"
                value="slack"
                checked={alertChannel === "slack"}
                onChange={() => onChangeAlertChannel("slack")}
              />
              <span>Slack</span>
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                name="wizard-alert-channel"
                value="telegram"
                checked={alertChannel === "telegram"}
                onChange={() => onChangeAlertChannel("telegram")}
              />
              <span>Telegram</span>
            </label>
          </div>
        </fieldset>
      )}

      {webhookSkipped && !webhookSaved && (
        <div className="border-t border-rule pt-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
            Alert channel skipped
          </p>
          <p className="mt-1 text-[13px] text-text-muted">
            The subscription is not saved. You can still publish the policy or
            revisit the wizard later.
          </p>
        </div>
      )}

      {webhookSaved && saveWebhook.kind === "saved" ? (
        <div className="space-y-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-success">
            ✓ Alert channel saved
          </p>
          <dl className="grid max-w-[640px] grid-cols-[140px_1fr] gap-y-1.5 gap-x-6 text-[13px]">
            <MetaRow label="Saved at" mono>
              {new Date(saveWebhook.sentAt).toLocaleTimeString()}
            </MetaRow>
            <MetaRow label="Stored as" mono>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="break-all cursor-help">
                    {savedMaskedLabel ?? "loading…"}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-[260px]">
                  Stored masked — never logged or rendered in full.
                </TooltipContent>
              </Tooltip>
            </MetaRow>
          </dl>
          <button
            type="button"
            onClick={() => {
              // "Replace" clears whichever channel is active. The IDB record
              // stays put until the next save overwrites it; toggling the
              // radio after this will reset all per-channel state via
              // onChangeAlertChannel.
              if (alertChannel === "slack") onChangeWebhook("");
              else {
                onChangeTelegramBotToken("");
                onChangeTelegramChatId("");
              }
            }}
            className="text-[13px] text-accent hover:underline"
          >
            Replace →
          </button>
        </div>
      ) : (
        <>
          {alertChannel === "slack" ? (
            <div>
              <label
                htmlFor="wizard-webhook"
                className="block text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted"
              >
                Slack incoming webhook URL
              </label>
              <Input
                id="wizard-webhook"
                type="password"
                value={webhookInput}
                onChange={(e) => onChangeWebhook(e.target.value)}
                onBlur={onBlurWebhook}
                placeholder="https://hooks.slack.com/services/T…/B…/…"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={webhookError ? true : undefined}
                aria-describedby={webhookError ? "wizard-webhook-error" : undefined}
                className="mt-2 w-full max-w-2xl font-mono"
              />
              {webhookError && (
                <p
                  id="wizard-webhook-error"
                  className="mt-1 text-[12px] text-danger"
                >
                  {webhookError}
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <label
                  htmlFor="wizard-telegram-token"
                  className="block text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted"
                >
                  Telegram bot token
                </label>
                <Input
                  id="wizard-telegram-token"
                  type="password"
                  value={telegramBotTokenInput}
                  onChange={(e) => onChangeTelegramBotToken(e.target.value)}
                  onBlur={onBlurTelegramBotToken}
                  placeholder="123456789:AAH-…"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={telegramBotTokenError ? true : undefined}
                  aria-describedby={
                    telegramBotTokenError ? "wizard-telegram-token-error" : undefined
                  }
                  className="mt-2 w-full max-w-2xl font-mono"
                />
                {telegramBotTokenError && (
                  <p
                    id="wizard-telegram-token-error"
                    className="mt-1 text-[12px] text-danger"
                  >
                    {telegramBotTokenError}
                  </p>
                )}
              </div>
              <div>
                <label
                  htmlFor="wizard-telegram-chat"
                  className="block text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted"
                >
                  Telegram chat_id
                </label>
                <Input
                  id="wizard-telegram-chat"
                  type="password"
                  value={telegramChatIdInput}
                  onChange={(e) => onChangeTelegramChatId(e.target.value)}
                  onBlur={onBlurTelegramChatId}
                  placeholder="123456789  or  -1001234567890  or  @username"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={telegramChatIdError ? true : undefined}
                  aria-describedby={
                    telegramChatIdError ? "wizard-telegram-chat-error" : undefined
                  }
                  className="mt-2 w-full max-w-2xl font-mono"
                />
                {telegramChatIdError && (
                  <p
                    id="wizard-telegram-chat-error"
                    className="mt-1 text-[12px] text-danger"
                  >
                    {telegramChatIdError}
                  </p>
                )}
              </div>
              <details className="rounded border border-rule bg-bg-soft p-3 text-[12px] text-text-muted">
                <summary className="cursor-pointer text-[12px] font-medium text-text">
                  Need help finding your chat_id?
                </summary>
                <ol className="mt-2 list-decimal space-y-1 pl-5">
                  <li>
                    In Telegram, open a chat with{" "}
                    <span className="font-mono">@BotFather</span>, send{" "}
                    <span className="font-mono">/newbot</span>, follow the
                    prompts, and copy the bot token it gives you.
                  </li>
                  <li>
                    Add the new bot to the chat (DM, group, or channel) where
                    you want alerts to land. For groups, the bot needs to be a
                    member; for channels, it needs admin rights.
                  </li>
                  <li>
                    Send any message in that chat so Telegram has a recent
                    update for the bot to read.
                  </li>
                  <li>
                    To find the chat_id either (a) DM{" "}
                    <span className="font-mono">@userinfobot</span> from that
                    chat &mdash; it will print the numeric id &mdash; or (b)
                    open{" "}
                    <span className="break-all font-mono">
                      https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates
                    </span>{" "}
                    in a browser tab and copy the{" "}
                    <span className="font-mono">result[0].message.chat.id</span>{" "}
                    value (use a numeric id; for channels prefer{" "}
                    <span className="font-mono">-100…</span>).
                  </li>
                </ol>
              </details>
            </div>
          )}

          {saveWebhook.kind === "error" && (
            <Alert variant="danger">
              Could not save: {saveWebhook.message}
            </Alert>
          )}

          {effectivePolicyId === null && (
            <p className="text-[12px] text-text-muted">
              Publish (or skip publish in observation-mode) so the
              subscription has a real policyId to bind to.
            </p>
          )}

          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
            <Dialog>
              <DialogTrigger asChild>
                <button
                  type="button"
                  disabled={disabled}
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline disabled:cursor-not-allowed disabled:text-text-muted disabled:no-underline"
                >
                  <BellSimple size={14} weight="regular" aria-hidden />
                  {saveWebhook.kind === "saving"
                    ? "saving…"
                    : alertChannel === "slack"
                      ? "Save webhook"
                      : "Save Telegram binding"}
                </button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>
                    Save {alertChannel === "slack" ? "Slack webhook" : "Telegram binding"}
                  </DialogTitle>
                  <DialogDescription>
                    The {alertChannel === "slack" ? "webhook URL" : "bot token and chat_id"}{" "}
                    are stored masked in this browser&rsquo;s IndexedDB only —
                    never sent to any backend and never logged or rendered in
                    full.
                  </DialogDescription>
                </DialogHeader>
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
                      onClick={onClickSaveWebhook}
                      className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline"
                    >
                      <BellSimple size={14} weight="regular" aria-hidden />
                      Confirm save
                    </button>
                  </DialogClose>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <button
              type="button"
              onClick={onClickSkipSlack}
              className="text-sm text-accent hover:underline"
            >
              Skip alerts — publish without notifications
            </button>
          </div>
        </>
      )}
    </div>
  );
}

interface SubSectionDProps {
  webhookSaved: boolean;
  webhookSkipped: boolean;
  sendTestAlertState: SlackState;
  testCooldown: boolean;
  onClickSendTestAlert: () => void;
}

function SubSectionD(props: SubSectionDProps) {
  const {
    webhookSaved,
    webhookSkipped,
    sendTestAlertState,
    testCooldown,
    onClickSendTestAlert,
  } = props;

  const disabled =
    !webhookSaved ||
    sendTestAlertState.kind === "sending" ||
    testCooldown;

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-text-muted">
        Sends a clearly-marked{" "}
        <span className="font-mono">[Ward watch wizard · test]</span> message
        so you can confirm Slack delivery before relying on real alerts.
      </p>

      {webhookSkipped && !webhookSaved && (
        <div className="border-t border-rule pt-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-warn">
            Alerts were skipped
          </p>
          <p className="mt-1 text-[13px] text-text-muted">
            Save an alert channel first to enable the test.
          </p>
        </div>
      )}

      <div>
        <Dialog>
          <DialogTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline disabled:cursor-not-allowed disabled:text-text-muted disabled:no-underline"
            >
              <PaperPlaneTilt size={14} weight="regular" aria-hidden />
              {sendTestAlertState.kind === "sending"
                ? "sending…"
                : testCooldown
                  ? "cooldown…"
                  : "Send test alert"}
            </button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Send test alert</DialogTitle>
              <DialogDescription>
                POSTs a clearly-marked{" "}
                <span className="font-mono">[Ward watch wizard · test]</span>{" "}
                message to your saved alert channel (Slack webhook or Telegram
                bot) so you can verify delivery before relying on real alerts.
              </DialogDescription>
            </DialogHeader>
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
                  onClick={onClickSendTestAlert}
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline"
                >
                  <PaperPlaneTilt size={14} weight="regular" aria-hidden />
                  Confirm send
                </button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {sendTestAlertState.kind === "ok" && (
        <div className="border-t border-rule pt-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-success">
            ✓ Alert channel accepted
          </p>
          <p className="mt-1 text-[13px] text-text-muted">
            Accepted at{" "}
            {new Date(sendTestAlertState.sentAt).toLocaleTimeString()}. Check
            your channel for the [Ward watch wizard · test] message.
          </p>
        </div>
      )}
      {sendTestAlertState.kind === "error" && (
        <Alert variant="danger">{sendTestAlertState.message}</Alert>
      )}
    </div>
  );
}
