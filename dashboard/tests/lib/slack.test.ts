import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  sendTestAlert,
  validateWebhookUrl,
  maskWebhookUrl,
  type SendTestAlertOpts,
} from "../../src/lib/slack";

// Fixture URL — NEVER a real webhook. The secret segment is the all-caps
// `SECRET_TEST` literal; assertions below check this string never appears
// in any console call.
const WEBHOOK = "https://hooks.slack.com/services/T_TEST/B_TEST/SECRET_TEST";
const AGENT = "0x000000000000000000000000000000000000beef" as `0x${string}`;
const POLICY_ID = ("0x" + "ab".repeat(32)) as `0x${string}`;

function baseOpts(overrides: Partial<SendTestAlertOpts> = {}): SendTestAlertOpts {
  return {
    webhookUrl: WEBHOOK,
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
  return { ok: true, status: 200, text: async () => "ok" } as unknown as Response;
}
function statusResponse(status: number, body = ""): Response {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    text: async () => body,
  } as unknown as Response;
}

/** Walk every recorded console call and assert the secret token is never present. */
function assertNoWebhookLeak() {
  const allArgs: unknown[] = [];
  for (const spy of [logSpy, warnSpy, errorSpy]) {
    for (const call of spy.mock.calls) allArgs.push(...call);
  }
  const stringified = allArgs.map((a) => (typeof a === "string" ? a : JSON.stringify(a)));
  for (const s of stringified) {
    expect(s).not.toContain("SECRET_TEST");
    // The masked form ends at 12 chars after /services/ — full webhook
    // path must not show up.
    expect(s).not.toContain("T_TEST/B_TEST/SECRET_TEST");
  }
}

describe("validateWebhookUrl", () => {
  it("accepts the canonical Slack incoming-webhook shape", () => {
    expect(validateWebhookUrl(WEBHOOK)).toBe(true);
  });

  it("rejects URLs with the wrong host", () => {
    expect(validateWebhookUrl("https://example.com/services/T_TEST/B_TEST/SECRET")).toBe(false);
  });

  it("rejects URLs missing one of the three opaque path segments", () => {
    expect(validateWebhookUrl("https://hooks.slack.com/services/T_TEST/B_TEST")).toBe(false);
    expect(validateWebhookUrl("https://hooks.slack.com/services/T_TEST/B_TEST/SECRET/")).toBe(false);
  });

  it("rejects URLs that carry a query string or fragment", () => {
    expect(validateWebhookUrl(WEBHOOK + "?foo=1")).toBe(false);
    expect(validateWebhookUrl(WEBHOOK + "#frag")).toBe(false);
  });

  it("rejects non-string inputs", () => {
    // @ts-expect-error -- exercising defensive type guard
    expect(validateWebhookUrl(undefined)).toBe(false);
    // @ts-expect-error -- exercising defensive type guard
    expect(validateWebhookUrl(123)).toBe(false);
  });
});

describe("maskWebhookUrl", () => {
  it("masks the secret tail behind an ellipsis after 12 chars", () => {
    const masked = maskWebhookUrl(WEBHOOK);
    expect(masked.startsWith("https://hooks.slack.com/services/")).toBe(true);
    expect(masked).not.toContain("SECRET_TEST");
    expect(masked).toContain("…");
  });

  it("returns a fixed placeholder for malformed inputs (no echoing user data)", () => {
    expect(maskWebhookUrl("nope")).toBe("https://hooks.slack.com/services/…");
  });
});

describe("sendTestAlert", () => {
  it("returns {ok:true, status:200} on a Slack 200 response", async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    const result = await sendTestAlert(baseOpts());
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(typeof result.sentAt).toBe("number");
  });

  it("posts as application/x-www-form-urlencoded (NOT application/json) to avoid a CORS preflight", async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    await sendTestAlert(baseOpts());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
  });

  it("encodes the JSON payload under a `payload=` form field", async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    await sendTestAlert(baseOpts());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = init.body as string;
    expect(typeof body).toBe("string");
    expect(body.startsWith("payload=")).toBe(true);
  });

  it("returns {ok:false, status:404, errorMessage} when Slack 404s the webhook", async () => {
    fetchMock.mockResolvedValueOnce(statusResponse(404));
    const result = await sendTestAlert(baseOpts());
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(result.errorMessage).toMatch(/404/);
    assertNoWebhookLeak();
  });

  it("returns a generic payload-bug message and logs the BODY (not the URL) on a 400", async () => {
    fetchMock.mockResolvedValueOnce(statusResponse(400, "invalid_payload"));
    const result = await sendTestAlert(baseOpts());
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(result.errorMessage).toMatch(/Could not format/);
    // The warn call should mention the body but NEVER the webhook URL.
    expect(warnSpy).toHaveBeenCalled();
    assertNoWebhookLeak();
  });

  it("surfaces channel_not_found verbatim on the 400 path so the wizard can route to the right error UI", async () => {
    fetchMock.mockResolvedValueOnce(statusResponse(400, "channel_not_found"));
    const result = await sendTestAlert(baseOpts());
    expect(result.errorMessage).toBe("channel_not_found");
  });

  it("returns a generic network-failure message when fetch throws a TypeError", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const result = await sendTestAlert(baseOpts());
    expect(result).toMatchObject({ ok: false, status: 0 });
    expect(result.errorMessage).toMatch(/Could not reach Slack/);
    assertNoWebhookLeak();
  });

  it("returns a structured 'cancelled' result on AbortError (never throws — wizard distinguishes by errorMessage)", async () => {
    const abortErr = new DOMException("aborted", "AbortError");
    fetchMock.mockRejectedValueOnce(abortErr);
    const result = await sendTestAlert(baseOpts());
    expect(result).toMatchObject({ ok: false, status: 0, errorMessage: "cancelled" });
    assertNoWebhookLeak();
  });

  it("returns a malformed-URL error WITHOUT calling fetch when the webhook URL is not a Slack webhook", async () => {
    const result = await sendTestAlert(baseOpts({ webhookUrl: "https://evil.example/x/y/z" }));
    expect(result).toMatchObject({ ok: false, status: 0 });
    expect(result.errorMessage).toMatch(/does not look like a Slack incoming webhook/);
    expect(fetchMock).not.toHaveBeenCalled();
    assertNoWebhookLeak();
  });

  it("never logs the full webhook URL across the whole table (defence-in-depth)", async () => {
    // Replay every branch in sequence and re-check at the end.
    fetchMock.mockResolvedValueOnce(okResponse());
    await sendTestAlert(baseOpts());
    fetchMock.mockResolvedValueOnce(statusResponse(404));
    await sendTestAlert(baseOpts());
    fetchMock.mockResolvedValueOnce(statusResponse(400, "bad shape"));
    await sendTestAlert(baseOpts());
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await sendTestAlert(baseOpts());
    assertNoWebhookLeak();
  });
});
