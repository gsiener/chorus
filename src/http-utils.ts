/**
 * HTTP utilities with typed errors and retry logic using Effect
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
  shouldRetry?: (response: Response) => boolean;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INITIAL_DELAY_MS = 500;

function isRetryable(error: FetchError): boolean {
  return (
    error._tag === "NetworkError" ||
    error._tag === "RateLimitError" ||
    error._tag === "ServerError"
  );
}

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
 */
export function fetchEffect(
  url: string,
  options: RequestInit,
  retryOptions: RetryOptions = {}
): Effect.Effect<Response, FetchError> {
  const { maxRetries = DEFAULT_MAX_RETRIES, initialDelayMs = DEFAULT_INITIAL_DELAY_MS } =
    retryOptions;

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

/**
 * Promise-based fetch with retry (runs the Effect internally)
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retryOptions: RetryOptions = {}
): Promise<Response> {
  const effect = fetchEffect(url, options, retryOptions);

  // Run the effect, converting Effect errors back to returned responses
  // (to match original behavior where non-ok responses are returned, not thrown)
  return Effect.runPromise(
    effect.pipe(
      Effect.catchAll((error) => {
        // For HttpError (4xx), we want to return the response, not throw
        // But we don't have the original response... so we throw for now
        // This matches the original behavior for network/server errors
        if (error._tag === "NetworkError") {
          return Effect.die(new Error(error.message));
        }
        // For rate limit and server errors that exhausted retries,
        // return a synthetic response to match original behavior
        if (error._tag === "RateLimitError") {
          return Effect.succeed(new Response(null, { status: 429 }));
        }
        if (error._tag === "ServerError") {
          return Effect.succeed(new Response(null, { status: error.status }));
        }
        if (error._tag === "HttpError") {
          return Effect.succeed(new Response(null, { status: error.status }));
        }
        return Effect.die(error);
      })
    )
  );
}
