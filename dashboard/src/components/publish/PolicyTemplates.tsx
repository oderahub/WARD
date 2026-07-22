import { TEMPLATES, type PolicyDraft, type Tier } from "../../lib/policy-draft";

interface Props {
  onPick: (draft: PolicyDraft) => void;
}

/** Compute a compact tier-mix badge like "IMMEDIATE + DELAYED" for a template. */
function tierMix(draft: PolicyDraft): string {
  const tiers = new Set<Tier>();
  for (const t of draft.targets) for (const s of t.selectors) tiers.add(s.tier);
  return Array.from(tiers).join(" + ");
}

/**
 * Starter-template gallery surfaced above an empty publish form. Picking a
 * card hydrates the parent's draft state — the user still has to swap in real
 * target addresses before the policy compiles.
 */
export default function PolicyTemplates({ onPick }: Props) {
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {TEMPLATES.map((tpl) => (
        <li key={tpl.id}>
          <button
            type="button"
            onClick={() => onPick(tpl.draft)}
            className="group flex h-full w-full flex-col gap-2 rounded-lg border border-rule bg-surface p-4 text-left transition hover:border-accent hover:bg-surface-elev"
          >
            <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-text-subtle">
              {tierMix(tpl.draft)}
            </span>
            <span className="text-[14px] font-medium text-text group-hover:text-accent">
              {tpl.draft.name}
            </span>
            <span className="text-[12px] text-text-muted">
              {tpl.description}
            </span>
            <span className="mt-auto pt-2 text-[12px] text-accent opacity-0 transition group-hover:opacity-100">
              use template →
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
