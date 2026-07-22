// Slack incoming-webhook client for the Watch Wizard self-test alert.
//
// Design constraints (project hard-rules + spec):
// - Runs entirely in the browser. No Node-only APIs.
// - The webhook URL is an operator secret. It MUST NOT appear in any
//   console.* call, returned errorMessage, or thrown error. The masking
//   helper below is the only sanctioned way to render any part of it.
// - Uses Content-Type: application/x-www-form-urlencoded so the request
//   is a CORS "simple request" and avoids a preflight. Do NOT add custom
//   headers (Authorization, X-*, etc.) — they would force a preflight.
// - No retries, queueing, or debouncing here. The wizard button is
//   responsible for click-debounce (Slack's ~1 msg/sec/channel limit).
// - Test alerts MUST be visibly marked with the "[Ward watch wizard · test]"
//   prefix so they cannot be mistaken for a real alert.

export type Tier = 'conservative' | 'balanced' | 'aggressive';

export interface SendTestAlertOpts {
  webhookUrl: string;
  agent: `0x${string}`;
  policyId: `0x${string}`;
  tier: Tier;
  recommendationReason: string;
  chainId?: number;
  signal?: AbortSignal;
}

export interface SendTestAlertResult {
  ok: boolean;
  status: number;
  errorMessage?: string;
  sentAt: number;
}

// Slack incoming-webhook canonical shape:
//   https://hooks.slack.com/services/T{TEAM_ID}/B{WEBHOOK_ID}/{SECRET_TOKEN}
// Three opaque, non-empty path segments after /services/. Segment chars are
// Slack's own opaque IDs — we don't constrain them beyond "non-empty and not
// containing a slash". Trailing slashes / query strings / fragments are
// rejected to keep the surface narrow.
const SLACK_WEBHOOK_PREFIX = 'https://hooks.slack.com/services/';
const SLACK_WEBHOOK_RE =
  /^https:\/\/hooks\.slack\.com\/services\/[^/?#\s]+\/[^/?#\s]+\/[^/?#\s]+$/;

export function validateWebhookUrl(url: string): boolean {
  if (typeof url !== 'string') return false;
  if (!url.startsWith(SLACK_WEBHOOK_PREFIX)) return false;
  return SLACK_WEBHOOK_RE.test(url);
}

/**
 * Masks a Slack webhook URL for safe display in logs and UI. Returns
 * `https://hooks.slack.com/services/` + the first 12 chars of the path
 * after `/services/`, with the remainder elided as `…`. If the input
 * isn't a recognizable Slack webhook URL, returns a fixed placeholder
 * so we never accidentally leak an arbitrary string.
 */
export function maskWebhookUrl(url: string): string {
  if (!validateWebhookUrl(url)) return 'https://hooks.slack.com/services/…';
  const tail = url.slice(SLACK_WEBHOOK_PREFIX.length);
  const visible = tail.slice(0, 12);
  return `${SLACK_WEBHOOK_PREFIX}${visible}${tail.length > 12 ? '…' : ''}`;
}

// Slack mrkdwn doesn't decode HTML entities, so escaping with `&#x60;`
// would render verbatim in-channel. We strip backticks and asterisks
// from user-supplied recommendation text instead — the rest of the
// payload is composed of literals/addresses we control.
function sanitizeMrkdwn(input: string, maxLen = 500): string {
  const truncated = input.length > maxLen ? input.slice(0, maxLen) : input;
  return truncated.replace(/[`*]/g, '');
}

function buildPayload(opts: SendTestAlertOpts, isoTimestamp: string): object {
  const tierUpper = opts.tier.toUpperCase();
  const reason = sanitizeMrkdwn(opts.recommendationReason);
  const chainId = opts.chainId ?? 50312;

  return {
    text: `[Ward watch wizard · test] Test alert from Ward watch wizard. agent ${opts.agent} · policy ${opts.policyId} · recommendation ${tierUpper}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '[Ward watch wizard · test]' },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Agent*\n\`${opts.agent}\`` },
          { type: 'mrkdwn', text: `*Policy ID*\n\`${opts.policyId}\`` },
          { type: 'mrkdwn', text: `*Recommendation*\n${tierUpper}` },
          { type: 'mrkdwn', text: '*Scope*\nObservation (after-the-fact)' },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Why this tier*\n${reason}` },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Sent ${isoTimestamp} · Somnia Shannon (chain ${chainId}) · This is a wizard self-test, not a real alert.`,
          },
        ],
      },
    ],
  };
}

const GENERIC_INVALID_URL =
  'URL does not look like a Slack incoming webhook';
const GENERIC_NETWORK_FAILURE =
  'Could not reach Slack from your browser. Check network or extensions and try again.';
const GENERIC_PAYLOAD_BUG =
  'Could not format the test alert. Please report this.';

async function mapErrorByStatus(response: Response): Promise<string> {
  const status = response.status;

  if (status === 404) {
    return 'Slack rejected this URL (404). Confirm the webhook still exists in your Slack workspace.';
  }
  if (status === 403 || status === 410) {
    return 'Slack disabled this webhook. Re-create it in Slack and paste the new URL.';
  }
  if (status === 400) {
    let body = '';
    try {
      body = await response.text();
    } catch {
      body = '';
    }
    if (body.includes('channel_not_found')) {
      return 'channel_not_found';
    }
    if (body.includes('channel_is_archived')) {
      return 'channel_is_archived';
    }
    // Likely a payload bug on our side — log the raw body for diagnosis
    // (never the URL) and surface a generic message to the operator.
    console.warn('[ward-slack] Slack 400 response body:', body);
    return GENERIC_PAYLOAD_BUG;
  }
  if (status === 413) {
    return 'Slack rejected the payload as too large (>40KB).';
  }
  if (status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    if (retryAfter) {
      return `Slack throttled this webhook (retry after ${retryAfter}s). Wait a few seconds and try again.`;
    }
    return 'Slack throttled this webhook. Wait a few seconds and try again.';
  }
  return `Slack returned HTTP ${status}.`;
}

export async function sendTestAlert(
  opts: SendTestAlertOpts,
): Promise<SendTestAlertResult> {
  const sentAt = Date.now();

  // Validate BEFORE constructing the payload or touching the network,
  // and never echo the URL back to the caller.
  if (!validateWebhookUrl(opts.webhookUrl)) {
    return {
      ok: false,
      status: 0,
      errorMessage: GENERIC_INVALID_URL,
      sentAt,
    };
  }

  const isoTimestamp = new Date(sentAt).toISOString();
  const payload = buildPayload(opts, isoTimestamp);
  const body = 'payload=' + encodeURIComponent(JSON.stringify(payload));

  let response: Response;
  try {
    response = await fetch(opts.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: opts.signal,
    });
  } catch (err) {
    // Honor the public "never throws" contract: surface aborts as a
    // structured result with status:0 and a 'cancelled' marker so callers
    // can distinguish them from real network failures by inspecting
    // errorMessage without needing a try/catch.
    const isAbort =
      (err instanceof DOMException && err.name === 'AbortError') ||
      (!!err &&
        typeof err === 'object' &&
        'name' in err &&
        (err as { name?: unknown }).name === 'AbortError');
    if (isAbort) {
      return {
        ok: false,
        status: 0,
        errorMessage: 'cancelled',
        sentAt,
      };
    }
    // TypeError on fetch() means network / CORS / extension blocked the
    // request. There is intentionally no status to report.
    return {
      ok: false,
      status: 0,
      errorMessage: GENERIC_NETWORK_FAILURE,
      sentAt,
    };
  }

  if (response.ok && response.status === 200) {
    return { ok: true, status: 200, sentAt };
  }

  const errorMessage = await mapErrorByStatus(response);
  return {
    ok: false,
    status: response.status,
    errorMessage,
    sentAt,
  };
}
