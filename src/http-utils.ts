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

export type FetchError = NetworkError | RateLimitError | ServerError | HttpError;

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  shouldRetry?: (response: Response) => boolean;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INITIAL_DELAY_MS = 500;

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with retry and exponential backoff
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retryOptions: RetryOptions = {}
): Promise<Response> {
  const { maxRetries = DEFAULT_MAX_RETRIES, initialDelayMs = DEFAULT_INITIAL_DELAY_MS } =
    retryOptions;

  let lastError: Error | null = null;
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      // Success - return immediately
      if (response.ok) {
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
      // Network error - save and retry
      lastError = error instanceof Error ? error : new Error(String(error));

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
