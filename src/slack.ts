/**
 * Slack API integration
 */

import type { Env, SlackMessage } from "./types";

// Error classes

export class SignatureVerificationError extends Error {
  readonly _tag = "SignatureVerificationError" as const;
  constructor(
    public readonly reason:
      | "missing_headers"
      | "timestamp_expired"
      | "signature_mismatch"
  ) {
    super(`Signature verification failed: ${reason}`);
    this.name = "SignatureVerificationError";
  }
}

export class SlackApiError extends Error {
  readonly _tag = "SlackApiError" as const;
  constructor(
    public readonly code: string,
    public readonly method: string
  ) {
    super(`Slack API error in ${method}: ${code}`);
    this.name = "SlackApiError";
  }
}

export type SlackError = SignatureVerificationError | SlackApiError;

// Signature verification

export async function verifySlackSignature(
  request: Request,
  body: string,
  signingSecret: string
): Promise<boolean> {
  try {
    const timestamp = request.headers.get("x-slack-request-timestamp");
    const signature = request.headers.get("x-slack-signature");

    if (!timestamp || !signature) {
      return false;
    }

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

    const signatureBuffer = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(sigBaseString)
    );

    const computedSignature =
      "v0=" +
      Array.from(new Uint8Array(signatureBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

    return signature === computedSignature;
  } catch {
    return false;
  }
}

// API helpers

interface SlackApiResponse {
  ok: boolean;
  error?: string;
}

async function slackFetch<T extends SlackApiResponse>(
  url: string,
  options: RequestInit,
  botToken: string
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${botToken}`,
      ...options.headers,
    },
  });

  const data = (await response.json()) as T;

  if (!data.ok) {
    throw new SlackApiError(data.error ?? "unknown", url);
  }

  return data;
}

// Thread messages

interface ThreadResponse extends SlackApiResponse {
  messages?: SlackMessage[];
}

export async function fetchThreadMessages(
  channel: string,
  threadTs: string,
  env: Env
): Promise<SlackMessage[]> {
  try {
    const data = await slackFetch<ThreadResponse>(
      `https://slack.com/api/conversations.replies?channel=${channel}&ts=${threadTs}`,
      {},
      env.SLACK_BOT_TOKEN
    );
    return (data.messages ?? []).sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
  } catch {
    return [];
  }
}

// Post message

interface PostResponse extends SlackApiResponse {
  ts?: string;
}

export async function postMessage(
  channel: string,
  text: string,
  threadTs: string | undefined,
  env: Env
): Promise<string | null> {
  try {
    const data = await slackFetch<PostResponse>(
      "https://slack.com/api/chat.postMessage",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, text, thread_ts: threadTs }),
      },
      env.SLACK_BOT_TOKEN
    );
    return data.ts ?? null;
  } catch {
    return null;
  }
}

// Update message

export async function updateMessage(
  channel: string,
  ts: string,
  text: string,
  env: Env
): Promise<boolean> {
  try {
    await slackFetch<SlackApiResponse>(
      "https://slack.com/api/chat.update",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, ts, text }),
      },
      env.SLACK_BOT_TOKEN
    );
    return true;
  } catch {
    return false;
  }
}

// Add reaction

interface ReactionResponse extends SlackApiResponse {}

export async function addReaction(
  channel: string,
  ts: string,
  emoji: string,
  env: Env
): Promise<boolean> {
  try {
    const response = await fetch("https://slack.com/api/reactions.add", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel, timestamp: ts, name: emoji }),
    });

    const data = (await response.json()) as ReactionResponse;

    // already_reacted is not an error
    if (!data.ok && data.error !== "already_reacted") {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

// Post direct message

interface ConversationOpenResponse extends SlackApiResponse {
  channel?: { id: string };
}

export async function postDirectMessage(
  userId: string,
  text: string,
  env: Env
): Promise<string | null> {
  try {
    const openData = await slackFetch<ConversationOpenResponse>(
      "https://slack.com/api/conversations.open",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ users: userId }),
      },
      env.SLACK_BOT_TOKEN
    );

    if (!openData.channel) {
      return null;
    }

    return postMessage(openData.channel.id, text, undefined, env);
  } catch {
    return null;
  }
}
