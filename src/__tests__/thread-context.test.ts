import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getThreadContext,
  saveThreadContext,
  processMessagesForContext,
  updateThreadContext,
} from "../thread-context";
import type { Env, ThreadContext, ClaudeMessage } from "../types";

describe("Thread Context", () => {
  let mockKvStore: Record<string, string>;
  let mockEnv: Env;

  beforeEach(() => {
    mockKvStore = {};
    mockEnv = {
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_SIGNING_SECRET: "test-secret",
      ANTHROPIC_API_KEY: "test-key",
      HONEYCOMB_API_KEY: "test-honeycomb",
      DOCS_KV: {
        get: vi.fn((key: string) => Promise.resolve(mockKvStore[key] || null)),
        put: vi.fn((key: string, value: string) => {
          mockKvStore[key] = value;
          return Promise.resolve();
        }),
      } as unknown as KVNamespace,
      VECTORIZE: {} as VectorizeIndex,
      AI: {} as Ai,
    };
  });

  describe("getThreadContext", () => {
    it("returns null when no context exists", async () => {
      const result = await getThreadContext("C123", "1234.5678", mockEnv);
      expect(result).toBeNull();
    });

    it("returns stored context", async () => {
      const context: ThreadContext = {
        threadTs: "1234.5678",
        channel: "C123",
        summary: "Test summary",
        keyTopics: ["topic1", "topic2"],
        initiativesMentioned: [],
        messageCount: 5,
        lastUpdatedAt: "2024-01-01T00:00:00Z",
      };
      mockKvStore["thread:context:C123:1234.5678"] = JSON.stringify(context);

      const result = await getThreadContext("C123", "1234.5678", mockEnv);
      expect(result).toEqual(context);
    });
  });

  describe("saveThreadContext", () => {
    it("stores context in KV", async () => {
      const context: ThreadContext = {
        threadTs: "1234.5678",
        channel: "C123",
        summary: "Test summary",
        keyTopics: [],
        initiativesMentioned: [],
        messageCount: 3,
        lastUpdatedAt: "2024-01-01T00:00:00Z",
      };

      await saveThreadContext(context, mockEnv);

      expect(mockKvStore["thread:context:C123:1234.5678"]).toBeDefined();
      expect(JSON.parse(mockKvStore["thread:context:C123:1234.5678"])).toEqual(context);
    });
  });

  describe("processMessagesForContext", () => {
    it("returns all messages when thread is short", () => {
      const messages: ClaudeMessage[] = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
        { role: "user", content: "How are you?" },
      ];

      const { messages: processed, contextPrefix } = processMessagesForContext(messages, null);

      expect(processed).toEqual(messages);
      expect(contextPrefix).toBeNull();
    });

    it("summarizes and truncates when thread is long", () => {
      const messages: ClaudeMessage[] = [];
      for (let i = 0; i < 10; i++) {
        messages.push({ role: "user", content: `Question ${i}` });
        messages.push({ role: "assistant", content: `Answer ${i}` });
      }

      const { messages: processed, contextPrefix } = processMessagesForContext(messages, null);

      // Should keep only recent messages
      expect(processed.length).toBeLessThan(messages.length);
      // Should have context prefix
      expect(contextPrefix).not.toBeNull();
      expect(contextPrefix).toContain("Previous Conversation Context");
    });

    it("uses existing context summary when available", () => {
      const messages: ClaudeMessage[] = [];
      for (let i = 0; i < 12; i++) {
        messages.push({ role: "user", content: `Question ${i}` });
        messages.push({ role: "assistant", content: `Answer ${i}` });
      }

      const existingContext: ThreadContext = {
        threadTs: "1234",
        channel: "C123",
        summary: "Existing summary from previous context",
        keyTopics: ["existing topic"],
        initiativesMentioned: [],
        messageCount: 20,
        lastUpdatedAt: "2024-01-01",
      };

      const { contextPrefix } = processMessagesForContext(messages, existingContext);

      expect(contextPrefix).toContain("Existing summary from previous context");
    });
  });

  describe("updateThreadContext", () => {
    it("creates new context for new thread", async () => {
      const messages: ClaudeMessage[] = [
        { role: "user", content: 'What about the "Product Launch" initiative?' },
        { role: "assistant", content: "The Product Launch is going well." },
      ];

      await updateThreadContext("C123", "1234.5678", messages, ["product-launch"], mockEnv);

      const stored = mockKvStore["thread:context:C123:1234.5678"];
      expect(stored).toBeDefined();

      const context = JSON.parse(stored) as ThreadContext;
      expect(context.channel).toBe("C123");
      expect(context.threadTs).toBe("1234.5678");
      expect(context.messageCount).toBe(2);
      expect(context.initiativesMentioned).toContain("product-launch");
      expect(context.keyTopics).toContain("Product Launch");
    });

    it("merges with existing context", async () => {
      const existingContext: ThreadContext = {
        threadTs: "1234.5678",
        channel: "C123",
        keyTopics: ["old topic"],
        initiativesMentioned: ["old-initiative"],
        messageCount: 3,
        lastUpdatedAt: "2024-01-01",
      };
      mockKvStore["thread:context:C123:1234.5678"] = JSON.stringify(existingContext);

      const messages: ClaudeMessage[] = [
        { role: "user", content: 'What about "New Topic"?' },
        { role: "assistant", content: "Let me explain." },
      ];

      await updateThreadContext("C123", "1234.5678", messages, ["new-initiative"], mockEnv);

      const stored = JSON.parse(mockKvStore["thread:context:C123:1234.5678"]) as ThreadContext;
      expect(stored.initiativesMentioned).toContain("old-initiative");
      expect(stored.initiativesMentioned).toContain("new-initiative");
      expect(stored.keyTopics).toContain("old topic");
      expect(stored.keyTopics).toContain("New Topic");
    });
  });
});
