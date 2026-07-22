import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  sendTestAlertTelegram,
  validateBotToken,
  validateChatId,
  maskBotToken,
  type SendTestAlertTelegramOpts,
} from "../../src/lib/telegram";

// Fixture token + chat_id — NEVER real values. Both literals are checked
// against every console call AND every returned errorMessage to enforce
// the "no secret leak" contract.
const BOT_TOKEN = "1234567890:SECRET_TEST_TOKEN_VALUE_ABCDEF1234";
const CHAT_ID = "987654321";
const AGENT = "0x000000000000000000000000000000000000beef" as `0x${string}`;
const POLICY_ID = ("0x" + "ab".repeat(32)) as `0x${string}`;

function baseOpts(
  overrides: Partial<SendTestAlertTelegramOpts> = {},
): SendTestAlertTelegramOpts {
  return {
    botToken: BOT_TOKEN,
    chatId: CHAT_ID,
    agent: AGENT,
    policyId: POLICY_ID,
    tier: "balanced",
    recommendationReason: "test reason",
    ...overrides,
  };
}

const fetchMock = vi.fn();
const logSpy = vi.fn();
const warnSpy = vi.fn();
const errorSpy = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  logSpy.mockReset();
  warnSpy.mockReset();
  errorSpy.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(logSpy);
  vi.spyOn(console, "warn").mockImplementation(warnSpy);
  vi.spyOn(console, "error").mockImplementation(errorSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function okResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: {} }),
    text: async () => "ok",
  } as unknown as Response;
}
function statusResponse(
  status: number,
  body: Record<string, unknown> = {},
  retryAfter?: string,
): Response {
  return {
    ok: false,
    status,
    headers: {
      get: (h: string) => (retryAfter && h === "Retry-After" ? retryAfter : null),
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * Walks every recorded console call AND the supplied results and asserts
 * neither the bot token nor the chat_id ever surfaces. The chat_id check
 * is the riskier one because Telegram's vendor `description` strings
 * frequently echo it back; we route around that in mapErrorByStatus by
 * NEVER passing the description through, and this assertion guards the
 * contract end-to-end.
 */
function assertNoSecretLeak(results: Array<{ errorMessage?: string }> = []) {
  const allArgs: unknown[] = [];
  for (const spy of [logSpy, warnSpy, errorSpy]) {
    for (const call of spy.mock.calls) allArgs.push(...call);
  }
  const stringified = allArgs.map((a) =>
    typeof a === "string" ? a : JSON.stringify(a),
  );
  for (const s of stringified) {
    expect(s).not.toContain("SECRET_TEST_TOKEN_VALUE");
    expect(s).not.toContain(BOT_TOKEN);
    expect(s).not.toContain(CHAT_ID);
  }
  for (const r of results) {
    if (typeof r.errorMessage === "string") {
      expect(r.errorMessage).not.toContain("SECRET_TEST_TOKEN_VALUE");
      expect(r.errorMessage).not.toContain(BOT_TOKEN);
      expect(r.errorMessage).not.toContain(CHAT_ID);
    }
  }
}

describe("validateBotToken", () => {
  it("accepts the canonical Telegram bot-token shape", () => {
    expect(validateBotToken(BOT_TOKEN)).toBe(true);
  });

  it("rejects tokens missing the colon separator", () => {
    expect(validateBotToken("1234567890SECRETTOKENABCDEFGHIJKL")).toBe(false);
  });

  it("rejects tokens whose secret tail is too short", () => {
    expect(validateBotToken("1234567890:short")).toBe(false);
  });

  it("rejects empty / non-string inputs", () => {
    expect(validateBotToken("")).toBe(false);
    // @ts-expect-error -- exercising defensive type guard
    expect(validateBotToken(undefined)).toBe(false);
    // @ts-expect-error -- exercising defensive type guard
    expect(validateBotToken(123)).toBe(false);
  });
});

describe("validateChatId", () => {
  it("accepts a numeric chat_id (DM)", () => {
    expect(validateChatId("123456789")).toBe(true);
  });
  it("accepts a negative numeric chat_id (group / supergroup / channel)", () => {
    expect(validateChatId("-1001234567890")).toBe(true);
  });
  it("accepts an @username chat_id", () => {
    expect(validateChatId("@mychannel")).toBe(true);
  });
  it("rejects empty, bare-dash, and too-short usernames", () => {
    expect(validateChatId("")).toBe(false);
    expect(validateChatId("-")).toBe(false);
    expect(validateChatId("@a")).toBe(false); // < 5 chars
    expect(validateChatId("nope!")).toBe(false);
  });
});

describe("maskBotToken", () => {
  it("keeps the public bot-id, masks the secret tail behind an ellipsis", () => {
    const masked = maskBotToken(BOT_TOKEN);
    expect(masked.startsWith("1234567890:")).toBe(true);
    expect(masked).not.toContain("SECRET_TEST_TOKEN_VALUE");
    expect(masked).toContain("…");
  });

  it("returns a fixed placeholder for malformed inputs (no echoing user data)", () => {
    expect(maskBotToken("nope")).toBe("<bot-token …>");
  });
});

describe("sendTestAlertTelegram", () => {
  it("returns {ok:true, status:200} on a Telegram 200 response", async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    const result = await sendTestAlertTelegram(baseOpts());
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(typeof result.sentAt).toBe("number");
  });

  it("posts as application/x-www-form-urlencoded (NOT application/json) to avoid a CORS preflight", async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    await sendTestAlertTelegram(baseOpts());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
  });

  it("encodes chat_id + text into a URLSearchParams body", async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    await sendTestAlertTelegram(baseOpts());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // URLSearchParams toString() encodes spaces as `+`, so decode back to
    // verify both fields landed.
    const parsed = new URLSearchParams(init.body as URLSearchParams);
    expect(parsed.get("chat_id")).toBe(CHAT_ID);
    const text = parsed.get("text") ?? "";
    expect(text).toContain("[Sentry watch wizard · test]");
    expect(text).toContain(AGENT);
  });

  it("returns {ok:false, status:401, errorMessage} when Telegram rejects the bot token", async () => {
    fetchMock.mockResolvedValueOnce(
      statusResponse(401, { ok: false, error_code: 401, description: "Unauthorized" }),
    );
    const result = await sendTestAlertTelegram(baseOpts());
    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(result.errorMessage).toMatch(/401/);
    assertNoSecretLeak([result]);
  });

  it("returns a 403 (bot not in chat) hint message", async () => {
    fetchMock.mockResolvedValueOnce(
      statusResponse(403, { ok: false, error_code: 403, description: "Forbidden: bot was kicked" }),
    );
    const result = await sendTestAlertTelegram(baseOpts());
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(result.errorMessage).toMatch(/bot is probably not a member/);
    assertNoSecretLeak([result]);
  });

  it("surfaces chat_not_found verbatim on the 400 path so the wizard can route to the right error UI", async () => {
    fetchMock.mockResolvedValueOnce(
      statusResponse(400, {
        ok: false,
        error_code: 400,
        description: "Bad Request: chat not found",
      }),
    );
    const result = await sendTestAlertTelegram(baseOpts());
    expect(result.errorMessage).toBe("chat_not_found");
  });

  it("DOES NOT leak the chat_id when Telegram echoes it in a 400 description", async () => {
    // Real Telegram has been observed to embed the chat_id verbatim in 400
    // descriptions like `Bad Request: invalid chat_id specified: 987654321`.
    // Our mapErrorByStatus MUST NOT echo that through.
    fetchMock.mockResolvedValueOnce(
      statusResponse(400, {
        ok: false,
        error_code: 400,
        description: `Bad Request: invalid chat_id specified: ${CHAT_ID}`,
      }),
    );
    const result = await sendTestAlertTelegram(baseOpts());
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(result.errorMessage).toMatch(/Could not format/);
    // The warn breadcrumb MUST mention that a 400 happened, but MUST NOT
    // carry the description.
    expect(warnSpy).toHaveBeenCalled();
    assertNoSecretLeak([result]);
  });

  it("surfaces a retry-aware throttle message on 429", async () => {
    fetchMock.mockResolvedValueOnce(
      statusResponse(429, { ok: false, description: "Too Many Requests: retry after 5" }, "5"),
    );
    const result = await sendTestAlertTelegram(baseOpts());
    expect(result).toMatchObject({ ok: false, status: 429 });
    expect(result.errorMessage).toMatch(/retry after 5/);
    assertNoSecretLeak([result]);
  });

  it("returns a generic network-failure message when fetch throws a TypeError", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const result = await sendTestAlertTelegram(baseOpts());
    expect(result).toMatchObject({ ok: false, status: 0 });
    expect(result.errorMessage).toMatch(/Could not reach Telegram/);
    assertNoSecretLeak([result]);
  });

  it("returns a structured 'cancelled' result on AbortError (never throws — wizard distinguishes by errorMessage)", async () => {
    const abortErr = new DOMException("aborted", "AbortError");
    fetchMock.mockRejectedValueOnce(abortErr);
    const result = await sendTestAlertTelegram(baseOpts());
    expect(result).toMatchObject({ ok: false, status: 0, errorMessage: "cancelled" });
    assertNoSecretLeak([result]);
  });

  it("returns a malformed-token error WITHOUT calling fetch when the token is bad", async () => {
    const result = await sendTestAlertTelegram(baseOpts({ botToken: "not-a-token" }));
    expect(result).toMatchObject({ ok: false, status: 0 });
    expect(result.errorMessage).toMatch(/does not look like a Telegram bot token/);
    expect(fetchMock).not.toHaveBeenCalled();
    assertNoSecretLeak([result]);
  });

  it("returns a malformed-chat-id error WITHOUT calling fetch when chat_id is bad", async () => {
    const result = await sendTestAlertTelegram(baseOpts({ chatId: "" }));
    expect(result).toMatchObject({ ok: false, status: 0 });
    expect(result.errorMessage).toMatch(/chat_id does not look right/);
    expect(fetchMock).not.toHaveBeenCalled();
    assertNoSecretLeak([result]);
  });

  it("never logs the full bot token OR the chat_id across the whole table (defence-in-depth)", async () => {
    const results: Array<{ errorMessage?: string }> = [];
    fetchMock.mockResolvedValueOnce(okResponse());
    results.push(await sendTestAlertTelegram(baseOpts()));
    fetchMock.mockResolvedValueOnce(statusResponse(401, { description: "Unauthorized" }));
    results.push(await sendTestAlertTelegram(baseOpts()));
    fetchMock.mockResolvedValueOnce(
      statusResponse(400, { description: `invalid chat_id specified: ${CHAT_ID}` }),
    );
    results.push(await sendTestAlertTelegram(baseOpts()));
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    results.push(await sendTestAlertTelegram(baseOpts()));
    assertNoSecretLeak(results);
  });
});
