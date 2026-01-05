import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchWithRetry,
  NetworkError,
  RateLimitError,
  ServerError,
  HttpError,
} from "../http-utils";

describe("fetchWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns response on successful fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      )
    );

    const response = await fetchWithRetry("https://example.com", {});

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 rate limit", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response("success", { status: 200 }));

    vi.stubGlobal("fetch", mockFetch);

    const responsePromise = fetchWithRetry("https://example.com", {}, {
      maxRetries: 3,
      initialDelayMs: 100,
    });

    await vi.runAllTimersAsync();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("retries on 5xx server errors", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response("success", { status: 200 }));

    vi.stubGlobal("fetch", mockFetch);

    const responsePromise = fetchWithRetry("https://example.com", {}, {
      maxRetries: 3,
      initialDelayMs: 100,
    });

    await vi.runAllTimersAsync();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("retries on network errors", async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network error"))
      .mockRejectedValueOnce(new Error("Connection reset"))
      .mockResolvedValueOnce(new Response("success", { status: 200 }));

    vi.stubGlobal("fetch", mockFetch);

    const responsePromise = fetchWithRetry("https://example.com", {}, {
      maxRetries: 3,
      initialDelayMs: 100,
    });

    await vi.runAllTimersAsync();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("returns 429 response after max retries exhausted", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 429 }));

    vi.stubGlobal("fetch", mockFetch);

    const responsePromise = fetchWithRetry("https://example.com", {}, {
      maxRetries: 3,
      initialDelayMs: 100,
    });

    await vi.runAllTimersAsync();
    const response = await responsePromise;

    expect(response.status).toBe(429);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("throws network error after max retries", async () => {
    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.reject(new Error("Persistent network error"))
    );

    vi.stubGlobal("fetch", mockFetch);

    const responsePromise = fetchWithRetry("https://example.com", {}, {
      maxRetries: 3,
      initialDelayMs: 100,
    });

    await vi.runAllTimersAsync();

    let error: Error | null = null;
    try {
      await responsePromise;
    } catch (e) {
      error = e as Error;
    }

    expect(error).not.toBeNull();
    expect(error?.message).toBe("Persistent network error");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry on 4xx client errors (except 429)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 400 }));

    vi.stubGlobal("fetch", mockFetch);

    const response = await fetchWithRetry("https://example.com", {}, {
      maxRetries: 3,
      initialDelayMs: 100,
    });

    expect(response.status).toBe(400);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 401 unauthorized", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));

    vi.stubGlobal("fetch", mockFetch);

    const response = await fetchWithRetry("https://example.com", {});

    expect(response.status).toBe(401);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("passes request options to fetch", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);

    await fetchWithRetry("https://example.com/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test: true }),
    });

    expect(mockFetch).toHaveBeenCalledWith("https://example.com/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test: true }),
    });
  });

  it("uses default retry options when not specified", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response("success", { status: 200 }));

    vi.stubGlobal("fetch", mockFetch);

    const responsePromise = fetchWithRetry("https://example.com", {});

    await vi.runAllTimersAsync();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3);
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
  });

  it("HttpError contains status for non-retryable errors", () => {
    const error = new HttpError(400, "Bad Request");
    expect(error._tag).toBe("HttpError");
    expect(error.status).toBe(400);
  });
});
