/**
 * GenAI OTel Histogram Metrics for Chorus
 *
 * Implements spec-compliant OTel histogram metrics for GenAI operations:
 * - gen_ai.client.operation.duration (seconds)
 * - gen_ai.client.token.usage (tokens)
 * - gen_ai.client.time_to_first_token (seconds)
 *
 * Uses a manual-flush pattern compatible with Cloudflare Workers (no timers).
 * Metrics are exported via OTLP JSON to Honeycomb's /v1/metrics endpoint.
 *
 * @see https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/gen-ai-metrics.md
 */

import {
  MeterProvider,
  MetricReader,
  AggregationType,
  AggregationTemporality,
  InstrumentType,
} from "@opentelemetry/sdk-metrics";
import type {
  PushMetricExporter,
  ResourceMetrics,
  CollectionResult,
} from "@opentelemetry/sdk-metrics";
import { ExportResultCode } from "@opentelemetry/core";
import type { ExportResult } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { JsonMetricsSerializer } from "@opentelemetry/otlp-transformer";
import type { Histogram, Attributes } from "@opentelemetry/api";

// ============================================================================
// Honeycomb Metric Exporter
// ============================================================================

/**
 * Custom PushMetricExporter that serializes via OTLP JSON and POSTs to Honeycomb.
 */
export class HoneycombMetricExporter implements PushMetricExporter {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private isShutdown = false;

  constructor(apiKey: string, dataset = "chorus") {
    this.url = "https://api.honeycomb.io/v1/metrics";
    this.headers = {
      "Content-Type": "application/json",
      "x-honeycomb-team": apiKey,
      "x-honeycomb-dataset": dataset,
    };
  }

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    if (this.isShutdown) {
      resultCallback({ code: ExportResultCode.FAILED });
      return;
    }

    const serialized = JsonMetricsSerializer.serializeRequest(metrics);
    if (!serialized) {
      resultCallback({ code: ExportResultCode.FAILED });
      return;
    }

    fetch(this.url, {
      method: "POST",
      headers: this.headers,
      body: serialized,
    })
      .then((response) => {
        if (response.ok) {
          resultCallback({ code: ExportResultCode.SUCCESS });
        } else {
          console.error(`Honeycomb metrics export failed: ${response.status}`);
          resultCallback({ code: ExportResultCode.FAILED });
        }
      })
      .catch((error) => {
        console.error("Honeycomb metrics export error:", error);
        resultCallback({ code: ExportResultCode.FAILED });
      });
  }

  selectAggregationTemporality(_instrumentType: InstrumentType): AggregationTemporality {
    // Honeycomb prefers DELTA temporality for metrics
    return AggregationTemporality.DELTA;
  }

  async forceFlush(): Promise<void> {
    // No buffering — each export is immediate
  }

  async shutdown(): Promise<void> {
    this.isShutdown = true;
  }
}

// ============================================================================
// Manual Flush Metric Reader (CF Workers compatible — no timers)
// ============================================================================

/**
 * MetricReader that only exports on explicit forceFlush() calls.
 * Cloudflare Workers don't support setInterval, so we trigger flush
 * manually from ctx.waitUntil() at the end of each request.
 */
export class ManualFlushMetricReader extends MetricReader {
  private readonly _exporter: PushMetricExporter;

  constructor(exporter: PushMetricExporter) {
    super({
      aggregationTemporalitySelector: (instrumentType: InstrumentType) =>
        exporter.selectAggregationTemporality?.(instrumentType) ?? AggregationTemporality.CUMULATIVE,
    });
    this._exporter = exporter;
  }

  protected async onForceFlush(): Promise<void> {
    const result: CollectionResult = await this.collect();
    await new Promise<void>((resolve, reject) => {
      this._exporter.export(result.resourceMetrics, (exportResult) => {
        if (exportResult.code === ExportResultCode.SUCCESS) {
          resolve();
        } else {
          reject(new Error("Metric export failed"));
        }
      });
    });
  }

  protected async onShutdown(): Promise<void> {
    await this._exporter.shutdown();
  }
}

// ============================================================================
// Histogram Bucket Boundaries (per GenAI metrics spec)
// ============================================================================

/** Duration buckets in seconds: 10ms to ~82s (exponential) */
const DURATION_BOUNDARIES = [0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92];

/** Token count buckets: 1 to ~67M (exponential) */
const TOKEN_BOUNDARIES = [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864];

/** TTFT buckets in seconds: 1ms to 10s (exponential) */
const TTFT_BOUNDARIES = [0.001, 0.005, 0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.0];

// ============================================================================
// Module-level State (same pattern as _pendingGenAiInput in telemetry.ts)
// ============================================================================

interface GenAiMetricsState {
  meterProvider: MeterProvider;
  operationDuration: Histogram;
  tokenUsage: Histogram;
  timeToFirstToken: Histogram;
}

let _currentMetrics: GenAiMetricsState | null = null;

export function setCurrentMetrics(metrics: GenAiMetricsState | null): void {
  _currentMetrics = metrics;
}

export function getCurrentMetrics(): GenAiMetricsState | null {
  return _currentMetrics;
}

// ============================================================================
// Initialization / Lifecycle
// ============================================================================

/**
 * Initialize GenAI metrics infrastructure for the current request.
 * Creates a MeterProvider with histogram instruments and Honeycomb exporter.
 */
export function initGenAiMetrics(env: { HONEYCOMB_API_KEY: string }): void {
  const exporter = new HoneycombMetricExporter(env.HONEYCOMB_API_KEY);
  const reader = new ManualFlushMetricReader(exporter);

  const meterProvider = new MeterProvider({
    resource: resourceFromAttributes({ "service.name": "chorus" }),
    readers: [reader],
    views: [
      {
        instrumentName: "gen_ai.client.operation.duration",
        instrumentType: InstrumentType.HISTOGRAM,
        aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: DURATION_BOUNDARIES } },
      },
      {
        instrumentName: "gen_ai.client.token.usage",
        instrumentType: InstrumentType.HISTOGRAM,
        aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: TOKEN_BOUNDARIES } },
      },
      {
        instrumentName: "gen_ai.client.time_to_first_token",
        instrumentType: InstrumentType.HISTOGRAM,
        aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: TTFT_BOUNDARIES } },
      },
    ],
  });

  const meter = meterProvider.getMeter("chorus-genai", "1.0.0");

  const operationDuration = meter.createHistogram("gen_ai.client.operation.duration", {
    description: "GenAI operation duration",
    unit: "s",
  });

  const tokenUsage = meter.createHistogram("gen_ai.client.token.usage", {
    description: "Measures number of input and output tokens used",
    unit: "{token}",
  });

  const timeToFirstToken = meter.createHistogram("gen_ai.client.time_to_first_token", {
    description: "Time to first token (client-observed)",
    unit: "s",
  });

  setCurrentMetrics({ meterProvider, operationDuration, tokenUsage, timeToFirstToken });
}

/**
 * Flush all recorded metrics to Honeycomb. Call from ctx.waitUntil().
 */
export async function flushGenAiMetrics(): Promise<void> {
  const metrics = getCurrentMetrics();
  if (!metrics) return;
  try {
    await metrics.meterProvider.forceFlush();
  } catch (error) {
    console.error("Failed to flush GenAI metrics:", error);
  }
}

/**
 * Tear down metrics state. Call in finally block.
 */
export function clearGenAiMetrics(): void {
  setCurrentMetrics(null);
}

// ============================================================================
// Recording Helpers
// ============================================================================

/** Common attributes for all GenAI metric recordings */
export interface GenAiMetricAttributes {
  "gen_ai.operation.name": string;
  "gen_ai.request.model": string;
  "gen_ai.response.model"?: string;
  "gen_ai.provider.name"?: string;
  "server.address"?: string;
  "error.type"?: string;
}

/**
 * Record a gen_ai.client.operation.duration histogram data point.
 * @param durationSeconds - operation duration in seconds
 * @param attrs - spec-required attributes
 */
export function recordOperationDuration(durationSeconds: number, attrs: GenAiMetricAttributes): void {
  const metrics = getCurrentMetrics();
  if (!metrics) return;
  metrics.operationDuration.record(durationSeconds, attrs as unknown as Attributes);
}

/**
 * Record a gen_ai.client.token.usage histogram data point.
 * @param tokenCount - number of tokens
 * @param tokenType - "input" or "output"
 * @param attrs - spec-required attributes
 */
export function recordTokenUsage(
  tokenCount: number,
  tokenType: "input" | "output",
  attrs: GenAiMetricAttributes
): void {
  const metrics = getCurrentMetrics();
  if (!metrics) return;
  metrics.tokenUsage.record(tokenCount, {
    ...attrs,
    "gen_ai.token.type": tokenType,
  } as unknown as Attributes);
}

/**
 * Record a gen_ai.client.time_to_first_token histogram data point.
 * @param ttftSeconds - time to first token in seconds
 * @param attrs - spec-required attributes
 */
export function recordTimeToFirstToken(ttftSeconds: number, attrs: GenAiMetricAttributes): void {
  const metrics = getCurrentMetrics();
  if (!metrics) return;
  metrics.timeToFirstToken.record(ttftSeconds, attrs as unknown as Attributes);
}
