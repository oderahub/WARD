import { useState } from "react";
import type { PolicyInput } from "@ward/sdk";
import { simulateIntent } from "../../lib/policy-draft";
import { Button, Input } from "../primitives";
import { Separator } from "../ui/separator";

interface Props {
  input: PolicyInput | null;
}

const LEGEND = "text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted";
const LABEL = "w-40 shrink-0 text-xs text-text-muted";

/**
 * Client-side preview of `WardOracle.checkIntent` against the in-form draft
 * policy. Lets a publisher sanity-check what their policy would allow BEFORE
 * spending gas to publish it. On-chain checkIntent remains authoritative.
 */
export function IntentSimulator({ input }: Props) {
  const [target, setTarget] = useState("");
  const [selector, setSelector] = useState("");
  const [value, setValue] = useState("0");
  const [result, setResult] = useState<{ allowed: boolean; reason: string } | null>(null);

  const disabled = input === null;

  function onSimulate() {
    if (!input) return;
    // simulateIntent matches PolicyLib's reason precedence
    // (paused → expired → target → selector → valueCap → daily) AND treats
    // `dailySpendWeiCap == 0n` as "zero cap" rather than "unlimited", so the
    // local daily-cap pre-check this component used to need is gone.
    setResult(simulateIntent(input, { target, selector, value }));
  }

  return (
    <div className="mt-4">
      <Separator className="mb-4" />
      <div className={LEGEND}>Try a call (preview only, not on-chain)</div>

      {disabled ? (
        <div className="mt-2 text-xs text-text-subtle">
          Resolve form errors above before simulating.
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <div className="flex items-center gap-2">
            <label htmlFor="sim-target" className={LABEL}>
              Contract address
            </label>
            <Input
              id="sim-target"
              className="flex-1 font-mono"
              placeholder="0x…"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="sim-selector" className={LABEL}>
              Function (e.g. transfer(address,uint256))
            </label>
            <Input
              id="sim-selector"
              className="flex-1 font-mono"
              placeholder="transfer(address,uint256)"
              value={selector}
              onChange={(e) => setSelector(e.target.value)}
            />
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="sim-value" className={LABEL}>
              value
            </label>
            <Input
              id="sim-value"
              className="flex-1 font-mono"
              placeholder="0 or `1 ether`"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>

          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onSimulate}>
              simulate
            </Button>
            {result && (
              <span
                className={
                  "font-mono text-[11px] uppercase tracking-[0.12em] " +
                  (result.allowed ? "text-success" : "text-danger")
                }
              >
                {result.allowed ? result.reason : `denied: ${result.reason}`}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
