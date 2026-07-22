/**
 * Human-readable rendering of zod-style error paths for inline form errors.
 *
 * Zod surfaces validation errors with a `path` array of segments that walk
 * into the policy draft tree, e.g.
 *   ["targets", 0, "selectors", 1, "valueCapPerCall"]
 *
 * The raw path is precise but unfriendly. Operators editing the policy in the
 * dashboard need to know which CONTRACT and which FUNCTION the error sits on,
 * not that it lives at `targets[0].selectors[1]`. This helper renders the
 * path as `Contract #1 → Function #2 → Per-call cap`, using 1-indexed counts
 * because that's how the UI numbers them in the drawer.
 *
 * Top-level scalar fields (dailySpendWeiCap, expiresAt, etc.) reuse the
 * existing FIELD_HUMAN_LABELS map so the error wording matches the diff view.
 * Nested LEAF labels (selector, tier, valueCapPerCall, delaySeconds, target)
 * are local to this helper because they only appear in this error-surfacing
 * context — the rest of the UI renders them via their own column headers.
 */
import { FIELD_HUMAN_LABELS } from "./selector-display";

/**
 * Plain-English labels for leaf field names that sit inside `targets[i]` /
 * `targets[i].selectors[j]`. Mirrors the inline column headers used in the
 * publish form so the error message reads the same as the field the operator
 * sees on screen.
 */
const NESTED_LEAF_LABELS: Record<string, string> = {
  target: "Address",
  selector: "Function signature",
  tier: "Approval mode",
  valueCapPerCall: "Per-call native cap",
  delaySeconds: "Delay",
};

/**
 * Translate a zod-style error path into a human-readable label.
 *
 * Empty path → "(top-level)" so the caller can still render something rather
 * than an empty string. Unknown paths fall back to a dot-joined raw form so
 * the operator at least sees the underlying field name and can match it to
 * the schema — silent dropping would be worse than a slightly technical label.
 */
export function humanizeErrorPath(
  path: ReadonlyArray<string | number>,
): string {
  if (path.length === 0) return "(top-level)";

  // Top-level scalar: single string segment that matches FIELD_HUMAN_LABELS.
  if (path.length === 1 && typeof path[0] === "string") {
    const label = FIELD_HUMAN_LABELS[path[0]];
    if (label) return label;
  }

  // Walk the path looking for the recognized nested shapes:
  //   targets[i]                                   → "Contract #i+1"
  //   targets[i].target                            → "Contract #i+1 → Address"
  //   targets[i].selectors[j]                      → "Contract #i+1 → Function #j+1"
  //   targets[i].selectors[j].<leaf>               → "Contract #i+1 → Function #j+1 → <Leaf>"
  if (path[0] === "targets" && typeof path[1] === "number") {
    const parts: string[] = [`Contract #${path[1] + 1}`];

    // Leaf directly on the target (e.g. "target").
    if (path.length === 3 && typeof path[2] === "string") {
      const leaf = NESTED_LEAF_LABELS[path[2]];
      if (leaf) {
        parts.push(leaf);
        return parts.join(" → ");
      }
    }

    if (path[2] === "selectors" && typeof path[3] === "number") {
      parts.push(`Function #${path[3] + 1}`);

      // Leaf on the selector (tier / valueCapPerCall / etc.).
      if (path.length === 5 && typeof path[4] === "string") {
        const leaf = NESTED_LEAF_LABELS[path[4]];
        if (leaf) {
          parts.push(leaf);
          return parts.join(" → ");
        }
      }

      // Selector index with no recognized leaf — still useful on its own.
      if (path.length === 4) {
        return parts.join(" → ");
      }
    }

    // Target index with no recognized continuation.
    if (path.length === 2) {
      return parts.join(" → ");
    }
  }

  // Fallback: dot-joined raw path so the operator at least sees the field.
  return path.map((segment) => String(segment)).join(".");
}
