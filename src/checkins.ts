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

// KV keys
const LAST_CHECKIN_PREFIX = "checkin:last:";

// Rate limiting intervals
const MIN_CHECKIN_INTERVAL_MS = 6 * 24 * 60 * 60 * 1000; // 6 days (production)
const TEST_CHECKIN_INTERVAL_MS = 20 * 60 * 60 * 1000; // 20 hours (allows daily in test mode)

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
 */
async function recordCheckin(userId: string, env: Env): Promise<void> {
  await env.DOCS_KV.put(`${LAST_CHECKIN_PREFIX}${userId}`, Date.now().toString(), {
    expirationTtl: 60 * 60 * 24 * 14, // Keep for 2 weeks
  });
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

    const emoji = status === "active" ? "🟢" : status === "proposed" ? "🟡" : "⏸️";
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
      await recordCheckin(testUser, env);
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
    await recordCheckin(ownerId, env);
    console.log(`Sent check-in to ${ownerId}`);
    return true;
  } else {
    console.error(`Failed to send check-in to ${ownerId}: ${result.error}`);
    return false;
  }
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
