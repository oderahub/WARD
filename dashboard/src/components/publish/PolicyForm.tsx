import { useId, useMemo } from "react";
import { Plus as PlusIcon, PencilSimple as PencilIcon } from "@phosphor-icons/react";
import { slugifyLabel, type PolicyDraft } from "../../lib/policy-draft";
import type { CompileResult } from "../../hooks/usePolicyDraft";
import {
  computeAggregateCapNote,
  computePerCallExceedsDailyWarnings,
} from "../../lib/policy-edit-warnings";
import { Input, Textarea, Alert } from "../primitives";
import { TargetRow } from "./TargetRow";

interface Props {
  draft: PolicyDraft;
  setDraft: (next: PolicyDraft) => void;
  compileResult?: CompileResult;
  shouldShowError: (path: string) => boolean;
  touch: (path: string) => void;
}

const LEGEND = "text-[11px] uppercase tracking-wider text-text-subtle";
const LABEL = "w-28 shrink-0 pt-1.5 text-xs text-text-muted";

/**
 * Map a schema error message (`<path>: <text>`) to its field. The compile
 * result emits one entry per Zod issue with a dotted path; we split on the
 * first `:` so messages containing colons (rare but possible) survive.
 *
 * First occurrence per path wins so we never stack multiple messages under
 * a single field — picking the most informative one would mean re-deriving
 * intent from text, which is brittle.
 */
export type FieldErrors = Map<string, string>;

function parseSchemaErrors(messages: ReadonlyArray<string>): FieldErrors {
  const map = new Map<string, string>();
  for (const msg of messages) {
    const colonIdx = msg.indexOf(":");
    if (colonIdx === -1) continue;
    const path = msg.slice(0, colonIdx).trim();
    const text = msg.slice(colonIdx + 1).trim();
    if (!map.has(path)) map.set(path, text);
  }
  return map;
}

export function PolicyForm({ draft, setDraft, compileResult, shouldShowError, touch }: Props) {
  // Compile-stage errors (SDK rejection after schema passed) have no
  // per-field path — surface them at the top as before. Schema errors map
  // to fields and render inline; the top alert hides for that path so the
  // page isn't shouting at users about errors they can also see in context.
  const isCompileError =
    compileResult && compileResult.ok === false && compileResult.stage === "compile";
  const schemaErrors: FieldErrors =
    compileResult && compileResult.ok === false && compileResult.stage === "schema"
      ? parseSchemaErrors(compileResult.messages)
      : new Map();

  // INFO-level per-selector note when valueCapPerCall > dailyCap.
  // Computed off the compiled PolicyInput (so it follows the same parsing as
  // the SDK) and only when the compile succeeded — schema/compile errors
  // already cover the "you typed something unparseable" case.
  const warnings: FieldErrors = useMemo(() => {
    if (!compileResult || compileResult.ok !== true) return new Map();
    return computePerCallExceedsDailyWarnings(compileResult.input);
  }, [compileResult]);

  // aggregate-cap INFO note. Surfaced at the bottom of the
  // spending-limits fieldset (the daily cap is the binding constraint, so the
  // message belongs in the same field group). Same compile-success gate as
  // the per-row warnings — schema/compile errors already cover unparseable
  // input.
  const aggregateCapNote: string | null = useMemo(() => {
    if (!compileResult || compileResult.ok !== true) return null;
    return computeAggregateCapNote(compileResult.input).note;
  }, [compileResult]);

  const gated = (path: string) =>
    shouldShowError(path) ? schemaErrors.get(path) : undefined;

  return (
    <div className="space-y-4 text-sm">
      {isCompileError && compileResult && compileResult.ok === false && (
        <Alert variant="danger" title="SDK compile failed">
          <ul className="list-disc pl-4 font-mono text-xs">
            {compileResult.messages.slice(0, 3).map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </Alert>
      )}

      <fieldset className="space-y-2 border-0 p-0">
        <legend className={LEGEND}>about this policy</legend>

        <Field
          label="policy name"
          required
          htmlFor="policy-name"
          error={gated("name")}
        >
          {(describedBy, invalid) => (
            <Input
              id="policy-name"
              aria-required="true"
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              className="flex-1"
              placeholder="e.g. My Trading Bot Policy"
              value={draft.name}
              onChange={(e) => {
                const nextName = e.target.value;
                // Auto-derive the short-id from name UNTIL the operator
                // explicitly edits the label field. The label hasn't been
                // "touched" iff it currently equals the slug we'd derive from
                // the previous name (or is empty for first-keystroke). Once
                // they override, this autopilot stops on its own.
                const currentlyAuto =
                  draft.label === "" || draft.label === slugifyLabel(draft.name);
                setDraft({
                  ...draft,
                  name: nextName,
                  label: currentlyAuto ? slugifyLabel(nextName) : draft.label,
                });
              }}
              onBlur={() => touch("name")}
            />
          )}
        </Field>

        <Field
          label="short id"
          required
          htmlFor="policy-label"
          error={gated("label")}
        >
          {(describedBy, invalid) => (
            <div className="flex flex-1 items-center gap-2">
              <Input
                id="policy-label"
                aria-required="true"
                aria-invalid={invalid || undefined}
                aria-describedby={describedBy}
                className="flex-1 font-mono"
                placeholder="e.g. my-bot-v1"
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                onBlur={() => touch("label")}
                title="Auto-derived from the policy name; edit to override. Letters, numbers, dashes, ~32 chars."
              />
              {draft.name && draft.label === slugifyLabel(draft.name) && (
                <span
                  className="inline-flex shrink-0 items-center gap-1 text-[11px] text-text-subtle"
                  title="Auto-derived from the policy name. Edit the field to override."
                >
                  <PencilIcon size={11} weight="regular" aria-hidden="true" />
                  auto
                </span>
              )}
            </div>
          )}
        </Field>

        <Field label="notes" htmlFor="policy-description">
          {() => (
            <Textarea
              id="policy-description"
              className="flex-1"
              rows={2}
              placeholder="What does this agent do? (Stored on-chain with the policy.)"
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          )}
        </Field>
      </fieldset>

      <fieldset className="space-y-2 border-0 p-0">
        <legend className={LEGEND}>native (AVAX) spending limits</legend>

        <Field
          label="daily native (AVAX) spend cap"
          htmlFor="policy-daily-cap"
          error={gated("dailySpendWeiCap")}
        >
          {(describedBy, invalid) => (
            <Input
              id="policy-daily-cap"
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              className="w-48 font-mono"
              placeholder='e.g. "1 ether" or 0'
              value={draft.dailySpendWeiCap}
              onChange={(e) => setDraft({ ...draft, dailySpendWeiCap: e.target.value })}
              onBlur={() => touch("dailySpendWeiCap")}
              title="Caps native AVAX (msg.value) spent per UTC day across all calls. ERC20 token transfers (e.g. USDC) are NOT counted here. Gate token spend by adding the token contract as a target and allowlisting `transfer(address,uint256)`. Use 0 to block all native spend (the contract treats 0 as zero cap, not unlimited)."
            />
          )}
        </Field>

        <Field
          label="valid until"
          htmlFor="policy-expires"
          error={gated("expiresAtISO")}
        >
          {(describedBy, invalid) => (
            <Input
              id="policy-expires"
              type="datetime-local"
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              className="w-56"
              value={toLocalDatetime(draft.expiresAtISO)}
              onChange={(e) => setDraft({ ...draft, expiresAtISO: fromLocalDatetime(e.target.value) })}
              onBlur={() => touch("expiresAtISO")}
              title="After this date, the policy stops authorizing calls."
            />
          )}
        </Field>

        <label
          className="flex items-center gap-2 text-xs text-text-muted"
          title="When paused, the policy blocks every call until you unpause it."
        >
          <input
            type="checkbox"
            checked={draft.paused}
            onChange={(e) => setDraft({ ...draft, paused: e.target.checked })}
          />
          Paused (blocks all calls)
        </label>

        {aggregateCapNote && (
          <p className="text-xs text-text-muted">{aggregateCapNote}</p>
        )}
      </fieldset>

      <fieldset className="space-y-2 border-0 p-0">
        <legend className={LEGEND}>
          what the agent can call <span className="text-danger" aria-hidden="true">*</span>
        </legend>
        {/* Root-level `targets` error (e.g. empty array) renders against the
         * legend rather than any single contract row. */}
        {shouldShowError("targets") && schemaErrors.get("targets") && (
          <p className="text-[11px] text-danger" role="alert">
            {schemaErrors.get("targets")}
          </p>
        )}
        <div className="space-y-3" aria-required="true">
          {draft.targets.map((t, i) => (
            <TargetRow
              key={i}
              target={t}
              canRemove={draft.targets.length > 1}
              errors={schemaErrors}
              warnings={warnings}
              pathPrefix={`targets.${i}`}
              shouldShowError={shouldShowError}
              touch={touch}
              onChange={(next) => {
                const copy = draft.targets.slice();
                copy[i] = next;
                setDraft({ ...draft, targets: copy });
              }}
              onRemove={() => {
                setDraft({ ...draft, targets: draft.targets.filter((_, j) => j !== i) });
              }}
            />
          ))}
        </div>
        <button
          type="button"
          aria-label="Add another contract"
          title="Add another contract"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-ward-border text-text-muted hover:border-accent hover:text-accent active:scale-[0.98] transition-transform"
          onClick={() =>
            setDraft({
              ...draft,
              targets: [
                ...draft.targets,
                {
                  target: "",
                  selectors: [
                    { selector: "", tier: "IMMEDIATE", valueCapPerCall: "0", delaySeconds: 0 },
                  ],
                },
              ],
            })
          }
        >
          <PlusIcon size={14} weight="bold" aria-hidden="true" />
        </button>
      </fieldset>
    </div>
  );
}

/**
 * Field wrapper: label on the left, control on the right, optional error
 * line directly under the control. Uses a render-prop so the consumer can
 * wire aria-describedby + aria-invalid onto the actual input element
 * (otherwise screen readers don't link the error to the field).
 */
interface FieldProps {
  label: string;
  htmlFor: string;
  required?: boolean;
  error?: string;
  children: (describedBy: string | undefined, invalid: boolean) => React.ReactNode;
}

function Field({ label, htmlFor, required, error, children }: FieldProps) {
  const errorId = useId();
  const describedBy = error ? errorId : undefined;
  return (
    <div className="flex items-start gap-2">
      <label htmlFor={htmlFor} className={LABEL}>
        {label}
        {required && <span className="text-danger" aria-hidden="true"> *</span>}
      </label>
      <div className="flex flex-1 flex-col gap-1">
        {children(describedBy, Boolean(error))}
        {error && (
          <p id={errorId} role="alert" className="text-[11px] text-danger">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

// `<input type="datetime-local">` wants `YYYY-MM-DDTHH:mm` in LOCAL time.
function toLocalDatetime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalDatetime(local: string): string {
  if (!local) return "";
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}
