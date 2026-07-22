/**
 * Owner-index auto-scan throttle key.
 *
 * The MyPoliciesPanel auto-scan should not re-fire while a recent scan for
 * the SAME (chainId, oracle, owner) tuple is still warm. The key is the
 * lowercased tuple — case differences in user input must not bypass the
 * throttle, and a network / oracle / wallet swap must get its own slot so
 * scope changes never get incorrectly suppressed by a stale entry.
 */
export function ownerIndexThrottleKey(
  chainId: number,
  oracle: string,
  owner: string,
): string {
  return `${chainId}:${oracle.toLowerCase()}:${owner.toLowerCase()}`;
}
