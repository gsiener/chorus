/**
 * Effect-based HTTP utilities with typed errors and retry logic
 */

import { Effect, Schedule, Duration, pipe } from "effect";

// Typed error classes with _tag for Effect pattern matching

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
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INITIAL_DELAY_MS = 500;

/**
 * Determine if an error is retryable
 */
function isRetryable(error: FetchError): boolean {
  return (
    error._tag === "NetworkError" ||
    error._tag === "RateLimitError" ||
    error._tag === "ServerError"
  );
}

/**
 * Convert a Response to a typed error
 */
function responseToError(response: Response): FetchError {
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    const retryAfterMs = retryAfter ? parseInt(retryAfter) * 1000 : undefined;
    return new RateLimitError(retryAfterMs);
  }

  if (response.status >= 500) {
    return new ServerError(response.status, response.statusText || `Server error ${response.status}`);
  }

  return new HttpError(response.status, response.statusText || `HTTP error ${response.status}`);
}

/**
 * Single fetch attempt that returns typed errors
 */
function fetchOnce(
  url: string,
  options: RequestInit
): Effect.Effect<Response, FetchError> {
  return Effect.tryPromise({
    try: () => fetch(url, options),
    catch: (error) =>
      new NetworkError(error instanceof Error ? error.message : String(error)),
  }).pipe(
    Effect.flatMap((response) => {
      if (response.ok) {
        return Effect.succeed(response);
      }
      return Effect.fail(responseToError(response));
    })
  );
}

/**
 * Effect-based fetch with retry and exponential backoff
 *
 * Returns typed errors:
 * - NetworkError: Network failures (DNS, connection, etc.)
 * - RateLimitError: 429 responses
 * - ServerError: 5xx responses
 * - HttpError: Other non-2xx responses (not retried)
 */
export function fetchEffect(
  url: string,
  options: RequestInit,
  retryOptions: RetryOptions = {}
): Effect.Effect<Response, FetchError> {
  const { maxRetries = DEFAULT_MAX_RETRIES, initialDelayMs = DEFAULT_INITIAL_DELAY_MS } =
    retryOptions;

  // Build retry schedule with exponential backoff
  const schedule = pipe(
    Schedule.exponential(Duration.millis(initialDelayMs)),
    Schedule.intersect(Schedule.recurs(maxRetries - 1))
  );

  return pipe(
    fetchOnce(url, options),
    Effect.retry(
      pipe(
        schedule,
        Schedule.whileInput((error: FetchError) => isRetryable(error))
      )
    )
  );
}
