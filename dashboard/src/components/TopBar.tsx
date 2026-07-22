import { useState, type FormEvent } from "react";
import { useBalance, useChainId, useSwitchChain } from "wagmi";
import { ArrowRight, MagnifyingGlass, SignOut } from "@phosphor-icons/react";
import { formatEther } from "viem";
import { parseIdInput } from "../lib/encoding";
import { useUrlState, type ModeKind } from "../hooks/useUrlState";
import { useWallet } from "../hooks/useWallet";
import { ACTIVE_CHAIN_ID } from "../lib/networks";
import { AddressChip, Button, Input } from "./primitives";
import ThemeToggle from "./ThemeToggle";

/**
 * TopBar — Lane B "document grade" chrome.
 *
 * Light warm-paper surface, single bottom hairline (no shadow). Brand mark
 * sits on the left (small accent square + "Ward" wordmark in Geist
 * Semibold). Wallet sits on the right: balance in Medium, address in mono
 * muted, disconnect as a link-style ghost button.
 *
 * Surface-conditional middle slots are preserved verbatim:
 *   - Publish surface → Enforce/Watch mode toggle
 *   - Queue surface   → jump-to-id search
 *
 * All click handlers, hooks, and data flow are unchanged from the v0.9.0
 * dark-chrome version — only styling/structure was restyled.
 */

export default function TopBar() {
  const { tab, mode, setMode, setDrawer } = useUrlState();
  const { address, isConnected, connect, disconnect } = useWallet();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();

  const [searchValue, setSearchValue] = useState("");
  const [searchError, setSearchError] = useState<string | null>(null);

  const handleSearch = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const parsed = parseIdInput(searchValue);
    if (!parsed) {
      setSearchError("Enter a request number (e.g. 42) or a policy id starting with 0x.");
      return;
    }
    setSearchError(null);
    setDrawer(parsed);
    setSearchValue("");
  };

  const wrongNetwork = isConnected && chainId !== ACTIVE_CHAIN_ID;

  const { data: balance } = useBalance({
    address: isConnected ? address : undefined,
  });
  const balanceWei = balance?.value;
  const balanceFormatted =
    balanceWei !== undefined ? Number(formatEther(balanceWei)).toFixed(3) : null;
  const isLowBalance =
    isConnected && balanceWei !== undefined && balanceWei < 10_000_000_000_000_000n;
  const showFaucet =
    isConnected && balanceWei !== undefined && (balanceWei === 0n || isLowBalance);

  return (
    <header className="flex h-14 shrink-0 items-center gap-5 border-b border-rule bg-bg px-6">
      {/* Mode toggle — Publish only */}
      {tab === "publish" && (
        <ModeToggle mode={mode} onChange={setMode} />
      )}

      {/* Jump-to-ID search — Queue only */}
      {tab === "queue" && (
        <form onSubmit={handleSearch} className="flex flex-1 justify-center">
          <div className="flex w-full max-w-md flex-col">
            <div className="relative flex items-stretch gap-1.5">
              <MagnifyingGlass
                size={14}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle"
              />
              <Input
                type="text"
                value={searchValue}
                onChange={(e) => {
                  setSearchValue(e.target.value);
                  if (searchError) setSearchError(null);
                }}
                placeholder="Jump to request #, or 0x policy id"
                spellCheck={false}
                autoComplete="off"
                aria-label="Jump to request number or policy id"
                className={`h-8 w-full pl-8 font-mono text-xs ${
                  searchError ? "border-danger focus:border-danger focus:ring-danger" : ""
                }`}
                aria-invalid={searchError ? true : false}
                aria-describedby={searchError ? "topbar-search-error" : undefined}
              />
              <Button
                type="submit"
                variant="ghost"
                size="xs"
                className="h-8 inline-flex items-center gap-1"
              >
                Go <ArrowRight size={12} />
              </Button>
            </div>
            {searchError && (
              <span id="topbar-search-error" className="mt-1 text-[11px] text-danger">
                {searchError}
              </span>
            )}
          </div>
        </form>
      )}

      {/* Always push the right-anchored cluster (theme + wallet) all the way
          to the top-right, even on tabs where the middle slot doesn't claim
          flex-1 (Publish's Enforce/Watch toggle is content-sized). The Queue
          search form already self-pushes via its own flex-1 wrapper, so we
          guard against double-flex there. */}
      {tab !== "queue" && <div className="flex-1" />}

      {/* Right-anchored cluster: theme toggle | wallet | disconnect.
          Visually grouped with `ml-auto` (for the queue branch where flex-1
          is on the form) + a subtle left divider so it reads as one unit
          separate from the page-context controls on the left. */}
      <div className="ml-auto flex shrink-0 items-center gap-3 border-l border-rule pl-4">
        {/* Theme toggle — light / dark / system, persisted via next-themes */}
        <ThemeToggle />

      {/* Wallet block — Lane B: light, mono address, link-style disconnect */}
        {wrongNetwork && (
          <Button
            variant="warn"
            size="xs"
            onClick={() => switchChain({ chainId: ACTIVE_CHAIN_ID })}
          >
            Wrong network. Switch to Avalanche
          </Button>
        )}
        {isConnected && address ? (
          <div className="flex items-center gap-3">
            {showFaucet && (
              <a
                href="https://faucet.avax.network/"
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-warn hover:underline"
              >
                Get AVAX →
              </a>
            )}
            <span
              className={`font-mono text-[12px] font-medium tabular-nums ${
                isLowBalance ? "text-warn" : "text-text"
              }`}
            >
              {balanceFormatted !== null ? `${balanceFormatted} AVAX` : "—"}
            </span>
            <AddressChip address={address} />
            <button
              type="button"
              onClick={disconnect}
              className="inline-flex items-center gap-1.5 text-[12px] text-text-muted underline-offset-2 hover:text-accent hover:underline"
            >
              <SignOut size={12} weight="regular" aria-hidden />
              Disconnect
            </button>
          </div>
        ) : (
          <Button variant="accent" size="md" onClick={connect}>
            Connect Wallet
          </Button>
        )}
      </div>
    </header>
  );
}

/**
 * ModeToggle — Lane B segmented toggle, Enforce | Watch.
 *
 * Reduced from a filled pill to a hairline-bordered segment with active
 * state cued by ink-blue accent on a 1px underline. Same setMode behavior.
 */
function ModeToggle({ mode, onChange }: { mode: ModeKind; onChange: (next: ModeKind) => void }) {
  return (
    <div
      role="tablist"
      aria-label="Publish mode"
      className="flex h-8 items-center gap-4 text-[12px]"
    >
      <ModeButton active={mode === "enforce"} onClick={() => onChange("enforce")}>
        Enforce
      </ModeButton>
      <ModeButton active={mode === "watch"} onClick={() => onChange("watch")}>
        Watch
      </ModeButton>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={[
        "relative inline-flex h-8 items-center font-medium transition-colors",
        active
          ? "text-text after:absolute after:inset-x-0 after:-bottom-px after:h-px after:bg-accent"
          : "text-text-muted hover:text-text",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
