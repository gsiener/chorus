import type { Env, SlackPayload, SlackEventCallback, SlackReactionAddedEvent, SlackAppMentionEvent, InitiativeStatusValue, ExpectedMetric } from "./types";
import { verifySlackSignature, fetchThreadMessages, postMessage, updateMessage, addReaction } from "./slack";
import { convertThreadToMessages, generateResponse } from "./claude";
import { addDocument, removeDocument, listDocuments, backfillDocuments } from "./docs";
import { extractFileContent, titleFromFilename } from "./files";
import {
  addInitiative,
  getInitiative,
  removeInitiative,
  updateInitiativeStatus,
  updateInitiativePrd,
  addInitiativeMetric,
  listInitiatives,
  formatInitiative,
  formatInitiativeList,
} from "./initiatives";

// Rate limiting for doc commands (per user, per minute)
const DOC_COMMAND_RATE_LIMIT = 10;
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_KEY_PREFIX = "ratelimit:";

// Event deduplication (prevent duplicate responses from Slack retries)
const EVENT_DEDUP_TTL_SECONDS = 60; // 1 minute
const EVENT_DEDUP_KEY_PREFIX = "event:";

/**
 * Check if user is rate limited (using KV for global state across workers)
 */
async function isRateLimited(userId: string, env: Env): Promise<boolean> {
  const key = `${RATE_LIMIT_KEY_PREFIX}${userId}`;
  const now = Date.now();

  const stored = await env.DOCS_KV.get<{ count: number; resetTime: number }>(key, "json");

  if (!stored || now > stored.resetTime) {
    // Start new window
    await env.DOCS_KV.put(key, JSON.stringify({ count: 1, resetTime: now + RATE_LIMIT_WINDOW_SECONDS * 1000 }), {
      expirationTtl: RATE_LIMIT_WINDOW_SECONDS,
    });
    return false;
  }

  if (stored.count >= DOC_COMMAND_RATE_LIMIT) {
    return true;
  }

  // Increment count
  await env.DOCS_KV.put(key, JSON.stringify({ count: stored.count + 1, resetTime: stored.resetTime }), {
    expirationTtl: Math.ceil((stored.resetTime - now) / 1000),
  });
  return false;
}

/**
 * Check if an event has already been processed (deduplication using KV)
 * Returns true if duplicate, false if new event
 */
async function isDuplicateEvent(eventId: string, env: Env): Promise<boolean> {
  const key = `${EVENT_DEDUP_KEY_PREFIX}${eventId}`;

  const existing = await env.DOCS_KV.get(key);

  if (existing) {
    console.log(`Duplicate event detected: ${eventId}`);
    return true;
  }

  // Mark as processed with TTL
  await env.DOCS_KV.put(key, "1", { expirationTtl: EVENT_DEDUP_TTL_SECONDS });
  return false;
}

const HELP_TEXT = `*Chorus* — your chief of staff for product leadership.

*Initiatives:*
• \`@Chorus initiatives\` — list all initiatives
• \`@Chorus initiative add "Name" - owner @user - description: text\`
• \`@Chorus initiative "Name" show\` — view details
• \`@Chorus initiative "Name" update status [proposed|active|paused|completed|cancelled]\`
• \`@Chorus initiative "Name" update prd [url]\`
• \`@Chorus initiative "Name" add metric: [gtm|product] [name] - target: [target]\`
• \`@Chorus initiative "Name" remove\`

*Knowledge Base:*
• \`@Chorus docs\` — list documents
• \`@Chorus add doc "Title": content\`
• \`@Chorus remove doc "Title"\`
• \`@Chorus backfill docs\` — reindex all documents for semantic search
• Upload files to add them as docs

*Tips:*
• Ask me about product strategy, roadmap, or initiatives
• I'll gently remind you about missing PRDs or metrics

👍 or 👎 my responses to help me improve!`;

/**
 * Parse doc commands from message text
 * Returns null if not a doc command
 */
function parseDocCommand(
  text: string,
  botUserId: string
): { type: "add"; title: string; content: string } | { type: "remove"; title: string } | { type: "list" } | { type: "backfill" } | null {
  // Remove bot mention and trim
  const cleaned = text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();

  // List docs: "docs" or "list docs"
  if (/^(list\s+)?docs$/i.test(cleaned)) {
    return { type: "list" };
  }

  // Backfill docs: "backfill docs"
  if (/^backfill\s+docs$/i.test(cleaned)) {
    return { type: "backfill" };
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

// Initiative command types
type InitiativeCommand =
  | { type: "list"; filters?: { owner?: string; status?: InitiativeStatusValue } }
  | { type: "add"; name: string; owner: string; description: string }
  | { type: "show"; name: string }
  | { type: "update-status"; name: string; status: InitiativeStatusValue }
  | { type: "update-prd"; name: string; prdLink: string }
  | { type: "add-metric"; name: string; metric: ExpectedMetric }
  | { type: "remove"; name: string };

const VALID_STATUSES: InitiativeStatusValue[] = ["proposed", "active", "paused", "completed", "cancelled"];

/**
 * Parse initiative commands from message text
 * Returns null if not an initiative command
 */
function parseInitiativeCommand(
  text: string,
  botUserId: string
): InitiativeCommand | null {
  const cleaned = text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();

  // List initiatives: "initiatives" or "initiative list"
  if (/^initiatives?$/i.test(cleaned) || /^initiatives?\s+list$/i.test(cleaned)) {
    return { type: "list" };
  }

  // List with filters: "initiatives --mine" or "initiatives --status active"
  const listFilterMatch = cleaned.match(/^initiatives?\s+list\s+(.+)$/i) ||
    cleaned.match(/^initiatives?\s+(--\S+.*)$/i);
  if (listFilterMatch) {
    const filters: { owner?: string; status?: InitiativeStatusValue } = {};
    const filterStr = listFilterMatch[1];

    if (/--mine/i.test(filterStr)) {
      // Will be filled in by caller with current user
      filters.owner = "__CURRENT_USER__";
    }

    const statusMatch = filterStr.match(/--status\s+(\w+)/i);
    if (statusMatch && VALID_STATUSES.includes(statusMatch[1].toLowerCase() as InitiativeStatusValue)) {
      filters.status = statusMatch[1].toLowerCase() as InitiativeStatusValue;
    }

    return { type: "list", filters };
  }

  // Add initiative: initiative add "Name" - owner @user - description: text
  const addMatch = cleaned.match(
    /^initiative\s+add\s+"([^"]+)"\s*-\s*owner\s+<@(\w+)>\s*-\s*description:\s*(.+)$/is
  );
  if (addMatch) {
    return {
      type: "add",
      name: addMatch[1],
      owner: addMatch[2],
      description: addMatch[3].trim(),
    };
  }

  // Show initiative: initiative "Name" show OR initiative show "Name"
  const showMatch = cleaned.match(/^initiative\s+"([^"]+)"\s+show$/i) ||
    cleaned.match(/^initiative\s+show\s+"([^"]+)"$/i);
  if (showMatch) {
    return { type: "show", name: showMatch[1] };
  }

  // Update status: initiative "Name" update status [status]
  const statusMatch = cleaned.match(
    /^initiative\s+"([^"]+)"\s+update\s+status\s+(\w+)$/i
  );
  if (statusMatch) {
    const status = statusMatch[2].toLowerCase();
    if (VALID_STATUSES.includes(status as InitiativeStatusValue)) {
      return {
        type: "update-status",
        name: statusMatch[1],
        status: status as InitiativeStatusValue,
      };
    }
  }

  // Update PRD: initiative "Name" update prd [url]
  const prdMatch = cleaned.match(
    /^initiative\s+"([^"]+)"\s+update\s+prd\s+(.+)$/i
  );
  if (prdMatch) {
    return {
      type: "update-prd",
      name: prdMatch[1],
      prdLink: prdMatch[2].trim().replace(/^<|>$/g, ""), // Remove Slack URL formatting
    };
  }

  // Add metric: initiative "Name" add metric: [gtm|product] [name] - target: [target]
  const metricMatch = cleaned.match(
    /^initiative\s+"([^"]+)"\s+add\s+metric:\s*(gtm|product)\s+(.+?)\s*-\s*target:\s*(.+)$/i
  );
  if (metricMatch) {
    return {
      type: "add-metric",
      name: metricMatch[1],
      metric: {
        type: metricMatch[2].toLowerCase() as "gtm" | "product",
        name: metricMatch[3].trim(),
        target: metricMatch[4].trim(),
      },
    };
  }

  // Remove initiative: initiative "Name" remove
  const removeMatch = cleaned.match(/^initiative\s+"([^"]+)"\s+remove$/i);
  if (removeMatch) {
    return { type: "remove", name: removeMatch[1] };
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
      if (await isDuplicateEvent(payload.event_id, env)) {
        return new Response("OK", { status: 200 });
      }

      if (event.type === "app_mention") {
        // Acknowledge immediately, process in background
        ctx.waitUntil(handleMention(payload, env));
        return new Response("OK", { status: 200 });
      }

      if (event.type === "reaction_added") {
        // Track feedback reactions in background
        ctx.waitUntil(handleReaction(payload, env));
        return new Response("OK", { status: 200 });
      }
    }

    return new Response("OK", { status: 200 });
  },
};

// Default export for Cloudflare Workers
export default handler;

async function handleMention(payload: SlackEventCallback, env: Env): Promise<void> {
  const event = payload.event as SlackAppMentionEvent;
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

    // Check for initiative commands
    const initCommand = parseInitiativeCommand(text, botUserId);

    if (initCommand) {
      let response: string;

      switch (initCommand.type) {
        case "list": {
          const filters = initCommand.filters;
          if (filters?.owner === "__CURRENT_USER__") {
            filters.owner = user;
          }
          const initiatives = await listInitiatives(env, filters);
          response = formatInitiativeList(initiatives);
          break;
        }
        case "add": {
          const result = await addInitiative(
            env,
            initCommand.name,
            initCommand.description,
            initCommand.owner,
            user
          );
          response = result.message;
          break;
        }
        case "show": {
          const initiative = await getInitiative(env, initCommand.name);
          response = initiative
            ? formatInitiative(initiative)
            : `Initiative "${initCommand.name}" not found.`;
          break;
        }
        case "update-status": {
          const result = await updateInitiativeStatus(
            env,
            initCommand.name,
            initCommand.status,
            user
          );
          response = result.message;
          break;
        }
        case "update-prd": {
          const result = await updateInitiativePrd(
            env,
            initCommand.name,
            initCommand.prdLink,
            user
          );
          response = result.message;
          break;
        }
        case "add-metric": {
          const result = await addInitiativeMetric(
            env,
            initCommand.name,
            initCommand.metric,
            user
          );
          response = result.message;
          break;
        }
        case "remove": {
          const result = await removeInitiative(env, initCommand.name);
          response = result.message;
          break;
        }
      }

      await postMessage(channel, response, threadTs, env);
      return;
    }

    // Check for doc commands
    const docCommand = parseDocCommand(text, botUserId);

    if (docCommand) {
      // Rate limit doc commands (except list)
      if (docCommand.type !== "list" && await isRateLimited(user, env)) {
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
      } else if (docCommand.type === "backfill") {
        // Post initial message
        await postMessage(channel, "Starting backfill of documents for semantic search...", threadTs, env);
        const result = await backfillDocuments(env);
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

    // Post a "thinking" message
    const thinkingTs = await postMessage(channel, "✨ Thinking...", threadTs, env);

    if (!thinkingTs) {
      throw new Error("Failed to post thinking message");
    }

    // Generate response
    const result = await generateResponse(messages, env);

    // Update with final response
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

/**
 * Handle reaction_added events for feedback tracking (PDD-24)
 * Logs thumbsup/thumbsdown reactions on bot messages to Honeycomb
 */
async function handleReaction(payload: SlackEventCallback, env: Env): Promise<void> {
  const event = payload.event as SlackReactionAddedEvent;
  const { reaction, user, item } = event;

  // Only track thumbsup/thumbsdown reactions
  if (reaction !== "+1" && reaction !== "-1" && reaction !== "thumbsup" && reaction !== "thumbsdown") {
    return;
  }

  try {
    const botUserId = await getBotUserId(env);

    // Only track reactions on bot messages
    if (event.item_user !== botUserId) {
      return;
    }

    const feedback = reaction === "+1" || reaction === "thumbsup" ? "positive" : "negative";

    // Log feedback for Honeycomb (via Workers observability)
    console.log(JSON.stringify({
      type: "feedback",
      feedback,
      reaction,
      user,
      channel: item.channel,
      message_ts: item.ts,
      timestamp: new Date().toISOString(),
    }));

  } catch (error) {
    console.error("Error handling reaction:", error);
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
