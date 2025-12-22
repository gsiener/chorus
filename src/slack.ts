import { trace } from "@opentelemetry/api";
import type { Env, SlackMessage, SlackThreadResponse, SlackPostResponse } from "./types";

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

  // Check timestamp is within 5 minutes to prevent replay attacks
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
  const tracer = trace.getTracer("chorus");
  return tracer.startActiveSpan("fetchThreadMessages", async (span) => {
    span.setAttributes({
      "slack.api.method": "conversations.replies",
      "slack.channel": channel,
      "slack.thread_ts": threadTs,
    });

    const response = await fetch(
      `https://slack.com/api/conversations.replies?channel=${channel}&ts=${threadTs}`,
      {
        headers: {
          Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        },
      }
    );

    const data = (await response.json()) as SlackThreadResponse;
    span.setAttribute("slack.api.ok", data.ok);

    if (!data.ok || !data.messages) {
      console.error("Failed to fetch thread:", data.error);
      span.setStatus({ code: 2, message: data.error ?? "Unknown error" });
      span.end();
      return [];
    }

    span.setAttribute("slack.message_count", data.messages.length);
    span.end();
    return data.messages;
  });
}

export async function postMessage(
  channel: string,
  text: string,
  threadTs: string | undefined,
  env: Env
): Promise<boolean> {
  const tracer = trace.getTracer("chorus");
  return tracer.startActiveSpan("postMessage", async (span) => {
    span.setAttributes({
      "slack.api.method": "chat.postMessage",
      "slack.channel": channel,
      "slack.thread_ts": threadTs ?? "",
      "message.length": text.length,
    });

    const response = await fetch("https://slack.com/api/chat.postMessage", {
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
    });

    const data = (await response.json()) as SlackPostResponse;
    span.setAttribute("slack.api.ok", data.ok);

    if (!data.ok) {
      console.error("Failed to post message:", data.error);
      span.setStatus({ code: 2, message: data.error ?? "Unknown error" });
      span.end();
      return false;
    }

    span.end();
    return true;
  });
}
