import { trace, SpanStatusCode, Span } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import type { Env } from './types';

class Telemetry {
  private tracer;
  private provider: BasicTracerProvider;

  constructor(env: Env) {
    // Initialize OpenTelemetry provider
    const resource = Resource.default().merge(
      new Resource({
        [ATTR_SERVICE_NAME]: 'chorus',
        [ATTR_SERVICE_VERSION]: '0.2.0',
        environment: env.ENVIRONMENT,
      })
    );

    this.provider = new BasicTracerProvider({ resource });

    // Configure Honeycomb exporter
    const exporter = new OTLPTraceExporter({
      url: 'https://api.honeycomb.io/v1/traces',
      headers: {
        'x-honeycomb-team': env.HONEYCOMB_API_KEY,
        'x-honeycomb-dataset': env.HONEYCOMB_DATASET,
      },
    });

    this.provider.addSpanProcessor(new BatchSpanProcessor(exporter));
    this.provider.register();

    this.tracer = trace.getTracer('chorus', '0.2.0');
  }

  /**
   * Start a new span and execute a function within it
   */
  async span<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    attributes?: Record<string, string | number | boolean>
  ): Promise<T> {
    return this.tracer.startActiveSpan(name, { attributes }, async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Add attributes to the current span
   */
  addAttributes(attributes: Record<string, string | number | boolean>) {
    const span = trace.getActiveSpan();
    if (span) {
      Object.entries(attributes).forEach(([key, value]) => {
        span.setAttribute(key, value);
      });
    }
  }

  /**
   * Record an event on the current span
   */
  addEvent(name: string, attributes?: Record<string, string | number | boolean>) {
    const span = trace.getActiveSpan();
    if (span) {
      span.addEvent(name, attributes);
    }
  }

  /**
   * Shut down the provider (call on worker cleanup)
   */
  async shutdown() {
    await this.provider.shutdown();
  }
}

// Helper to create telemetry instance
export function createTelemetry(env: Env): Telemetry {
  return new Telemetry(env);
}

export type { Telemetry };
