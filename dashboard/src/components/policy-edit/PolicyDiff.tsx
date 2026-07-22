import { useState } from "react";
import type { Hex } from "viem";
import {
  PlusCircle as PlusIcon,
  MinusCircle as MinusIcon,
  PencilSimple as PencilIcon,
  WarningCircle as WarningIcon,
} from "@phosphor-icons/react";
import type { PolicyInput, SelectorRule, TargetRule } from "@ward/sdk";
import { computeAggregateCapNote } from "../../lib/policy-edit-warnings";
import type { HumanizedFieldError } from "../../lib/policy-edit-errors";
import {
  formatDailyCapCompact,
  formatExpiresAtForDiff,
  formatPerCallCapCompact,
  formatWeiTooltip,
  isLegacyZeroExpiry,
} from "../../lib/policy-render";
import {
  FIELD_HUMAN_LABELS,
  formatSelector,
  humanizeTier,
  lookupSelector,
  lookupTarget,
  tierLabel,
} from "../../lib/selector-display";

/**
 * Two-column visual diff of a PolicyInput body. Used by `EditPolicyModal` to
 * preview the on-chain effect of an `updatePolicy` call before the user signs.
 * Targets compare by lowercased address, selectors by 4-byte selector.
 */

interface Props {
  before: PolicyInput;
  after: PolicyInput;
  /** Per-field validation errors; when set, renders a banner naming each invalid field. */
  errors?: ReadonlyArray<HumanizedFieldError>;
  /** True when `after` was synthesized by patching invalid fields back to `before`. */
  partial?: boolean;
}

type ChangeKind = "added" | "removed" | "modified" | "same";

function scalarChanged(before: unknown, after: unknown): boolean {
  if (typeof before === "bigint" || typeof after === "bigint") {
    return BigInt(before as bigint) !== BigInt(after as bigint);
  }
  return before !== after;
}

function indexBy<T>(items: ReadonlyArray<T>, key: (t: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) map.set(key(item), item);
  return map;
}

function compareSelectorRule(a: SelectorRule, b: SelectorRule): boolean {
  return (
    a.tier === b.tier &&
    a.valueCapPerCall === b.valueCapPerCall &&
    a.delaySeconds === b.delaySeconds
  );
}

function compareTargetRule(a: TargetRule, b: TargetRule): boolean {
  if (a.selectors.length !== b.selectors.length) return false;
  const ai = indexBy(a.selectors, (s) => s.selector.toLowerCase());
  for (const sb of b.selectors) {
    const sa = ai.get(sb.selector.toLowerCase());
    if (!sa) return false;
    if (!compareSelectorRule(sa, sb)) return false;
  }
  return true;
}

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

const GRID_TEMPLATE = "grid grid-cols-[180px_1fr_1fr] items-start gap-2";

const ROW_BORDER_BY_KIND: Record<ChangeKind, string> = {
  added: "border-success/40 bg-success/5",
  removed: "border-danger/40 bg-danger/5",
  modified: "border-warn/40 bg-warn/5",
  same: "border-ward-border",
};

interface ChangeBadgeProps {
  kind: Exclude<ChangeKind, "same">;
}

/**
 * Icon + word change marker. Color is reinforcement, not signal: the icon
 * shape and the label both communicate the change type so a screenshot in
 * grayscale or a color-vision-impaired operator can still parse the diff.
 */
function ChangeBadge({ kind }: ChangeBadgeProps) {
  if (kind === "added") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-success">
        <PlusIcon size={11} weight="bold" />
        Added
      </span>
    );
  }
  if (kind === "removed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-danger/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-danger">
        <MinusIcon size={11} weight="bold" />
        Removed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-warn/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-warn">
      <PencilIcon size={11} weight="bold" />
      Changed
    </span>
  );
}

export default function PolicyDiff({ before, after, errors, partial }: Props) {
  const [showUnchanged, setShowUnchanged] = useState(false);
  const hasErrors = !!errors && errors.length > 0;

  const targetsBefore = indexBy(before.targets, (t) => t.target.toLowerCase());
  const targetsAfter = indexBy(after.targets, (t) => t.target.toLowerCase());

  const allTargetAddrs = Array.from(
    new Set([...targetsBefore.keys(), ...targetsAfter.keys()]),
  ).sort();

  // Aggregate-cap INFO note for the AFTER state only — the operator cares
  // whether the policy they're about to submit triggers the constraint.
  const aggregateCapNote = computeAggregateCapNote(after).note;

  type ScalarSpec = {
    fieldKey: "dailySpendWeiCap" | "maxSlippageBps" | "expiresAt" | "paused";
    rawLabel: string;
    label: string;
    before: string;
    after: string;
    changed: boolean;
    beforeTitle?: string;
    afterTitle?: string;
    dangerBefore?: boolean;
    dangerAfter?: boolean;
  };

  const scalars: ScalarSpec[] = [
    {
      fieldKey: "dailySpendWeiCap",
      rawLabel: "dailySpendWeiCap",
      label: FIELD_HUMAN_LABELS.dailySpendWeiCap ?? "dailySpendWeiCap",
      before: formatDailyCapCompact(before.dailySpendWeiCap),
      after: formatDailyCapCompact(after.dailySpendWeiCap),
      changed: scalarChanged(before.dailySpendWeiCap, after.dailySpendWeiCap),
      beforeTitle: formatWeiTooltip(before.dailySpendWeiCap),
      afterTitle: formatWeiTooltip(after.dailySpendWeiCap),
    },
    {
      fieldKey: "maxSlippageBps",
      rawLabel: "maxSlippageBps",
      label: FIELD_HUMAN_LABELS.maxSlippageBps ?? "maxSlippageBps",
      before: String(before.maxSlippageBps),
      after: String(after.maxSlippageBps),
      changed: scalarChanged(before.maxSlippageBps, after.maxSlippageBps),
    },
    {
      fieldKey: "expiresAt",
      rawLabel: "expiresAt",
      label: FIELD_HUMAN_LABELS.expiresAt ?? "expiresAt",
      before: formatExpiresAtForDiff(before.expiresAt),
      after: formatExpiresAtForDiff(after.expiresAt),
      changed: scalarChanged(before.expiresAt, after.expiresAt),
      dangerBefore: isLegacyZeroExpiry(before.expiresAt),
      dangerAfter: isLegacyZeroExpiry(after.expiresAt),
    },
    {
      fieldKey: "paused",
      rawLabel: "paused",
      label: FIELD_HUMAN_LABELS.paused ?? "paused",
      before: String(before.paused),
      after: String(after.paused),
      changed: scalarChanged(before.paused, after.paused),
    },
  ];

  const changedScalars = scalars.filter((s) => s.changed);
  const unchangedScalars = scalars.filter((s) => !s.changed);

  const targetEntries = allTargetAddrs.map((addr) => {
    const tBefore = targetsBefore.get(addr);
    const tAfter = targetsAfter.get(addr);
    const kind: ChangeKind = !tBefore
      ? "added"
      : !tAfter
        ? "removed"
        : compareTargetRule(tBefore, tAfter)
          ? "same"
          : "modified";
    return { addr, tBefore, tAfter, kind };
  });

  const changedTargets = targetEntries.filter((t) => t.kind !== "same");
  const unchangedTargets = targetEntries.filter((t) => t.kind === "same");

  const totalUnchanged = unchangedScalars.length + unchangedTargets.length;
  const nothingChanged = changedScalars.length === 0 && changedTargets.length === 0;

  return (
    <div className="space-y-3 text-xs">
      {hasErrors && (
        <ErrorBanner errors={errors!} partial={!!partial} />
      )}

      {/*
        Sticky column header. The previous diff had no header strip and the
        operator was left guessing which column was "current" vs "proposed".
        Sticky-top keeps the labels visible while scrolling through a long
        target list inside the modal.
      */}
      <div
        className={`${GRID_TEMPLATE} sticky top-0 z-10 rounded-md border border-ward-border bg-surface px-2 py-1.5 text-[10px] uppercase tracking-wider text-text-subtle`}
      >
        <span>Field</span>
        <span>
          Current{" "}
          <span className="font-normal normal-case text-text-muted">
            (on-chain)
          </span>
        </span>
        <span>
          Proposed{" "}
          <span className="font-normal normal-case text-text-muted">
            {partial ? "(partial, invalid fields shown unchanged)" : "(your edit)"}
          </span>
        </span>
      </div>

      {nothingChanged && !hasErrors && (
        <div className="rounded-md border border-ward-border bg-surface p-3 text-text-subtle">
          No differences. The proposed body matches the on-chain policy exactly.
        </div>
      )}

      {/* Changed scalars first — these are typically what the operator just
          edited, so they belong at the top of the diff without scrolling. */}
      {changedScalars.map((s) => (
        <ScalarRow key={s.fieldKey} {...s} />
      ))}

      {/* Changed targets next */}
      {changedTargets.length > 0 && (
        <div className="space-y-2 pt-1">
          <div className="text-[11px] uppercase tracking-wider text-text-subtle">
            Targets (changed)
          </div>
          {changedTargets.map(({ addr, tBefore, tAfter, kind }) => (
            <TargetBlock
              key={addr}
              address={addr}
              kind={kind}
              before={tBefore}
              after={tAfter}
            />
          ))}
        </div>
      )}

      {/* Single "show unchanged" toggle reveals BOTH unchanged scalars AND
          unchanged targets together — the operator gets the full picture on
          demand without paying the visual cost upfront. */}
      {totalUnchanged > 0 && (
        <div className="pt-1">
          <button
            type="button"
            onClick={() => setShowUnchanged((v) => !v)}
            className="text-[11px] text-text-muted underline-offset-2 hover:text-text hover:underline"
          >
            {showUnchanged
              ? `Hide unchanged (${totalUnchanged})`
              : `Show unchanged (${totalUnchanged})`}
          </button>
        </div>
      )}

      {showUnchanged && (
        <div className="space-y-2 opacity-70">
          {unchangedScalars.map((s) => (
            <ScalarRow key={`u-${s.fieldKey}`} {...s} />
          ))}
          {unchangedTargets.length > 0 && (
            <div className="space-y-2 pt-1">
              <div className="text-[11px] uppercase tracking-wider text-text-subtle">
                Targets (unchanged)
              </div>
              {unchangedTargets.map(({ addr, tBefore, tAfter, kind }) => (
                <TargetBlock
                  key={`u-${addr}`}
                  address={addr}
                  kind={kind}
                  before={tBefore}
                  after={tAfter}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {aggregateCapNote && (
        <p className="text-xs text-text-muted">{aggregateCapNote}</p>
      )}
    </div>
  );
}

interface ScalarRowProps {
  rawLabel: string;
  label: string;
  before: string;
  after: string;
  changed: boolean;
  beforeTitle?: string;
  afterTitle?: string;
  /**
   * Per-side danger override — used for the legacy-0 expiresAt sentinel so
   * the row reads red even when both sides happen to match (e.g. previewing
   * an edit that hasn't touched expiresAt yet). Takes precedence over the
   * "changed" warn coloring on that side only.
   */
  dangerBefore?: boolean;
  dangerAfter?: boolean;
}

function ScalarRow({
  label,
  before,
  after,
  changed,
  beforeTitle,
  afterTitle,
  dangerBefore,
  dangerAfter,
}: ScalarRowProps) {
  const beforeColor = dangerBefore ? "text-danger" : "text-text-muted";
  const afterColor = dangerAfter
    ? "text-danger"
    : changed
      ? "text-warn"
      : "text-text-muted";
  return (
    <div
      className={`${GRID_TEMPLATE} rounded-md border px-2 py-1.5 ${
        changed ? "border-warn/40 bg-warn/5" : "border-ward-border"
      }`}
    >
      <div className="flex items-center gap-1.5">
        {changed && <ChangeBadge kind="modified" />}
        <span className="text-[11px] text-text-subtle">{label}</span>
      </div>
      <span
        className={`font-mono break-all ${beforeColor}`}
        title={beforeTitle}
      >
        {before}
      </span>
      <span className={`font-mono break-all ${afterColor}`} title={afterTitle}>
        {after}
      </span>
    </div>
  );
}

interface TargetBlockProps {
  address: string;
  kind: ChangeKind;
  before: TargetRule | undefined;
  after: TargetRule | undefined;
}

function TargetBlock({ address, kind, before, after }: TargetBlockProps) {
  const friendly = lookupTarget(address);
  const selectorsBefore = before
    ? indexBy(before.selectors, (s) => s.selector.toLowerCase())
    : new Map<string, SelectorRule>();
  const selectorsAfter = after
    ? indexBy(after.selectors, (s) => s.selector.toLowerCase())
    : new Map<string, SelectorRule>();
  const allSels = Array.from(
    new Set([...selectorsBefore.keys(), ...selectorsAfter.keys()]),
  ).sort();

  return (
    <div className={`rounded-md border p-2 ${ROW_BORDER_BY_KIND[kind]}`}>
      <div className="flex items-baseline gap-2">
        {friendly ? (
          <>
            <span className="text-xs font-medium text-text">{friendly}</span>
            <span className="text-text-muted">·</span>
            <span
              className="font-mono text-[11px] text-text-muted"
              title={address}
            >
              {truncateAddress(address)}
            </span>
          </>
        ) : (
          <span className="font-mono text-[11px] text-text" title={address}>
            {truncateAddress(address)}
          </span>
        )}
        {kind !== "same" && (
          <span className="ml-auto">
            <ChangeBadge kind={kind} />
          </span>
        )}
      </div>
      {allSels.length > 0 && (
        <div className="mt-1.5 space-y-1 pl-4">
          {allSels.map((sel) => {
            const sBefore = selectorsBefore.get(sel);
            const sAfter = selectorsAfter.get(sel);
            const selKind: ChangeKind = !sBefore
              ? "added"
              : !sAfter
                ? "removed"
                : compareSelectorRule(sBefore, sAfter)
                  ? "same"
                  : "modified";
            return (
              <SelectorRowView
                key={sel}
                selector={sel as Hex}
                kind={selKind}
                before={sBefore}
                after={sAfter}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

interface SelectorRowViewProps {
  selector: Hex;
  kind: ChangeKind;
  before: SelectorRule | undefined;
  after: SelectorRule | undefined;
}

function SelectorRowView({
  selector,
  kind,
  before,
  after,
}: SelectorRowViewProps) {
  const signature = lookupSelector(selector);
  const display = signature ?? formatSelector(selector);

  return (
    <div className={`rounded border px-2 py-1 ${ROW_BORDER_BY_KIND[kind]}`}>
      <div className="flex items-baseline gap-2">
        <span
          className="font-mono text-[11px] text-text"
          title={signature ? selector : undefined}
        >
          {display}
        </span>
        {!signature && (
          <span className="text-[10px] uppercase tracking-wider text-text-subtle">
            unverified selector
          </span>
        )}
        {kind !== "same" && (
          <span className="ml-auto">
            <ChangeBadge kind={kind} />
          </span>
        )}
      </div>
      {kind === "modified" && before && after && (
        <div className="mt-1 space-y-0.5 pl-3 text-[11px]">
          {before.tier !== after.tier && (
            <div>
              <span className="text-text-subtle">approval mode: </span>
              <span
                className="text-warn"
                title={`${tierLabel(before.tier)} → ${tierLabel(after.tier)}`}
              >
                {humanizeTier(before.tier)} → {humanizeTier(after.tier)}
              </span>
            </div>
          )}
          {before.valueCapPerCall !== after.valueCapPerCall && (
            <div>
              <span className="text-text-subtle">per-call native cap: </span>
              <span
                className="text-warn"
                title={`${formatWeiTooltip(before.valueCapPerCall)} → ${formatWeiTooltip(after.valueCapPerCall)}`}
              >
                {formatPerCallCapCompact(before.valueCapPerCall)} →{" "}
                {formatPerCallCapCompact(after.valueCapPerCall)}
              </span>
            </div>
          )}
          {before.delaySeconds !== after.delaySeconds && (
            <div>
              <span className="text-text-subtle">delay: </span>
              <span className="text-warn">
                {before.delaySeconds}s → {after.delaySeconds}s
              </span>
            </div>
          )}
        </div>
      )}
      {kind === "added" && after && (
        <div className="pl-3 text-[11px] text-text-muted">
          <span title={tierLabel(after.tier)}>{humanizeTier(after.tier)}</span> · cap{" "}
          <span title={formatWeiTooltip(after.valueCapPerCall)}>
            {formatPerCallCapCompact(after.valueCapPerCall)}
          </span>{" "}
          · delay {after.delaySeconds}s
        </div>
      )}
      {kind === "removed" && before && (
        <div className="pl-3 text-[11px] text-text-muted">
          <span title={tierLabel(before.tier)}>{humanizeTier(before.tier)}</span> · cap{" "}
          <span title={formatWeiTooltip(before.valueCapPerCall)}>
            {formatPerCallCapCompact(before.valueCapPerCall)}
          </span>{" "}
          · delay {before.delaySeconds}s
        </div>
      )}
    </div>
  );
}

interface ErrorBannerProps {
  errors: ReadonlyArray<HumanizedFieldError>;
  /** True when a partial diff renders below; false when the diff cannot be computed at all. */
  partial: boolean;
}

/**
 * Lists every invalid field with its friendly path label + schema/compile message.
 * Caps the visible list at 6; overflow is rendered as a count.
 */
function ErrorBanner({ errors, partial }: ErrorBannerProps) {
  const VISIBLE = 6;
  const visible = errors.slice(0, VISIBLE);
  const overflow = errors.length - visible.length;
  const headline = partial
    ? `Showing partial diff: ${errors.length} field error${errors.length === 1 ? "" : "s"} to fix:`
    : `Cannot compute diff: ${errors.length} field error${errors.length === 1 ? "" : "s"} to fix:`;
  return (
    <div
      role="alert"
      className="rounded-md border border-danger/40 bg-danger/10 p-3 text-[11px]"
    >
      <div className="mb-1 flex items-center gap-1.5 font-medium text-danger">
        <WarningIcon size={14} weight="bold" aria-hidden="true" />
        <span>{headline}</span>
      </div>
      <ul className="space-y-0.5 pl-5 text-text">
        {visible.map((e) => (
          <li key={e.path} className="list-disc">
            <span className="font-medium">{e.label}</span>:{" "}
            <span className="text-text-muted">{e.message}</span>
          </li>
        ))}
        {overflow > 0 && (
          <li className="list-disc text-text-muted">
            …and {overflow} more (highlighted above).
          </li>
        )}
      </ul>
      <p className="mt-1.5 text-text-subtle">
        Fix the highlighted fields above to see the full diff.
      </p>
    </div>
  );
}
