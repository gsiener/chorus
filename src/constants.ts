/**
 * Centralized constants for Chorus
 *
 * This file contains all configuration constants that were previously scattered
 * across the codebase. Centralizing them improves maintainability and makes
 * the system more prompt-native by separating configuration from code.
 */

// Status emojis for initiatives
export const STATUS_EMOJIS: Record<string, string> = {
  active: "🟢",
  proposed: "🟡",
  paused: "⏸️",
  completed: "✅",
  cancelled: "❌",
} as const;

/**
 * Get emoji for initiative status
 */
export function getStatusEmoji(status: string): string {
  return STATUS_EMOJIS[status] || "❓";
}

// Rate limiting configuration (per user, per minute)
export const RATE_LIMIT_WINDOW_SECONDS = 60;
export const RATE_LIMIT_KEY_PREFIX = "ratelimit:";

export const RATE_LIMITS: Record<string, number> = {
  doc: 10, // Doc add/remove: 10 per minute
  search: 20, // Search commands: 20 per minute (more lenient)
  default: 30, // Default for other commands
};

// Event deduplication
export const EVENT_DEDUP_TTL_SECONDS = 60; // 1 minute
export const EVENT_DEDUP_KEY_PREFIX = "event:";

// Document storage limits
export const MAX_DOC_SIZE = 50000; // 50 KB per document
export const MAX_TOTAL_KB_SIZE = 200000; // 200 KB total
export const MAX_TITLE_LENGTH = 100;
export const DEFAULT_DOC_PAGE_SIZE = 10;

// Check-in intervals
export const MIN_CHECKIN_INTERVAL_MS = 6 * 24 * 60 * 60 * 1000; // 6 days (production)
export const TEST_CHECKIN_INTERVAL_MS = 20 * 60 * 60 * 1000; // 20 hours (test mode)
export const CHECKIN_KV_TTL_SECONDS = 60 * 60 * 24 * 14; // 2 weeks

// Cache TTLs
export const BOT_ID_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
export const USER_INFO_CACHE_TTL_SECONDS = 60 * 60; // 1 hour
export const KB_CACHE_TTL_SECONDS = 600; // 10 minutes
export const AMPLITUDE_CACHE_TTL_SECONDS = 3600; // 1 hour (data is weekly)
export const PRIORITIES_CACHE_TTL_SECONDS = 90000; // 25 hours — overlaps daily cron window
// Scheduled sync intervals
export const DOC_BACKFILL_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// KV key prefixes for scheduled sync tracking
export const LAST_BACKFILL_KEY = "sync:backfill:last";
