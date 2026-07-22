// Telegram Bot API client for the Watch Wizard self-test alert.
//
// Design constraints (project hard-rules + spec):
// - Runs entirely in the browser. No Node-only APIs.
// - The bot token AND chat_id are both operator secrets. NEITHER MUST appear
//   in any console.* call, returned errorMessage, or thrown error. The
//   masking helper below is the only sanctioned way to render any part of
//   the token; chat_id is never rendered or logged anywhere.
// - Uses Content-Type: application/x-www-form-urlencoded so the request is
//   a CORS "simple request" and avoids a preflight, mirroring slack.ts. Do
//   NOT add custom headers (Authorization, X-*, etc.) — they would force a
//   preflight. Telegram's bot API accepts form-urlencoded bodies for
//   sendMessage equivalently to JSON.
// - No retries, queueing, or debouncing here. The wizard button is
//   responsible for click-debounce (Telegram's ~30 msg/sec global, 1
//   msg/sec/chat limit).
// - Test alerts MUST be visibly marked with the "[Ward watch wizard · test]"
//   prefix so they cannot be mistaken for a real alert. There is intentionally
//   no `sendAlertTelegram` alias — adding one before a divergent production
//   text-builder exists would invite production sends carrying the self-test
//   prefix.
// - On vendor error paths, we NEVER echo Telegram's `description` field
//   verbatim into the returned errorMessage or into a console call: the
//   Telegram bot API embeds the chat_id (operator secret) into many of those
//   descriptions (e.g. `Bad Request: chat not found` is benign, but
//   `Bad Request: invalid chat_id specified: <ID>` is not). Only whitelisted
//   marker strings are surfaced; everything else collapses to a generic
//   message keyed off HTTP status.

export type Tier = 'conservative' | 'balanced' | 'aggressive';

export interface SendTestAlertTelegramOpts {
  botToken: string;
  chatId: string;
  agent: `0x${string}`;
  policyId: `0x${string}`;
  tier: Tier;
  recommendationReason: string;
  chainId?: number;
  signal?: AbortSignal;
}

export interface SendTestAlertTelegramResult {
  ok: boolean;
  status: number;
  errorMessage?: string;
  sentAt: number;
}

// Telegram bot tokens look like `<digits>:<35-char-base64ish>`, e.g.
// `123456789:AAH-abc...`. We accept the documented shape only: at least
// six digits (Telegram bot ids are always >= 6 digits in practice), a
// colon, then 30+ url-safe base64 chars. Anything else (trailing space,
// missing colon, weird charset) is rejected to keep the surface narrow.
const BOT_TOKEN_RE = /^[0-9]{6,}:[A-Za-z0-9_-]{30,}$/;
// chat_id is either a numeric id (int64, possibly negative for groups /
// channels — leading `-` allowed; `-100…` for supergroups) OR an @username.
// The @username form is 5-32 chars of [A-Za-z0-9_] per Telegram's rules.
// Empty string and bare `-` are rejected.
const CHAT_ID_RE = /^(-?[0-9]+|@[A-Za-z0-9_]{5,32})$/;

export function validateBotToken(token: string): boolean {
  if (typeof token !== 'string') return false;
  return BOT_TOKEN_RE.test(token);
}

export function validateChatId(chatId: string): boolean {
  if (typeof chatId !== 'string') return false;
  return CHAT_ID_RE.test(chatId);
}

/**
 * Masks a Telegram bot token for safe display in logs and UI. Returns the
 * leading numeric bot-id + `:` + first 4 chars of the secret tail, with the
 * remainder elided as `…`. Returns a fixed placeholder for malformed inputs
 * so we never accidentally echo arbitrary user data back. The chat_id is
 * intentionally NOT masked-and-displayed anywhere — it has no equivalent
 * "shareable prefix" the way bot tokens do.
 */
export function maskBotToken(token: string): string {
  if (!validateBotToken(token)) return '<bot-token …>';
  const idx = token.indexOf(':');
  const botId = token.slice(0, idx);
  const tail = token.slice(idx + 1);
  return `${botId}:${tail.slice(0, 4)}…`;
}

// Telegram renders `text` as plain text when no `parse_mode` is set, so
// backticks, asterisks, underscores, and angle brackets all show up
// literally. We only enforce a max length to keep payloads sane (Telegram
// caps message text at 4096 chars; the 500-char ceiling here matches the
// Slack recommendation-reason cap in slack.ts).
function sanitizePlain(input: string, maxLen = 500): string {
  return input.length > maxLen ? input.slice(0, maxLen) : input;
}

function buildText(opts: SendTestAlertTelegramOpts, isoTimestamp: string): string {
  const tierUpper = opts.tier.toUpperCase();
  const reason = sanitizePlain(opts.recommendationReason);
  const chainId = opts.chainId ?? 43113;
  return [
    `[Ward watch wizard · test]`,
    ``,
    `Agent: ${opts.agent}`,
    `Policy ID: ${opts.policyId}`,
    `Recommendation: ${tierUpper}`,
    `Scope: Observation (after-the-fact)`,
    ``,
    `Why this tier:`,
    reason,
    ``,
    `Sent ${isoTimestamp} · Avalanche Fuji (chain ${chainId}) · This is a wizard self-test, not a real alert.`,
  ].join('\n');
}

const GENERIC_INVALID_TOKEN =
  'Bot token does not look like a Telegram bot token (expected <digits>:<secret>).';
const GENERIC_INVALID_CHAT =
  'chat_id does not look right — expected a numeric id (e.g. 123456789) or @username.';
const GENERIC_NETWORK_FAILURE =
  'Could not reach Telegram from your browser — check network or extensions and try again.';
const GENERIC_PAYLOAD_BUG =
  'Could not format the test alert — please report this.';

/**
 * Maps a Telegram error response to an operator-facing message. Critically,
 * this function NEVER passes Telegram's `description` field through to the
 * returned errorMessage or to a console call, because the description often
 * embeds the chat_id (operator secret). The only `description` content we
 * trust is the whitelisted marker `chat not found` — translated to the same
 * `chat_not_found` token the wizard already routes on for Slack parity.
 *
 * Status-only branches (401/403/404/429/5xx) are safe because they don't
 * reflect any operator-supplied data.
 */
async function mapErrorByStatus(response: Response): Promise<string> {
  const status = response.status;

  if (status === 401) {
    return 'Telegram rejected the bot token (401 Unauthorized). Re-create the bot via @BotFather and paste the new token.';
  }
  if (status === 403) {
    return 'Telegram refused to deliver (403 Forbidden). The bot is probably not a member of the chat. Add it to the chat, then send any message in the chat first.';
  }
  if (status === 404) {
    return 'Telegram returned 404. The bot token URL was not recognized. Double-check the token (no extra whitespace, no truncation).';
  }
  if (status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    if (retryAfter) {
      return `Telegram throttled this bot (retry after ${retryAfter}s). Wait a few seconds and try again.`;
    }
    return 'Telegram throttled this bot. Wait a few seconds and try again.';
  }
  if (status === 400) {
    // Read JUST enough of the body to detect the `chat not found` marker.
    // We do NOT log the body and we do NOT pass it through to errorMessage,
    // because Telegram's descriptions frequently contain the operator's
    // chat_id verbatim. Compute a lowercased view in a local for the
    // whitelist check, then discard.
    let isChatNotFound = false;
    try {
      const body = (await response.json()) as { description?: unknown };
      const description =
        typeof body.description === 'string' ? body.description.toLowerCase() : '';
      isChatNotFound = description.includes('chat not found');
    } catch {
      // body wasn't JSON / fetch is exhausted — fall through to the
      // generic message.
    }
    if (isChatNotFound) {
      return 'chat_not_found';
    }
    // For any other 400 we surface a generic payload-bug message. We log a
    // FIXED breadcrumb (no description, no chat_id) so devtools shows that
    // a 400 happened without leaking anything.
    console.warn('[ward-telegram] Telegram returned 400 (description withheld to avoid leaking chat_id).');
    return GENERIC_PAYLOAD_BUG;
  }
  return `Telegram returned HTTP ${status}.`;
}

export async function sendTestAlertTelegram(
  opts: SendTestAlertTelegramOpts,
): Promise<SendTestAlertTelegramResult> {
  const sentAt = Date.now();

  // Validate BEFORE constructing the payload or touching the network, and
  // never echo the token or chat_id back to the caller.
  if (!validateBotToken(opts.botToken)) {
    return { ok: false, status: 0, errorMessage: GENERIC_INVALID_TOKEN, sentAt };
  }
  if (!validateChatId(opts.chatId)) {
    return { ok: false, status: 0, errorMessage: GENERIC_INVALID_CHAT, sentAt };
  }

  const isoTimestamp = new Date(sentAt).toISOString();
  const text = buildText(opts, isoTimestamp);
  // Telegram accepts form-urlencoded bodies for sendMessage, so we use the
  // same CORS-simple Content-Type that slack.ts uses (avoids preflight).
  // URLSearchParams handles percent-encoding for us and is supported in
  // every browser the dashboard targets.
  const body = new URLSearchParams();
  body.set('chat_id', opts.chatId);
  body.set('text', text);

  const url = `https://api.telegram.org/bot${opts.botToken}/sendMessage`;

  let response: Response;
  try {
    response = await fetch(url, {
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
      return { ok: false, status: 0, errorMessage: 'cancelled', sentAt };
    }
    // TypeError on fetch() means network / CORS / extension blocked the
    // request. There is intentionally no status to report.
    return { ok: false, status: 0, errorMessage: GENERIC_NETWORK_FAILURE, sentAt };
  }

  if (response.ok && response.status === 200) {
    return { ok: true, status: 200, sentAt };
  }
  const errorMessage = await mapErrorByStatus(response);
  return { ok: false, status: response.status, errorMessage, sentAt };
}
