import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  sendWeeklyCheckins,
  getLastCheckIn,
  listUserCheckIns,
  formatCheckInHistory,
  type CheckInRecord,
} from "../checkins";
import type { Env } from "../types";

// Mock linear-priorities module
vi.mock("../linear-priorities", () => ({
  fetchPriorityInitiatives: vi.fn(),
  resolveOwnerSlackIds: vi.fn(),
  extractPriorityMetadata: vi.fn(() => ({ techRisk: null, theme: null, slackChannel: null })),
}));

import {
  fetchPriorityInitiatives,
  resolveOwnerSlackIds,
  extractPriorityMetadata,
} from "../linear-priorities";

const mockFetchPriorities = vi.mocked(fetchPriorityInitiatives);
const mockResolveOwnerSlackIds = vi.mocked(resolveOwnerSlackIds);
const mockExtractMetadata = vi.mocked(extractPriorityMetadata);

function makeRelation(overrides: {
  name: string;
  status?: string;
  sortOrder?: number;
  ownerEmail?: string;
  ownerName?: string;
}) {
  return {
    sortOrder: overrides.sortOrder ?? 1,
    relatedInitiative: {
      id: `init-${overrides.name.toLowerCase().replace(/\s+/g, "-")}`,
      name: overrides.name,
      description: null,
      status: overrides.status ?? "Started",
      targetDate: null,
      url: `https://linear.app/test/${overrides.name}`,
      content: null,
      owner: overrides.ownerEmail
        ? { name: overrides.ownerName ?? "Test User", email: overrides.ownerEmail }
        : null,
      projects: { nodes: [] },
    },
  };
}

describe("Weekly Check-ins", () => {
  const mockKvStore: Record<string, string> = {};

  const mockEnv: Env = {
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_SIGNING_SECRET: "test-signing-secret",
    ANTHROPIC_API_KEY: "sk-ant-test-key",
    HONEYCOMB_API_KEY: "test-honeycomb-key",
    LINEAR_API_KEY: "lin-test-key",
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
    mockFetchPriorities.mockResolvedValue([]);
    mockResolveOwnerSlackIds.mockResolvedValue(new Map());
    mockExtractMetadata.mockReturnValue({ techRisk: null, theme: null, slackChannel: null });
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
    mockFetchPriorities.mockResolvedValue([
      makeRelation({
        name: "Test Initiative",
        status: "Started",
        sortOrder: 1,
        ownerEmail: "alice@example.com",
      }),
    ]);
    mockResolveOwnerSlackIds.mockResolvedValue(
      new Map([["alice@example.com", "U123"]])
    );

    // Mock Slack API calls (postDirectMessage uses fetch)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, channel: { id: "D123" }, ts: "1234.5678" }),
    }));

    const result = await sendWeeklyCheckins(mockEnv);

    expect(result.success).toBe(true);
    expect(result.sentTo).toBe(1);
    expect(mockKvStore["checkin:last:U123"]).toBeDefined();
  });

  it("skips owners whose email can't be resolved to Slack ID", async () => {
    mockFetchPriorities.mockResolvedValue([
      makeRelation({
        name: "Test Initiative",
        status: "Started",
        sortOrder: 1,
        ownerEmail: "unknown@example.com",
      }),
    ]);
    // Empty map — no email resolved
    mockResolveOwnerSlackIds.mockResolvedValue(new Map());

    const result = await sendWeeklyCheckins(mockEnv);

    expect(result.success).toBe(true);
    expect(result.sentTo).toBe(0);
  });

  it("rate limits check-ins per user", async () => {
    mockFetchPriorities.mockResolvedValue([
      makeRelation({
        name: "Test Initiative",
        status: "Started",
        sortOrder: 1,
        ownerEmail: "alice@example.com",
      }),
    ]);
    mockResolveOwnerSlackIds.mockResolvedValue(
      new Map([["alice@example.com", "U123"]])
    );

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

    mockFetchPriorities.mockResolvedValue([]);

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

    mockFetchPriorities.mockResolvedValue([
      makeRelation({
        name: "Important Priority",
        status: "Started",
        sortOrder: 1,
        ownerEmail: "testuser@example.com",
      }),
    ]);
    mockResolveOwnerSlackIds.mockResolvedValue(
      new Map([["testuser@example.com", "U_TEST_USER"]])
    );

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

  it("stores check-in history when sending", async () => {
    mockFetchPriorities.mockResolvedValue([
      makeRelation({
        name: "Test Priority",
        status: "Started",
        sortOrder: 1,
        ownerEmail: "alice@example.com",
      }),
    ]);
    mockResolveOwnerSlackIds.mockResolvedValue(
      new Map([["alice@example.com", "U123"]])
    );

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, channel: { id: "D123" }, ts: "1234.5678" }),
    }));

    await sendWeeklyCheckins(mockEnv);

    // Check that history was stored
    const historyData = mockKvStore["checkin:history:U123"];
    expect(historyData).toBeDefined();

    const history = JSON.parse(historyData) as CheckInRecord[];
    expect(history.length).toBe(1);
    expect(history[0].initiativeCount).toBe(1);
    expect(history[0].sentAt).toBeDefined();
  });

  it("groups multiple initiatives per owner", async () => {
    mockFetchPriorities.mockResolvedValue([
      makeRelation({
        name: "Priority A",
        status: "Started",
        sortOrder: 1,
        ownerEmail: "alice@example.com",
      }),
      makeRelation({
        name: "Priority B",
        status: "Planned",
        sortOrder: 5,
        ownerEmail: "alice@example.com",
      }),
    ]);
    mockResolveOwnerSlackIds.mockResolvedValue(
      new Map([["alice@example.com", "U123"]])
    );

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, channel: { id: "D123" }, ts: "1234.5678" }),
    }));

    await sendWeeklyCheckins(mockEnv);

    const historyData = mockKvStore["checkin:history:U123"];
    const history = JSON.parse(historyData) as CheckInRecord[];
    expect(history[0].initiativeCount).toBe(2);
  });
});

describe("Check-in History Queries", () => {
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

  describe("getLastCheckIn", () => {
    it("returns null when no history exists", async () => {
      const result = await getLastCheckIn("U123", mockEnv);
      expect(result).toBeNull();
    });

    it("returns the most recent check-in", async () => {
      const history: CheckInRecord[] = [
        { sentAt: "2024-01-15T10:00:00Z", initiativeCount: 2 },
        { sentAt: "2024-01-08T10:00:00Z", initiativeCount: 1 },
      ];
      mockKvStore["checkin:history:U123"] = JSON.stringify(history);

      const result = await getLastCheckIn("U123", mockEnv);

      expect(result).not.toBeNull();
      expect(result!.sentAt).toBe("2024-01-15T10:00:00Z");
      expect(result!.initiativeCount).toBe(2);
    });
  });

  describe("listUserCheckIns", () => {
    it("returns empty array when no history exists", async () => {
      const result = await listUserCheckIns("U123", mockEnv);
      expect(result).toEqual([]);
    });

    it("returns all check-ins", async () => {
      const history: CheckInRecord[] = [
        { sentAt: "2024-01-15T10:00:00Z", initiativeCount: 2 },
        { sentAt: "2024-01-08T10:00:00Z", initiativeCount: 1 },
        { sentAt: "2024-01-01T10:00:00Z", initiativeCount: 1 },
      ];
      mockKvStore["checkin:history:U123"] = JSON.stringify(history);

      const result = await listUserCheckIns("U123", mockEnv);

      expect(result.length).toBe(3);
    });

    it("respects limit parameter", async () => {
      const history: CheckInRecord[] = [
        { sentAt: "2024-01-15T10:00:00Z", initiativeCount: 2 },
        { sentAt: "2024-01-08T10:00:00Z", initiativeCount: 1 },
        { sentAt: "2024-01-01T10:00:00Z", initiativeCount: 1 },
      ];
      mockKvStore["checkin:history:U123"] = JSON.stringify(history);

      const result = await listUserCheckIns("U123", mockEnv, 2);

      expect(result.length).toBe(2);
      expect(result[0].sentAt).toBe("2024-01-15T10:00:00Z");
      expect(result[1].sentAt).toBe("2024-01-08T10:00:00Z");
    });
  });

  describe("formatCheckInHistory", () => {
    it("returns empty message when no history", () => {
      const result = formatCheckInHistory([]);
      expect(result).toContain("No check-in history found");
    });

    it("formats single check-in", () => {
      const history: CheckInRecord[] = [
        { sentAt: "2024-01-15T10:00:00Z", initiativeCount: 1 },
      ];

      const result = formatCheckInHistory(history);

      expect(result).toContain("1 record");
      expect(result).toContain("1 priority");
    });

    it("formats multiple check-ins", () => {
      const history: CheckInRecord[] = [
        { sentAt: "2024-01-15T10:00:00Z", initiativeCount: 3 },
        { sentAt: "2024-01-08T10:00:00Z", initiativeCount: 2 },
      ];

      const result = formatCheckInHistory(history);

      expect(result).toContain("2 records");
      expect(result).toContain("3 priorities");
      expect(result).toContain("2 priorities");
    });
  });
});
