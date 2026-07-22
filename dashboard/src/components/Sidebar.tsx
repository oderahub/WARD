import {
  Upload,
  ClockClockwise,
  Eye,
  MagicWand,
  type Icon,
} from "@phosphor-icons/react";
import { useUrlState, type TabKind } from "../hooks/useUrlState";
import { Logo } from "./Logo";

/**
 * Sidebar — Lane B "document grade" left rail.
 *
 * Warm-paper surface with a single right hairline (no fill, no shadow,
 * no pill backgrounds). Tabs are text-only line items in Geist; the
 * active tab is cued by ink-color text plus a 1px left-border in accent
 * ink-blue. Inactive tabs are muted; hover lifts to ink. No icons —
 * Lane B prefers typographic hierarchy over symbol weight.
 *
 * Width is a fixed 14rem on every viewport (no hover-to-expand). The
 * collapse/expand transition belonged to the old dark navy chrome and
 * read as motion-for-motion's-sake against the document aesthetic.
 *
 * Brand now lives in TopBar; the sidebar header is just a hairline
 * spacer that aligns with the TopBar's bottom rule so the chrome reads
 * as one continuous grid.
 *
 * The 4 routed tabs cover the operator workflow: publish a policy, browse the
 * queue, inspect watched violations, and run the Watch Wizard.
 */

interface NavItem {
  tab: TabKind;
  label: string;
  hint: string;
  icon: Icon;
}

const NAV: ReadonlyArray<NavItem> = [
  { tab: "publish",      label: "Publish",      hint: "Compile and publish a policy on-chain", icon: Upload },
  { tab: "queue",        label: "Queue",        hint: "Pending intents and recent oracle events", icon: ClockClockwise },
  { tab: "watched",      label: "Watched",      hint: "Watch-mode violations from immutable agents", icon: Eye },
  { tab: "watch-wizard", label: "Watch wizard", hint: "Discover a Somnia agent and set up Slack alerts in 60 seconds", icon: MagicWand },
];

export function Sidebar() {
  const { tab, setTab } = useUrlState();

  return (
    <aside
      aria-label="Primary"
      className="sticky top-0 z-20 flex h-screen w-56 shrink-0 flex-col border-r border-rule bg-bg"
    >
      {/* Header — Ward brand mark in the top-left corner, before the
          sidebar's right rule. Height aligns with the TopBar's bottom rule
          so the chrome reads as one continuous grid. */}
      <div className="flex h-14 shrink-0 items-center border-b border-rule pl-0 pr-6">
        <Logo size={30} />
      </div>

      {/* Nav — text-only line items, accent-bar on active */}
      <nav className="flex flex-1 flex-col gap-3 px-6 py-5">
        {NAV.map(({ tab: t, label, hint, icon: Icon }) => {
          const active = tab === t;
          return (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              title={hint}
              aria-current={active ? "page" : undefined}
              className={[
                "relative flex items-center gap-2 text-left text-[13px] transition-colors",
                "pl-3 -ml-3",
                active
                  ? "font-medium text-text border-l border-accent"
                  : "border-l border-transparent font-normal text-text-muted hover:text-text",
              ].join(" ")}
            >
              <Icon
                size={16}
                weight="regular"
                aria-hidden
                className={active ? "text-accent" : "text-text-subtle"}
              />
              {label}
            </button>
          );
        })}
      </nav>

      {/* Footer — Shannon testnet context, mono key/value to echo StatusBar */}
      <div className="border-t border-rule px-6 py-3 font-mono text-[11px] text-text-muted">
        <div className="flex items-center gap-2">
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
          <span className="whitespace-nowrap">Shannon testnet</span>
        </div>
      </div>
    </aside>
  );
}
