interface EmptyStateProps {
  title: string;
  hint?: string;
}

/**
 * Reusable low-prominence empty-state block. Used wherever a list is
 * legitimately empty (vs. loading) so the UI never just shows a blank pane.
 */
export default function EmptyState({ title, hint }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-3 py-8 text-center">
      <p className="text-sm text-text-muted">{title}</p>
      {hint && <p className="text-xs text-text-subtle">{hint}</p>}
    </div>
  );
}
