/**
 * Shared HTTP utilities for retry logic with exponential backoff
 */

// Default retry configuration
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INITIAL_DELAY_MS = 500;

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  /** Custom function to determine if response should be retried */
  shouldRetry?: (response: Response) => boolean;
}

/**
 * Calculate delay for a given retry attempt with exponential backoff
 * Uses retry-after header if available, otherwise exponential backoff
 */
export function calculateRetryDelay(
  response: Response | null,
  attempt: number,
  initialDelayMs: number
): number {
  if (response) {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      return parseInt(retryAfter) * 1000;
    }
  }
  return initialDelayMs * Math.pow(2, attempt);
}

/**
 * Default retry condition: retry on 429 (rate limit) or 5xx errors
 */
function defaultShouldRetry(response: Response): boolean {
  return response.status === 429 || response.status >= 500;
}

/**
 * Fetch with retry and exponential backoff
 *
 * Retries on:
 * - Network errors
 * - 429 rate limit responses
 * - 5xx server errors
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retryOptions: RetryOptions = {}
): Promise<Response> {
  const {
    maxRetries = DEFAULT_MAX_RETRIES,
    initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
    shouldRetry = defaultShouldRetry,
  } = retryOptions;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      // Check if we should retry based on response
      if (shouldRetry(response)) {
        if (attempt < maxRetries - 1) {
          const delay = calculateRetryDelay(response, attempt, initialDelayMs);
          console.log(`Retrying after ${delay}ms (attempt ${attempt + 1}/${maxRetries}, status ${response.status})`);
          await sleep(delay);
          continue;
        }
      }

      return response;
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries - 1) {
        const delay = calculateRetryDelay(null, attempt, initialDelayMs);
        console.log(`Fetch error, retrying after ${delay}ms: ${lastError.message}`);
        await sleep(delay);
      }
    }
  }

  throw lastError ?? new Error('Fetch failed after retries');
}
