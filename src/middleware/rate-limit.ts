/**
 * Middleware for request handling
 *
 * Contains rate limiting, event deduplication, and idempotency logic
 */

import type { Env } from "../types";

// Rate limiting configuration (per user, per minute)
export const RATE_LIMIT_WINDOW_SECONDS = 60;
export const RATE_LIMIT_KEY_PREFIX = "ratelimit:";

// Command-specific rate limits
export const RATE_LIMITS: Record<string, number> = {
  doc: 10,
  search: 20,
  default: 30,
};

// Event deduplication (prevent duplicate responses from Slack retries)
export const EVENT_DEDUP_TTL_SECONDS = 60;
export const EVENT_DEDUP_KEY_PREFIX = "event:";

// Operation-level idempotency (prevent duplicate operations on retries)
export const IDEMPOTENCY_TTL_SECONDS = 3600; // 1 hour
export const IDEMPOTENCY_KEY_PREFIX = "idempotency:";

/**
 * Check if user is rate limited for a specific command type
 * Uses KV for global state across workers
 */
export async function isRateLimited(
  userId: string,
  commandType: string,
  env: Env
): Promise<boolean> {
  const key = `${RATE_LIMIT_KEY_PREFIX}${commandType}:${userId}`;
  const now = Date.now();
  const limit = RATE_LIMITS[commandType] ?? RATE_LIMITS.default;

  const stored = await env.DOCS_KV.get<{ count: number; resetTime: number }>(key, "json");

  if (!stored || now > stored.resetTime) {
    // Start new window
    await env.DOCS_KV.put(key, JSON.stringify({ count: 1, resetTime: now + RATE_LIMIT_WINDOW_SECONDS * 1000 }), {
      expirationTtl: RATE_LIMIT_WINDOW_SECONDS,
    });
    return false;
  }

  if (stored.count >= limit) {
    console.log(`Rate limit hit for ${commandType} by user ${userId}: ${stored.count}/${limit}`);
    return true;
  }

  // Increment count
  await env.DOCS_KV.put(key, JSON.stringify({ count: stored.count + 1, resetTime: stored.resetTime }), {
    expirationTtl: Math.ceil((stored.resetTime - now) / 1000),
  });
  return false;
}

/**
 * Check if an event has already been processed (deduplication using KV)
 * Returns true if duplicate, false if new event
 */
export async function isDuplicateEvent(eventId: string, env: Env): Promise<boolean> {
  const key = `${EVENT_DEDUP_KEY_PREFIX}${eventId}`;

  const existing = await env.DOCS_KV.get(key);

  if (existing) {
    console.log(`Duplicate event detected: ${eventId}`);
    return true;
  }

  // Mark as processed with TTL
  await env.DOCS_KV.put(key, "1", { expirationTtl: EVENT_DEDUP_TTL_SECONDS });
  return false;
}

/**
 * Check and mark operation as in-progress (idempotency)
 * Returns true if operation should proceed, false if already in progress/completed
 */
export async function startOperation(
  operationId: string,
  env: Env
): Promise<boolean> {
  const key = `${IDEMPOTENCY_KEY_PREFIX}${operationId}`;

  const existing = await env.DOCS_KV.get(key);

  if (existing) {
    console.log(`Operation already in progress or completed: ${operationId}`);
    return false;
  }

  await env.DOCS_KV.put(key, "1", { expirationTtl: IDEMPOTENCY_TTL_SECONDS });
  return true;
}

/**
 * Mark operation as completed
 */
export async function completeOperation(operationId: string, env: Env): Promise<void> {
  const key = `${IDEMPOTENCY_KEY_PREFIX}${operationId}`;
  await env.DOCS_KV.put(key, "completed", { expirationTtl: IDEMPOTENCY_TTL_SECONDS });
}
