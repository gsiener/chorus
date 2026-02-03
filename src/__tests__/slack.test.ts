import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  verifySlackSignature,
  fetchThreadMessages,
  postMessage,
  updateMessage,
  addReaction,
  postDirectMessage,
  fetchUserInfo,
} from "../slack";
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
    HONEYCOMB_API_KEY: "test-honeycomb-key",
    DOCS_KV: { get: vi.fn().mockResolvedValue(null), put: vi.fn() } as unknown as KVNamespace,
    VECTORIZE: { query: vi.fn(), insert: vi.fn() } as unknown as VectorizeIndex,
    AI: { run: vi.fn() } as unknown as Ai,
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
    HONEYCOMB_API_KEY: "test-honeycomb-key",
    DOCS_KV: { get: vi.fn().mockResolvedValue(null), put: vi.fn() } as unknown as KVNamespace,
    VECTORIZE: { query: vi.fn(), insert: vi.fn() } as unknown as VectorizeIndex,
    AI: { run: vi.fn() } as unknown as Ai,
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns message ts on success", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, ts: "1234.5678" }))
    );

    const result = await postMessage("C123", "Hello world", "1234.0000", mockEnv);

    expect(result).toBe("1234.5678");
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
          unfurl_links: true,
        }),
      }
    );
  });

  it("returns null on API error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: "channel_not_found" }))
    );

    const result = await postMessage("C123", "Hello world", undefined, mockEnv);

    expect(result).toBeNull();
  });
});

describe("updateMessage", () => {
  const mockEnv: Env = {
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_SIGNING_SECRET: "test-secret",
    ANTHROPIC_API_KEY: "test-key",
    HONEYCOMB_API_KEY: "test-honeycomb-key",
    DOCS_KV: { get: vi.fn().mockResolvedValue(null), put: vi.fn() } as unknown as KVNamespace,
    VECTORIZE: { query: vi.fn(), insert: vi.fn() } as unknown as VectorizeIndex,
    AI: { run: vi.fn() } as unknown as Ai,
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("updates message successfully", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }))
    );

    const result = await updateMessage("C123", "1700000001.000000", "Updated text", mockEnv);

    expect(result).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "https://slack.com/api/chat.update",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          channel: "C123",
          ts: "1700000001.000000",
          text: "Updated text",
        }),
      })
    );
  });

  it("returns false on API error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: "message_not_found" }))
    );

    const result = await updateMessage("C123", "1700000001.000000", "Updated", mockEnv);

    expect(result).toBe(false);
  });
});

describe("addReaction", () => {
  const mockEnv: Env = {
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_SIGNING_SECRET: "test-secret",
    ANTHROPIC_API_KEY: "test-key",
    HONEYCOMB_API_KEY: "test-honeycomb-key",
    DOCS_KV: { get: vi.fn().mockResolvedValue(null), put: vi.fn() } as unknown as KVNamespace,
    VECTORIZE: { query: vi.fn(), insert: vi.fn() } as unknown as VectorizeIndex,
    AI: { run: vi.fn() } as unknown as Ai,
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds reaction successfully", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }))
    );

    const result = await addReaction("C123", "1700000001.000000", "thumbsup", mockEnv);

    expect(result).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "https://slack.com/api/reactions.add",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          channel: "C123",
          timestamp: "1700000001.000000",
          name: "thumbsup",
        }),
      })
    );
  });

  it("returns true when already reacted", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: "already_reacted" }))
    );

    const result = await addReaction("C123", "1700000001.000000", "thumbsup", mockEnv);

    expect(result).toBe(true);
  });

  it("returns false on other API errors", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: "channel_not_found" }))
    );

    const result = await addReaction("C123", "1700000001.000000", "thumbsup", mockEnv);

    expect(result).toBe(false);
  });
});

describe("postDirectMessage", () => {
  const mockEnv: Env = {
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_SIGNING_SECRET: "test-secret",
    ANTHROPIC_API_KEY: "test-key",
    HONEYCOMB_API_KEY: "test-honeycomb-key",
    DOCS_KV: { get: vi.fn().mockResolvedValue(null), put: vi.fn() } as unknown as KVNamespace,
    VECTORIZE: { query: vi.fn(), insert: vi.fn() } as unknown as VectorizeIndex,
    AI: { run: vi.fn() } as unknown as Ai,
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens DM channel and posts message", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, channel: { id: "D123" } }))
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, ts: "1700000001.000000" }))
      );

    const result = await postDirectMessage("U456", "Hello via DM!", mockEnv);

    expect(result.ts).toBe("1700000001.000000");
    expect(result.error).toBeUndefined();

    // First call opens DM
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://slack.com/api/conversations.open",
      expect.objectContaining({
        body: JSON.stringify({ users: "U456" }),
      })
    );

    // Second call posts message
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({
        body: JSON.stringify({
          channel: "D123",
          text: "Hello via DM!",
          thread_ts: undefined,
          unfurl_links: true,
        }),
      })
    );
  });

  it("returns error when DM channel cannot be opened", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: "user_not_found" }))
    );

    const result = await postDirectMessage("U456", "Hello!", mockEnv);

    expect(result.ts).toBeNull();
    expect(result.error).toBe("user_not_found");
    expect(fetch).toHaveBeenCalledTimes(1); // Should not attempt to post
  });

  it("returns error when message post fails", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, channel: { id: "D123" } }))
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: "rate_limited" }))
      );

    const result = await postDirectMessage("U456", "Hello!", mockEnv);

    expect(result.ts).toBeNull();
    expect(result.error).toBe("message_post_failed");
  });
});

describe("fetchUserInfo", () => {
  let mockKvStore: Record<string, string>;
  let mockEnv: Env;

  beforeEach(() => {
    mockKvStore = {};
    mockEnv = {
      SLACK_BOT_TOKEN: "xoxb-test-token",
      SLACK_SIGNING_SECRET: "test-secret",
      ANTHROPIC_API_KEY: "test-key",
      HONEYCOMB_API_KEY: "test-honeycomb-key",
      DOCS_KV: {
        get: vi.fn((key: string) => Promise.resolve(mockKvStore[key] || null)),
        put: vi.fn((key: string, value: string) => {
          mockKvStore[key] = value;
          return Promise.resolve();
        }),
      } as unknown as KVNamespace,
      VECTORIZE: { query: vi.fn(), insert: vi.fn() } as unknown as VectorizeIndex,
      AI: { run: vi.fn() } as unknown as Ai,
    };
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches user info from Slack API", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({
        ok: true,
        user: {
          id: "U123",
          name: "testuser",
          real_name: "Test User",
          profile: {
            title: "Engineer",
            email: "test@example.com",
          },
        },
      }))
    );

    const result = await fetchUserInfo("U123", mockEnv);

    expect(result).not.toBeNull();
    expect(result!.id).toBe("U123");
    expect(result!.name).toBe("testuser");
    expect(result!.realName).toBe("Test User");
    expect(result!.title).toBe("Engineer");
    expect(result!.email).toBe("test@example.com");
  });

  it("returns cached user info if available", async () => {
    const cachedUser = {
      id: "U123",
      name: "cacheduser",
      realName: "Cached User",
      title: "Designer",
      email: "cached@example.com",
    };
    mockKvStore["user:info:U123"] = JSON.stringify(cachedUser);

    const result = await fetchUserInfo("U123", mockEnv);

    expect(result).toEqual(cachedUser);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("caches fetched user info", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({
        ok: true,
        user: {
          id: "U456",
          name: "newuser",
          real_name: "New User",
          profile: {},
        },
      }))
    );

    await fetchUserInfo("U456", mockEnv);

    expect(mockEnv.DOCS_KV.put).toHaveBeenCalledWith(
      "user:info:U456",
      expect.any(String),
      expect.objectContaining({ expirationTtl: expect.any(Number) })
    );
  });

  it("returns null on API error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: "user_not_found" }))
    );

    const result = await fetchUserInfo("U999", mockEnv);

    expect(result).toBeNull();
  });

  it("returns null when user not in response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }))
    );

    const result = await fetchUserInfo("U999", mockEnv);

    expect(result).toBeNull();
  });
});
