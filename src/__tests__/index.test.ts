import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock OpenTelemetry to avoid node:os import issues in Workers pool
vi.mock("@opentelemetry/api", () => ({
  trace: {
    getTracer: () => ({
      startActiveSpan: (_name: string, fn: (span: { end: () => void; setAttribute: () => void; setStatus: () => void }) => unknown) =>
        fn({ end: () => {}, setAttribute: () => {}, setStatus: () => {} }),
    }),
    getActiveSpan: () => ({ setAttribute: () => {}, setStatus: () => {}, end: () => {} }),
  },
  SpanStatusCode: { ERROR: 2, OK: 1 },
}));

vi.mock("@microlabs/otel-cf-workers", () => ({
  instrument: (handler: unknown) => handler,
}));

import { handler, resetBotUserIdCache } from "../index";
import type { Env } from "../types";

describe("Worker", () => {
  const mockEnv: Env = {
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_SIGNING_SECRET: "test-signing-secret",
    ANTHROPIC_API_KEY: "sk-ant-test-key",
    HONEYCOMB_API_KEY: "test-honeycomb-key",
    DOCS_KV: { get: vi.fn().mockResolvedValue(null), put: vi.fn() } as unknown as KVNamespace,
    VECTORIZE: { query: vi.fn(), insert: vi.fn() } as unknown as VectorizeIndex,
    AI: { run: vi.fn() } as unknown as Ai,
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

  it("handles help command and triggers background processing", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvHelp1",
      event_time: 1234567890,
      event: {
        type: "app_mention",
        user: "U123",
        text: "<@U_BOT> help",
        channel: "C123",
        ts: "1234.5678",
      },
    });
    const request = await createSignedRequest(body, mockEnv.SLACK_SIGNING_SECRET);

    const response = await handler.fetch(request, mockEnv, mockCtx);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
    // Help command should be processed in background via waitUntil
    expect(mockCtx.waitUntil).toHaveBeenCalled();
  });
});

describe("Docs API", () => {
  const mockKvStore: Record<string, string> = {};
  const mockEnv: Env = {
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_SIGNING_SECRET: "test-signing-secret",
    ANTHROPIC_API_KEY: "sk-ant-test-key",
    HONEYCOMB_API_KEY: "test-honeycomb-key",
    DOCS_API_KEY: "test-api-key",
    DOCS_KV: {
      get: vi.fn((key: string) => Promise.resolve(mockKvStore[key] || null)),
      put: vi.fn((key: string, value: string) => {
        mockKvStore[key] = value;
        return Promise.resolve();
      }),
      delete: vi.fn((key: string) => {
        delete mockKvStore[key];
        return Promise.resolve();
      }),
    } as unknown as KVNamespace,
    VECTORIZE: {
      query: vi.fn().mockResolvedValue({ matches: [] }),
      insert: vi.fn().mockResolvedValue(undefined),
      deleteByIds: vi.fn().mockResolvedValue(undefined),
    } as unknown as VectorizeIndex,
    AI: {
      run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2, 0.3]] }),
    } as unknown as Ai,
  };

  const mockCtx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;

  beforeEach(() => {
    // Clear mock KV store
    Object.keys(mockKvStore).forEach((key) => delete mockKvStore[key]);
    vi.clearAllMocks();
  });

  it("returns 401 without API key", async () => {
    const request = new Request("https://example.com/api/docs", {
      method: "GET",
    });

    const response = await handler.fetch(request, mockEnv, mockCtx);

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 with wrong API key", async () => {
    const request = new Request("https://example.com/api/docs", {
      method: "GET",
      headers: { Authorization: "Bearer wrong-key" },
    });

    const response = await handler.fetch(request, mockEnv, mockCtx);

    expect(response.status).toBe(401);
  });

  it("GET /api/docs returns document list", async () => {
    const request = new Request("https://example.com/api/docs", {
      method: "GET",
      headers: { Authorization: "Bearer test-api-key" },
    });

    const response = await handler.fetch(request, mockEnv, mockCtx);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { documents: string };
    expect(body.documents).toBeDefined();
  });

  it("POST /api/docs adds a document", async () => {
    const request = new Request("https://example.com/api/docs", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-api-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "Test Doc", content: "Test content" }),
    });

    const response = await handler.fetch(request, mockEnv, mockCtx);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toContain("Test Doc");
  });

  it("POST /api/docs returns 400 for missing fields", async () => {
    const request = new Request("https://example.com/api/docs", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-api-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "Test Doc" }), // missing content
    });

    const response = await handler.fetch(request, mockEnv, mockCtx);

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Missing required fields");
  });

  it("DELETE /api/docs removes a document", async () => {
    // First add a document
    mockKvStore["docs:index"] = JSON.stringify({
      documents: [{ title: "To Delete", addedBy: "api", addedAt: new Date().toISOString(), charCount: 10 }],
    });
    mockKvStore["docs:content:to-delete"] = "content";

    const request = new Request("https://example.com/api/docs", {
      method: "DELETE",
      headers: {
        Authorization: "Bearer test-api-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "To Delete" }),
    });

    const response = await handler.fetch(request, mockEnv, mockCtx);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });

  it("DELETE /api/docs returns 404 for non-existent doc", async () => {
    const request = new Request("https://example.com/api/docs", {
      method: "DELETE",
      headers: {
        Authorization: "Bearer test-api-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "Non-existent" }),
    });

    const response = await handler.fetch(request, mockEnv, mockCtx);

    expect(response.status).toBe(404);
  });

  it("returns 405 for unsupported methods", async () => {
    const request = new Request("https://example.com/api/docs", {
      method: "PUT",
      headers: { Authorization: "Bearer test-api-key" },
    });

    const response = await handler.fetch(request, mockEnv, mockCtx);

    expect(response.status).toBe(405);
  });
});

describe("Search Command", () => {
  const mockEnv: Env = {
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_SIGNING_SECRET: "test-signing-secret",
    ANTHROPIC_API_KEY: "sk-ant-test-key",
    HONEYCOMB_API_KEY: "test-honeycomb-key",
    DOCS_KV: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn(),
      delete: vi.fn(),
    } as unknown as KVNamespace,
    VECTORIZE: {
      query: vi.fn().mockResolvedValue({
        matches: [
          {
            id: "doc:test-doc:chunk:0",
            score: 0.85,
            metadata: {
              title: "Test Strategy Doc",
              content: "This is the test content about strategy.",
            },
          },
        ],
      }),
      insert: vi.fn(),
      deleteByIds: vi.fn(),
    } as unknown as VectorizeIndex,
    AI: {
      run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2, 0.3]] }),
    } as unknown as Ai,
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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, user_id: "U_BOT", ts: "1234.5679" }),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("handles search command with quoted query", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev456",
      event_time: 1234567890,
      event: {
        type: "app_mention",
        user: "U123",
        text: '<@U_BOT> search "strategy"',
        channel: "C123",
        ts: "1234.5678",
      },
    });
    const request = await createSignedRequest(body, mockEnv.SLACK_SIGNING_SECRET);

    const response = await handler.fetch(request, mockEnv, mockCtx);

    expect(response.status).toBe(200);
    expect(mockCtx.waitUntil).toHaveBeenCalled();
  });

  it("handles search command with unquoted query", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev789",
      event_time: 1234567890,
      event: {
        type: "app_mention",
        user: "U123",
        text: "<@U_BOT> search roadmap planning",
        channel: "C123",
        ts: "1234.5678",
      },
    });
    const request = await createSignedRequest(body, mockEnv.SLACK_SIGNING_SECRET);

    const response = await handler.fetch(request, mockEnv, mockCtx);

    expect(response.status).toBe(200);
    expect(mockCtx.waitUntil).toHaveBeenCalled();
  });
});

describe("Slash Commands", () => {
  const mockEnv: Env = {
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_SIGNING_SECRET: "test-signing-secret",
    ANTHROPIC_API_KEY: "sk-ant-test-key",
    HONEYCOMB_API_KEY: "test-honeycomb-key",
    DOCS_KV: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn(),
      delete: vi.fn(),
    } as unknown as KVNamespace,
    VECTORIZE: {
      query: vi.fn().mockResolvedValue({ matches: [] }),
      insert: vi.fn(),
      deleteByIds: vi.fn(),
    } as unknown as VectorizeIndex,
    AI: {
      run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2, 0.3]] }),
    } as unknown as Ai,
  };

  const mockCtx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;

  async function createSignedSlashRequest(
    params: URLSearchParams,
    signingSecret: string
  ): Promise<Request> {
    const body = params.toString();
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

    return new Request("https://example.com/slack/slash", {
      method: "POST",
      headers: {
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns help for /chorus command", async () => {
    const params = new URLSearchParams({
      command: "/chorus",
      text: "",
      user_id: "U123",
      channel_id: "C123",
    });
    const request = await createSignedSlashRequest(params, mockEnv.SLACK_SIGNING_SECRET);

    const response = await handler.fetch(request, mockEnv, mockCtx);

    expect(response.status).toBe(200);
    const body = await response.json() as { response_type: string; text: string };
    expect(body.response_type).toBe("ephemeral");
    expect(body.text).toContain("Chorus");
    expect(body.text).toContain("initiatives");
  });

  it("lists initiatives for /chorus initiatives command", async () => {
    const params = new URLSearchParams({
      command: "/chorus",
      text: "initiatives",
      user_id: "U123",
      channel_id: "C123",
    });
    const request = await createSignedSlashRequest(params, mockEnv.SLACK_SIGNING_SECRET);

    const response = await handler.fetch(request, mockEnv, mockCtx);

    expect(response.status).toBe(200);
    const body = await response.json() as { response_type: string; text: string };
    expect(body.response_type).toBe("ephemeral");
    // Will show "No initiatives found" or initiatives list
    expect(body.text).toBeDefined();
  });

  it("handles /chorus-search command", async () => {
    const params = new URLSearchParams({
      command: "/chorus-search",
      text: "roadmap",
      user_id: "U123",
      channel_id: "C123",
    });
    const request = await createSignedSlashRequest(params, mockEnv.SLACK_SIGNING_SECRET);

    const response = await handler.fetch(request, mockEnv, mockCtx);

    expect(response.status).toBe(200);
    const body = await response.json() as { response_type: string; text: string };
    expect(body.response_type).toBe("ephemeral");
    // Will show results or "No results found"
    expect(body.text).toBeDefined();
  });

  it("handles /chorus search query", async () => {
    const params = new URLSearchParams({
      command: "/chorus",
      text: "search roadmap",
      user_id: "U123",
      channel_id: "C123",
    });
    const request = await createSignedSlashRequest(params, mockEnv.SLACK_SIGNING_SECRET);

    const response = await handler.fetch(request, mockEnv, mockCtx);

    expect(response.status).toBe(200);
    const body = await response.json() as { response_type: string; text: string };
    expect(body.text).toBeDefined();
  });

  it("returns 401 for invalid signature", async () => {
    const params = new URLSearchParams({
      command: "/chorus",
      text: "",
      user_id: "U123",
    });

    const request = new Request("https://example.com/slack/slash", {
      method: "POST",
      headers: {
        "x-slack-request-timestamp": Math.floor(Date.now() / 1000).toString(),
        "x-slack-signature": "v0=invalid",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const response = await handler.fetch(request, mockEnv, mockCtx);

    expect(response.status).toBe(401);
  });

  it("handles unknown command with help", async () => {
    const params = new URLSearchParams({
      command: "/unknown-chorus",
      text: "",
      user_id: "U123",
      channel_id: "C123",
    });
    const request = await createSignedSlashRequest(params, mockEnv.SLACK_SIGNING_SECRET);

    const response = await handler.fetch(request, mockEnv, mockCtx);

    expect(response.status).toBe(200);
    const body = await response.json() as { response_type: string; text: string };
    expect(body.text).toContain("Unknown command");
    expect(body.text).toContain("/chorus");
  });
});
