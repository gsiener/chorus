import type { Env, SlackPayload, SlackEventCallback } from "./types";
import { verifySlackSignature, fetchThreadMessages, postMessage, updateMessage, addReaction } from "./slack";
import { convertThreadToMessages, generateResponseStreaming } from "./claude";
import { addDocument, removeDocument, listDocuments } from "./docs";
import { extractFileContent, titleFromFilename } from "./files";

// Rate limiting for doc commands (per user, per minute)
const DOC_COMMAND_RATE_LIMIT = 10;
const RATE_LIMIT_WINDOW_MS = 60000;
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();

// Event deduplication (prevent duplicate responses from Slack retries)
const EVENT_DEDUP_TTL_MS = 60000; // 1 minute
const processedEvents = new Map<string, number>();

function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);

  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(userId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  if (entry.count >= DOC_COMMAND_RATE_LIMIT) {
    return true;
  }

  entry.count++;
  return false;
}

/**
 * Check if an event has already been processed (deduplication)
 */
function isDuplicateEvent(eventId: string): boolean {
  const now = Date.now();

  // Clean up old entries
  for (const [id, timestamp] of processedEvents) {
    if (now - timestamp > EVENT_DEDUP_TTL_MS) {
      processedEvents.delete(id);
    }
  }

  if (processedEvents.has(eventId)) {
    console.log(`Duplicate event detected: ${eventId}`);
    return true;
  }

  processedEvents.set(eventId, now);
  return false;
}

const HELP_TEXT = `*Chorus* — your internal assistant for product, roadmap, and strategy.

*Commands:*
• \`@Chorus help\` — show this message
• \`@Chorus docs\` — list knowledge base documents
• \`@Chorus add doc "Title": content\` — add a document
• \`@Chorus remove doc "Title"\` — remove a document

*Tips:*
• Upload text files to add them to the knowledge base
• Ask me anything about product strategy, roadmap, or priorities
• I'll use the knowledge base to give you accurate answers

👍 or 👎 my responses to help me improve!`;

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

// Export handler for testing
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

      // Deduplicate events (Slack may retry)
      if (isDuplicateEvent(payload.event_id)) {
        return new Response("OK", { status: 200 });
      }

      if (event.type === "app_mention") {
        // Acknowledge immediately, process in background
        ctx.waitUntil(handleMention(payload, env));
        return new Response("OK", { status: 200 });
      }
    }

    return new Response("OK", { status: 200 });
  },
};

// Default export for Cloudflare Workers
export default handler;

async function handleMention(payload: SlackEventCallback, env: Env): Promise<void> {
  const { event } = payload;
  const { channel, ts, thread_ts, text, user, files } = event;

  try {
    const threadTs = thread_ts ?? ts;
    const botUserId = await getBotUserId(env);
    const cleanedText = text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();

    // Handle help command
    if (/^help$/i.test(cleanedText)) {
      await postMessage(channel, HELP_TEXT, threadTs, env);
      return;
    }

    // Handle file uploads - add them as docs
    if (files && files.length > 0) {
      // Send immediate acknowledgment
      const fileNames = files.map(f => f.name).join(", ");
      await postMessage(channel, `📄 Processing ${files.length > 1 ? "files" : "file"}: ${fileNames}...`, threadTs, env);

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
      return;
    }

    // Check for doc commands
    const docCommand = parseDocCommand(text, botUserId);

    if (docCommand) {
      // Rate limit doc commands (except list)
      if (docCommand.type !== "list" && isRateLimited(user)) {
        await postMessage(
          channel,
          "You're adding documents too quickly. Please wait a minute before trying again.",
          threadTs,
          env
        );
        return;
      }

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
      return;
    }

    // Regular message - route to Claude
    let messages;

    if (thread_ts) {
      // Fetch existing thread history
      const threadMessages = await fetchThreadMessages(channel, thread_ts, env);
      messages = convertThreadToMessages(threadMessages, botUserId);
    } else {
      // New thread - just use the current message
      messages = [
        {
          role: "user" as const,
          content: cleanedText,
        },
      ];
    }

    // Post a "thinking" message that we'll update with streaming response
    const thinkingTs = await postMessage(channel, "✨ Thinking...", threadTs, env);

    if (!thinkingTs) {
      throw new Error("Failed to post thinking message");
    }

    // Generate response with streaming
    let currentText = "";
    let lastUpdateTime = 0;
    const UPDATE_INTERVAL_MS = 1000; // Update Slack at most every 1 second

    const result = await generateResponseStreaming(messages, env, async (chunk) => {
      currentText += chunk;
      const now = Date.now();

      // Rate limit updates to avoid Slack API limits
      if (now - lastUpdateTime >= UPDATE_INTERVAL_MS) {
        await updateMessage(channel, thinkingTs, currentText + " ✨", env);
        lastUpdateTime = now;
      }
    });

    // Final update with complete response (remove thinking indicator)
    await updateMessage(channel, thinkingTs, result.text, env);

    // Add feedback reactions to the response
    await addReaction(channel, thinkingTs, "thumbsup", env);
    await addReaction(channel, thinkingTs, "thumbsdown", env);

    // Log metrics
    console.log(`Response complete: cached=${result.cached}, tokens=${result.inputTokens + result.outputTokens}`);
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

// Cache the bot user ID with TTL (1 hour)
const BOT_ID_CACHE_TTL_MS = 60 * 60 * 1000;
let cachedBotUserId: string | null = null;
let botUserIdCacheExpiry = 0;

async function getBotUserId(env: Env): Promise<string> {
  const now = Date.now();

  if (cachedBotUserId && now < botUserIdCacheExpiry) {
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
    botUserIdCacheExpiry = now + BOT_ID_CACHE_TTL_MS;
    return data.user_id;
  }

  throw new Error("Failed to get bot user ID");
}

// For testing - reset the cached bot user ID
export function resetBotUserIdCache(): void {
  cachedBotUserId = null;
  botUserIdCacheExpiry = 0;
}
