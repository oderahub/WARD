import { BaseError, ContractFunctionRevertedError } from 'viem';

export interface HumanizedError {
  headline: string;
  detail?: string;
}

function extractMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return String(err);
}

/**
 * Per-error-name sentences for reverts the dashboard surfaces frequently.
 * Falls back to the raw `errorName` when no entry exists so unmapped reverts
 * still render their canonical name instead of a generic "Contract reverted".
 *
 * Names map to:
 *   - NotOwner: thrown by SentryAgentBase.setPolicyId when the caller isn't
 *     the agent's owner. Common when a dev pastes their agent address but
 *     connects a different wallet (e.g. deployer vs. ops wallet).
 *   - NotRegistrar: thrown by SentryAgentRegistry.{register,update,setActive}
 *     when the caller isn't the original registrar. The wizard normally gates
 *     against this via the alreadyRegisteredByOther check, but a stale-cache
 *     race (or a registry-RPC timeout that hid the existing row) can still
 *     reach the simulate step.
 */
const REVERT_NAME_HUMANIZED: Record<string, string> = {
  NotOwner:
    "This wallet doesn't own the agent. The original deployer (or whoever was passed to SentryAgentBase's constructor) is the only address that can rebind its policy.",
  NotRegistrar:
    "This wallet didn't register the agent. Only the original registrar can update its registry row.",
};

/**
 * Detect the "agent doesn't expose setPolicyId" case from a viem revert. The
 * agent contract has no fallback that returns 4 bytes matching the function
 * selector, so the call lands in execution-revert with no data — viem surfaces
 * that as an empty-`data` ContractFunctionRevertedError, or, for older RPCs,
 * as a generic "execution reverted" with no decoded reason. We treat both as
 * "the agent didn't inherit SentryAgentBase" because that is by far the most
 * common cause when a caller knows the wallet is the owner.
 *
 * Heuristic, not proof: a custom agent could intentionally revert from
 * setPolicyId with no reason, so we phrase the message as a likely cause
 * rather than a certainty.
 */
function isSetPolicyIdMissingShape(err: unknown, functionName?: string): boolean {
  if (functionName !== "setPolicyId") return false;
  if (err instanceof BaseError) {
    const revertError = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revertError instanceof ContractFunctionRevertedError) {
      // No decoded errorName AND no decoded args → the contract reverted with
      // no return data, which is what an EVM call to a non-existent selector
      // (without a fallback returning 4 bytes) produces.
      if (!revertError.data?.errorName) return true;
    }
  }
  const message = extractMessage(err);
  // Fallback: some RPCs strip the structured revert into a plain string.
  if (/execution reverted(?!:)/i.test(message)) return true;
  return false;
}

export interface HumanizeOptions {
  /** When the caller knows which contract function was being invoked, pass
   *  the name here so the humanizer can specialize messages — e.g. the
   *  "agent didn't inherit SentryAgentBase" sentence is only meaningful for
   *  `setPolicyId`. */
  functionName?: string;
}

export function humanizeWeb3Error(
  err: unknown,
  options: HumanizeOptions = {},
): HumanizedError {
  const message = extractMessage(err);

  if (/user rejected|denied transaction|user denied/i.test(message)) {
    return { headline: 'Cancelled in wallet.' };
  }

  if (/insufficient funds/i.test(message)) {
    return {
      headline: 'Not enough STT for gas. Top up your wallet from the Somnia faucet.',
    };
  }

  if (err instanceof BaseError) {
    const revertError = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revertError && revertError instanceof ContractFunctionRevertedError) {
      const errorName = revertError.data?.errorName;
      if (errorName && REVERT_NAME_HUMANIZED[errorName]) {
        return {
          headline: REVERT_NAME_HUMANIZED[errorName],
          detail: revertError.shortMessage || revertError.message,
        };
      }
      // No decoded errorName for a setPolicyId call → agent likely doesn't
      // inherit SentryAgentBase. Tested via isSetPolicyIdMissingShape so the
      // string-match fallback handles RPCs that flatten the revert.
      if (isSetPolicyIdMissingShape(err, options.functionName)) {
        return {
          headline:
            "This agent doesn't expose a setPolicyId hook, so Sentry can't update its policy binding from the dashboard. To enable that, inherit from contracts/src/integration/SentryAgentBase.sol (Sentry's base contract for late-binding) and redeploy.",
          detail: revertError.shortMessage || revertError.message,
        };
      }
      return {
        headline: revertError.shortMessage || errorName || 'Contract reverted',
        detail: revertError.message,
      };
    }
  }

  // String-fallback path for the no-`setPolicyId` case (older RPCs that
  // flatten reverts before viem can decode them).
  if (isSetPolicyIdMissingShape(err, options.functionName)) {
    return {
      headline:
        "This agent doesn't expose a setPolicyId hook, so Sentry can't update its policy binding from the dashboard. To enable that, inherit from contracts/src/integration/SentryAgentBase.sol (Sentry's base contract for late-binding) and redeploy.",
      detail: message.trim().slice(0, 200),
    };
  }

  const revertMatch = message.match(/execution reverted: (.+?)(?:"|$)/i);
  if (revertMatch) {
    return { headline: 'Transaction would revert.', detail: revertMatch[1] };
  }

  if (/chain mismatch|wrong network/i.test(message)) {
    return { headline: 'Switch your wallet to Somnia testnet.' };
  }

  if (/nonce too low/i.test(message)) {
    return { headline: 'Nonce conflict. Refresh the page and try again.' };
  }

  return {
    headline: 'Transaction failed.',
    detail: message.trim().slice(0, 200),
  };
}
