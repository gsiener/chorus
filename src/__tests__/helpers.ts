/**
 * Shared test utilities for Chorus tests
 *
 * This module provides common mocks and helpers used across test files.
 * Import from here instead of duplicating mock implementations.
 */

import { vi } from "vitest";
import type { Env } from "../types";

/**
 * Create a mock KV namespace with in-memory Map storage
 * Provides get/put/delete methods that behave like KVNamespace
 */
export function createMockKV() {
  const store = new Map<string, string>();
  return {
    get: vi.fn((key: string, options?: "json" | { type: "json" }) => {
      const value = store.get(key) ?? null;
      if (value === null) return Promise.resolve(null);
      if (options === "json" || (options && typeof options === "object" && options.type === "json")) {
        return Promise.resolve(JSON.parse(value));
      }
      return Promise.resolve(value);
    }),
    put: vi.fn((key: string, value: string, _options?: { expirationTtl?: number }) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    delete: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
    list: vi.fn(() => Promise.resolve({ keys: [], list_complete: true, cursor: "" })),
    /** Direct access to the underlying store for test assertions */
    _store: store,
    /** Clear all stored values */
    _clear: () => store.clear(),
  };
}

export type MockKV = ReturnType<typeof createMockKV>;

/**
 * Create a mock Env object with all required bindings
 * @param overrides - Optional partial Env to override defaults
 */
export function createMockEnv(overrides: Partial<Env & { kv?: MockKV }> = {}): Env & { _kv: MockKV } {
  const kv = overrides.kv ?? createMockKV();

  return {
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_SIGNING_SECRET: "test-signing-secret",
    ANTHROPIC_API_KEY: "sk-ant-test-key",
    HONEYCOMB_API_KEY: "test-honeycomb-key",
    DOCS_KV: kv as unknown as KVNamespace,
    VECTORIZE: {
      query: vi.fn().mockResolvedValue({ matches: [] }),
      insert: vi.fn().mockResolvedValue(undefined),
      deleteByIds: vi.fn().mockResolvedValue(undefined),
    } as unknown as VectorizeIndex,
    AI: {
      run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2, 0.3]] }),
    } as unknown as Ai,
    _kv: kv,
    ...overrides,
  };
}

/**
 * Create a mock ExecutionContext
 */
export function createMockContext() {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

/**
 * Create a properly signed Slack request for testing
 * @param body - Request body as string
 * @param signingSecret - Slack signing secret
 * @param options - Additional request options
 */
export async function createSignedRequest(
  body: string,
  signingSecret: string,
  options: {
    url?: string;
    contentType?: string;
  } = {}
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

  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(sigBaseString)
  );

  const signature =
    "v0=" +
    Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  return new Request(options.url ?? "https://example.com/slack/events", {
    method: "POST",
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
      "Content-Type": options.contentType ?? "application/json",
    },
    body,
  });
}

/**
 * Create a signed Slack slash command request
 * @param params - URL search params for the slash command
 * @param signingSecret - Slack signing secret
 */
export async function createSignedSlashRequest(
  params: URLSearchParams,
  signingSecret: string
): Promise<Request> {
  return createSignedRequest(params.toString(), signingSecret, {
    url: "https://example.com/slack/slash",
    contentType: "application/x-www-form-urlencoded",
  });
}

/**
 * Create a mock fetch response
 * @param data - Response data (will be JSON stringified if object)
 * @param options - Response options
 */
export function mockFetchResponse(
  data: unknown,
  options: { ok?: boolean; status?: number } = {}
) {
  const ok = options.ok ?? true;
  const status = options.status ?? (ok ? 200 : 400);
  const body = typeof data === "string" ? data : JSON.stringify(data);

  return new Response(body, { status });
}

/**
 * Create a mock Slack API response
 * @param overrides - Partial response to override defaults
 */
export function mockSlackResponse(overrides: Record<string, unknown> = {}) {
  return mockFetchResponse({
    ok: true,
    ts: "1234.5678",
    channel: { id: "C123" },
    user_id: "U_BOT",
    ...overrides,
  });
}

/**
 * Create a mock Claude API response
 * @param text - Response text
 * @param usage - Token usage (optional)
 */
export function mockClaudeResponse(
  text: string,
  usage: { input_tokens?: number; output_tokens?: number } = {}
) {
  return mockFetchResponse({
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model: "claude-sonnet-4-20250514",
    stop_reason: "end_turn",
    usage: {
      input_tokens: usage.input_tokens ?? 100,
      output_tokens: usage.output_tokens ?? 50,
    },
  });
}

/**
 * Stub global fetch with a mock implementation
 * Returns the mock function for assertions
 */
export function stubFetch(implementation?: typeof fetch) {
  const mockFetch = vi.fn(implementation ?? (() => Promise.resolve(mockSlackResponse())));
  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

/**
 * Clear all mocks and unstub globals
 * Call in afterEach
 */
export function cleanupMocks() {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
}

/**
 * Create an app_mention event payload
 */
export function createAppMentionPayload(overrides: {
  text?: string;
  user?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  event_id?: string;
} = {}) {
  return {
    type: "event_callback",
    event_id: overrides.event_id ?? "Ev123",
    event_time: 1234567890,
    event: {
      type: "app_mention",
      user: overrides.user ?? "U123",
      text: overrides.text ?? "<@U_BOT> hello",
      channel: overrides.channel ?? "C123",
      ts: overrides.ts ?? "1234.5678",
      ...(overrides.thread_ts ? { thread_ts: overrides.thread_ts } : {}),
    },
  };
}
