import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { convertThreadToMessages, generateResponse } from "../claude";
import type { Env, SlackMessage } from "../types";

describe("convertThreadToMessages", () => {
  const botUserId = "U_BOT_123";

  it("converts user messages correctly", () => {
    const messages: SlackMessage[] = [
      { user: "U123", text: "<@U_BOT_123> what is the roadmap?", ts: "1234.5678" },
    ];

    const result = convertThreadToMessages(messages, botUserId);

    expect(result).toEqual([
      { role: "user", content: "what is the roadmap?" },
    ]);
  });

  it("converts bot messages to assistant role", () => {
    const messages: SlackMessage[] = [
      { user: "U123", text: "<@U_BOT_123> hello", ts: "1234.5678" },
      { user: "U_BOT_123", text: "Hi there! How can I help?", ts: "1234.5679", bot_id: "B123" },
    ];

    const result = convertThreadToMessages(messages, botUserId);

    expect(result).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "Hi there! How can I help?" },
    ]);
  });

  it("removes multiple bot mentions", () => {
    const messages: SlackMessage[] = [
      { user: "U123", text: "<@U_BOT_123> hey <@U_BOT_123> what's up?", ts: "1234.5678" },
    ];

    const result = convertThreadToMessages(messages, botUserId);

    expect(result).toEqual([
      { role: "user", content: "hey  what's up?" },
    ]);
  });

  it("filters out empty messages", () => {
    const messages: SlackMessage[] = [
      { user: "U123", text: "<@U_BOT_123>", ts: "1234.5678" },
      { user: "U123", text: "<@U_BOT_123> actual question", ts: "1234.5679" },
    ];

    const result = convertThreadToMessages(messages, botUserId);

    expect(result).toEqual([
      { role: "user", content: "actual question" },
    ]);
  });

  it("handles messages with no bot mention", () => {
    const messages: SlackMessage[] = [
      { user: "U123", text: "follow up question", ts: "1234.5678" },
    ];

    const result = convertThreadToMessages(messages, botUserId);

    expect(result).toEqual([
      { role: "user", content: "follow up question" },
    ]);
  });
});

describe("generateResponse", () => {
  const mockEnv: Env = {
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_SIGNING_SECRET: "test-secret",
    ANTHROPIC_API_KEY: "sk-ant-test-key",
    HONEYCOMB_API_KEY: "test-honeycomb-key",
    DOCS_KV: { get: vi.fn().mockResolvedValue(null), put: vi.fn() } as unknown as KVNamespace,
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns Claude response text on success", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({
        content: [{ type: "text", text: "Here is the roadmap information..." }],
      }))
    );

    const messages = [{ role: "user" as const, content: "What is the roadmap?" }];
    const result = await generateResponse(messages, mockEnv);

    expect(result).toBe("Here is the roadmap information...");
    expect(fetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "sk-ant-test-key",
          "anthropic-version": "2023-06-01",
        },
      })
    );
  });

  it("throws error on API failure", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("Rate limited", { status: 429 })
    );

    const messages = [{ role: "user" as const, content: "What is the roadmap?" }];

    await expect(generateResponse(messages, mockEnv)).rejects.toThrow("Claude API error: 429");
  });

  it("returns fallback message when response has no content", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ content: [] }))
    );

    const messages = [{ role: "user" as const, content: "What is the roadmap?" }];
    const result = await generateResponse(messages, mockEnv);

    expect(result).toBe("Sorry, I couldn't generate a response.");
  });
});
