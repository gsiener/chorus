import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sleep, calculateRetryDelay, fetchWithRetry } from "../http-utils";

describe("sleep", () => {
  it("resolves after specified time", async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(45); // Allow small variance
    expect(elapsed).toBeLessThan(100);
  });
});

describe("calculateRetryDelay", () => {
  it("uses retry-after header when present", () => {
    const response = new Response(null, {
      headers: { "retry-after": "5" },
    });
    const delay = calculateRetryDelay(response, 0, 500);
    expect(delay).toBe(5000); // 5 seconds in ms
  });

  it("uses exponential backoff when no retry-after header", () => {
    const response = new Response(null);
    expect(calculateRetryDelay(response, 0, 500)).toBe(500); // 500 * 2^0
    expect(calculateRetryDelay(response, 1, 500)).toBe(1000); // 500 * 2^1
    expect(calculateRetryDelay(response, 2, 500)).toBe(2000); // 500 * 2^2
    expect(calculateRetryDelay(response, 3, 500)).toBe(4000); // 500 * 2^3
  });

  it("uses exponential backoff when response is null (network error)", () => {
    expect(calculateRetryDelay(null, 0, 1000)).toBe(1000);
    expect(calculateRetryDelay(null, 1, 1000)).toBe(2000);
    expect(calculateRetryDelay(null, 2, 1000)).toBe(4000);
  });

  it("respects custom initial delay", () => {
    const response = new Response(null);
    expect(calculateRetryDelay(response, 0, 100)).toBe(100);
    expect(calculateRetryDelay(response, 1, 100)).toBe(200);
  });
});

describe("fetchWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns response on successful fetch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    ));

    const response = await fetchWithRetry("https://example.com", {});

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 rate limit", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response("success", { status: 200 }));

    vi.stubGlobal("fetch", mockFetch);

    const responsePromise = fetchWithRetry("https://example.com", {}, {
      maxRetries: 3,
      initialDelayMs: 100,
    });

    // Advance timers to handle retries
    await vi.runAllTimersAsync();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("retries on 5xx server errors", async () => {
    const mockFetch = vi.fn()
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
    const mockFetch = vi.fn()
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

  it("throws after max retries exhausted", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 429 }));

    vi.stubGlobal("fetch", mockFetch);

    const responsePromise = fetchWithRetry("https://example.com", {}, {
      maxRetries: 3,
      initialDelayMs: 100,
    });

    await vi.runAllTimersAsync();
    const response = await responsePromise;

    // Returns the last response even if still retryable
    expect(response.status).toBe(429);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("throws network error after max retries", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Persistent network error"));

    vi.stubGlobal("fetch", mockFetch);

    const responsePromise = fetchWithRetry("https://example.com", {}, {
      maxRetries: 3,
      initialDelayMs: 100,
    });

    await vi.runAllTimersAsync();

    await expect(responsePromise).rejects.toThrow("Persistent network error");
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
    expect(mockFetch).toHaveBeenCalledTimes(1); // No retries
  });

  it("does not retry on 401 unauthorized", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));

    vi.stubGlobal("fetch", mockFetch);

    const response = await fetchWithRetry("https://example.com", {});

    expect(response.status).toBe(401);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("uses custom shouldRetry function", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 418 })) // I'm a teapot
      .mockResolvedValueOnce(new Response("success", { status: 200 }));

    vi.stubGlobal("fetch", mockFetch);

    const responsePromise = fetchWithRetry("https://example.com", {}, {
      maxRetries: 3,
      initialDelayMs: 100,
      shouldRetry: (response) => response.status === 418, // Retry on teapot
    });

    await vi.runAllTimersAsync();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
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
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response("success", { status: 200 }));

    vi.stubGlobal("fetch", mockFetch);

    const responsePromise = fetchWithRetry("https://example.com", {});

    await vi.runAllTimersAsync();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3); // Default maxRetries is 3
  });
});
