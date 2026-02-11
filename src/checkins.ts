/**
 * Weekly DM check-ins for R&D Priority initiative owners
 *
 * Sends proactive status updates to initiative owners with
 * their R&D Priorities listed by status and rank.
 */

import type { Env } from "./types";
import { postDirectMessage } from "./slack";
import {
  fetchPriorityInitiatives,
  resolveOwnerSlackIds,
  extractPriorityMetadata,
} from "./linear-priorities";
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
}

interface OwnerInitiative {
  name: string;
  status: string;
  rank: number;
  slackChannel: string | null;
}

/**
 * Get R&D Priority initiatives grouped by owner Slack ID
 */
async function getInitiativesByOwner(
  env: Env
): Promise<Map<string, OwnerInitiative[]>> {
  const relations = await fetchPriorityInitiatives(env);
  if (relations.length === 0) {
    return new Map();
  }

  const ownerSlackIds = await resolveOwnerSlackIds(relations, env);
  const byOwner = new Map<string, OwnerInitiative[]>();

  for (const relation of relations) {
    const init = relation.relatedInitiative;
    if (!init.owner?.email) continue;

    const slackId = ownerSlackIds.get(init.owner.email.toLowerCase());
    if (!slackId) continue;

    const { slackChannel } = extractPriorityMetadata(init);
    const initiative: OwnerInitiative = {
      name: init.name,
      status: init.status,
      rank: Math.round(relation.sortOrder),
      slackChannel,
    };

    if (!byOwner.has(slackId)) {
      byOwner.set(slackId, []);
    }
    byOwner.get(slackId)!.push(initiative);
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
function formatCheckinMessage(initiatives: OwnerInitiative[]): string {
  const lines: string[] = [
    "👋 *Weekly R&D Priority Check-in*",
    "",
    `You own ${initiatives.length} R&D priorit${initiatives.length === 1 ? "y" : "ies"}:`,
  ];

  // Group by status
  const byStatus = new Map<string, OwnerInitiative[]>();
  for (const init of initiatives) {
    if (!byStatus.has(init.status)) {
      byStatus.set(init.status, []);
    }
    byStatus.get(init.status)!.push(init);
  }

  // Show by status, sorted by rank within each group
  const statusOrder = ["Started", "Planned", "Backlog"];

  for (const status of statusOrder) {
    const inits = byStatus.get(status);
    if (!inits || inits.length === 0) continue;

    const emoji = getStatusEmoji(status.toLowerCase());
    lines.push("");
    lines.push(`*${status}:*`);

    for (const init of inits.sort((a, b) => a.rank - b.rank)) {
      let line = `${emoji} #${init.rank} ${init.name}`;
      if (init.slackChannel) {
        line += ` (${init.slackChannel})`;
      }
      lines.push(line);
    }
  }

  // Show any statuses not in our preferred order
  for (const [status, inits] of byStatus) {
    if (statusOrder.includes(status)) continue;
    const emoji = getStatusEmoji(status.toLowerCase());
    lines.push("");
    lines.push(`*${status}:*`);
    for (const init of inits.sort((a, b) => a.rank - b.rank)) {
      lines.push(`${emoji} #${init.rank} ${init.name}`);
    }
  }

  lines.push("");
  lines.push("_Reply to discuss any priority, or use_ `@Chorus priorities` _to see the full list._");

  return lines.join("\n");
}

async function sendTestCheckin(env: Env, testUser: string): Promise<{ success: boolean; message: string; sentTo: number }> {
  console.log(`Test user ${testUser} has no initiatives, sending test message`);
  const testMessage =
    "👋 *Weekly R&D Priority Check-in (Test)*\n\n" +
    "_This is a test message. You don't currently own any R&D Priorities._";

  if (await shouldSendCheckin(testUser, env)) {
    const result = await postDirectMessage(testUser, testMessage, env);
    if (result.ts) {
      await recordCheckin(testUser, env, { initiativeCount: 0 });
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

async function processOwnerCheckin(env: Env, ownerId: string, initiatives: OwnerInitiative[]): Promise<boolean> {
  // Skip if we recently sent a check-in
  if (!(await shouldSendCheckin(ownerId, env))) {
    console.log(`Skipping check-in for ${ownerId} (recently sent)`);
    return false;
  }

  // Format and send the message
  const message = formatCheckinMessage(initiatives);
  const result = await postDirectMessage(ownerId, message, env);

  if (result.ts) {
    await recordCheckin(ownerId, env, {
      initiativeCount: initiatives.length,
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
    return "No check-in history found. Check-ins are sent weekly to R&D Priority owners.";
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
    lines.push(`• ${date}: ${record.initiativeCount} priorit${record.initiativeCount === 1 ? "y" : "ies"}`);
  }

  return lines.join("\n");
}

/**
 * Send check-in DMs to R&D Priority initiative owners
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
