import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { storeFeedbackRecord, updateFeedbackWithReaction, handleFeedbackPage } from "../feedback";
import type { Env, FeedbackRecord } from "../types";
import { FEEDBACK_TTL_SECONDS } from "../constants";

function createMockEnv(kvOverrides: Partial<KVNamespace> = {}): Env {
  return {
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_SIGNING_SECRET: "test-secret",
    ANTHROPIC_API_KEY: "sk-ant-test",
    HONEYCOMB_API_KEY: "test-hc",
    DOCS_KV: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
      ...kvOverrides,
    } as unknown as KVNamespace,
    VECTORIZE: { query: vi.fn(), insert: vi.fn() } as unknown as VectorizeIndex,
    AI: { run: vi.fn() } as unknown as Ai,
  };
}

const sampleRecord: FeedbackRecord = {
  prompt: "What are our top priorities?",
  response: "Here are the top priorities...",
  user: "U123",
  channel: "C456",
  ts: "1234567890.123456",
  timestamp: "2026-02-11T10:00:00.000Z",
  inputTokens: 100,
  outputTokens: 50,
};

describe("storeFeedbackRecord", () => {
  it("stores record with correct key, TTL, and metadata", async () => {
    const env = createMockEnv();
    await storeFeedbackRecord(env, sampleRecord);

    expect(env.DOCS_KV.put).toHaveBeenCalledWith(
      "feedback:C456:1234567890.123456",
      JSON.stringify(sampleRecord),
      {
        expirationTtl: FEEDBACK_TTL_SECONDS,
        metadata: {
          prompt: "What are our top priorities?",
          user: "U123",
          timestamp: "2026-02-11T10:00:00.000Z",
        },
      }
    );
  });

  it("truncates long prompts in metadata", async () => {
    const env = createMockEnv();
    const longPrompt = "a".repeat(200);
    await storeFeedbackRecord(env, { ...sampleRecord, prompt: longPrompt });

    const putCall = vi.mocked(env.DOCS_KV.put).mock.calls[0];
    const metadata = putCall[2]?.metadata as { prompt: string };
    expect(metadata.prompt).toHaveLength(100);
  });
});

describe("updateFeedbackWithReaction", () => {
  it("updates existing record with feedback", async () => {
    const env = createMockEnv({
      get: vi.fn().mockResolvedValue(sampleRecord),
    });

    await updateFeedbackWithReaction(env, "C456", "1234567890.123456", "positive", "U789");

    expect(env.DOCS_KV.put).toHaveBeenCalledTimes(1);
    const putCall = vi.mocked(env.DOCS_KV.put).mock.calls[0];
    const stored = JSON.parse(putCall[1] as string) as FeedbackRecord;
    expect(stored.feedback?.type).toBe("positive");
    expect(stored.feedback?.reactor).toBe("U789");
    const metadata = putCall[2]?.metadata as { feedback: string };
    expect(metadata.feedback).toBe("positive");
  });

  it("silently skips when no record exists", async () => {
    const env = createMockEnv({
      get: vi.fn().mockResolvedValue(null),
    });

    await updateFeedbackWithReaction(env, "C456", "1234567890.123456", "negative", "U789");

    expect(env.DOCS_KV.put).not.toHaveBeenCalled();
  });
});

describe("handleFeedbackPage", () => {
  it("returns HTML with correct content type", async () => {
    const env = createMockEnv();
    const response = await handleFeedbackPage(env);

    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const html = await response.text();
    expect(html).toContain("Chorus Feedback Log");
  });

  it("shows empty state when no entries exist", async () => {
    const env = createMockEnv();
    const response = await handleFeedbackPage(env);
    const html = await response.text();

    expect(html).toContain("0 entries");
    expect(html).toContain("No feedback entries yet.");
  });

  it("renders entries sorted by date descending", async () => {
    const env = createMockEnv({
      list: vi.fn().mockResolvedValue({
        keys: [
          {
            name: "feedback:C1:ts1",
            metadata: { prompt: "older question", user: "U1", timestamp: "2026-02-10T10:00:00.000Z" },
          },
          {
            name: "feedback:C1:ts2",
            metadata: { prompt: "newer question", user: "U2", timestamp: "2026-02-11T10:00:00.000Z" },
          },
        ],
        list_complete: true,
      }),
    });

    const response = await handleFeedbackPage(env);
    const html = await response.text();

    const newerIdx = html.indexOf("newer question");
    const olderIdx = html.indexOf("older question");
    expect(newerIdx).toBeLessThan(olderIdx);
  });

  it("shows feedback indicators", async () => {
    const env = createMockEnv({
      list: vi.fn().mockResolvedValue({
        keys: [
          {
            name: "feedback:C1:ts1",
            metadata: { prompt: "good", user: "U1", feedback: "positive", timestamp: "2026-02-11T10:00:00.000Z" },
          },
          {
            name: "feedback:C1:ts2",
            metadata: { prompt: "bad", user: "U2", feedback: "negative", timestamp: "2026-02-11T09:00:00.000Z" },
          },
          {
            name: "feedback:C1:ts3",
            metadata: { prompt: "none", user: "U3", timestamp: "2026-02-11T08:00:00.000Z" },
          },
        ],
        list_complete: true,
      }),
    });

    const response = await handleFeedbackPage(env);
    const html = await response.text();

    expect(html).toContain("👍");
    expect(html).toContain("👎");
    expect(html).toContain("—");
  });

  it("applies negative class to downvoted rows", async () => {
    const env = createMockEnv({
      list: vi.fn().mockResolvedValue({
        keys: [
          {
            name: "feedback:C1:ts1",
            metadata: { prompt: "bad response", user: "U1", feedback: "negative", timestamp: "2026-02-11T10:00:00.000Z" },
          },
        ],
        list_complete: true,
      }),
    });

    const response = await handleFeedbackPage(env);
    const html = await response.text();

    expect(html).toContain('class="negative"');
  });

  it("escapes HTML in prompt text", async () => {
    const env = createMockEnv({
      list: vi.fn().mockResolvedValue({
        keys: [
          {
            name: "feedback:C1:ts1",
            metadata: { prompt: '<script>alert("xss")</script>', user: "U1", timestamp: "2026-02-11T10:00:00.000Z" },
          },
        ],
        list_complete: true,
      }),
    });

    const response = await handleFeedbackPage(env);
    const html = await response.text();

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
