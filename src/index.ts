import { instrument } from "@microlabs/otel-cf-workers";
import { trace } from "@opentelemetry/api";
import type { Env, SlackPayload, SlackEventCallback } from "./types";
import { verifySlackSignature, fetchThreadMessages, postMessage } from "./slack";
import { convertThreadToMessages, generateResponse } from "./claude";
import { addDocument, removeDocument, listDocuments } from "./docs";
import { extractFileContent, titleFromFilename } from "./files";
import { traceConfig } from "./tracing";

/**
 * Parse doc commands from message text
 * Returns null if not a doc command
 */
function parseDocCommand(
  text: string,
  botUserId: string
): { type: "add"; title: string; content: string } | { type: "remove"; title: string } | { type: "list" } | null {
  // Remove bot mention and trim
  const cleaned = text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();

  // List docs: "docs" or "list docs"
  if (/^(list\s+)?docs$/i.test(cleaned)) {
    return { type: "list" };
  }

  // Add doc: add doc "Title": content
  const addMatch = cleaned.match(/^add\s+doc\s+"([^"]+)":\s*(.+)$/is);
  if (addMatch) {
    return { type: "add", title: addMatch[1], content: addMatch[2].trim() };
  }

  // Remove doc: remove doc "Title"
  const removeMatch = cleaned.match(/^remove\s+doc\s+"([^"]+)"$/i);
  if (removeMatch) {
    return { type: "remove", title: removeMatch[1] };
  }

  return null;
}

const handler = {
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

export default instrument(handler, traceConfig);

async function handleMention(payload: SlackEventCallback, env: Env): Promise<void> {
  const { event } = payload;
  const { channel, ts, thread_ts, text, user, files } = event;

  const tracer = trace.getTracer("chorus");
  await tracer.startActiveSpan("handleMention", async (span) => {
    span.setAttributes({
      "slack.channel": channel,
      "slack.user": user,
      "slack.thread_ts": thread_ts ?? ts,
      "slack.is_thread": !!thread_ts,
      "message.length": text.length,
      "slack.file_count": files?.length ?? 0,
    });

    try {
      const threadTs = thread_ts ?? ts;
      const botUserId = await getBotUserId(env);

      // Handle file uploads - add them as docs
      if (files && files.length > 0) {
        span.setAttribute("command.type", "file_upload");
        const results: string[] = [];

        for (const file of files) {
          try {
            const extracted = await extractFileContent(file, env);
            if (extracted) {
              const title = titleFromFilename(extracted.filename);
              const result = await addDocument(env, title, extracted.content, user);
              results.push(result.message);
            } else {
              results.push(`Couldn't extract text from "${file.name}" (unsupported format or empty).`);
            }
          } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            results.push(`Error processing "${file.name}": ${errMsg}`);
          }
        }

        await postMessage(channel, results.join("\n"), threadTs, env);
        span.setStatus({ code: 1 });
        return;
      }

      // Check for doc commands
      const docCommand = parseDocCommand(text, botUserId);

      if (docCommand) {
        span.setAttribute("command.type", docCommand.type);
        let response: string;

        if (docCommand.type === "list") {
          response = await listDocuments(env);
        } else if (docCommand.type === "add") {
          const result = await addDocument(env, docCommand.title, docCommand.content, user);
          response = result.message;
        } else {
          const result = await removeDocument(env, docCommand.title);
          response = result.message;
        }

        await postMessage(channel, response, threadTs, env);
        span.setStatus({ code: 1 });
        return;
      }

      // Regular message - route to Claude
      let messages;

      if (thread_ts) {
        // Fetch existing thread history
        const threadMessages = await fetchThreadMessages(channel, thread_ts, env);
        span.setAttribute("thread.message_count", threadMessages.length);
        messages = convertThreadToMessages(threadMessages, botUserId);
      } else {
        // New thread - just use the current message
        messages = [
          {
            role: "user" as const,
            content: text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim(),
          },
        ];
      }

      // Generate response with Claude
      const response = await generateResponse(messages, env);
      span.setAttribute("response.length", response.length);

      // Post response to Slack
      await postMessage(channel, response, threadTs, env);
      span.setStatus({ code: 1 }); // OK
    } catch (error) {
      span.setStatus({ code: 2, message: String(error) }); // ERROR
      span.recordException(error as Error);
      console.error("Error handling mention:", error);
      await postMessage(
        channel,
        "Sorry, I encountered an error processing your request.",
        thread_ts ?? ts,
        env
      );
    } finally {
      span.end();
    }
  });
}

// Cache the bot user ID
let cachedBotUserId: string | null = null;

async function getBotUserId(env: Env): Promise<string> {
  const tracer = trace.getTracer("chorus");
  return tracer.startActiveSpan("getBotUserId", async (span) => {
    const cacheHit = !!cachedBotUserId;
    span.setAttribute("cache.hit", cacheHit);

    if (cachedBotUserId) {
      span.end();
      return cachedBotUserId;
    }

    const response = await fetch("https://slack.com/api/auth.test", {
      headers: {
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      },
    });

    const data = (await response.json()) as { ok: boolean; user_id?: string };
    span.setAttribute("slack.api.ok", data.ok);

    if (data.ok && data.user_id) {
      cachedBotUserId = data.user_id;
      span.end();
      return data.user_id;
    }

    span.setStatus({ code: 2, message: "Failed to get bot user ID" });
    span.end();
    throw new Error("Failed to get bot user ID");
  });
}
