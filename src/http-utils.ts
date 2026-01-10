/**
 * HTTP utilities with typed errors and retry logic
 */

// Typed error classes

export class NetworkError extends Error {
  readonly _tag = "NetworkError" as const;
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

export class RateLimitError extends Error {
  readonly _tag = "RateLimitError" as const;
  constructor(public readonly retryAfterMs?: number) {
    super(`Rate limited${retryAfterMs ? ` (retry after ${retryAfterMs}ms)` : ""}`);
    this.name = "RateLimitError";
  }
}

export class ServerError extends Error {
  readonly _tag = "ServerError" as const;
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ServerError";
  }
}

export class HttpError extends Error {
  readonly _tag = "HttpError" as const;
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class TimeoutError extends Error {
  readonly _tag = "TimeoutError" as const;
  constructor(public readonly timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

// Circuit breaker interface
export interface CircuitBreakerState {
  failures: number;
  lastFailureTime: number;
  isOpen: boolean;
}

export type FetchError = NetworkError | RateLimitError | ServerError | HttpError | TimeoutError;

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  timeoutMs?: number;
  shouldRetry?: (response: Response) => boolean;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INITIAL_DELAY_MS = 500;

// Circuit breaker configuration
const CIRCUIT_BREAKER_THRESHOLD = 5; // Open after 5 consecutive failures
const CIRCUIT_BREAKER_TIMEOUT_MS = 60000; // Close after 60 seconds
const circuitBreakers = new Map<string, CircuitBreakerState>();

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check circuit breaker state for a URL
 */
function checkCircuitBreaker(url: string): void {
  const state = circuitBreakers.get(url);

  if (!state) return;

  // If circuit is open and timeout hasn't elapsed, throw error
  if (state.isOpen && Date.now() - state.lastFailureTime < CIRCUIT_BREAKER_TIMEOUT_MS) {
    throw new Error(`Circuit breaker open for ${url}`);
  }

  // Reset circuit if timeout has elapsed
  if (state.isOpen && Date.now() - state.lastFailureTime >= CIRCUIT_BREAKER_TIMEOUT_MS) {
    state.isOpen = false;
    state.failures = 0;
    console.log(`Circuit breaker reset for ${url}`);
  }
}

/**
 * Update circuit breaker state after a failed request
 */
function updateCircuitBreakerOnFailure(url: string): void {
  let state = circuitBreakers.get(url);

  if (!state) {
    state = { failures: 0, lastFailureTime: 0, isOpen: false };
    circuitBreakers.set(url, state);
  }

  state.failures++;
  state.lastFailureTime = Date.now();

  // Open circuit if threshold reached
  if (state.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    state.isOpen = true;
    console.log(`Circuit breaker opened for ${url} after ${state.failures} failures`);
  }
}

/**
 * Update circuit breaker state after a successful request
 */
function updateCircuitBreakerOnSuccess(url: string): void {
  const state = circuitBreakers.get(url);

  if (!state) return;

  state.failures = 0;
  state.isOpen = false;
}

/**
 * Fetch with retry, exponential backoff, optional timeout, and circuit breaker
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retryOptions: RetryOptions = {}
): Promise<Response> {
  const { maxRetries = DEFAULT_MAX_RETRIES, initialDelayMs = DEFAULT_INITIAL_DELAY_MS, timeoutMs } =
    retryOptions;

  let lastError: Error | null = null;
  let lastResponse: Response | null = null;

  // Check circuit breaker before attempting request
  checkCircuitBreaker(url);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Create abort controller for timeout if specified
      const fetchOptions: RequestInit = { ...options };
      if (timeoutMs) {
        fetchOptions.signal = AbortSignal.timeout(timeoutMs);
      }

      const response = await fetch(url, fetchOptions);

      // Success - return immediately
      if (response.ok) {
        updateCircuitBreakerOnSuccess(url);
        return response;
      }

      // Non-retryable error - return immediately
      if (!isRetryableStatus(response.status)) {
        return response;
      }

      // Retryable error - save response and continue
      lastResponse = response;

      // Wait before retrying (exponential backoff)
      if (attempt < maxRetries - 1) {
        const delay = initialDelayMs * Math.pow(2, attempt);
        await sleep(delay);
      }
    } catch (error) {
      // Check if this is a timeout error
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new TimeoutError(timeoutMs!);
      }

      // Network error - save and retry
      lastError = error instanceof Error ? error : new Error(String(error));

      // Update circuit breaker on failure
      updateCircuitBreakerOnFailure(url);

      if (attempt < maxRetries - 1) {
        const delay = initialDelayMs * Math.pow(2, attempt);
        await sleep(delay);
      }
    }
  }

  // All retries exhausted
  if (lastError) {
    throw lastError;
  }

  // Return the last response (rate limit or server error)
  return lastResponse!;
}
