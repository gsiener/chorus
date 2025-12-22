import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handler } from "../handler";
import type { Env } from "../types";

describe("Worker", () => {
  const mockEnv: Env = {
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_SIGNING_SECRET: "test-signing-secret",
    ANTHROPIC_API_KEY: "sk-ant-test-key",
    HONEYCOMB_API_KEY: "test-honeycomb-key",
  };

  const mockCtx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;

  async function createSignedRequest(
    body: string,
    signingSecret: string
  ): Promise<Request> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const sigBaseString = `v0:${timestamp}:${body}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(signingSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(sigBaseString));
    const signature = "v0=" + Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    return new Request("https://example.com/slack/events", {
      method: "POST",
      headers: {
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
        "Content-Type": "application/json",
      },
      body,
    });
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("returns 405 for non-POST requests", async () => {
    const request = new Request("https://example.com", { method: "GET" });
    const response = await handler.fetch(request, mockEnv, mockCtx);

    expect(response.status).toBe(405);
    expect(await response.text()).toBe("Method not allowed");
  });

  it("returns 401 for invalid signature", async () => {
    const request = new Request("https://example.com", {
      method: "POST",
      headers: {
        "x-slack-request-timestamp": Math.floor(Date.now() / 1000).toString(),
        "x-slack-signature": "v0=invalid",
      },
      body: "{}",
    });

    const response = await handler.fetch(request, mockEnv, mockCtx);

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Invalid signature");
  });

  it("handles url_verification challenge", async () => {
    const body = JSON.stringify({
      type: "url_verification",
      challenge: "test-challenge-token",
    });
    const request = await createSignedRequest(body, mockEnv.SLACK_SIGNING_SECRET);

    const response = await handler.fetch(request, mockEnv, mockCtx);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("test-challenge-token");
    expect(response.headers.get("Content-Type")).toBe("text/plain");
  });

  it("acknowledges app_mention event and processes in background", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev123",
      event_time: 1234567890,
      event: {
        type: "app_mention",
        user: "U123",
        text: "<@U_BOT> what is the roadmap?",
        channel: "C123",
        ts: "1234.5678",
      },
    });
    const request = await createSignedRequest(body, mockEnv.SLACK_SIGNING_SECRET);

    const response = await handler.fetch(request, mockEnv, mockCtx);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
    expect(mockCtx.waitUntil).toHaveBeenCalled();
  });

  it("returns OK for unhandled event types", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev123",
      event_time: 1234567890,
      event: {
        type: "message",
        user: "U123",
        text: "Hello",
        channel: "C123",
        ts: "1234.5678",
      },
    });
    const request = await createSignedRequest(body, mockEnv.SLACK_SIGNING_SECRET);

    const response = await handler.fetch(request, mockEnv, mockCtx);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
    expect(mockCtx.waitUntil).not.toHaveBeenCalled();
  });
});
