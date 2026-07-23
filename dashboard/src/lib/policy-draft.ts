import { z } from "zod";
import { isAddress, parseAbiItem, toFunctionSelector } from "viem";
import {
  parseEtherFlexible,
  suggestEtherFix,
  TIER_NAMES,
  type PolicyInput,
  type Tier as SdkTier,
} from "@ward/sdk";
import { NETWORKS, UNSET_ADDRESS } from "./networks";

/**
 * Schema for the in-form draft of a POLICY.md. Mirrors the v0.1 spec the SDK
 * compiler enforces, but with form-friendly types (strings everywhere) so the
 * UI can hold partial / in-progress state without losing the user's typing.
 *
 * The render layer below is the only path from this shape to POLICY.md text.
 * The SDK's `compilePolicy` is the only path from POLICY.md text to a valid
 * on-chain PolicyInput. We deliberately do NOT skip the markdown round-trip:
 * staying on that path means the dashboard publish behavior is bit-identical
 * to `ward push` from the CLI.
 */
export const TIER_VALUES = ["IMMEDIATE", "DELAYED", "VETO_REQUIRED"] as const;
export type Tier = (typeof TIER_VALUES)[number];

/**
 * Clock-skew window for the past-expiry refine. A user publishing
 * from a slightly-fast client should not get rejected for an expiry that's
 * 5 seconds in the past on their machine but still future on the chain RPC.
 * 60s is large enough to absorb realistic NTP drift, small enough that a
 * user who *meant* an already-expired draft still sees the error.
 */
const SAFETY_WINDOW_MS = 60_000;

/**
 * Cap published-policy lifetime at 5 years out. A pasted
 * `9999-01-01T00:00:00Z` parses as a valid future timestamp under the past-only
 * refine but is effectively "never expires"; capping at +5y keeps "expiry as a
 * dead-man's switch" honest. Mirrored on the SDK compiler so the CLI path
 * agrees.
 */
const MAX_POLICY_LIFETIME_MS = 5 * 365 * 24 * 60 * 60 * 1000;

const addressRegex = /^0x[a-fA-F0-9]{40}$/;
/**
 * The zero address is the placeholder used in starter templates. It has its
 * own dedicated refine (below) with a friendlier "swap the placeholder"
 * message so the user isn't told it's "reserved" when really it's just
 * un-filled. Kept separate from RESERVED_TARGETS for that reason.
 */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const signatureRegex = /^[a-zA-Z_][a-zA-Z0-9_]*\([a-zA-Z0-9_,\[\] ]*\)$/;
const hexSelectorRegex = /^0x[0-9a-fA-F]{8}$/;
// Publish-only ASCII slug rule. The edit flow must keep accepting existing
// labels like "trading v1" so we don't break re-edit of historical policies —
// this regex is therefore on the display schema, not the semantic one.
// This regex is the publish gate that prevents non-ASCII labels from reaching
// the chain. PolicyDrawer's `isAsciiPrintable` is the read-side mirror.
const labelSlugRegex = /^[a-zA-Z0-9._-]+$/;

/**
 * Derive a policy `label` (short id) from a human-readable `name`. Used by the
 * publish form to auto-fill the label field as the operator types the name, so
 * they only override when they want something different. Output rules:
 *   - lowercase
 *   - non-[a-z0-9] runs collapsed to single `-`
 *   - leading/trailing `-` stripped
 *   - sliced to 32 chars (then re-trimmed in case a trailing `-` survives)
 *   - falls back to the literal `policy` when the input is empty or all-junk
 */
export function slugifyLabel(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return slug.length > 0 ? slug : "policy";
}
// Accept either a plain wei integer ("1000000000000000000") or an "N ether"
// shorthand the SDK normalizes ("1 ether", "0.1 ether").
const weiOrEtherRegex = /^(0|[1-9][0-9]*)(\.[0-9]+)?( ether)?$|^[0-9]+$/;

/**
 * Validate a cap-string the way the SDK ultimately will. Returns null on
 * success, or a specific error message tailored to the failure mode (typo
 * suggestion when the user wrote `0.5ethe` / `1 eth`, plain shape error for
 * truly unparseable input). Keeps the regex as the primary gate so behavior
 * for well-formed inputs is unchanged, but upgrades the message from the
 * generic "wei integer or `N ether` shorthand" when a typo is detectable.
 *
 * Native-only by design: AVAX (chain native value) is the only metering Ward
 * does on-chain; ERC20 token amounts encoded in calldata are not parsed. So we
 * deliberately do NOT accept `gwei` / `wei` / `eth` here, and the caller
 * messaging makes that explicit on the form.
 */
function validateCapString(s: string): string | null {
  if (weiOrEtherRegex.test(s)) return null;
  const hint = suggestEtherFix(s);
  if (hint !== null) {
    return `Unrecognized unit. Did you mean "${hint}"? (Only "N ether" or a plain wei integer is accepted; spending caps gate native AVAX only.)`;
  }
  return "wei integer or `N ether` shorthand (e.g. `0.5 ether` or `1000000000000000000`)";
}

/**
 * ABI-width bounds for the on-chain Policy struct (PolicyTypes.sol):
 *   - dailySpendWeiCap, valueCapPerCall: uint256
 *   - delaySeconds: uint32
 * A draft above either bound would overflow / truncate when the contract reads
 * the input struct. Mirror the SDK compiler/builder so the dashboard catches
 * the problem at form-validation time rather than at the publish revert.
 */
const UINT32_MAX_DRAFT = 0xffff_ffff; // 4294967295
const UINT256_MAX_DRAFT = (1n << 256n) - 1n;

/**
 * Parse a `weiOrEtherRegex`-validated string into a bigint, or null if the
 * input doesn't normalize cleanly. Used by the uint256-bound refines below;
 * the regex already guarantees the input shape, so the only failure mode is
 * an "N ether" decimal-fraction that overflows wei via `parseEther`-equivalent
 * scaling — out of scope for this helper (we just check the wei integer).
 */
function parseWeiStringForBoundCheck(s: string): bigint | null {
  const trimmed = s.trim();
  if (trimmed === "" || trimmed === "0") return 0n;
  const etherMatch = /^(\d+)(?:\.(\d+))?\s*ether$/i.exec(trimmed);
  if (etherMatch) {
    const whole = etherMatch[1];
    const frac = (etherMatch[2] ?? "").padEnd(18, "0").slice(0, 18);
    try {
      return BigInt(whole) * 10n ** 18n + BigInt(frac || "0");
    } catch {
      return null;
    }
  }
  if (/^\d+$/.test(trimmed)) {
    try {
      return BigInt(trimmed);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Targets that must never appear in a published policy. Built from:
 * - All configured oracle / queue addresses (a policy targeting its own
 *   gatekeeper or the action queue would either no-op or self-rug).
 * - The canonical EVM precompiles (11 total) — calling these via a policy is
 *   almost certainly a footgun rather than intent:
 *     0x01 ecrecover                0x02 sha256
 *     0x03 ripemd160                0x04 identity
 *     0x05 modexp                   0x06 ecAdd
 *     0x07 ecMul                    0x08 ecPairing
 *     0x09 blake2f                  0x0a EIP-4844 KZG point evaluation
 *     0x100 RIP-7212 P256VERIFY
 *   We deliberately do NOT include 0x0b..0xff — those are not assigned
 *   precompiles, and a future EIP could assign meaning to any of them.
 *
 * NOTE: The zero address is handled by its own dedicated refine on the
 * target schemas (see `ZERO_ADDRESS` above), which surfaces a friendlier
 * "Replace the placeholder address with your contract address." message
 * rather than the generic reserved-target wording. Keeping 0x0 out of this
 * set is what lets that friendlier message win without double-reporting.
 */
const PRECOMPILE_ADDRESSES: readonly number[] = [
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x100,
];
function buildReservedTargets(): Set<string> {
  const set = new Set<string>();
  for (const net of Object.values(NETWORKS)) {
    // Skip UNSET_ADDRESS: a network whose deployment isn't configured yet
    // carries the zero address, and adding it here would shadow the friendlier
    // placeholder-specific message described above.
    if (net.oracleAddress !== UNSET_ADDRESS) set.add(net.oracleAddress.toLowerCase());
    if (net.queueAddress !== UNSET_ADDRESS) set.add(net.queueAddress.toLowerCase());
  }
  for (const n of PRECOMPILE_ADDRESSES) {
    set.add(`0x${n.toString(16).padStart(40, "0")}`);
  }
  return set;
}
export const RESERVED_TARGETS: Set<string> = buildReservedTargets();

/**
 * Reject control bytes (C0 controls 0x00..0x1F and DEL 0x7F) in a label.
 * Tab/newline/etc. would survive padHex'ing to bytes32 and silently corrupt
 * UI rendering and explorer links that interpolate the label.
 */
function labelHasControlBytes(label: string): boolean {
  for (let i = 0; i < label.length; i++) {
    const code = label.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * A label is "ASCII printable" when every code unit lies in 0x20..0x7e
 * inclusive (space through tilde). Used by PolicyDrawer to decide whether to
 * render the raw bytes32 hex form instead of the decoded text — a label
 * containing a non-ASCII byte would otherwise render as mojibake or get
 * silently truncated at the first high byte. Space (0x20) IS printable here
 * because historical labels like `"trading v1"` must keep round-tripping
 * through the edit modal (the publish-time slug rule lives on the display
 * schema; this helper is just for rendering safety).
 */
export function isAsciiPrintable(label: string): boolean {
  for (let i = 0; i < label.length; i++) {
    const code = label.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/**
 * Invisible or ambiguous code points that render as nothing (zero-width / BOM)
 * or as something visually indistinguishable from a regular space (Unicode
 * space separators, line and paragraph separators). A name containing any of
 * these would round-trip through the markdown header looking identical to a
 * different-but-visually-equal name — perfect for spoofing in a dashboard list
 * — and the Unicode line / paragraph separators also break markdown rendering
 * and leak into the bytes32 hex form. Reject at the schema level.
 *
 * Classes covered:
 *   - C0 controls (0x00..0x1F) and DEL (0x7F) — enforced inline in
 *     isValidPolicyName / sanitizeNameForMarkdown, not in this set.
 *   - BOM and zero-width range (0xFEFF, 0x200B..0x200F).
 *   - Unicode line / paragraph separators (0x2028, 0x2029).
 *   - Unicode General_Category=Zs (space separators) EXCEPT U+0020 — every
 *     Zs code point renders as whitespace indistinguishable from a regular
 *     space, so any of them in a name is the same spoofing surface as NBSP.
 *
 * Zero-width / BOM:
 *   0xFEFF — BOM / zero-width no-break space
 *   0x200B — zero-width space
 *   0x200C — zero-width non-joiner
 *   0x200D — zero-width joiner
 *   0x200E — left-to-right mark
 *   0x200F — right-to-left mark
 *
 * Line / paragraph separators:
 *   0x2028 — line separator (whitespace that splits a markdown line)
 *   0x2029 — paragraph separator (whitespace that splits a markdown paragraph)
 *
 * Unicode space separators (full Zs except U+0020):
 *   0x00A0 — non-breaking space
 *   0x1680 — ogham space mark
 *   0x2000..0x200A — en quad through hair space (en/em/thin/etc.)
 *   0x202F — narrow no-break space
 *   0x205F — medium mathematical space
 *   0x3000 — ideographic space
 */
const UNICODE_SPACE_SEPARATORS_EXCEPT_SPACE: readonly number[] = [
  0x00a0, // NO-BREAK SPACE
  0x1680, // OGHAM SPACE MARK
  0x2000, // EN QUAD
  0x2001, // EM QUAD
  0x2002, // EN SPACE
  0x2003, // EM SPACE
  0x2004, // THREE-PER-EM SPACE
  0x2005, // FOUR-PER-EM SPACE
  0x2006, // SIX-PER-EM SPACE
  0x2007, // FIGURE SPACE
  0x2008, // PUNCTUATION SPACE
  0x2009, // THIN SPACE
  0x200a, // HAIR SPACE
  0x202f, // NARROW NO-BREAK SPACE
  0x205f, // MEDIUM MATHEMATICAL SPACE
  0x3000, // IDEOGRAPHIC SPACE
];
const INVISIBLE_OR_AMBIGUOUS_CODEPOINTS: ReadonlySet<number> = new Set([
  0xfeff, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029,
  ...UNICODE_SPACE_SEPARATORS_EXCEPT_SPACE,
]);

/**
 * A policy name shows up verbatim as the markdown header and in every UI
 * list /
 * explorer link. The rule is: single line of visible characters and regular
 * (U+0020) spaces only.
 *  - Reject triple backticks (would close the markdown wrapper).
 *  - Reject any CR/LF/tab (force a single line; tab also corrupts header
 *    rendering inconsistently across markdown engines).
 *  - Reject the C0 control range 0x00..0x1F and DEL 0x7F.
 *  - Reject BOM and zero-width chars (invisible bytes enable spoofing).
 *  - Reject Unicode line/paragraph separators U+2028/U+2029 (break the
 *    single-line invariant in renderers that honor them).
 *  - Reject every Unicode General_Category=Zs (space separator) code point
 *    EXCEPT U+0020 — NBSP, en/em/thin/ideographic/etc. all render as
 *    whitespace indistinguishable from a regular space but parse as different
 *    bytes, which is the same spoofing surface as the zero-width chars.
 *  - Allow space (0x20) and everything else printable / extended-Unicode.
 * Defense-in-depth `sanitizeNameForMarkdown` in `renderPolicyMarkdown` covers
 * the same patterns at render time so a draft that bypassed this schema still
 * produces valid markdown.
 */
function isValidPolicyName(name: string): boolean {
  if (name.includes("```")) return false;
  if (/[\r\n\t]/.test(name)) return false;
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code === 0x7f) return false;
    // Only space (0x20) is allowed from the C0 + space range; every other
    // control byte (including tab, which is also caught above) is rejected.
    if (code < 0x20) return false;
    if (INVISIBLE_OR_AMBIGUOUS_CODEPOINTS.has(code)) return false;
  }
  return true;
}

/**
 * Display-only check: the selector either reads as a `0x` + 8-hex bytes4
 * (which the SDK compiler accepts directly when seeded from chain), or is a
 * function signature that round-trips through `parseAbiItem`. The publish
 * form is signature-only by UX; this check exists so a typo in the form
 * (`transfer (address)` with extra space, missing paren, etc.) gets caught
 * before the compile step throws a less-localized error.
 */
function isValidSelectorDisplay(s: string): boolean {
  if (hexSelectorRegex.test(s)) return true;
  if (!signatureRegex.test(s)) return false;
  try {
    parseAbiItem(`function ${s}`);
    return true;
  } catch {
    return false;
  }
}
/**
 * Helper: resolve a draft selector string to the lowercase 4-byte
 * hex form, or null if it can't be resolved. Used by the duplicate-selector
 * dedup pass — format-invalid selectors are deliberately skipped (the display
 * schema reports those separately so the user doesn't see two errors at once).
 */
export function selectorToBytes4OrNull(s: string): string | null {
  if (hexSelectorRegex.test(s)) return s.toLowerCase();
  if (!signatureRegex.test(s)) return null;
  try {
    return toFunctionSelector(s).toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Semantic selector rules: every check that should hold regardless of how the
 * draft was seeded. The selector field is left untyped here (just non-empty)
 * because both publish (signature) and edit (hex) flows produce valid strings
 * the compiler accepts — the display-only signature/hex distinction lives on
 * SelectorDraftSchemaDisplay.
 */
export const SelectorDraftSchemaSemantic = z
  .object({
    selector: z.string().min(1, "selector required"),
    tier: z.enum(TIER_VALUES),
    valueCapPerCall: z
      .string()
      .min(1, "cap required (use `0` for no native value)")
      // Shape check via custom refine (not `.regex(...)`) so we can upgrade the
      // generic shape error to a typo-aware "did you mean …" when the user
      // wrote `0.5ethe` or `1 eth`. Behavior on well-formed inputs is unchanged.
      .superRefine((s, ctx) => {
        const msg = validateCapString(s);
        if (msg !== null) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: msg });
        }
      })
      // valueCapPerCall is uint256 on-chain; refuse overflow at form time.
      .refine(
        (s) => {
          if (validateCapString(s) !== null) return true; // skip when shape already errored
          const v = parseWeiStringForBoundCheck(s);
          return v !== null && v <= UINT256_MAX_DRAFT;
        },
        { message: "valueCapPerCall exceeds uint256 max" },
      ),
    // delaySeconds is uint32 on-chain; cap the draft so it cannot truncate downstream.
    delaySeconds: z.coerce.number().int().min(0).max(UINT32_MAX_DRAFT).default(0),
  })
  .superRefine((s, ctx) => {
    if (s.tier !== "DELAYED" && s.delaySeconds !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["delaySeconds"],
        message: "delaySeconds must be 0 for IMMEDIATE and VETO_REQUIRED",
      });
    }
    // DELAYED tier requires a positive delay window. A DELAYED
    // selector with `delaySeconds: 0` collapses to IMMEDIATE on-chain — the
    // user almost certainly meant a real delay, so refuse the publish.
    if (s.tier === "DELAYED" && s.delaySeconds === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["delaySeconds"],
        message: "DELAYED tier requires a positive delaySeconds.",
      });
    }
  });

/** Publish-form selector schema: semantic rules + the display format check. */
export const SelectorDraftSchema = SelectorDraftSchemaSemantic.superRefine((s, ctx) => {
  if (!isValidSelectorDisplay(s.selector)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["selector"],
      message: "must be a function signature like `transfer(address,uint256)`",
    });
  }
});
export type SelectorDraft = z.infer<typeof SelectorDraftSchema>;

export const TargetDraftSchemaSemantic = z
  .object({
    target: z
      .string()
      .min(1, "target address required")
      .regex(addressRegex, "must be a 0x-prefixed 40-hex address"),
    selectors: z.array(SelectorDraftSchemaSemantic).min(1, "at least one selector required"),
  })
  .superRefine((t, ctx) => {
    // Zero-address placeholder: starter templates seed targets[0].target to
    // 0x0 so the user is forced to swap it. Surface a context-specific
    // message BEFORE the RESERVED_TARGETS branch so the friendlier wording
    // wins (and the user doesn't see two errors at once).
    if (t.target.toLowerCase() === ZERO_ADDRESS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target"],
        message: "Replace the placeholder address with your contract address.",
      });
      return;
    }
    // viem strict mode rejects mixed-case addresses with a wrong
    // EIP-55 checksum. All-lowercase / all-uppercase still pass — that's the
    // standard "no checksum provided" interpretation. The point is to catch
    // the typo-shaped failure (one wrong nibble in a mixed-case paste).
    if (addressRegex.test(t.target) && !isAddress(t.target, { strict: true })) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target"],
        message: "Invalid address checksum. Paste from your wallet, or use all-lowercase.",
      });
    }
    // Refuse precompiles and the Ward oracle/queue addresses.
    if (RESERVED_TARGETS.has(t.target.toLowerCase())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target"],
        message: "Target cannot be the WardOracle, WardQueue, or a precompile address.",
      });
    }
  });
export type TargetDraft = z.infer<typeof TargetDraftSchemaSemantic>;

/** Publish-form target schema: semantic rules + the publish-form selector schema. */
export const TargetDraftSchema = z
  .object({
    target: z
      .string()
      .min(1, "target address required")
      .regex(addressRegex, "must be a 0x-prefixed 40-hex address"),
    selectors: z.array(SelectorDraftSchema).min(1, "at least one selector required"),
  })
  .superRefine((t, ctx) => {
    if (t.target.toLowerCase() === ZERO_ADDRESS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target"],
        message: "Replace the placeholder address with your contract address.",
      });
      return;
    }
    if (addressRegex.test(t.target) && !isAddress(t.target, { strict: true })) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target"],
        message: "Invalid address checksum. Paste from your wallet, or use all-lowercase.",
      });
    }
    if (RESERVED_TARGETS.has(t.target.toLowerCase())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target"],
        message: "Target cannot be the WardOracle, WardQueue, or a precompile address.",
      });
    }
  });

/**
 * Semantic policy rules: every check that should hold regardless of how the
 * draft was seeded — applied to BOTH the publish form AND the edit modal so
 * semantic fixes (expiry-in-the-future, label control bytes, reserved targets,
 * etc.) close in the edit flow too. The edit flow seeds selectors as raw hex
 * (round-tripped from chain) which is why these rules cannot include the
 * function-signature format check.
 */
export const PolicyDraftSchemaSemantic = z
  .object({
    name: z
      .string()
      .min(1, "name required (becomes the markdown header)")
      .refine(isValidPolicyName, {
        message:
          "Policy name must be a single line of visible characters and spaces only.",
      }),
    description: z.string().default(""),
    label: z
      .string()
      .min(1, "label required (≤ 32 UTF-8 bytes; will be padHex'd to bytes32)")
      .refine((s) => new TextEncoder().encode(s).length <= 32, {
        message: "label exceeds 32 bytes when UTF-8 encoded",
      })
      .refine((s) => !labelHasControlBytes(s), {
        message: "label must not contain control bytes (tab/newline/etc.)",
      }),
    dailySpendWeiCap: z
      .string()
      .min(1, "use `0` to block all native spend")
      // Same shape-with-typo-hint validator the per-call cap uses; keeps the
      // two cap fields' error wording symmetric so the operator never sees a
      // generic message on one and a typo hint on the other.
      .superRefine((s, ctx) => {
        const msg = validateCapString(s);
        if (msg !== null) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: msg });
        }
      })
      // dailySpendWeiCap is uint256 on-chain; refuse overflow at form time.
      .refine(
        (s) => {
          if (validateCapString(s) !== null) return true; // skip when shape already errored
          const v = parseWeiStringForBoundCheck(s);
          return v !== null && v <= UINT256_MAX_DRAFT;
        },
        { message: "dailySpendWeiCap exceeds uint256 max" },
      ),
    expiresAtISO: z
      .string()
      .min(1, "Expiry required. Ward treats 0 as already-expired.")
      .refine((s) => !Number.isNaN(Date.parse(s)), {
        message: "must be a parseable ISO-8601 timestamp",
      }),
    paused: z.boolean().default(false),
    targets: z.array(TargetDraftSchemaSemantic).min(1, "at least one target required"),
    // UI-draft-only: the deployed WardAgentBase address the operator pasted
    // into the Source-agent entry on the Publish form, when the probe
    // confirmed it's bind-capable. Threaded into PostPublishChecklist as the
    // pre-filled Bind agent so the operator doesn't paste it twice. The chain
    // does NOT store this — renderPolicyMarkdown deliberately omits it.
    bindAgentAddress: z
      .string()
      .regex(addressRegex)
      .optional(),
  })
  .superRefine((p, ctx) => {
    // An expiry of `0` (or any past timestamp) compiles to an
    // already-expired policy, so every call would fail EXPIRED on-chain. The
    // emptyPolicyDraft path can't hit this (it seeds six months out) but a
    // user could type one in, and policyInputToDraft maps on-chain
    // `expiresAt === 0n` to "" — which is caught by .min(1) above. The
    // SAFETY_WINDOW_MS slack absorbs client/server clock skew (~60s) so a
    // user publishing right at the edge isn't rejected for a fast clock.
    const parsed = Date.parse(p.expiresAtISO);
    if (!Number.isNaN(parsed)) {
      // Defense-in-depth against the BigInt(0)-from-chain seed path: even if
      // the empty-string guard above is bypassed, an epoch-0 timestamp is
      // semantically "already expired" and must not parse as a valid draft.
      if (BigInt(Math.floor(parsed / 1000)) === 0n) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["expiresAtISO"],
          message: "Expiry required. Ward treats 0 as already-expired.",
        });
      } else if (parsed <= Date.now() + SAFETY_WINDOW_MS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["expiresAtISO"],
          message: "Expiry must be in the future.",
        });
      } else if (parsed > Date.now() + MAX_POLICY_LIFETIME_MS) {
        // See MAX_POLICY_LIFETIME_MS comment. The cap exists so a
        // pasted "9999-..." can't ship as an effectively-immortal policy.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["expiresAtISO"],
          message: "Expiry too far in the future. Max 5 years out.",
        });
      }
    }
    // Dedupe targets by lowercase address. The on-chain
    // `publishPolicy` reverts on duplicate targets — flag here so the user
    // sees the dupe inline rather than as a generic contract revert.
    const seenTargets = new Map<string, number>();
    p.targets.forEach((t, ti) => {
      const key = t.target.toLowerCase();
      const prior = seenTargets.get(key);
      if (prior !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["targets", ti, "target"],
          message: "Duplicate target address (case-insensitive).",
        });
      } else {
        seenTargets.set(key, ti);
      }
    });
    // Dedupe selectors within each target by lowercase bytes4.
    // Two different signatures can hash to the same selector (selector
    // collisions are rare but real); also two spellings of the same hex are
    // trivially equivalent. Either case yields a DuplicateSelector revert
    // on-chain — surface it inline.
    p.targets.forEach((t, ti) => {
      const seenSelectors = new Map<string, number>();
      t.selectors.forEach((s, si) => {
        const bytes4 = selectorToBytes4OrNull(s.selector);
        if (bytes4 === null) return; // format-invalid selectors handled by display schema
        const prior = seenSelectors.get(bytes4);
        if (prior !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["targets", ti, "selectors", si, "selector"],
            message: "Duplicate selector (same bytes4 as another in this target).",
          });
        } else {
          seenSelectors.set(bytes4, si);
        }
      });
    });
  });

/**
 * Display-only policy rules layered on top of the semantic schema. These are
 * the rules that only make sense on the publish form (typed signatures, ASCII
 * slug labels) — applying them to the edit modal would break hex-seeded
 * selectors and historical labels like "trading v1".
 */
export const PolicyDraftSchemaDisplay = PolicyDraftSchemaSemantic.superRefine((p, ctx) => {
  if (!labelSlugRegex.test(p.label)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["label"],
      message: "label must match ^[a-zA-Z0-9._-]+$ (letters, digits, dot, underscore, hyphen)",
    });
  }
  p.targets.forEach((t, ti) => {
    t.selectors.forEach((s, si) => {
      if (!isValidSelectorDisplay(s.selector)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["targets", ti, "selectors", si, "selector"],
          message: "must be a function signature like `transfer(address,uint256)`",
        });
      }
    });
  });
});

/**
 * Publish-form convenience export. Equivalent to running the semantic checks
 * and then the display checks; the edit modal uses `PolicyDraftSchemaSemantic`
 * directly so hex selectors and historical labels still parse.
 */
export const PolicyDraftSchema = PolicyDraftSchemaDisplay;
export type PolicyDraft = z.infer<typeof PolicyDraftSchemaSemantic>;

/**
 * Defense-in-depth sanitizer for a policy name before it is interpolated into
 * the generated markdown header. Mirrors the rules enforced by
 * `isValidPolicyName` at the schema layer so a draft constructed outside the
 * schema (e.g. an older persisted draft, or a future caller that skipped
 * safeParse) still produces valid, single-line markdown.
 *
 * 1. Triple backticks → two apostrophes (would close the markdown wrapper).
 * 2. CR / LF → single space (would force a multi-line header).
 * 3. C0 controls (0x00..0x1F) and DEL (0x7F) → stripped.
 * 4. Zero-width / BOM, U+2028/U+2029 line/paragraph separators, and the full
 *    Unicode General_Category=Zs space-separator class except U+0020 (NBSP,
 *    en/em/thin/ideographic/etc.) → stripped: invisible
 *    bytes enable spoofing, the line/paragraph separators additionally break
 *    the single-line markdown header, and the Zs separators all render
 *    indistinguishably from a regular space.
 */
export function sanitizeNameForMarkdown(name: string): string {
  const collapsed = name.replace(/`{3,}/g, "''").replace(/[\r\n]+/g, " ");
  let result = "";
  for (let i = 0; i < collapsed.length; i++) {
    const code = collapsed.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) continue;
    if (INVISIBLE_OR_AMBIGUOUS_CODEPOINTS.has(code)) continue;
    result += collapsed.charAt(i);
  }
  return result;
}

/**
 * Render a (possibly partial) draft to POLICY.md text. Used for live preview
 * and as the input to the SDK's compilePolicy. Always produces a syntactically
 * valid markdown wrapper around a YAML block, even if the YAML inside has
 * empty / placeholder values — the compile step is what flags those.
 */
export function renderPolicyMarkdown(draft: PolicyDraft): string {
  const lines: string[] = [];
  // Defense-in-depth: the semantic schema rejects names containing triple
  // backticks, newlines, control bytes, and zero-width chars, but a draft
  // constructed outside the schema (e.g. an older persisted draft from before
  // the rule was added, or a future caller skipping safeParse) could still
  // slip one through. `sanitizeNameForMarkdown` mirrors the same rule set at
  // render time so the generated markdown is always well-formed.
  const safeName = sanitizeNameForMarkdown(draft.name || "Untitled policy");
  lines.push(`# ${safeName}`);
  lines.push("");
  if (draft.description.trim()) {
    // Strip any user-supplied triple backticks before insertion — otherwise a
    // pasted ```...``` chunk would break out of the markdown wrapper and
    // collide with the generated `policy fence below.
    lines.push(draft.description.trim().replace(/`{3,}/g, "''"));
    lines.push("");
  }
  lines.push("```policy");
  lines.push(`version: "0.1"`);
  lines.push(`dailySpendWeiCap: "${draft.dailySpendWeiCap}"`);
  // An empty `expiresAtISO` represents the on-chain "never expires" sentinel
  // (expiresAt = 0). The SDK's `normalizeTimestamp` accepts `"0"` directly,
  // so emit that rather than an empty quoted string (which would throw).
  // The publish-side zod schema requires a non-empty ISO string, so this path
  // is only reachable from the edit-modal seed (`policyInputToDraft`).
  lines.push(`expiresAt: "${draft.expiresAtISO === "" ? "0" : draft.expiresAtISO}"`);
  if (draft.paused) lines.push("paused: true");
  lines.push("targets:");
  for (const t of draft.targets) {
    lines.push(`  - target: "${t.target}"`);
    lines.push(`    selectors:`);
    for (const s of t.selectors) {
      lines.push(`      - selector: "${s.selector}"`);
      lines.push(`        valueCapPerCall: "${s.valueCapPerCall}"`);
      lines.push(`        tier: ${s.tier}`);
      lines.push(`        delaySeconds: ${s.delaySeconds}`);
    }
  }
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

/**
 * Starter templates surfaced above an empty publish form. Each one is a
 * complete, valid-shape PolicyDraft except that targets[0].target is the zero
 * address — the user is forced to swap in a real contract address before the
 * draft compiles, so we never accidentally pre-fill a misleading destination.
 */
export const TEMPLATES: { id: string; description: string; draft: PolicyDraft }[] = [
  {
    id: "dex-swapper-v1",
    description: "Trading bot that swaps via a DEX router (e.g. LFJ)",
    draft: {
      name: "DEX swapper",
      description: "Trading bot that swaps via a DEX router (e.g. LFJ)",
      label: "dex-swapper-v1",
      dailySpendWeiCap: "1 ether",
      expiresAtISO: "2026-11-30T00:00:00.000Z",
      paused: false,
      targets: [
        {
          target: "0x0000000000000000000000000000000000000000",
          selectors: [
            { selector: "approve(address,uint256)", tier: "IMMEDIATE", valueCapPerCall: "0", delaySeconds: 0 },
            {
              selector: "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
              tier: "DELAYED",
              valueCapPerCall: "0.1 ether",
              delaySeconds: 60,
            },
          ],
        },
      ],
    },
  },
  {
    id: "nft-mint-v1",
    description: "Mints NFTs with per-call price cap",
    draft: {
      name: "NFT mint guard",
      description: "Mints NFTs with per-call price cap",
      label: "nft-mint-v1",
      dailySpendWeiCap: "0.5 ether",
      expiresAtISO: "2026-11-30T00:00:00.000Z",
      paused: false,
      targets: [
        {
          target: "0x0000000000000000000000000000000000000000",
          selectors: [
            { selector: "mint(address,uint256)", tier: "IMMEDIATE", valueCapPerCall: "0.05 ether", delaySeconds: 0 },
          ],
        },
      ],
    },
  },
  {
    id: "treasury-v1",
    description: "Treasury ops with VETO_REQUIRED on withdrawals",
    draft: {
      name: "Treasury bot",
      description: "Treasury ops with VETO_REQUIRED on withdrawals",
      label: "treasury-v1",
      dailySpendWeiCap: "0",
      expiresAtISO: "2026-11-30T00:00:00.000Z",
      paused: false,
      targets: [
        {
          target: "0x0000000000000000000000000000000000000000",
          selectors: [
            { selector: "transfer(address,uint256)", tier: "IMMEDIATE", valueCapPerCall: "0", delaySeconds: 0 },
            { selector: "withdraw(uint256)", tier: "VETO_REQUIRED", valueCapPerCall: "0", delaySeconds: 0 },
          ],
        },
      ],
    },
  },
  {
    id: "keeper-bot-v1",
    description: "Automation keeper with a delayed review window on upkeeps",
    draft: {
      name: "Keeper bot",
      description: "Automation keeper with a delayed review window on upkeeps",
      label: "keeper-bot-v1",
      dailySpendWeiCap: "0",
      expiresAtISO: "2026-11-30T00:00:00.000Z",
      paused: false,
      targets: [
        {
          target: "0x0000000000000000000000000000000000000000",
          selectors: [
            { selector: "performUpkeep(bytes)", tier: "DELAYED", valueCapPerCall: "0", delaySeconds: 30 },
          ],
        },
      ],
    },
  },
];

function tierName(t: SdkTier): "IMMEDIATE" | "DELAYED" | "VETO_REQUIRED" {
  if (t === TIER_NAMES.IMMEDIATE) return "IMMEDIATE";
  if (t === TIER_NAMES.DELAYED) return "DELAYED";
  return "VETO_REQUIRED";
}

/**
 * Client-side preview only. On-chain `checkIntent` is authoritative.
 *
 * Given a compiled PolicyInput (DRAFT — not yet on-chain) and an intent the
 * user types into the simulator, mirror WardOracle.checkIntent's decision
 * tree so the publisher can see what their policy would allow before
 * spending gas to publish it.
 */
export function simulateIntent(
  input: PolicyInput,
  intent: { target: string; selector: string; value: string },
  opts?: { nowSec?: bigint; spentTodayWei?: bigint },
): { allowed: boolean; reason: string } {
  // Order mirrors PolicyLib.validate (contracts/src/PolicyLib.sol):
  //   paused → expired → target → selector → valueCap → daily.
  // BAD_CALLDATA + SELECTOR_MISMATCH are contract-internal calldata checks;
  // the simulator takes a string selector so those cases do not apply here.

  // 1. PAUSED — beats everything else, including missing target/selector.
  if (input.paused) return { allowed: false, reason: "PAUSED" };

  // 2. EXPIRED — fires before target/selector/value/daily.
  if (opts?.nowSec !== undefined && opts.nowSec > input.expiresAt) {
    return { allowed: false, reason: "EXPIRED" };
  }

  // 3. TARGET_NOT_ALLOWED
  const target = input.targets.find(
    (t) => t.target.toLowerCase() === intent.target.toLowerCase(),
  );
  if (!target) return { allowed: false, reason: "NO_TARGET" };

  // 4. SELECTOR_NOT_ALLOWED
  let selector4: string;
  try {
    selector4 = /^0x[0-9a-fA-F]{8}$/.test(intent.selector)
      ? intent.selector.toLowerCase()
      : toFunctionSelector(intent.selector).toLowerCase();
  } catch {
    return { allowed: false, reason: "SELECTOR_NOT_ALLOWED" };
  }

  const entry = target.selectors.find((s) => s.selector.toLowerCase() === selector4);
  if (!entry) return { allowed: false, reason: "SELECTOR_NOT_ALLOWED" };

  // 5. VALUE_CAP
  let valueWei: bigint;
  try {
    valueWei = parseEtherFlexible(intent.value);
  } catch {
    return { allowed: false, reason: "VALUE_EXCEEDS_CAP" };
  }

  if (valueWei > entry.valueCapPerCall) return { allowed: false, reason: "VALUE_EXCEEDS_CAP" };

  // 6. DAILY_CAP
  const spent = opts?.spentTodayWei ?? 0n;
  // PolicyLib treats `dailySpendWeiCap == 0` as "zero cap, not unlimited" —
  // any positive `intent.value` must therefore fail with DAILY_CAP_EXCEEDED.
  // value=0 + cap=0 is allowed (no native spend, no daily ledger to update).
  if (input.dailySpendWeiCap === 0n) {
    if (valueWei > 0n) return { allowed: false, reason: "DAILY_CAP_EXCEEDED" };
  } else if (spent + valueWei > input.dailySpendWeiCap) {
    return { allowed: false, reason: "DAILY_CAP_EXCEEDED" };
  }

  return { allowed: true, reason: `ALLOWED. tier=${tierName(entry.tier)}` };
}

/** Convenience: blank starter draft for a fresh form. */
export function emptyPolicyDraft(): PolicyDraft {
  const sixMonthsOut = new Date();
  sixMonthsOut.setUTCMonth(sixMonthsOut.getUTCMonth() + 6);
  sixMonthsOut.setUTCHours(0, 0, 0, 0);
  return {
    name: "",
    description: "",
    label: "",
    dailySpendWeiCap: "0",
    expiresAtISO: sixMonthsOut.toISOString(),
    paused: false,
    targets: [
      {
        target: "",
        selectors: [
          { selector: "", tier: "IMMEDIATE", valueCapPerCall: "0", delaySeconds: 0 },
        ],
      },
    ],
  };
}
