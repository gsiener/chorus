import type { Env, SlackMessage, SlackThreadResponse, SlackPostResponse } from "./types";
import { fetchWithRetry } from "./http-utils";

export async function verifySlackSignature(
  request: Request,
  body: string,
  signingSecret: string
): Promise<boolean> {
  const timestamp = request.headers.get("x-slack-request-timestamp");
  const signature = request.headers.get("x-slack-signature");

  if (!timestamp || !signature) {
    return false;
  }

  // Check timestamp is within 5 seconds to prevent replay attacks (Slack recommendation)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 5) {
    return false;
  }

  const sigBaseString = `v0:${timestamp}:${body}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(sigBaseString));
  const computedSignature = "v0=" + Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return signature === computedSignature;
}

export async function fetchThreadMessages(
  channel: string,
  threadTs: string,
  env: Env
): Promise<SlackMessage[]> {
  const response = await fetchWithRetry(
    `https://slack.com/api/conversations.replies?channel=${channel}&ts=${threadTs}`,
    {
      headers: {
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      },
    }
  );

  const data = (await response.json()) as SlackThreadResponse;

  if (!data.ok || !data.messages) {
    console.error("Failed to fetch thread:", data.error);
    return [];
  }

  // Sort by timestamp to ensure chronological order
  return data.messages.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
}

export async function postMessage(
  channel: string,
  text: string,
  threadTs: string | undefined,
  env: Env
): Promise<string | null> {
  const response = await fetchWithRetry(
    "https://slack.com/api/chat.postMessage",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel,
        text,
        thread_ts: threadTs,
      }),
    }
  );

  const data = (await response.json()) as SlackPostResponse;

  if (!data.ok) {
    console.error("Failed to post message:", data.error);
    return null;
  }

  return data.ts ?? null;
}

/**
 * Update an existing message
 */
export async function updateMessage(
  channel: string,
  ts: string,
  text: string,
  env: Env
): Promise<boolean> {
  const response = await fetchWithRetry(
    "https://slack.com/api/chat.update",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel,
        ts,
        text,
      }),
    }
  );

  const data = (await response.json()) as SlackPostResponse;

  if (!data.ok) {
    console.error("Failed to update message:", data.error);
    return false;
  }

  return true;
}

/**
 * Add a reaction to a message
 */
export async function addReaction(
  channel: string,
  ts: string,
  emoji: string,
  env: Env
): Promise<boolean> {
  const response = await fetch(
    "https://slack.com/api/reactions.add",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel,
        timestamp: ts,
        name: emoji,
      }),
    }
  );

  const data = (await response.json()) as { ok: boolean; error?: string };

  if (!data.ok && data.error !== "already_reacted") {
    console.error("Failed to add reaction:", data.error);
    return false;
  }

  return true;
}
