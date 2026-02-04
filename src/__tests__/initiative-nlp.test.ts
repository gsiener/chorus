import { describe, it, expect, vi, beforeEach } from "vitest";
import { mightBeInitiativeCommand, processNaturalLanguageCommand } from "../initiative-nlp";
import type { Env } from "../types";

// Mock KV storage
function createMockKV() {
  const store = new Map<string, string>();
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    put: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    delete: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
    _store: store,
  };
}

function createMockEnv(kv = createMockKV()): Env {
  return {
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_SIGNING_SECRET: "test-secret",
    ANTHROPIC_API_KEY: "test-key",
    HONEYCOMB_API_KEY: "test-honeycomb-key",
    DOCS_KV: kv as unknown as KVNamespace,
    VECTORIZE: { query: vi.fn(), insert: vi.fn() } as unknown as VectorizeIndex,
    AI: { run: vi.fn() } as unknown as Ai,
  };
}

describe("mightBeInitiativeCommand", () => {
  // NOTE: NLP initiative commands are DISABLED (always returns false)
  // This ensures all initiative queries go to Claude, which uses R&D Priorities.
  // See initiative-nlp.ts for details.

  it("always returns false (NLP disabled for PDD-65)", () => {
    // Management commands now return false too
    expect(mightBeInitiativeCommand("mark the mobile app as active")).toBe(false);
    expect(mightBeInitiativeCommand("change status of dashboard to completed")).toBe(false);
    expect(mightBeInitiativeCommand("set status of Project X to paused")).toBe(false);
    expect(mightBeInitiativeCommand("add metric to Dashboard")).toBe(false);
    expect(mightBeInitiativeCommand("assign to @user")).toBe(false);
  });

  it("returns false for general questions about initiatives (PDD-65)", () => {
    // These should go to Claude, which has R&D priorities in context
    expect(mightBeInitiativeCommand("what are our initiatives")).toBe(false);
    expect(mightBeInitiativeCommand("list all initiatives")).toBe(false);
    expect(mightBeInitiativeCommand("show me the initiatives")).toBe(false);
    expect(mightBeInitiativeCommand("can you list all the initiatives")).toBe(false);
    expect(mightBeInitiativeCommand("tell me about the initiatives")).toBe(false);
  });

  it("returns false for unrelated messages", () => {
    expect(mightBeInitiativeCommand("what time is it")).toBe(false);
    expect(mightBeInitiativeCommand("hello there")).toBe(false);
    expect(mightBeInitiativeCommand("tell me a joke")).toBe(false);
  });
});

describe("processNaturalLanguageCommand", () => {
  let mockEnv: Env;

  beforeEach(() => {
    mockEnv = createMockEnv();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("returns null when Claude doesn't use a tool", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "I'm not sure what you mean." }],
        model: "claude-sonnet-4-20250514",
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    } as Response);

    const result = await processNaturalLanguageCommand("random question", "U123", mockEnv);
    expect(result).toBe("I'm not sure what you mean.");
  });

  it("executes list_initiatives tool", async () => {
    // First call - Claude with tool use
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "tool_1",
          name: "list_initiatives",
          input: {},
        }],
        model: "claude-sonnet-4-20250514",
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    } as Response);

    const result = await processNaturalLanguageCommand("show all initiatives", "U123", mockEnv);

    // Should return formatted list (empty since no initiatives in mock)
    expect(result).toContain("No initiatives found");
  });

  it("executes update_initiative_status tool", async () => {
    // Add an initiative first
    const kv = createMockKV();
    mockEnv.DOCS_KV = kv as unknown as KVNamespace;

    kv._store.set("initiatives:index", JSON.stringify({
      initiatives: [{
        id: "mobile-app",
        name: "Mobile App",
        owner: "U456",
        status: "proposed",
        hasMetrics: false,
        hasPrd: false,
        updatedAt: new Date().toISOString(),
      }],
    }));
    kv._store.set("initiatives:detail:mobile-app", JSON.stringify({
      id: "mobile-app",
      name: "Mobile App",
      description: "Build mobile app",
      owner: "U456",
      status: { value: "proposed", updatedAt: new Date().toISOString(), updatedBy: "U456" },
      expectedMetrics: [],
      createdAt: new Date().toISOString(),
      createdBy: "U456",
      updatedAt: new Date().toISOString(),
    }));

    // Mock Claude response with tool use
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "tool_1",
          name: "update_initiative_status",
          input: { name: "Mobile App", status: "active" },
        }],
        model: "claude-sonnet-4-20250514",
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    } as Response);

    const result = await processNaturalLanguageCommand("mark mobile app as active", "U123", mockEnv);

    expect(result).toContain("active");
  });

  it("handles API errors gracefully", async () => {
    // Mock all retries to fail
    vi.mocked(fetch).mockResolvedValue(
      new Response("Internal Server Error", {
        status: 500,
        statusText: "Internal Server Error",
      })
    );

    const result = await processNaturalLanguageCommand("list initiatives", "U123", mockEnv);
    expect(result).toBeNull();
  });
});
