import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendDailyFeedbackDigest } from "../feedback-digest";
import type { Env, FeedbackRecord, FeedbackMetadata } from "../types";

function makeFeedbackRecord(overrides: Partial<FeedbackRecord> = {}): FeedbackRecord {
  return {
    prompt: "What are our top priorities?",
    response: "Here are the priorities...",
    user: "U_ASKER",
    channel: "C123",
    ts: "1234.5678",
    timestamp: "2026-03-02T12:00:00Z",
    inputTokens: 100,
    outputTokens: 200,
    ...overrides,
  };
}

function makeKvKey(
  record: FeedbackRecord,
  metadata: FeedbackMetadata
): { name: string; metadata: FeedbackMetadata } {
  return {
    name: `feedback:${record.channel}:${record.ts}`,
    metadata,
  };
}

describe("sendDailyFeedbackDigest", () => {
  let mockKvData: Record<string, string>;
  let mockKvKeys: { name: string; metadata?: FeedbackMetadata }[];
  let mockFetchCalls: { url: string; body: string }[];

  const mockEnv: Env = {
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_SIGNING_SECRET: "test-signing-secret",
    ANTHROPIC_API_KEY: "sk-ant-test-key",
    HONEYCOMB_API_KEY: "test-honeycomb-key",
    FEEDBACK_DIGEST_USER: "U_GRAHAM",
    DOCS_KV: {
      get: vi.fn((key: string, format?: string) => {
        const val = mockKvData[key];
        if (!val) return Promise.resolve(null);
        if (format === "json") return Promise.resolve(JSON.parse(val));
        return Promise.resolve(val);
      }),
      list: vi.fn(() =>
        Promise.resolve({ keys: mockKvKeys, list_complete: true, cursor: "" })
      ),
    } as unknown as KVNamespace,
    VECTORIZE: {} as unknown as VectorizeIndex,
    AI: {} as unknown as Ai,
  };

  beforeEach(() => {
    mockKvData = {};
    mockKvKeys = [];
    mockFetchCalls = [];
    vi.clearAllMocks();

    // Mock fetch for Slack API calls
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        mockFetchCalls.push({ url: urlStr, body: init?.body as string });

        // auth.test returns bot user ID
        if (urlStr.includes("auth.test")) {
          return {
            ok: true,
            json: () => Promise.resolve({ ok: true, user_id: "U_BOT" }),
          };
        }

        return {
          ok: true,
          json: () =>
            Promise.resolve({ ok: true, channel: { id: "D123" }, ts: "9999.0001" }),
        };
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends digest with mixed positive/negative feedback", async () => {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

    const record1 = makeFeedbackRecord({
      channel: "C1",
      ts: "1001.0",
      prompt: "What are our priorities?",
      feedback: { type: "positive", reactor: "U_ALICE", reactedAt: oneHourAgo },
    });
    const record2 = makeFeedbackRecord({
      channel: "C2",
      ts: "1002.0",
      prompt: "How do we handle auth?",
      feedback: { type: "negative", reactor: "U_BOB", reactedAt: oneHourAgo },
    });

    mockKvKeys = [
      makeKvKey(record1, {
        prompt: record1.prompt.slice(0, 100),
        user: record1.user,
        feedback: "positive",
        timestamp: record1.timestamp,
      }),
      makeKvKey(record2, {
        prompt: record2.prompt.slice(0, 100),
        user: record2.user,
        feedback: "negative",
        timestamp: record2.timestamp,
      }),
    ];
    mockKvData[`feedback:C1:1001.0`] = JSON.stringify(record1);
    mockKvData[`feedback:C2:1002.0`] = JSON.stringify(record2);

    const result = await sendDailyFeedbackDigest(mockEnv);

    expect(result.success).toBe(true);
    expect(result.message).toContain("2 reaction(s)");

    // Verify the DM was sent (conversations.open + chat.postMessage = 2 fetch calls)
    expect(mockFetchCalls.length).toBeGreaterThanOrEqual(1);

    // Find the postMessage call
    const postCall = mockFetchCalls.find((c) => c.url.includes("chat.postMessage"));
    expect(postCall).toBeDefined();
    const body = JSON.parse(postCall!.body);
    expect(body.text).toContain("2 reactions yesterday (1 👍, 1 👎)");
    expect(body.text).toContain("<@U_ALICE>");
    expect(body.text).toContain("<@U_BOB>");
  });

  it("sends 'no reactions' message when none in 24h", async () => {
    mockKvKeys = [];

    const result = await sendDailyFeedbackDigest(mockEnv);

    expect(result.success).toBe(true);

    const postCall = mockFetchCalls.find((c) => c.url.includes("chat.postMessage"));
    expect(postCall).toBeDefined();
    const body = JSON.parse(postCall!.body);
    expect(body.text).toContain("No reactions in the last 24 hours");
  });

  it("skips entries without feedback", async () => {
    const record = makeFeedbackRecord({ channel: "C1", ts: "1001.0" });
    // No feedback field set

    mockKvKeys = [
      {
        name: `feedback:C1:1001.0`,
        metadata: {
          prompt: record.prompt.slice(0, 100),
          user: record.user,
          timestamp: record.timestamp,
          // no feedback field
        },
      },
    ];
    mockKvData[`feedback:C1:1001.0`] = JSON.stringify(record);

    const result = await sendDailyFeedbackDigest(mockEnv);

    expect(result.success).toBe(true);

    const postCall = mockFetchCalls.find((c) => c.url.includes("chat.postMessage"));
    expect(postCall).toBeDefined();
    const body = JSON.parse(postCall!.body);
    expect(body.text).toContain("No reactions in the last 24 hours");
  });

  it("skips entries with feedback older than 24h", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    const record = makeFeedbackRecord({
      channel: "C1",
      ts: "1001.0",
      feedback: { type: "positive", reactor: "U_ALICE", reactedAt: twoDaysAgo },
    });

    mockKvKeys = [
      makeKvKey(record, {
        prompt: record.prompt.slice(0, 100),
        user: record.user,
        feedback: "positive",
        timestamp: record.timestamp,
      }),
    ];
    mockKvData[`feedback:C1:1001.0`] = JSON.stringify(record);

    const result = await sendDailyFeedbackDigest(mockEnv);

    expect(result.success).toBe(true);

    const postCall = mockFetchCalls.find((c) => c.url.includes("chat.postMessage"));
    expect(postCall).toBeDefined();
    const body = JSON.parse(postCall!.body);
    expect(body.text).toContain("No reactions in the last 24 hours");
  });

  it("filters out bot self-reactions", async () => {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

    const botReaction = makeFeedbackRecord({
      channel: "C1",
      ts: "1001.0",
      prompt: "What are our priorities?",
      feedback: { type: "positive", reactor: "U_BOT", reactedAt: oneHourAgo },
    });
    const humanReaction = makeFeedbackRecord({
      channel: "C2",
      ts: "1002.0",
      prompt: "How do we handle auth?",
      feedback: { type: "negative", reactor: "U_HUMAN", reactedAt: oneHourAgo },
    });

    mockKvKeys = [
      makeKvKey(botReaction, {
        prompt: botReaction.prompt.slice(0, 100),
        user: botReaction.user,
        feedback: "positive",
        timestamp: botReaction.timestamp,
      }),
      makeKvKey(humanReaction, {
        prompt: humanReaction.prompt.slice(0, 100),
        user: humanReaction.user,
        feedback: "negative",
        timestamp: humanReaction.timestamp,
      }),
    ];
    mockKvData[`feedback:C1:1001.0`] = JSON.stringify(botReaction);
    mockKvData[`feedback:C2:1002.0`] = JSON.stringify(humanReaction);

    const result = await sendDailyFeedbackDigest(mockEnv);

    expect(result.success).toBe(true);
    expect(result.message).toContain("1 reaction(s)");

    const postCall = mockFetchCalls.find((c) => c.url.includes("chat.postMessage"));
    expect(postCall).toBeDefined();
    const body = JSON.parse(postCall!.body);
    expect(body.text).toContain("1 reaction yesterday");
    expect(body.text).toContain("<@U_HUMAN>");
    expect(body.text).not.toContain("<@U_BOT>");
  });

  it("does nothing when FEEDBACK_DIGEST_USER is not set", async () => {
    const envWithoutUser = { ...mockEnv, FEEDBACK_DIGEST_USER: undefined };

    const result = await sendDailyFeedbackDigest(envWithoutUser);

    expect(result.success).toBe(true);
    expect(result.message).toContain("not set");
    expect(mockFetchCalls.length).toBe(0);
  });
});
