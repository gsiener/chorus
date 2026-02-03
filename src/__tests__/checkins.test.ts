import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  sendWeeklyCheckins,
  getLastCheckIn,
  listUserCheckIns,
  formatCheckInHistory,
  type CheckInRecord,
} from "../checkins";
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

  it("stores check-in history when sending", async () => {
    mockKvStore["initiatives:index"] = JSON.stringify({
      initiatives: [
        {
          id: "test-initiative",
          name: "Test Initiative",
          owner: "U123",
          status: "active",
          hasMetrics: false,
          hasPrd: true,
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
    expect(history[0].missingPrd).toBe(0); // hasPrd is true
    expect(history[0].missingMetrics).toBe(1); // hasMetrics is false
    expect(history[0].sentAt).toBeDefined();
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
        { sentAt: "2024-01-15T10:00:00Z", initiativeCount: 2, missingPrd: 1, missingMetrics: 0 },
        { sentAt: "2024-01-08T10:00:00Z", initiativeCount: 1, missingPrd: 1, missingMetrics: 1 },
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
        { sentAt: "2024-01-15T10:00:00Z", initiativeCount: 2, missingPrd: 1, missingMetrics: 0 },
        { sentAt: "2024-01-08T10:00:00Z", initiativeCount: 1, missingPrd: 1, missingMetrics: 1 },
        { sentAt: "2024-01-01T10:00:00Z", initiativeCount: 1, missingPrd: 0, missingMetrics: 1 },
      ];
      mockKvStore["checkin:history:U123"] = JSON.stringify(history);

      const result = await listUserCheckIns("U123", mockEnv);

      expect(result.length).toBe(3);
    });

    it("respects limit parameter", async () => {
      const history: CheckInRecord[] = [
        { sentAt: "2024-01-15T10:00:00Z", initiativeCount: 2, missingPrd: 1, missingMetrics: 0 },
        { sentAt: "2024-01-08T10:00:00Z", initiativeCount: 1, missingPrd: 1, missingMetrics: 1 },
        { sentAt: "2024-01-01T10:00:00Z", initiativeCount: 1, missingPrd: 0, missingMetrics: 1 },
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
        { sentAt: "2024-01-15T10:00:00Z", initiativeCount: 1, missingPrd: 0, missingMetrics: 0 },
      ];

      const result = formatCheckInHistory(history);

      expect(result).toContain("1 record");
      expect(result).toContain("1 initiative");
    });

    it("shows gaps in check-ins", () => {
      const history: CheckInRecord[] = [
        { sentAt: "2024-01-15T10:00:00Z", initiativeCount: 3, missingPrd: 2, missingMetrics: 1 },
      ];

      const result = formatCheckInHistory(history);

      expect(result).toContain("2 missing PRD");
      expect(result).toContain("1 missing metrics");
    });

    it("formats multiple check-ins", () => {
      const history: CheckInRecord[] = [
        { sentAt: "2024-01-15T10:00:00Z", initiativeCount: 3, missingPrd: 1, missingMetrics: 0 },
        { sentAt: "2024-01-08T10:00:00Z", initiativeCount: 2, missingPrd: 2, missingMetrics: 1 },
      ];

      const result = formatCheckInHistory(history);

      expect(result).toContain("2 records");
      expect(result).toContain("3 initiatives");
      expect(result).toContain("2 initiatives");
    });
  });
});
