import { useCallback, useMemo, useState } from "react";
import { compilePolicy, type PolicyInput } from "@ward/sdk";
import {
  emptyPolicyDraft,
  PolicyDraftSchema,
  renderPolicyMarkdown,
  type PolicyDraft,
} from "../lib/policy-draft";
import { useUrlState } from "./useUrlState";

export type CompileResult =
  | { ok: true; input: PolicyInput }
  | { ok: false; stage: "schema" | "compile"; messages: string[] };

export interface UsePolicyDraft {
  draft: PolicyDraft;
  setDraft: (next: PolicyDraft) => void;
  yamlText: string;
  compileResult: CompileResult;
  /** Set of field paths the user has blurred at least once. */
  touched: Set<string>;
  /** Mark a field path as touched (call from onBlur). */
  touch: (path: string) => void;
  /** True once the user has clicked publish at least once.
   *  Once set, ALL errors render regardless of touched state. */
  hasAttemptedPublish: boolean;
  /** Set hasAttemptedPublish=true. Idempotent. */
  markPublishAttempt: () => void;
  /** Convenience: returns true if the field error should be rendered. */
  shouldShowError: (path: string) => boolean;
}

/**
 * Single source of truth for the publish form. Owns the draft state, renders
 * it to markdown live, and runs it through the SAME SDK compiler the CLI uses
 * — so what you see in the preview is exactly what would go on-chain.
 *
 * The schema parse runs first (catches form-shape errors with field paths);
 * if that's clean, the SDK compile runs (catches semantic errors like
 * unknown YAML keys, malformed wei caps, expired timestamps).
 */
export function usePolicyDraft(initial: PolicyDraft = emptyPolicyDraft()): UsePolicyDraft {
  const [draft, setDraft] = useState<PolicyDraft>(initial);
  // Tracks per-field blur state so the form can defer error rendering until
  // the user has actually interacted with a field (or hit publish).
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const [hasAttemptedPublish, setHasAttemptedPublish] = useState(false);

  // The SDK compiler is the last-line defense before `setPolicy`. Pass the
  // active oracle/queue so self-target rejection fires in the
  // same pre-flight pass as the dashboard's zod schema rather than waiting
  // for an on-chain revert. Label flows through so the compiler can also run
  // its control-byte check at the same point the dashboard does.
  const { oracle: oracleAddress, queue: queueAddress } = useUrlState();
  const yamlText = useMemo(() => renderPolicyMarkdown(draft), [draft]);

  const compileResult: CompileResult = useMemo(() => {
    const parsed = PolicyDraftSchema.safeParse(draft);
    if (!parsed.success) {
      return {
        ok: false,
        stage: "schema",
        messages: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      };
    }
    try {
      const input = compilePolicy(yamlText, {
        oracleAddress,
        queueAddress,
        label: draft.label,
      });
      return { ok: true, input };
    } catch (e) {
      return {
        ok: false,
        stage: "compile",
        messages: [(e as Error).message],
      };
    }
  }, [draft, yamlText, oracleAddress, queueAddress]);

  const touch = useCallback((path: string) => {
    setTouched((s) => (s.has(path) ? s : new Set(s).add(path)));
  }, []);

  const markPublishAttempt = useCallback(() => {
    setHasAttemptedPublish((v) => (v ? v : true));
  }, []);

  const shouldShowError = useCallback(
    (path: string) => hasAttemptedPublish || touched.has(path),
    [hasAttemptedPublish, touched],
  );

  return {
    draft,
    setDraft,
    yamlText,
    compileResult,
    touched,
    touch,
    hasAttemptedPublish,
    markPublishAttempt,
    shouldShowError,
  };
}
