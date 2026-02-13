/**
 * Feedback log — stores prompt/response pairs in KV with 45-day TTL,
 * updates with thumbs up/down reactions, and serves an HTML dashboard.
 */

import type { Env, FeedbackRecord, FeedbackMetadata } from "./types";
import {
  FEEDBACK_KV_PREFIX,
  FEEDBACK_TTL_SECONDS,
  FEEDBACK_METADATA_PROMPT_LENGTH,
} from "./constants";

export async function storeFeedbackRecord(
  env: Env,
  record: FeedbackRecord
): Promise<void> {
  const key = `${FEEDBACK_KV_PREFIX}${record.channel}:${record.ts}`;
  const metadata: FeedbackMetadata = {
    prompt: record.prompt.slice(0, FEEDBACK_METADATA_PROMPT_LENGTH),
    user: record.user,
    timestamp: record.timestamp,
  };
  await env.DOCS_KV.put(key, JSON.stringify(record), {
    expirationTtl: FEEDBACK_TTL_SECONDS,
    metadata,
  });
}

export async function updateFeedbackWithReaction(
  env: Env,
  channel: string,
  ts: string,
  feedbackType: "positive" | "negative",
  reactor: string
): Promise<void> {
  const key = `${FEEDBACK_KV_PREFIX}${channel}:${ts}`;
  const record = await env.DOCS_KV.get<FeedbackRecord>(key, "json");
  if (!record) return;

  record.feedback = {
    type: feedbackType,
    reactor,
    reactedAt: new Date().toISOString(),
  };

  const metadata: FeedbackMetadata = {
    prompt: record.prompt.slice(0, FEEDBACK_METADATA_PROMPT_LENGTH),
    user: record.user,
    feedback: feedbackType,
    timestamp: record.timestamp,
  };

  await env.DOCS_KV.put(key, JSON.stringify(record), {
    expirationTtl: FEEDBACK_TTL_SECONDS,
    metadata,
  });
}

export async function handleFeedbackPage(env: Env): Promise<Response> {
  const keys = await env.DOCS_KV.list<FeedbackMetadata>({
    prefix: FEEDBACK_KV_PREFIX,
  });

  const entries = keys.keys
    .filter((k) => k.metadata)
    .sort((a, b) => {
      const ta = a.metadata?.timestamp ?? "";
      const tb = b.metadata?.timestamp ?? "";
      return tb.localeCompare(ta);
    });

  const html = renderFeedbackHtml(entries);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function feedbackIndicator(feedback?: "positive" | "negative"): string {
  if (feedback === "positive") return "👍";
  if (feedback === "negative") return "👎";
  return "—";
}

function renderFeedbackHtml(
  entries: { name: string; metadata?: FeedbackMetadata }[]
): string {
  const rows = entries
    .map((entry) => {
      const m = entry.metadata!;
      const rowClass = m.feedback === "negative" ? ' class="negative"' : "";
      return `      <tr${rowClass}>
        <td>${formatDate(m.timestamp)}</td>
        <td>${escapeHtml(m.prompt)}</td>
        <td><code>${escapeHtml(m.user)}</code></td>
        <td class="feedback">${feedbackIndicator(m.feedback)}</td>
      </tr>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Chorus Feedback Log</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 2rem; background: #fafafa; color: #333; }
    h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 0.5rem; }
    .meta { color: #888; font-size: 0.85rem; margin-bottom: 1.5rem; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    th { text-align: left; padding: 0.75rem 1rem; background: #f5f5f5; font-weight: 600; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: #666; border-bottom: 1px solid #e5e5e5; }
    td { padding: 0.75rem 1rem; border-bottom: 1px solid #f0f0f0; font-size: 0.9rem; }
    tr:last-child td { border-bottom: none; }
    tr.negative { background: #fef2f2; }
    td code { font-size: 0.8rem; background: #f0f0f0; padding: 0.15rem 0.4rem; border-radius: 3px; }
    td.feedback { text-align: center; font-size: 1.1rem; }
    .empty { text-align: center; padding: 3rem; color: #999; }
  </style>
</head>
<body>
  <h1>Chorus Feedback Log</h1>
  <p class="meta">${entries.length} entries (last 45 days)</p>
  ${
    entries.length === 0
      ? '<div class="empty">No feedback entries yet.</div>'
      : `<table>
    <thead>
      <tr>
        <th>Date</th>
        <th>Prompt</th>
        <th>User</th>
        <th>Feedback</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>`
  }
</body>
</html>`;
}
