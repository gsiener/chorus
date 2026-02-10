import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  MeterProvider,
  InMemoryMetricExporter,
  AggregationTemporality,
  DataPointType,
  InstrumentType,
} from "@opentelemetry/sdk-metrics";
import type { ResourceMetrics, HistogramMetricData } from "@opentelemetry/sdk-metrics";
import type { Histogram } from "@opentelemetry/sdk-metrics";
import {
  HoneycombMetricExporter,
  ManualFlushMetricReader,
  initGenAiMetrics,
  flushGenAiMetrics,
  clearGenAiMetrics,
  getCurrentMetrics,
  setCurrentMetrics,
  recordOperationDuration,
  recordTokenUsage,
  recordTimeToFirstToken,
} from "../genai-metrics";

describe("genai-metrics", () => {
  afterEach(() => {
    clearGenAiMetrics();
    vi.restoreAllMocks();
  });

  describe("ManualFlushMetricReader", () => {
    it("collects and exports on forceFlush without timers", async () => {
      const exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
      const reader = new ManualFlushMetricReader(exporter);

      const meterProvider = new MeterProvider({
        readers: [reader],
      });

      const meter = meterProvider.getMeter("test");
      const histogram = meter.createHistogram("test.histogram");
      histogram.record(42);

      // Before flush — no metrics exported
      expect(exporter.getMetrics()).toHaveLength(0);

      // After flush — metrics exported
      await meterProvider.forceFlush();
      const metrics = exporter.getMetrics();
      expect(metrics.length).toBeGreaterThan(0);

      const scopeMetrics = metrics[0].scopeMetrics;
      expect(scopeMetrics.length).toBeGreaterThan(0);

      const metricData = scopeMetrics[0].metrics;
      expect(metricData.length).toBeGreaterThan(0);
      expect(metricData[0].descriptor.name).toBe("test.histogram");

      await meterProvider.shutdown();
    });
  });

  describe("HoneycombMetricExporter", () => {
    it("POSTs serialized metrics to Honeycomb /v1/metrics", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("", { status: 200 })
      );

      const exporter = new HoneycombMetricExporter("test-api-key", "test-dataset");
      const reader = new ManualFlushMetricReader(exporter);
      const meterProvider = new MeterProvider({ readers: [reader] });

      const meter = meterProvider.getMeter("test");
      const histogram = meter.createHistogram("test.metric");
      histogram.record(1.5);

      await meterProvider.forceFlush();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://api.honeycomb.io/v1/metrics");
      expect((options as RequestInit).method).toBe("POST");
      expect((options as RequestInit).headers).toEqual(
        expect.objectContaining({
          "x-honeycomb-team": "test-api-key",
          "x-honeycomb-dataset": "test-dataset",
          "Content-Type": "application/json",
        })
      );
      // Body should be a Uint8Array (OTLP JSON serialized)
      expect((options as RequestInit).body).toBeInstanceOf(Uint8Array);

      await meterProvider.shutdown();
    });

    it("handles export failure gracefully", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));
      vi.spyOn(console, "error").mockImplementation(() => {});

      const exporter = new HoneycombMetricExporter("test-api-key");
      const reader = new ManualFlushMetricReader(exporter);
      const meterProvider = new MeterProvider({ readers: [reader] });

      const meter = meterProvider.getMeter("test");
      meter.createHistogram("test.metric").record(1);

      // Flush rejects because export failed
      await expect(meterProvider.forceFlush()).rejects.toThrow();
      await meterProvider.shutdown();
    });

    it("returns DELTA aggregation temporality", () => {
      const exporter = new HoneycombMetricExporter("key");
      expect(exporter.selectAggregationTemporality(InstrumentType.HISTOGRAM)).toBe(
        AggregationTemporality.DELTA
      );
    });
  });

  describe("initGenAiMetrics / clearGenAiMetrics lifecycle", () => {
    it("initializes and clears metrics state", () => {
      expect(getCurrentMetrics()).toBeNull();

      initGenAiMetrics({ HONEYCOMB_API_KEY: "test-key" });
      const state = getCurrentMetrics();
      expect(state).not.toBeNull();
      expect(state!.meterProvider).toBeInstanceOf(MeterProvider);
      expect(state!.operationDuration).toBeDefined();
      expect(state!.tokenUsage).toBeDefined();
      expect(state!.timeToFirstToken).toBeDefined();

      clearGenAiMetrics();
      expect(getCurrentMetrics()).toBeNull();
    });
  });

  describe("recording helpers", () => {
    let exporter: InMemoryMetricExporter;
    let meterProvider: MeterProvider;

    beforeEach(() => {
      exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
      const reader = new ManualFlushMetricReader(exporter);
      meterProvider = new MeterProvider({ readers: [reader] });

      const meter = meterProvider.getMeter("chorus-genai", "1.0.0");
      setCurrentMetrics({
        meterProvider,
        operationDuration: meter.createHistogram("gen_ai.client.operation.duration", { unit: "s" }),
        tokenUsage: meter.createHistogram("gen_ai.client.token.usage", { unit: "{token}" }),
        timeToFirstToken: meter.createHistogram("gen_ai.client.time_to_first_token", { unit: "s" }),
      });
    });

    afterEach(async () => {
      clearGenAiMetrics();
      await meterProvider.shutdown();
    });

    it("records operation duration with correct attributes", async () => {
      recordOperationDuration(2.5, {
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "claude-opus-4-5-20251101",
        "gen_ai.provider.name": "anthropic",
        "server.address": "api.anthropic.com",
      });

      await meterProvider.forceFlush();
      const metrics = exporter.getMetrics();
      const durationMetric = findHistogramMetric(metrics, "gen_ai.client.operation.duration");

      expect(durationMetric).toBeDefined();
      expect(durationMetric!.descriptor.unit).toBe("s");
      expect(durationMetric!.dataPointType).toBe(DataPointType.HISTOGRAM);

      const dp = durationMetric!.dataPoints[0];
      const value = dp.value as Histogram;
      expect(value.sum).toBe(2.5);
      expect(value.count).toBe(1);
      expect(dp.attributes["gen_ai.operation.name"]).toBe("chat");
      expect(dp.attributes["gen_ai.request.model"]).toBe("claude-opus-4-5-20251101");
    });

    it("records token usage with input and output separately", async () => {
      const attrs = {
        "gen_ai.operation.name": "chat" as const,
        "gen_ai.request.model": "claude-opus-4-5-20251101",
        "gen_ai.provider.name": "anthropic",
      };

      recordTokenUsage(1500, "input", attrs);
      recordTokenUsage(350, "output", attrs);

      await meterProvider.forceFlush();
      const metrics = exporter.getMetrics();
      const tokenMetric = findHistogramMetric(metrics, "gen_ai.client.token.usage");

      expect(tokenMetric).toBeDefined();
      expect(tokenMetric!.descriptor.unit).toBe("{token}");
      expect(tokenMetric!.dataPoints).toHaveLength(2);

      const inputDp = tokenMetric!.dataPoints.find(
        (dp) => dp.attributes["gen_ai.token.type"] === "input"
      );
      const outputDp = tokenMetric!.dataPoints.find(
        (dp) => dp.attributes["gen_ai.token.type"] === "output"
      );

      expect(inputDp).toBeDefined();
      expect((inputDp!.value as Histogram).sum).toBe(1500);
      expect(outputDp).toBeDefined();
      expect((outputDp!.value as Histogram).sum).toBe(350);
    });

    it("records TTFT for streaming path", async () => {
      recordTimeToFirstToken(0.245, {
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "claude-opus-4-5-20251101",
        "gen_ai.provider.name": "anthropic",
      });

      await meterProvider.forceFlush();
      const metrics = exporter.getMetrics();
      const ttftMetric = findHistogramMetric(metrics, "gen_ai.client.time_to_first_token");

      expect(ttftMetric).toBeDefined();
      expect(ttftMetric!.descriptor.unit).toBe("s");
      const dp = ttftMetric!.dataPoints[0];
      const value = dp.value as Histogram;
      expect(value.sum).toBeCloseTo(0.245, 3);
      expect(value.count).toBe(1);
    });

    it("records TTFT for non-streaming path (TTFT ≈ total)", async () => {
      const totalSeconds = 3.2;
      recordTimeToFirstToken(totalSeconds, {
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "claude-opus-4-5-20251101",
        "gen_ai.provider.name": "anthropic",
      });

      await meterProvider.forceFlush();
      const metrics = exporter.getMetrics();
      const ttftMetric = findHistogramMetric(metrics, "gen_ai.client.time_to_first_token");

      expect(ttftMetric).toBeDefined();
      expect((ttftMetric!.dataPoints[0].value as Histogram).sum).toBeCloseTo(3.2, 3);
    });

    it("records duration with error.type on failure", async () => {
      recordOperationDuration(1.0, {
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "claude-opus-4-5-20251101",
        "gen_ai.provider.name": "anthropic",
        "server.address": "api.anthropic.com",
        "error.type": "HTTP 429",
      });

      await meterProvider.forceFlush();
      const metrics = exporter.getMetrics();
      const durationMetric = findHistogramMetric(metrics, "gen_ai.client.operation.duration");

      expect(durationMetric).toBeDefined();
      const dp = durationMetric!.dataPoints[0];
      expect(dp.attributes["error.type"]).toBe("HTTP 429");
    });

    it("is a no-op when metrics are not initialized", () => {
      clearGenAiMetrics();

      // Should not throw
      recordOperationDuration(1.0, {
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "test",
      });
      recordTokenUsage(100, "input", {
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "test",
      });
      recordTimeToFirstToken(0.1, {
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "test",
      });
    });
  });

  describe("flushGenAiMetrics", () => {
    it("flushes without error when metrics are initialized", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));

      initGenAiMetrics({ HONEYCOMB_API_KEY: "test-key" });
      recordOperationDuration(1.0, {
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "test-model",
      });

      await expect(flushGenAiMetrics()).resolves.toBeUndefined();
    });

    it("is a no-op when metrics are not initialized", async () => {
      clearGenAiMetrics();
      await expect(flushGenAiMetrics()).resolves.toBeUndefined();
    });
  });
});

/**
 * Helper to find a histogram metric by name from ResourceMetrics[]
 */
function findHistogramMetric(
  allMetrics: ResourceMetrics[],
  name: string
): HistogramMetricData | undefined {
  for (const rm of allMetrics) {
    for (const sm of rm.scopeMetrics) {
      for (const metric of sm.metrics) {
        if (metric.descriptor.name === name && metric.dataPointType === DataPointType.HISTOGRAM) {
          return metric as HistogramMetricData;
        }
      }
    }
  }
  return undefined;
}
