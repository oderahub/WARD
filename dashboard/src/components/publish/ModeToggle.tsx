export type PublishMode = "enforce" | "watch";

interface Props {
  value: PublishMode;
  onChange: (next: PublishMode) => void;
}

/**
 * Two-option segmented control: ENFORCE vs WATCH. Visual matches QueueTab's
 * SegmentedChip (border-y + divide-x rounded-md container, accent underline
 * on the active item) so the publish surface feels consistent with the queue.
 *
 * Tooltips spell out the semantic difference because the two modes look
 * identical at publish time — the divergence is whether your agent code calls
 * checkIntent (enforce) or whether Sentry just observes (watch).
 */
export function ModeToggle({ value, onChange }: Props) {
  return (
    <div
      role="tablist"
      aria-label="Publish mode"
      className="flex w-fit divide-x divide-sentry-border rounded-md border-y border-sentry-border overflow-hidden"
    >
      <Option
        label="Enforce"
        title="Your agent calls Sentry inline and refuses any call the policy rejects. Requires 3 lines of Solidity in the agent contract."
        active={value === "enforce"}
        onClick={() => onChange("enforce")}
      />
      <Option
        label="Watch"
        title="Sentry watches an already-deployed agent and alerts on policy violations after they happen. No agent code changes; no real-time blocking."
        active={value === "watch"}
        onClick={() => onChange("watch")}
      />
    </div>
  );
}

interface OptionProps {
  label: string;
  title: string;
  active: boolean;
  onClick: () => void;
}

function Option({ label, title, active, onClick }: OptionProps) {
  const activeClass = "bg-surface-elev text-text border-b-2 border-accent -mb-px";
  const idleClass = "bg-surface text-text-muted hover:text-text";
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      title={title}
      onClick={onClick}
      className={`px-3 py-1.5 text-xs transition-colors active:scale-[0.97] transition-transform ${active ? activeClass : idleClass}`}
    >
      {label}
    </button>
  );
}
