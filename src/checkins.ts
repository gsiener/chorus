/**
 * Weekly DM check-ins for initiative owners
 *
 * Sends proactive status updates to initiative owners with:
 * - Status summary of their initiatives
 * - Gaps (missing PRD, metrics)
 * - Nudges for stale initiatives
 */

import type { Env, InitiativeMetadata, Initiative } from "./types";
import { postDirectMessage } from "./slack";
import { INITIATIVES_KV } from "./kv";
import {
  getStatusEmoji,
  MIN_CHECKIN_INTERVAL_MS,
  TEST_CHECKIN_INTERVAL_MS,
  CHECKIN_KV_TTL_SECONDS,
} from "./constants";

// KV keys
const LAST_CHECKIN_PREFIX = "checkin:last:";
const CHECKIN_HISTORY_PREFIX = "checkin:history:";
const MAX_CHECKIN_HISTORY = 10;

/**
 * Structured record of a check-in that was sent
 */
export interface CheckInRecord {
  sentAt: string;
  initiativeCount: number;
  missingPrd: number;
  missingMetrics: number;
}

interface InitiativeWithDetails extends InitiativeMetadata {
  description?: string;
  lastDiscussedAt?: string;
}

/**
 * Get initiatives grouped by owner
 * Uses batch KV reads to avoid N+1 query pattern
 */
async function getInitiativesByOwner(
  env: Env
): Promise<Map<string, InitiativeWithDetails[]>> {
  const indexData = await env.DOCS_KV.get(INITIATIVES_KV.index);
  if (!indexData) {
    return new Map();
  }

  const index = JSON.parse(indexData) as { initiatives: InitiativeMetadata[] };

  // Filter to active initiatives first
  const activeInitiatives = index.initiatives.filter(
    (meta) => meta.status !== "completed" && meta.status !== "cancelled"
  );

  if (activeInitiatives.length === 0) {
    return new Map();
  }

  // Batch load all initiative details in parallel (fixes N+1 query issue)
  const detailPromises = activeInitiatives.map(async (meta) => {
    const detailData = await env.DOCS_KV.get(`${INITIATIVES_KV.prefix}${meta.id}`);
    const details = detailData ? (JSON.parse(detailData) as Initiative) : null;
    return { meta, details };
  });

  const results = await Promise.all(detailPromises);

  // Group by owner
  const byOwner = new Map<string, InitiativeWithDetails[]>();

  for (const { meta, details } of results) {
    const initiative: InitiativeWithDetails = {
      ...meta,
      description: details?.description,
      lastDiscussedAt: details?.lastDiscussedAt,
    };

    if (!byOwner.has(meta.owner)) {
      byOwner.set(meta.owner, []);
    }
    byOwner.get(meta.owner)!.push(initiative);
  }

  return byOwner;
}

/**
 * Check if we should send a check-in to this user (rate limiting)
 */
async function shouldSendCheckin(userId: string, env: Env): Promise<boolean> {
  const lastCheckin = await env.DOCS_KV.get(`${LAST_CHECKIN_PREFIX}${userId}`);

  if (!lastCheckin) {
    return true;
  }

  const lastTime = parseInt(lastCheckin, 10);
  const interval = env.TEST_CHECKIN_USER ? TEST_CHECKIN_INTERVAL_MS : MIN_CHECKIN_INTERVAL_MS;
  return Date.now() - lastTime > interval;
}

/**
 * Record that we sent a check-in to this user
 * Stores both the timestamp (for rate limiting) and a structured record (for history)
 */
async function recordCheckin(
  userId: string,
  env: Env,
  record?: Omit<CheckInRecord, "sentAt">
): Promise<void> {
  const now = Date.now();

  // Store timestamp for rate limiting (existing behavior)
  await env.DOCS_KV.put(`${LAST_CHECKIN_PREFIX}${userId}`, now.toString(), {
    expirationTtl: CHECKIN_KV_TTL_SECONDS,
  });

  // Store structured history if record provided
  if (record) {
    const historyKey = `${CHECKIN_HISTORY_PREFIX}${userId}`;
    const existingData = await env.DOCS_KV.get(historyKey);
    const history: CheckInRecord[] = existingData ? JSON.parse(existingData) : [];

    // Add new record at the beginning
    history.unshift({
      sentAt: new Date(now).toISOString(),
      ...record,
    });

    // Keep only the most recent records
    const trimmedHistory = history.slice(0, MAX_CHECKIN_HISTORY);

    await env.DOCS_KV.put(historyKey, JSON.stringify(trimmedHistory));
  }
}

/**
 * Get the most recent check-in record for a user
 */
export async function getLastCheckIn(userId: string, env: Env): Promise<CheckInRecord | null> {
  const historyKey = `${CHECKIN_HISTORY_PREFIX}${userId}`;
  const data = await env.DOCS_KV.get(historyKey);

  if (!data) {
    return null;
  }

  const history = JSON.parse(data) as CheckInRecord[];
  return history.length > 0 ? history[0] : null;
}

/**
 * List check-in history for a user
 */
export async function listUserCheckIns(
  userId: string,
  env: Env,
  limit?: number
): Promise<CheckInRecord[]> {
  const historyKey = `${CHECKIN_HISTORY_PREFIX}${userId}`;
  const data = await env.DOCS_KV.get(historyKey);

  if (!data) {
    return [];
  }

  const history = JSON.parse(data) as CheckInRecord[];
  return limit ? history.slice(0, limit) : history;
}

/**
 * Format check-in message for a user
 */
function formatCheckinMessage(initiatives: InitiativeWithDetails[]): string {
  const lines: string[] = [
    "👋 *Weekly Initiative Check-in*",
    "",
    `You own ${initiatives.length} active initiative${initiatives.length === 1 ? "" : "s"}:`,
  ];

  // Group by status
  const byStatus = new Map<string, InitiativeWithDetails[]>();
  for (const init of initiatives) {
    if (!byStatus.has(init.status)) {
      byStatus.set(init.status, []);
    }
    byStatus.get(init.status)!.push(init);
  }

  // Show active first, then proposed, then paused
  const statusOrder = ["active", "proposed", "paused"];

  for (const status of statusOrder) {
    const inits = byStatus.get(status);
    if (!inits || inits.length === 0) continue;

    const emoji = getStatusEmoji(status);
    lines.push("");
    lines.push(`*${status.charAt(0).toUpperCase() + status.slice(1)}:*`);

    for (const init of inits) {
      const gaps: string[] = [];
      if (!init.hasPrd) gaps.push("needs PRD");
      if (!init.hasMetrics) gaps.push("needs metrics");

      let line = `${emoji} ${init.name}`;
      if (gaps.length > 0) {
        line += ` _(${gaps.join(", ")})_`;
      }
      lines.push(line);
    }
  }

  // Summary of gaps
  const totalMissingPrd = initiatives.filter((i) => !i.hasPrd).length;
  const totalMissingMetrics = initiatives.filter((i) => !i.hasMetrics).length;

  if (totalMissingPrd > 0 || totalMissingMetrics > 0) {
    lines.push("");
    lines.push("*Quick wins this week:*");
    if (totalMissingPrd > 0) {
      lines.push(`• Add PRD links to ${totalMissingPrd} initiative${totalMissingPrd === 1 ? "" : "s"}`);
    }
    if (totalMissingMetrics > 0) {
      lines.push(`• Define metrics for ${totalMissingMetrics} initiative${totalMissingMetrics === 1 ? "" : "s"}`);
    }
  }

  lines.push("");
  lines.push("_Reply to update any initiative, or use_ `@Chorus initiatives` _to see all._");

  return lines.join("\n");
}

async function sendTestCheckin(env: Env, testUser: string): Promise<{ success: boolean; message: string; sentTo: number }> {
  console.log(`Test user ${testUser} has no initiatives, sending test message`);
  const testMessage =
    "👋 *Weekly Initiative Check-in (Test)*\n\n" +
    "_This is a test message. You don't currently own any initiatives._\n\n" +
    "Use `@Chorus add initiative \"Name\" owned by @you` to create one.";

  if (await shouldSendCheckin(testUser, env)) {
    const result = await postDirectMessage(testUser, testMessage, env);
    if (result.ts) {
      // Record with zero initiatives (test mode)
      await recordCheckin(testUser, env, {
        initiativeCount: 0,
        missingPrd: 0,
        missingMetrics: 0,
      });
      return {
        success: true,
        message: "Sent test check-in (no initiatives).",
        sentTo: 1,
      };
    } else {
      console.error(`Failed to send test check-in to ${testUser}: ${result.error}`);
      return {
        success: false,
        message: `Failed to send test check-in DM: ${result.error}`,
        sentTo: 0,
      };
    }
  } else {
    console.log(`Skipping test check-in for ${testUser} (recently sent)`);
    return {
      success: true,
      message: "Skipped test check-in (recently sent).",
      sentTo: 0,
    };
  }
}

async function processOwnerCheckin(env: Env, ownerId: string, initiatives: InitiativeWithDetails[]): Promise<boolean> {
  // Skip if we recently sent a check-in
  if (!(await shouldSendCheckin(ownerId, env))) {
    console.log(`Skipping check-in for ${ownerId} (recently sent)`);
    return false;
  }

  // Format and send the message
  const message = formatCheckinMessage(initiatives);
  const result = await postDirectMessage(ownerId, message, env);

  if (result.ts) {
    // Record with structured history
    await recordCheckin(ownerId, env, {
      initiativeCount: initiatives.length,
      missingPrd: initiatives.filter((i) => !i.hasPrd).length,
      missingMetrics: initiatives.filter((i) => !i.hasMetrics).length,
    });
    console.log(`Sent check-in to ${ownerId}`);
    return true;
  } else {
    console.error(`Failed to send check-in to ${ownerId}: ${result.error}`);
    return false;
  }
}

/**
 * Format check-in history for display
 */
export function formatCheckInHistory(history: CheckInRecord[]): string {
  if (history.length === 0) {
    return "No check-in history found. Check-ins are sent weekly to initiative owners.";
  }

  const lines: string[] = [
    `*Check-in History* (${history.length} record${history.length === 1 ? "" : "s"})`,
    "",
  ];

  for (const record of history) {
    const date = new Date(record.sentAt).toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    const gaps: string[] = [];
    if (record.missingPrd > 0) gaps.push(`${record.missingPrd} missing PRD`);
    if (record.missingMetrics > 0) gaps.push(`${record.missingMetrics} missing metrics`);

    let line = `• ${date}: ${record.initiativeCount} initiative${record.initiativeCount === 1 ? "" : "s"}`;
    if (gaps.length > 0) {
      line += ` _(${gaps.join(", ")})_`;
    }
    lines.push(line);
  }

  return lines.join("\n");
}

/**
 * Send check-in DMs to initiative owners
 * When TEST_CHECKIN_USER is set, only sends to that user (for testing)
 */
export async function sendWeeklyCheckins(
  env: Env
): Promise<{ success: boolean; message: string; sentTo: number }> {
  try {
    const byOwner = await getInitiativesByOwner(env);
    let sentCount = 0;

    // In test mode, only send to the test user
    const testUser = env.TEST_CHECKIN_USER;
    if (testUser) {
      console.log(`Test mode: only sending check-ins to ${testUser}`);

      // If test user doesn't own any initiatives, send them a test message anyway
      if (!byOwner.has(testUser)) {
        return await sendTestCheckin(env, testUser);
      }
    }

    for (const [ownerId, initiatives] of byOwner) {
      // In test mode, skip anyone who isn't the test user
      if (testUser && ownerId !== testUser) {
        continue;
      }

      if (await processOwnerCheckin(env, ownerId, initiatives)) {
        sentCount++;
      }
    }

    return {
      success: true,
      message: `Sent weekly check-ins to ${sentCount} owner${sentCount === 1 ? "" : "s"}.`,
      sentTo: sentCount,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Weekly check-in error:", error);
    return {
      success: false,
      message: `Failed to send check-ins: ${errorMessage}`,
      sentTo: 0,
    };
  }
}
