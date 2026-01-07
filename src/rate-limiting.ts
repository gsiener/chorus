import type { Env } from "./types";

// Rate limiting configuration (per user, per minute)
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_KEY_PREFIX = "ratelimit:";

// Command-specific rate limits
const RATE_LIMITS: Record<string, number> = {
  doc: 10,      // Doc add/remove: 10 per minute
  search: 20,   // Search commands: 20 per minute (more lenient)
  default: 30,  // Default for other commands
};

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
