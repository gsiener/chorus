import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendWeeklyCheckins } from "../checkins";
import type { Env } from "../types";

describe("Weekly Check-ins", () => {
  const mockKvStore: Record<string, string> = {};

  const mockEnv: Env = {
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_SIGNING_SECRET: "test-signing-secret",
    ANTHROPIC_API_KEY: "sk-ant-test-key",
    HONEYCOMB_API_KEY: "test-honeycomb-key",
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
    VECTORIZE: {} as unknown as VectorizeIndex,
    AI: {} as unknown as Ai,
  };

  beforeEach(() => {
    Object.keys(mockKvStore).forEach((key) => delete mockKvStore[key]);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns success with no initiatives", async () => {
    const result = await sendWeeklyCheckins(mockEnv);

    expect(result.success).toBe(true);
    expect(result.sentTo).toBe(0);
  });

  it("sends check-in to initiative owners", async () => {
    // Set up mock initiatives
    mockKvStore["initiatives:index"] = JSON.stringify({
      initiatives: [
        {
          id: "test-initiative",
          name: "Test Initiative",
          owner: "U123",
          status: "active",
          hasMetrics: false,
          hasPrd: false,
          updatedAt: "2024-01-01",
        },
      ],
    });

    mockKvStore["initiatives:detail:test-initiative"] = JSON.stringify({
      id: "test-initiative",
      name: "Test Initiative",
      description: "A test initiative",
      owner: "U123",
      status: { value: "active", updatedAt: "2024-01-01", updatedBy: "test" },
      expectedMetrics: [],
      createdAt: "2024-01-01",
      createdBy: "test",
      updatedAt: "2024-01-01",
    });

    // Mock Slack API calls
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, channel: { id: "D123" }, ts: "1234.5678" }),
    }));

    const result = await sendWeeklyCheckins(mockEnv);

    expect(result.success).toBe(true);
    expect(result.sentTo).toBe(1);
    expect(mockKvStore["checkin:last:U123"]).toBeDefined();
  });

  it("skips completed and cancelled initiatives", async () => {
    mockKvStore["initiatives:index"] = JSON.stringify({
      initiatives: [
        {
          id: "completed-init",
          name: "Completed Initiative",
          owner: "U123",
          status: "completed",
          hasMetrics: true,
          hasPrd: true,
          updatedAt: "2024-01-01",
        },
        {
          id: "cancelled-init",
          name: "Cancelled Initiative",
          owner: "U456",
          status: "cancelled",
          hasMetrics: false,
          hasPrd: false,
          updatedAt: "2024-01-01",
        },
      ],
    });

    const result = await sendWeeklyCheckins(mockEnv);

    expect(result.success).toBe(true);
    expect(result.sentTo).toBe(0);
  });

  it("rate limits check-ins per user", async () => {
    mockKvStore["initiatives:index"] = JSON.stringify({
      initiatives: [
        {
          id: "test-init",
          name: "Test Initiative",
          owner: "U123",
          status: "active",
          hasMetrics: true,
          hasPrd: true,
          updatedAt: "2024-01-01",
        },
      ],
    });

    // Set a recent check-in timestamp (within 6 days)
    mockKvStore["checkin:last:U123"] = (Date.now() - 1000 * 60 * 60 * 24 * 2).toString(); // 2 days ago

    const result = await sendWeeklyCheckins(mockEnv);

    expect(result.success).toBe(true);
    expect(result.sentTo).toBe(0); // Should skip due to rate limiting
  });

  it("sends test message when test user has no initiatives", async () => {
    const testEnv = {
      ...mockEnv,
      TEST_CHECKIN_USER: "U_TEST_USER",
    };

    // No initiatives in the system
    mockKvStore["initiatives:index"] = JSON.stringify({ initiatives: [] });

    // Mock Slack API calls
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, channel: { id: "D123" }, ts: "1234.5678" }),
    }));

    const result = await sendWeeklyCheckins(testEnv);

    expect(result.success).toBe(true);
    expect(result.sentTo).toBe(1);
    expect(result.message).toBe("Sent test check-in (no initiatives).");
    expect(mockKvStore["checkin:last:U_TEST_USER"]).toBeDefined();
  });

  it("sends real check-in when test user owns initiatives", async () => {
    const testEnv = {
      ...mockEnv,
      TEST_CHECKIN_USER: "U_TEST_USER",
    };

    // Test user owns an initiative
    mockKvStore["initiatives:index"] = JSON.stringify({
      initiatives: [
        {
          id: "test-init",
          name: "Test Initiative",
          owner: "U_TEST_USER",
          status: "active",
          hasMetrics: false,
          hasPrd: false,
          updatedAt: "2024-01-01",
        },
      ],
    });

    mockKvStore["initiatives:detail:test-init"] = JSON.stringify({
      id: "test-init",
      name: "Test Initiative",
      description: "A test initiative",
      owner: "U_TEST_USER",
      status: { value: "active", updatedAt: "2024-01-01", updatedBy: "test" },
      expectedMetrics: [],
      createdAt: "2024-01-01",
      createdBy: "test",
      updatedAt: "2024-01-01",
    });

    // Mock Slack API calls
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, channel: { id: "D123" }, ts: "1234.5678" }),
    }));

    const result = await sendWeeklyCheckins(testEnv);

    expect(result.success).toBe(true);
    expect(result.sentTo).toBe(1);
    // Should NOT say "no initiatives" - should be a real check-in
    expect(result.message).not.toContain("no initiatives");
  });
});
