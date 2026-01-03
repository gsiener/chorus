import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import { trace, SpanStatusCode } from "@opentelemetry/api";

// These imports will fail initially - expected (RED phase)
import {
  TracingService,
  withSpan,
  recordAttribute,
  recordError as recordEffectError,
} from "../effect-telemetry";

describe("effect-telemetry", () => {
  let mockSpan: {
    setAttribute: ReturnType<typeof vi.fn>;
    setAttributes: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
    recordException: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };

  let mockTracer: {
    startSpan: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockSpan = {
      setAttribute: vi.fn(),
      setAttributes: vi.fn(),
      setStatus: vi.fn(),
      recordException: vi.fn(),
      end: vi.fn(),
    };

    mockTracer = {
      startSpan: vi.fn().mockReturnValue(mockSpan),
    };

    vi.spyOn(trace, "getTracer").mockReturnValue(mockTracer as any);
    vi.spyOn(trace, "getActiveSpan").mockReturnValue(mockSpan as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const TestTracingLayer = Layer.succeed(TracingService, {
    serviceName: "test-service",
  });

  describe("withSpan", () => {
    it("creates a span around an effect", async () => {
      const effect = withSpan("test-operation", Effect.succeed("result"));

      const result = await Effect.runPromise(
        Effect.provide(effect, TestTracingLayer)
      );

      expect(result).toBe("result");
      expect(mockTracer.startSpan).toHaveBeenCalledWith("test-operation", undefined);
      expect(mockSpan.end).toHaveBeenCalled();
    });

    it("passes span options to tracer", async () => {
      const effect = withSpan(
        "test-operation",
        Effect.succeed("result"),
        { attributes: { "test.attr": "value" } }
      );

      await Effect.runPromise(Effect.provide(effect, TestTracingLayer));

      expect(mockTracer.startSpan).toHaveBeenCalledWith("test-operation", {
        attributes: { "test.attr": "value" },
      });
    });

    it("ends span on success", async () => {
      const effect = withSpan("success-op", Effect.succeed(42));

      await Effect.runPromise(Effect.provide(effect, TestTracingLayer));

      expect(mockSpan.end).toHaveBeenCalled();
      expect(mockSpan.setStatus).not.toHaveBeenCalled();
    });

    it("records error and ends span on failure", async () => {
      const testError = new Error("test failure");
      const effect = withSpan("fail-op", Effect.fail(testError));

      const exit = await Effect.runPromiseExit(
        Effect.provide(effect, TestTracingLayer)
      );

      expect(exit._tag).toBe("Failure");
      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: "test failure",
      });
      expect(mockSpan.recordException).toHaveBeenCalledWith(testError);
      expect(mockSpan.end).toHaveBeenCalled();
    });
  });

  describe("recordAttribute", () => {
    it("sets attribute on active span", async () => {
      const effect = recordAttribute("my.attribute", "my-value");

      await Effect.runPromise(effect);

      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        "my.attribute",
        "my-value"
      );
    });

    it("handles numeric attributes", async () => {
      const effect = recordAttribute("my.count", 42);

      await Effect.runPromise(effect);

      expect(mockSpan.setAttribute).toHaveBeenCalledWith("my.count", 42);
    });

    it("handles boolean attributes", async () => {
      const effect = recordAttribute("my.flag", true);

      await Effect.runPromise(effect);

      expect(mockSpan.setAttribute).toHaveBeenCalledWith("my.flag", true);
    });

    it("does nothing when no active span", async () => {
      vi.spyOn(trace, "getActiveSpan").mockReturnValue(undefined);

      const effect = recordAttribute("my.attribute", "value");

      // Should not throw
      await Effect.runPromise(effect);
    });
  });

  describe("recordError", () => {
    it("records error on active span", async () => {
      const testError = new Error("something went wrong");
      const effect = recordEffectError(testError);

      await Effect.runPromise(effect);

      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: "something went wrong",
      });
      expect(mockSpan.recordException).toHaveBeenCalledWith(testError);
    });

    it("includes context when provided", async () => {
      const testError = new Error("failed");
      const effect = recordEffectError(testError, "during API call");

      await Effect.runPromise(effect);

      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        "error.context",
        "during API call"
      );
    });

    it("does nothing when no active span", async () => {
      vi.spyOn(trace, "getActiveSpan").mockReturnValue(undefined);

      const effect = recordEffectError(new Error("ignored"));

      // Should not throw
      await Effect.runPromise(effect);
    });
  });

  describe("TracingService", () => {
    it("provides service name for tracer", async () => {
      const CustomLayer = Layer.succeed(TracingService, {
        serviceName: "custom-service",
      });

      const effect = withSpan("op", Effect.succeed("ok"));

      await Effect.runPromise(Effect.provide(effect, CustomLayer));

      expect(trace.getTracer).toHaveBeenCalledWith("custom-service");
    });
  });
});
