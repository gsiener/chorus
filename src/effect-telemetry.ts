/**
 * Effect-to-OpenTelemetry adapter for Cloudflare Workers
 *
 * Bridges Effect's functional style to the existing OTel tracing setup.
 * This avoids the @effect/opentelemetry package which requires Node.js-specific
 * OTel packages that conflict with Cloudflare Workers.
 */

import { Effect, Context, Layer } from "effect";
import { trace, SpanStatusCode, SpanOptions, Span } from "@opentelemetry/api";

// Service definition

export interface TracingServiceConfig {
  readonly serviceName: string;
}

export class TracingService extends Context.Tag("TracingService")<
  TracingService,
  TracingServiceConfig
>() {}

// Create a live layer
export const TracingServiceLive = (serviceName: string) =>
  Layer.succeed(TracingService, { serviceName });

/**
 * Wrap an Effect in an OTel span
 *
 * Creates a span, runs the effect, and ends the span.
 * Records errors on failure.
 */
export function withSpan<A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,
  options?: SpanOptions
): Effect.Effect<A, E, R | TracingService> {
  return Effect.flatMap(TracingService, ({ serviceName }) => {
    const tracer = trace.getTracer(serviceName);
    const span = tracer.startSpan(name, options);

    return effect.pipe(
      Effect.tap(() => {
        span.end();
      }),
      Effect.tapError((error) => {
        if (error instanceof Error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error.message,
          });
          span.recordException(error);
        }
        span.end();
        return Effect.void;
      }),
      Effect.tapDefect((cause) => {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: String(cause),
        });
        span.end();
        return Effect.void;
      })
    );
  });
}

/**
 * Record an attribute on the active span
 */
export function recordAttribute(
  key: string,
  value: string | number | boolean
): Effect.Effect<void> {
  return Effect.sync(() => {
    const span = trace.getActiveSpan();
    if (span) {
      span.setAttribute(key, value);
    }
  });
}

/**
 * Record multiple attributes on the active span
 */
export function recordAttributes(
  attributes: Record<string, string | number | boolean>
): Effect.Effect<void> {
  return Effect.sync(() => {
    const span = trace.getActiveSpan();
    if (span) {
      span.setAttributes(attributes);
    }
  });
}

/**
 * Record an error on the active span
 */
export function recordError(
  error: Error,
  context?: string
): Effect.Effect<void> {
  return Effect.sync(() => {
    const span = trace.getActiveSpan();
    if (!span) return;

    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error.message,
    });

    if (context) {
      span.setAttribute("error.context", context);
    }

    span.recordException(error);
  });
}

/**
 * Get the active span (for advanced use cases)
 */
export function getActiveSpan(): Effect.Effect<Span | undefined> {
  return Effect.sync(() => trace.getActiveSpan());
}
