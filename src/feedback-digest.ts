/**
 * Daily feedback digest — sends a summary of Chorus feedback reactions
 * from the past 24 hours as a Slack DM.
 */

import type { Env, FeedbackRecord, FeedbackMetadata } from "./types";
import { postDirectMessage } from "./slack";
import { FEEDBACK_KV_PREFIX } from "./constants";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/**
 * Send a daily digest of Chorus feedback reactions to the configured user.
 */
export async function sendDailyFeedbackDigest(
  env: Env
): Promise<{ success: boolean; message: string }> {
  const userId = env.FEEDBACK_DIGEST_USER;
  if (!userId) {
    return { success: true, message: "FEEDBACK_DIGEST_USER not set, skipping." };
  }

  try {
    const cutoff = Date.now() - TWENTY_FOUR_HOURS_MS;

    // List all feedback keys with metadata
    const keys = await env.DOCS_KV.list<FeedbackMetadata>({
      prefix: FEEDBACK_KV_PREFIX,
    });

    // Filter to entries that have feedback set in metadata
    const withFeedback = keys.keys.filter((k) => k.metadata?.feedback);

    // Resolve bot user ID to filter out self-reactions (e.g. bot's own thumbs-up ack)
    const botUserId = await getBotUserId(env);

    // Fetch full records to check reactedAt timestamp
    const recentFeedback: FeedbackRecord[] = [];
    for (const key of withFeedback) {
      const record = await env.DOCS_KV.get<FeedbackRecord>(key.name, "json");
      if (!record?.feedback?.reactedAt) continue;
      if (record.feedback.reactor === botUserId) continue;

      const reactedAtMs = new Date(record.feedback.reactedAt).getTime();
      if (reactedAtMs >= cutoff) {
        recentFeedback.push(record);
      }
    }

    // Resolve permalinks for each entry
    const permalinks = new Map<string, string>();
    for (const entry of recentFeedback) {
      const link = await getPermalink(entry.channel, entry.ts, env);
      if (link) permalinks.set(`${entry.channel}:${entry.ts}`, link);
    }

    // Format the digest message
    const message = formatDigestMessage(recentFeedback, permalinks);

    const result = await postDirectMessage(userId, message, env);
    if (result.ts) {
      return {
        success: true,
        message: `Sent feedback digest with ${recentFeedback.length} reaction(s).`,
      };
    } else {
      console.error(`Failed to send feedback digest: ${result.error}`);
      return {
        success: false,
        message: `Failed to send feedback digest DM: ${result.error}`,
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Feedback digest error:", error);
    return {
      success: false,
      message: `Failed to send feedback digest: ${errorMessage}`,
    };
  }
}

function formatDigestMessage(entries: FeedbackRecord[], permalinks: Map<string, string>): string {
  if (entries.length === 0) {
    return "📊 *Daily Chorus Feedback*\n\nNo reactions in the last 24 hours. 🎉";
  }

  const positive = entries.filter((e) => e.feedback?.type === "positive").length;
  const negative = entries.filter((e) => e.feedback?.type === "negative").length;

  const lines: string[] = [
    "📊 *Daily Chorus Feedback*",
    "",
    `${entries.length} reaction${entries.length === 1 ? "" : "s"} yesterday (${positive} 👍, ${negative} 👎)`,
    "",
  ];

  // Sort by reactedAt descending
  const sorted = [...entries].sort((a, b) => {
    const ta = a.feedback?.reactedAt ?? "";
    const tb = b.feedback?.reactedAt ?? "";
    return tb.localeCompare(ta);
  });

  for (const entry of sorted) {
    const emoji = entry.feedback?.type === "positive" ? "👍" : "👎";
    const reactor = entry.feedback?.reactor ? `<@${entry.feedback.reactor}>` : "unknown";
    const promptExcerpt = entry.prompt.length > 80
      ? entry.prompt.slice(0, 80) + "…"
      : entry.prompt;
    const time = entry.feedback?.reactedAt
      ? new Date(entry.feedback.reactedAt).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          timeZone: "America/New_York",
        })
      : "";

    const permalink = permalinks.get(`${entry.channel}:${entry.ts}`);
    const timeLink = permalink && time ? `<${permalink}|${time}>` : time;

    lines.push(`${emoji} ${reactor} ${timeLink ? `at ${timeLink}` : ""}`);
    lines.push(`> _${promptExcerpt}_`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

async function getPermalink(channel: string, ts: string, env: Env): Promise<string | null> {
  try {
    const url = `https://slack.com/api/chat.getPermalink?channel=${channel}&message_ts=${ts}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    });
    const data = (await response.json()) as { ok: boolean; permalink?: string };
    return data.ok && data.permalink ? data.permalink : null;
  } catch {
    return null;
  }
}

async function getBotUserId(env: Env): Promise<string | null> {
  try {
    const response = await fetch("https://slack.com/api/auth.test", {
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    });
    const data = (await response.json()) as { ok: boolean; user_id?: string };
    return data.ok && data.user_id ? data.user_id : null;
  } catch {
    return null;
  }
}
