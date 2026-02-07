import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchAllMetrics,
  formatMetricsForSlack,
  formatMetricsForClaude,
  getAmplitudeContext,
  clearAmplitudeCache,
  getAmplitudeMetrics,
  getWeekRanges,
  type AmplitudeMetrics,
} from "../amplitude";
import type { Env } from "../types";

// Mock data that matches Amplitude API response shapes
const mockSegmentationResponse = (values: number[]) => ({
  ok: true,
  json: () =>
    Promise.resolve({
      data: {
        series: [values],
        seriesLabels: values.map((_, i) => i),
      },
    }),
});

const mockRetentionResponse = (percents: number[]) => ({
  ok: true,
  json: () =>
    Promise.resolve({
      data: {
        combined: { retentionPercents: percents },
      },
    }),
});

const mockGroupedSegmentationResponse = (
  teams: Record<string, number>,
) => ({
  ok: true,
  json: () =>
    Promise.resolve({
      data: {
        series: [
          Object.fromEntries(
            Object.entries(teams).map(([slug, value]) => [
              slug,
              { value },
            ]),
          ),
        ],
        seriesLabels: [0],
      },
    }),
});

describe("Amplitude Integration", () => {
  const mockKvStore: Record<string, string> = {};

  const mockEnv: Env = {
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_SIGNING_SECRET: "test-signing-secret",
    ANTHROPIC_API_KEY: "sk-ant-test-key",
    HONEYCOMB_API_KEY: "test-honeycomb-key",
    AMPLITUDE_API_KEY: "test-amp-key",
    AMPLITUDE_API_SECRET: "test-amp-secret",
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

  describe("getWeekRanges", () => {
    it("returns date ranges in YYYYMMDD format", () => {
      const ranges = getWeekRanges();
      expect(ranges.currentStart).toMatch(/^\d{8}$/);
      expect(ranges.currentEnd).toMatch(/^\d{8}$/);
      expect(ranges.previousStart).toMatch(/^\d{8}$/);
      expect(ranges.previousEnd).toMatch(/^\d{8}$/);
    });

    it("current week ends before previous week starts", () => {
      const ranges = getWeekRanges();
      expect(ranges.previousEnd < ranges.currentStart).toBe(true);
    });
  });

  describe("getAmplitudeContext", () => {
    it("returns null when credentials are not configured", async () => {
      const envWithoutKey = { ...mockEnv, AMPLITUDE_API_KEY: undefined };
      const result = await getAmplitudeContext(envWithoutKey);
      expect(result).toBeNull();
    });

    it("returns cached context when available", async () => {
      const cachedData: AmplitudeMetrics = {
        metrics: [
          {
            name: "Monthly Active Teams",
            category: "Engagement",
            currentValue: 487,
            previousValue: 472,
            changePercent: 3.2,
            unit: "teams",
          },
        ],
        growingAccounts: [],
        fetchedAt: new Date().toISOString(),
        weekStart: "20260126",
        weekEnd: "20260201",
      };
      mockKvStore["amplitude:metrics:weekly"] = JSON.stringify(cachedData);

      const result = await getAmplitudeContext(mockEnv);

      expect(result).toContain("Monthly Active Teams");
      expect(result).toContain("487");
      // Should NOT have called fetch since we got cache hit
      expect(vi.mocked(mockEnv.DOCS_KV.get)).toHaveBeenCalledWith(
        "amplitude:metrics:weekly",
      );
    });

    it("handles API errors gracefully", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          text: () => Promise.resolve("Internal Server Error"),
        }),
      );

      const result = await getAmplitudeContext(mockEnv);
      expect(result).toBeNull();
    });
  });

  describe("clearAmplitudeCache", () => {
    it("deletes the cache key from KV", async () => {
      mockKvStore["amplitude:metrics:weekly"] = "cached data";
      await clearAmplitudeCache(mockEnv);
      expect(vi.mocked(mockEnv.DOCS_KV.delete)).toHaveBeenCalledWith(
        "amplitude:metrics:weekly",
      );
    });
  });

  describe("getAmplitudeMetrics", () => {
    it("returns null when credentials are not configured", async () => {
      const envWithoutKey = { ...mockEnv, AMPLITUDE_API_KEY: undefined };
      const result = await getAmplitudeMetrics(envWithoutKey);
      expect(result).toBeNull();
    });

    it("returns cached metrics when available", async () => {
      const cachedData: AmplitudeMetrics = {
        metrics: [],
        growingAccounts: [],
        fetchedAt: new Date().toISOString(),
        weekStart: "20260126",
        weekEnd: "20260201",
      };
      mockKvStore["amplitude:metrics:weekly"] = JSON.stringify(cachedData);

      const result = await getAmplitudeMetrics(mockEnv);
      expect(result).toEqual(cachedData);
    });
  });

  describe("formatMetricsForSlack", () => {
    const sampleData: AmplitudeMetrics = {
      metrics: [
        {
          name: "Monthly Active Teams",
          category: "Engagement",
          currentValue: 487,
          previousValue: 472,
          changePercent: 3.2,
          unit: "teams",
        },
        {
          name: "DAU/MAU (Enterprise)",
          category: "Engagement",
          currentValue: 31.2,
          previousValue: 31.1,
          changePercent: 0.3,
          unit: "%",
        },
        {
          name: "Canvas & MCP Users",
          category: "Feature Adoption",
          currentValue: 312,
          previousValue: 263,
          changePercent: 18.6,
          unit: "users",
        },
      ],
      growingAccounts: [
        {
          teamSlug: "nubank",
          currentUsers: 180,
          previousUsers: 142,
          changePercent: 26.8,
        },
        {
          teamSlug: "stripe",
          currentUsers: 238,
          previousUsers: 198,
          changePercent: 20.2,
        },
      ],
      fetchedAt: new Date().toISOString(),
      weekStart: "20260126",
      weekEnd: "20260201",
    };

    it("formats metrics with colored spark bars", () => {
      const result = formatMetricsForSlack(sampleData);

      expect(result).toContain(":bar_chart:");
      expect(result).toContain("*Weekly Product Metrics*");
      expect(result).toContain("*Monthly Active Teams:* 487");
      expect(result).toContain("↑ 3.2% WoW");
      // No colored circles at start of lines
      expect(result).not.toContain(":large_green_circle:");
      expect(result).not.toContain(":red_circle:");
      expect(result).not.toContain(":white_circle:");
    });

    it("uses white bars for steady metrics", () => {
      const result = formatMetricsForSlack(sampleData);

      // DAU/MAU has 0.3% change -> steady -> white bars
      expect(result).toContain("*DAU/MAU (Enterprise):* 31.2%");
      expect(result).toContain("→ 0.3% WoW");
      expect(result).toContain(":white_large_square:");
    });

    it("uses green bars for positive and red for negative trends", () => {
      const result = formatMetricsForSlack(sampleData);

      // Canvas & MCP Users has 18.6% -> green bars
      expect(result).toContain(":large_green_square:");
    });

    it("groups metrics by category with emojis", () => {
      const result = formatMetricsForSlack(sampleData);

      expect(result).toContain(":busts_in_silhouette: *Engagement*");
      expect(result).toContain(":sparkles: *Feature Adoption*");
    });

    it("includes growing accounts with medals", () => {
      const result = formatMetricsForSlack(sampleData);

      expect(result).toContain(":fire: *Top Growing Accounts*");
      expect(result).toContain(":first_place_medal:");
      expect(result).toContain("*nubank*");
      expect(result).toContain("+26.8%");
      expect(result).toContain("142 → 180 users");
    });

    it("omits growing accounts section when empty", () => {
      const dataNoGrowth = { ...sampleData, growingAccounts: [] };
      const result = formatMetricsForSlack(dataNoGrowth);

      expect(result).not.toContain("Top Growing Accounts");
    });
  });

  describe("formatMetricsForClaude", () => {
    const sampleData: AmplitudeMetrics = {
      metrics: [
        {
          name: "Monthly Active Teams",
          category: "Engagement",
          currentValue: 487,
          previousValue: 472,
          changePercent: 3.2,
          unit: "teams",
        },
      ],
      growingAccounts: [
        {
          teamSlug: "nubank",
          currentUsers: 180,
          previousUsers: 142,
          changePercent: 26.8,
        },
      ],
      fetchedAt: new Date().toISOString(),
      weekStart: "20260126",
      weekEnd: "20260201",
    };

    it("formats as plain text for system prompt", () => {
      const result = formatMetricsForClaude(sampleData);

      expect(result).toContain("Product metrics for the week of");
      expect(result).toContain("Monthly Active Teams: 487");
      expect(result).toContain("↑ 3.2% week-over-week");
    });

    it("includes growing accounts", () => {
      const result = formatMetricsForClaude(sampleData);

      expect(result).toContain("Fastest growing accounts");
      expect(result).toContain("nubank: +26.8%");
    });
  });

  describe("fetchAllMetrics", () => {
    it("fetches all metrics and returns structured data", async () => {
      // Mock all the Amplitude API calls
      // fetchAllMetrics makes many parallel fetch calls, we return mock data for each
      let callCount = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string) => {
          callCount++;
          if (typeof url === "string" && url.includes("/retention")) {
            return Promise.resolve(mockRetentionResponse([100, 42, 35, 28]));
          }
          // For growing accounts (grouped by team_slug)
          if (typeof url === "string" && url.includes("team_slug")) {
            return Promise.resolve(
              mockGroupedSegmentationResponse({
                nubank: 180,
                stripe: 238,
                slack: 150,
              }),
            );
          }
          // Default segmentation response
          return Promise.resolve(mockSegmentationResponse([100, 120, 115, 130]));
        }),
      );

      const result = await fetchAllMetrics(mockEnv);

      expect(result.metrics).toHaveLength(9);
      expect(result.metrics[0].name).toBe("Monthly Active Teams");
      expect(result.fetchedAt).toBeDefined();
      expect(result.weekStart).toMatch(/^\d{8}$/);
      expect(result.weekEnd).toMatch(/^\d{8}$/);
    });

    it("handles API errors by throwing", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          text: () => Promise.resolve("Unauthorized"),
        }),
      );

      await expect(fetchAllMetrics(mockEnv)).rejects.toThrow(
        "Amplitude API error: 401",
      );
    });
  });
});
