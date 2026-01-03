import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Effect, Exit, Cause } from "effect";

// These imports will fail initially - that's expected (RED phase)
import {
  fetchEffect,
  NetworkError,
  RateLimitError,
  ServerError,
  HttpError,
} from "../http-utils-effect";

describe("http-utils-effect", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe("fetchEffect", () => {
    it("returns response on successful fetch", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ success: true }), { status: 200 })
        )
      );

      const effect = fetchEffect("https://example.com", {});
      const result = await Effect.runPromise(effect);

      expect(result.status).toBe(200);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("retries on 429 rate limit and succeeds", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 429 }))
        .mockResolvedValueOnce(new Response(null, { status: 429 }))
        .mockResolvedValueOnce(new Response("success", { status: 200 }));

      vi.stubGlobal("fetch", mockFetch);

      const effect = fetchEffect(
        "https://example.com",
        {},
        { maxRetries: 3, initialDelayMs: 100 }
      );

      const resultPromise = Effect.runPromise(effect);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("retries on 5xx server errors and succeeds", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 500 }))
        .mockResolvedValueOnce(new Response(null, { status: 503 }))
        .mockResolvedValueOnce(new Response("success", { status: 200 }));

      vi.stubGlobal("fetch", mockFetch);

      const effect = fetchEffect(
        "https://example.com",
        {},
        { maxRetries: 3, initialDelayMs: 100 }
      );

      const resultPromise = Effect.runPromise(effect);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("retries on network errors and succeeds", async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(new Error("Network error"))
        .mockRejectedValueOnce(new Error("Connection reset"))
        .mockResolvedValueOnce(new Response("success", { status: 200 }));

      vi.stubGlobal("fetch", mockFetch);

      const effect = fetchEffect(
        "https://example.com",
        {},
        { maxRetries: 3, initialDelayMs: 100 }
      );

      const resultPromise = Effect.runPromise(effect);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("fails with RateLimitError after max retries on 429", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 429 }));

      vi.stubGlobal("fetch", mockFetch);

      const effect = fetchEffect(
        "https://example.com",
        {},
        { maxRetries: 3, initialDelayMs: 100 }
      );

      const exitPromise = Effect.runPromiseExit(effect);
      await vi.runAllTimersAsync();
      const exit = await exitPromise;

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.failureOption(exit.cause);
        expect(error._tag).toBe("Some");
        if (error._tag === "Some") {
          expect(error.value).toBeInstanceOf(RateLimitError);
        }
      }
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("fails with ServerError after max retries on 5xx", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 500 }));

      vi.stubGlobal("fetch", mockFetch);

      const effect = fetchEffect(
        "https://example.com",
        {},
        { maxRetries: 3, initialDelayMs: 100 }
      );

      const exitPromise = Effect.runPromiseExit(effect);
      await vi.runAllTimersAsync();
      const exit = await exitPromise;

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.failureOption(exit.cause);
        expect(error._tag).toBe("Some");
        if (error._tag === "Some") {
          expect(error.value).toBeInstanceOf(ServerError);
          expect((error.value as ServerError).status).toBe(500);
        }
      }
    });

    it("fails with NetworkError after max retries on network failure", async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValue(new Error("Persistent network error"));

      vi.stubGlobal("fetch", mockFetch);

      const effect = fetchEffect(
        "https://example.com",
        {},
        { maxRetries: 3, initialDelayMs: 100 }
      );

      const exitPromise = Effect.runPromiseExit(effect);
      await vi.runAllTimersAsync();
      const exit = await exitPromise;

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.failureOption(exit.cause);
        expect(error._tag).toBe("Some");
        if (error._tag === "Some") {
          expect(error.value).toBeInstanceOf(NetworkError);
          expect((error.value as NetworkError).message).toContain(
            "Persistent network error"
          );
        }
      }
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("does not retry on 4xx client errors (except 429)", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 400 }));

      vi.stubGlobal("fetch", mockFetch);

      const effect = fetchEffect(
        "https://example.com",
        {},
        { maxRetries: 3, initialDelayMs: 100 }
      );

      const exit = await Effect.runPromiseExit(effect);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.failureOption(exit.cause);
        expect(error._tag).toBe("Some");
        if (error._tag === "Some") {
          expect(error.value).toBeInstanceOf(HttpError);
          expect((error.value as HttpError).status).toBe(400);
        }
      }
      expect(mockFetch).toHaveBeenCalledTimes(1); // No retries
    });

    it("does not retry on 401 unauthorized", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 401 }));

      vi.stubGlobal("fetch", mockFetch);

      const effect = fetchEffect("https://example.com", {});

      const exit = await Effect.runPromiseExit(effect);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("passes request options to fetch", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", mockFetch);

      const effect = fetchEffect("https://example.com/api", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test: true }),
      });

      await Effect.runPromise(effect);

      expect(mockFetch).toHaveBeenCalledWith("https://example.com/api", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test: true }),
      });
    });

    it("respects retry-after header", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(null, {
            status: 429,
            headers: { "retry-after": "2" },
          })
        )
        .mockResolvedValueOnce(new Response("success", { status: 200 }));

      vi.stubGlobal("fetch", mockFetch);

      const effect = fetchEffect(
        "https://example.com",
        {},
        { maxRetries: 3, initialDelayMs: 100 }
      );

      const resultPromise = Effect.runPromise(effect);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("typed errors", () => {
    it("NetworkError contains original error message", () => {
      const error = new NetworkError("Connection refused");
      expect(error.message).toBe("Connection refused");
      expect(error._tag).toBe("NetworkError");
    });

    it("RateLimitError contains retry-after if available", () => {
      const error = new RateLimitError(5000);
      expect(error._tag).toBe("RateLimitError");
      expect(error.retryAfterMs).toBe(5000);
    });

    it("ServerError contains status code", () => {
      const error = new ServerError(503, "Service Unavailable");
      expect(error._tag).toBe("ServerError");
      expect(error.status).toBe(503);
      expect(error.message).toBe("Service Unavailable");
    });

    it("HttpError contains status for non-retryable errors", () => {
      const error = new HttpError(400, "Bad Request");
      expect(error._tag).toBe("HttpError");
      expect(error.status).toBe(400);
    });
  });
});
