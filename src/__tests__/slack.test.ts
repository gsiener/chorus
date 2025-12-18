import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { verifySlackSignature, fetchThreadMessages, postMessage } from "../slack";
import type { Env } from "../types";

describe("verifySlackSignature", () => {
  const signingSecret = "test-signing-secret";

  async function createValidSignature(body: string, timestamp: string): Promise<string> {
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
    return "v0=" + Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  it("returns true for valid signature", async () => {
    const body = '{"test": "data"}';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await createValidSignature(body, timestamp);

    const request = new Request("https://example.com", {
      method: "POST",
      headers: {
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
    });

    const result = await verifySlackSignature(request, body, signingSecret);
    expect(result).toBe(true);
  });

  it("returns false when timestamp header is missing", async () => {
    const request = new Request("https://example.com", {
      method: "POST",
      headers: {
        "x-slack-signature": "v0=abc123",
      },
    });

    const result = await verifySlackSignature(request, "{}", signingSecret);
    expect(result).toBe(false);
  });

  it("returns false when signature header is missing", async () => {
    const request = new Request("https://example.com", {
      method: "POST",
      headers: {
        "x-slack-request-timestamp": "1234567890",
      },
    });

    const result = await verifySlackSignature(request, "{}", signingSecret);
    expect(result).toBe(false);
  });

  it("returns false when timestamp is too old", async () => {
    const body = '{"test": "data"}';
    const oldTimestamp = (Math.floor(Date.now() / 1000) - 600).toString(); // 10 minutes ago
    const signature = await createValidSignature(body, oldTimestamp);

    const request = new Request("https://example.com", {
      method: "POST",
      headers: {
        "x-slack-request-timestamp": oldTimestamp,
        "x-slack-signature": signature,
      },
    });

    const result = await verifySlackSignature(request, body, signingSecret);
    expect(result).toBe(false);
  });

  it("returns false for invalid signature", async () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();

    const request = new Request("https://example.com", {
      method: "POST",
      headers: {
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": "v0=invalid_signature",
      },
    });

    const result = await verifySlackSignature(request, "{}", signingSecret);
    expect(result).toBe(false);
  });
});

describe("fetchThreadMessages", () => {
  const mockEnv: Env = {
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_SIGNING_SECRET: "test-secret",
    ANTHROPIC_API_KEY: "test-key",
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns messages on success", async () => {
    const mockMessages = [
      { user: "U123", text: "Hello", ts: "1234.5678" },
      { user: "U456", text: "Hi there", ts: "1234.5679", bot_id: "B123" },
    ];

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, messages: mockMessages }))
    );

    const result = await fetchThreadMessages("C123", "1234.5678", mockEnv);

    expect(result).toEqual(mockMessages);
    expect(fetch).toHaveBeenCalledWith(
      "https://slack.com/api/conversations.replies?channel=C123&ts=1234.5678",
      {
        headers: {
          Authorization: "Bearer xoxb-test-token",
        },
      }
    );
  });

  it("returns empty array on API error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: "channel_not_found" }))
    );

    const result = await fetchThreadMessages("C123", "1234.5678", mockEnv);

    expect(result).toEqual([]);
  });
});

describe("postMessage", () => {
  const mockEnv: Env = {
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_SIGNING_SECRET: "test-secret",
    ANTHROPIC_API_KEY: "test-key",
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns true on success", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, ts: "1234.5678" }))
    );

    const result = await postMessage("C123", "Hello world", "1234.0000", mockEnv);

    expect(result).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer xoxb-test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel: "C123",
          text: "Hello world",
          thread_ts: "1234.0000",
        }),
      }
    );
  });

  it("returns false on API error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: "channel_not_found" }))
    );

    const result = await postMessage("C123", "Hello world", undefined, mockEnv);

    expect(result).toBe(false);
  });
});
