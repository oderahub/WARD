/**
 * Honest-visibility banner. Rendered above the Queue tab to prevent the
 * common misread that the dashboard shows ALL oracle traffic — it doesn't.
 * immediate-mode flows are view-only on-chain and never emit events, so they
 * cannot appear here regardless of volume.
 */
export default function VisibilityBanner() {
  return (
    <div className="border-b border-ward-border bg-bg px-4 py-1 text-[11px] text-text-muted">
      <span className="text-text-subtle uppercase tracking-wider mr-2">scope</span>
      Ward only sees delayed + veto-required calls. immediate-mode
      checkIntent emits no events — invisible here.
    </div>
  );
}
