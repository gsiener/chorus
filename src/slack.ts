/**
 * Slack API integration with typed errors using Effect
 */

import { Effect, Context, Layer, pipe } from "effect";
import type { Env, SlackMessage, SlackThreadResponse, SlackPostResponse } from "./types";

// Typed error classes

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

// Service definition

export interface SlackServiceConfig {
  readonly botToken: string;
  readonly signingSecret: string;
}

export class SlackService extends Context.Tag("SlackService")<
  SlackService,
  SlackServiceConfig
>() {}

export const SlackServiceLive = (botToken: string, signingSecret: string) =>
  Layer.succeed(SlackService, { botToken, signingSecret });

const envToLayer = (env: Env) =>
  SlackServiceLive(env.SLACK_BOT_TOKEN, env.SLACK_SIGNING_SECRET);

// Effect-based signature verification

export function verifySignatureEffect(
  request: Request,
  body: string
): Effect.Effect<boolean, SignatureVerificationError, SlackService> {
  return Effect.gen(function* () {
    const { signingSecret } = yield* SlackService;

    const timestamp = request.headers.get("x-slack-request-timestamp");
    const signature = request.headers.get("x-slack-signature");

    if (!timestamp || !signature) {
      return yield* Effect.fail(new SignatureVerificationError("missing_headers"));
    }

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(timestamp)) > 5) {
      return yield* Effect.fail(new SignatureVerificationError("timestamp_expired"));
    }

    const sigBaseString = `v0:${timestamp}:${body}`;
    const encoder = new TextEncoder();

    const key = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey(
          "raw",
          encoder.encode(signingSecret),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"]
        ),
      catch: () => new SignatureVerificationError("signature_mismatch"),
    });

    const signatureBuffer = yield* Effect.tryPromise({
      try: () => crypto.subtle.sign("HMAC", key, encoder.encode(sigBaseString)),
      catch: () => new SignatureVerificationError("signature_mismatch"),
    });

    const computedSignature =
      "v0=" +
      Array.from(new Uint8Array(signatureBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

    if (signature !== computedSignature) {
      return yield* Effect.fail(new SignatureVerificationError("signature_mismatch"));
    }

    return true;
  });
}

// Promise-based wrapper
export async function verifySlackSignature(
  request: Request,
  body: string,
  signingSecret: string
): Promise<boolean> {
  const layer = SlackServiceLive("", signingSecret);
  return Effect.runPromise(
    Effect.provide(verifySignatureEffect(request, body), layer).pipe(
      Effect.catchAll(() => Effect.succeed(false))
    )
  );
}

// API helpers

function slackFetch<T>(
  url: string,
  options: RequestInit,
  method: string
): Effect.Effect<T, SlackApiError, SlackService> {
  return Effect.gen(function* () {
    const { botToken } = yield* SlackService;

    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(url, {
          ...options,
          headers: {
            Authorization: `Bearer ${botToken}`,
            ...options.headers,
          },
        }),
      catch: (e) => new SlackApiError(String(e), method),
    });

    const data = (yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => new SlackApiError("json_parse_error", method),
    })) as { ok: boolean; error?: string } & T;

    if (!data.ok) {
      return yield* Effect.fail(new SlackApiError(data.error ?? "unknown", method));
    }

    return data as T;
  });
}

// Thread messages

interface ThreadResponse {
  ok: boolean;
  messages?: SlackMessage[];
  error?: string;
}

export function fetchThreadMessagesEffect(
  channel: string,
  threadTs: string
): Effect.Effect<SlackMessage[], SlackApiError, SlackService> {
  return pipe(
    slackFetch<ThreadResponse>(
      `https://slack.com/api/conversations.replies?channel=${channel}&ts=${threadTs}`,
      {},
      "conversations.replies"
    ),
    Effect.map((data) =>
      (data.messages ?? []).sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts))
    )
  );
}

export async function fetchThreadMessages(
  channel: string,
  threadTs: string,
  env: Env
): Promise<SlackMessage[]> {
  return Effect.runPromise(
    Effect.provide(fetchThreadMessagesEffect(channel, threadTs), envToLayer(env)).pipe(
      Effect.catchAll(() => Effect.succeed([] as SlackMessage[]))
    )
  );
}

// Post message

interface PostResponse {
  ok: boolean;
  ts?: string;
  error?: string;
}

export function postMessageEffect(
  channel: string,
  text: string,
  threadTs: string | undefined
): Effect.Effect<string, SlackApiError, SlackService> {
  return pipe(
    slackFetch<PostResponse>(
      "https://slack.com/api/chat.postMessage",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, text, thread_ts: threadTs }),
      },
      "chat.postMessage"
    ),
    Effect.map((data) => data.ts ?? "")
  );
}

export async function postMessage(
  channel: string,
  text: string,
  threadTs: string | undefined,
  env: Env
): Promise<string | null> {
  return Effect.runPromise(
    Effect.provide(postMessageEffect(channel, text, threadTs), envToLayer(env)).pipe(
      Effect.catchAll(() => Effect.succeed(null as string | null))
    )
  );
}

// Update message

export function updateMessageEffect(
  channel: string,
  ts: string,
  text: string
): Effect.Effect<boolean, SlackApiError, SlackService> {
  return pipe(
    slackFetch<{ ok: boolean }>(
      "https://slack.com/api/chat.update",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, ts, text }),
      },
      "chat.update"
    ),
    Effect.map(() => true)
  );
}

export async function updateMessage(
  channel: string,
  ts: string,
  text: string,
  env: Env
): Promise<boolean> {
  return Effect.runPromise(
    Effect.provide(updateMessageEffect(channel, ts, text), envToLayer(env)).pipe(
      Effect.catchAll(() => Effect.succeed(false))
    )
  );
}

// Add reaction

export function addReactionEffect(
  channel: string,
  ts: string,
  emoji: string
): Effect.Effect<boolean, SlackApiError, SlackService> {
  return Effect.gen(function* () {
    const { botToken } = yield* SlackService;

    const response = yield* Effect.tryPromise({
      try: () =>
        fetch("https://slack.com/api/reactions.add", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${botToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ channel, timestamp: ts, name: emoji }),
        }),
      catch: (e) => new SlackApiError(String(e), "reactions.add"),
    });

    const data = (yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => new SlackApiError("json_parse_error", "reactions.add"),
    })) as { ok: boolean; error?: string };

    if (!data.ok && data.error !== "already_reacted") {
      return yield* Effect.fail(new SlackApiError(data.error ?? "unknown", "reactions.add"));
    }

    return true;
  });
}

export async function addReaction(
  channel: string,
  ts: string,
  emoji: string,
  env: Env
): Promise<boolean> {
  return Effect.runPromise(
    Effect.provide(addReactionEffect(channel, ts, emoji), envToLayer(env)).pipe(
      Effect.catchAll(() => Effect.succeed(false))
    )
  );
}

// Post direct message

interface ConversationOpenResponse {
  ok: boolean;
  channel?: { id: string };
  error?: string;
}

export function postDirectMessageEffect(
  userId: string,
  text: string
): Effect.Effect<string, SlackApiError, SlackService> {
  return Effect.gen(function* () {
    const openData = yield* slackFetch<ConversationOpenResponse>(
      "https://slack.com/api/conversations.open",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ users: userId }),
      },
      "conversations.open"
    );

    if (!openData.channel) {
      return yield* Effect.fail(new SlackApiError("no_channel_returned", "conversations.open"));
    }

    return yield* postMessageEffect(openData.channel.id, text, undefined);
  });
}

export async function postDirectMessage(
  userId: string,
  text: string,
  env: Env
): Promise<string | null> {
  return Effect.runPromise(
    Effect.provide(postDirectMessageEffect(userId, text), envToLayer(env)).pipe(
      Effect.catchAll(() => Effect.succeed(null as string | null))
    )
  );
}
