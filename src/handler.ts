import type { Env, SlackPayload, SlackEventCallback } from "./types";
import { verifySlackSignature, fetchThreadMessages, postMessage } from "./slack";
import { convertThreadToMessages, generateResponse } from "./claude";

export const handler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const body = await request.text();

    // Verify Slack signature
    const isValid = await verifySlackSignature(request, body, env.SLACK_SIGNING_SECRET);
    if (!isValid) {
      return new Response("Invalid signature", { status: 401 });
    }

    const payload = JSON.parse(body) as SlackPayload;

    // Handle URL verification (Slack app setup)
    if (payload.type === "url_verification") {
      return new Response(payload.challenge, {
        headers: { "Content-Type": "text/plain" },
      });
    }

    // Handle event callbacks
    if (payload.type === "event_callback") {
      const event = payload.event;

      if (event.type === "app_mention") {
        // Acknowledge immediately, process in background
        ctx.waitUntil(handleMention(payload, env));
        return new Response("OK", { status: 200 });
      }
    }

    return new Response("OK", { status: 200 });
  },
};

export async function handleMention(payload: SlackEventCallback, env: Env): Promise<void> {
  const { event } = payload;
  const { channel, ts, thread_ts, text } = event;

  try {
    // Determine the thread context
    const threadTs = thread_ts ?? ts;
    let messages;

    if (thread_ts) {
      // Fetch existing thread history
      const threadMessages = await fetchThreadMessages(channel, thread_ts, env);
      messages = convertThreadToMessages(threadMessages, await getBotUserId(env));
    } else {
      // New thread - just use the current message
      const botUserId = await getBotUserId(env);
      messages = [
        {
          role: "user" as const,
          content: text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim(),
        },
      ];
    }

    // Generate response with Claude
    const response = await generateResponse(messages, env);

    // Post response to Slack
    await postMessage(channel, response, threadTs, env);
  } catch (error) {
    console.error("Error handling mention:", error);
    await postMessage(
      channel,
      "Sorry, I encountered an error processing your request.",
      thread_ts ?? ts,
      env
    );
  }
}

// Cache the bot user ID
let cachedBotUserId: string | null = null;

export async function getBotUserId(env: Env): Promise<string> {
  if (cachedBotUserId) {
    return cachedBotUserId;
  }

  const response = await fetch("https://slack.com/api/auth.test", {
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
    },
  });

  const data = (await response.json()) as { ok: boolean; user_id?: string };
  if (data.ok && data.user_id) {
    cachedBotUserId = data.user_id;
    return data.user_id;
  }

  throw new Error("Failed to get bot user ID");
}

// For testing - reset the cached bot user ID
export function resetBotUserIdCache(): void {
  cachedBotUserId = null;
}
