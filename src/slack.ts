/**
 * Slack API integration
 */

import type { Env, SlackMessage } from "./types";
import { USER_INFO_CACHE_TTL_SECONDS } from "./constants";

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
    if (Math.abs(now - parseInt(timestamp)) > 300) {
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
  } catch (error) {
    console.error(`Failed to fetch thread messages for ${channel}/${threadTs}:`, error);
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
        body: JSON.stringify({ channel, text, thread_ts: threadTs, unfurl_links: true }),
      },
      env.SLACK_BOT_TOKEN
    );
    return data.ts ?? null;
  } catch (error) {
    console.error(`Failed to post message to ${channel}:`, error);
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
  } catch (error) {
    console.error(`Failed to update message ${ts} in ${channel}:`, error);
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
    await slackFetch<ReactionResponse>(
      "https://slack.com/api/reactions.add",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, timestamp: ts, name: emoji }),
      },
      env.SLACK_BOT_TOKEN
    );
    return true;
  } catch (error) {
    if (error instanceof SlackApiError && error.code === "already_reacted") {
      // already_reacted is not an error we care about
      return true;
    }
    console.error(`Failed to add reaction to ${channel}/${ts}: ${error}`);
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
): Promise<{ ts: string | null; error?: string }> {
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
      console.error(`conversations.open returned no channel for user ${userId}`);
      return { ts: null, error: "no_channel_returned" };
    }

    const ts = await postMessage(openData.channel.id, text, undefined, env);
    if (!ts) {
      console.error(`postMessage failed for user ${userId}`);
      return { ts: null, error: "message_post_failed" };
    }
    return { ts };
  } catch (error) {
    const errorMessage =
      error instanceof SlackApiError
        ? error.code
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(`Failed to send DM to ${userId}: ${errorMessage}`);
    return { ts: null, error: errorMessage };
  }
}

/**
 * User info returned from Slack API
 */
export interface UserInfo {
  id: string;
  name: string;
  realName: string | null;
  title: string | null;
  email: string | null;
}

// KV key prefix for user info cache
const USER_INFO_CACHE_PREFIX = "user:info:";

interface SlackUserResponse {
  ok: boolean;
  user?: {
    id: string;
    name: string;
    real_name?: string;
    profile?: {
      title?: string;
      email?: string;
      real_name?: string;
    };
  };
  error?: string;
}

/**
 * Fetch user info from Slack API with KV caching
 */
export async function fetchUserInfo(
  userId: string,
  env: Env
): Promise<UserInfo | null> {
  const cacheKey = `${USER_INFO_CACHE_PREFIX}${userId}`;

  // Check cache first
  const cached = await env.DOCS_KV.get(cacheKey);
  if (cached) {
    return JSON.parse(cached) as UserInfo;
  }

  try {
    const url = `https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`;
    const data = await slackFetch<SlackUserResponse>(
      url,
      { method: "GET" },
      env.SLACK_BOT_TOKEN
    );

    if (!data.user) {
      console.error(`users.info returned no user for ${userId}`);
      return null;
    }

    const userInfo: UserInfo = {
      id: data.user.id,
      name: data.user.name,
      realName: data.user.real_name || data.user.profile?.real_name || null,
      title: data.user.profile?.title || null,
      email: data.user.profile?.email || null,
    };

    // Cache the result
    await env.DOCS_KV.put(cacheKey, JSON.stringify(userInfo), {
      expirationTtl: USER_INFO_CACHE_TTL_SECONDS,
    });

    return userInfo;
  } catch (error) {
    const errorMessage =
      error instanceof SlackApiError
        ? error.code
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(`Failed to fetch user info for ${userId}: ${errorMessage}`);
    return null;
  }
}
