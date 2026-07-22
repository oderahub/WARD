import { useId } from "react";
import { Plus as PlusIcon, Trash as TrashIcon } from "@phosphor-icons/react";
import type { TargetDraft } from "../../lib/policy-draft";
import { lookupTarget } from "../../lib/selector-display";
import { Input } from "../primitives";
import { SelectorRow } from "./SelectorRow";
import AbiPicker from "./AbiPicker";
import type { FieldErrors } from "./PolicyForm";

interface Props {
  target: TargetDraft;
  onChange: (next: TargetDraft) => void;
  onRemove: () => void;
  canRemove: boolean;
  /** Full validation map; this row reads slices under `pathPrefix`. */
  errors?: FieldErrors;
  /** Same-shape map for INFO-level notes (not errors). Used for the
   *  "per-call cap > daily cap" inline note on selector rows. */
  warnings?: FieldErrors;
  /** Dotted prefix into `errors` for this target, e.g. `targets.0`. */
  pathPrefix?: string;
  shouldShowError: (path: string) => boolean;
  touch: (path: string) => void;
}

export function TargetRow({
  target,
  onChange,
  onRemove,
  canRemove,
  errors,
  warnings,
  pathPrefix,
  shouldShowError,
  touch,
}: Props) {
  const targetId = useId();
  const errorId = useId();

  const targetPath = pathPrefix ? `${pathPrefix}.target` : undefined;
  const selectorsPath = pathPrefix ? `${pathPrefix}.selectors` : undefined;
  const hasValidAddress =
    !!target.target && /^0x[a-fA-F0-9]{40}$/.test(target.target);

  const targetError =
    errors && targetPath && shouldShowError(targetPath)
      ? errors.get(targetPath)
      : undefined;
  const selectorsError =
    errors && selectorsPath && shouldShowError(selectorsPath)
      ? errors.get(selectorsPath)
      : undefined;

  // Resolve a friendly name for well-known targets (currently none — the
  // map in selector-display.ts is intentionally empty) so the contract row
  // can identify itself by name, not just a 0x address. Degrades silently
  // when the address is unknown.
  const friendlyName = hasValidAddress ? lookupTarget(target.target) : undefined;

  return (
    <div className="space-y-3 rounded-md border border-ward-border bg-bg p-4">
      <div className="flex items-start gap-2">
        <label
          htmlFor={targetId}
          className="w-24 shrink-0 pt-1.5 text-[11px] uppercase tracking-wider text-text-subtle"
        >
          contract
        </label>
        <div className="flex flex-1 flex-col gap-1 min-w-0">
          {friendlyName && (
            <span className="text-xs font-medium text-text">{friendlyName}</span>
          )}
          <Input
            id={targetId}
            aria-invalid={targetError ? true : undefined}
            aria-describedby={targetError ? errorId : undefined}
            className="w-full font-mono text-xs"
            placeholder="0xA1601891Da4b60c9311B3A024e3E03C5136460e4"
            value={target.target}
            onChange={(e) => onChange({ ...target, target: e.target.value })}
            onBlur={() => targetPath && touch(targetPath)}
          />
          {targetError && (
            <p id={errorId} role="alert" className="text-[11px] text-danger">
              {targetError}
            </p>
          )}
        </div>
        <button
          type="button"
          aria-label={canRemove ? "Remove this contract from the policy" : "At least one contract is required"}
          title={canRemove ? "Remove contract" : "At least one contract is required"}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-ward-border text-text-muted hover:border-danger hover:text-danger disabled:cursor-not-allowed disabled:opacity-30 active:scale-[0.98] transition-transform"
          onClick={onRemove}
          disabled={!canRemove}
        >
          <TrashIcon size={14} weight="regular" aria-hidden="true" />
        </button>
      </div>

      {hasValidAddress && (
        <AbiPicker
          address={target.target}
          existingSelectors={target.selectors}
          onAddSelectors={(sels) => {
            // If the only selector on this target is the blank placeholder the
            // form starts with, REPLACE it instead of appending — otherwise the
            // empty signature stays in the policy draft and publish validation
            // fails after a "successful" ABI pick. (Codex pre-review catch.)
            const hasOnlyBlankSelector =
              target.selectors.length === 1 && target.selectors[0].selector.trim() === "";
            onChange({
              ...target,
              selectors: hasOnlyBlankSelector ? sels : [...target.selectors, ...sels],
            });
          }}
        />
      )}

      <div
        className={
          hasValidAddress
            ? "space-y-3 border-t border-ward-border pt-3"
            : "space-y-3"
        }
      >
        {target.selectors.length > 1 && (
          <div className="grid grid-cols-12 gap-2 px-1 text-[11px] uppercase tracking-wider text-text-subtle">
            <span className="col-span-5">function (e.g. transfer(address,uint256))</span>
            <span className="col-span-3">approval mode</span>
            <span
              className="col-span-2"
              title="Caps native STT msg.value per call. Does NOT meter ERC20 token amounts inside calldata."
            >
              max native per call
            </span>
            <span className="col-span-1">wait (sec)</span>
            <span className="col-span-1" />
          </div>
        )}

        {selectorsError && (
          <p className="px-1 text-[11px] text-danger" role="alert">
            {selectorsError}
          </p>
        )}

        <div className="divide-y divide-ward-border/60">
          {target.selectors.map((sel, i) => (
            <SelectorRow
              key={i}
              selector={sel}
              canRemove={target.selectors.length > 1}
              errors={errors}
              warnings={warnings}
              pathPrefix={pathPrefix ? `${pathPrefix}.selectors.${i}` : undefined}
              shouldShowError={shouldShowError}
              touch={touch}
              onChange={(next) => {
                const copy = target.selectors.slice();
                copy[i] = next;
                onChange({ ...target, selectors: copy });
              }}
              onRemove={() => {
                const copy = target.selectors.filter((_, j) => j !== i);
                onChange({ ...target, selectors: copy });
              }}
            />
          ))}
        </div>

        <button
          type="button"
          aria-label="Add another function"
          title="Add another function"
          className="mt-3 inline-flex h-7 w-7 items-center justify-center rounded-md border border-ward-border text-text-muted hover:border-accent hover:text-accent active:scale-[0.98] transition-transform"
          onClick={() =>
            onChange({
              ...target,
              selectors: [
                ...target.selectors,
                { selector: "", tier: "IMMEDIATE", valueCapPerCall: "0", delaySeconds: 0 },
              ],
            })
          }
        >
          <PlusIcon size={14} weight="bold" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
