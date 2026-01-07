import type {
  Env,
  SlackPayload,
  SlackEventCallback,
  SlackReactionAddedEvent,
  SlackAppMentionEvent,
  InitiativeStatusValue,
} from "../types";
import {
  parseDocCommand,
  parseInitiativeCommand,
  parseSearchCommand,
  VALID_STATUSES,
} from "../parseCommands";
import { verifySlackSignature, fetchThreadMessages, postMessage, updateMessage, addReaction } from "../slack";
import { convertThreadToMessages, generateResponse, ThreadInfo, CLAUDE_MODEL } from "../claude";
import { addDocument, removeDocument, listDocuments, backfillDocuments, getRandomDocument } from "../docs";
import { extractFileContent, titleFromFilename } from "../files";
import {
  addInitiative,
  getInitiative,
  removeInitiative,
  updateInitiativeStatus,
  updateInitiativePrd,
  updateInitiativeName,
  updateInitiativeDescription,
  updateInitiativeOwner,
  addInitiativeMetric,
  listInitiatives,
  formatInitiative,
  formatInitiativeList,
  searchInitiatives,
} from "../initiatives";
import { searchDocuments, formatSearchResultsForUser } from "../embeddings";
import { syncLinearProjects } from "../linear";
import { trace } from "@opentelemetry/api";
import {
  recordCommand,
  recordCategorizedError,
  recordFeedback,
  recordRequestContext,
  recordThreadContext,
  recordSearchResults,
  recordClaudeResponse,
  recordFileProcessing,
  recordRateLimit,
  recordSlackLatency,
} from "../telemetry";
import { mightBeInitiativeCommand, processNaturalLanguageCommand } from "../initiative-nlp";
import { isRateLimited } from "../rate-limiting";
import { Context } from "hono";



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

import { HELP_TEXT } from "../constants";


export async function handleSlashCommand(c: Context<{ Bindings: Env }>): Promise<Response> {
  const body = await c.req.text();
  const env = c.env;

  // Verify Slack signature
  const isValid = await verifySlackSignature(c.req.raw, body, env.SLACK_SIGNING_SECRET);
  if (!isValid) {
    return c.text("Invalid signature", 401);
  }

  // Parse form data
  const params = new URLSearchParams(body);
  const command = params.get("command") || "";
  const text = params.get("text") || "";
  const userId = params.get("user_id") || "";

  recordCommand(`slash:${command.replace("/", "")}`);

  // Route based on command
  let response: string;

  if (command === "/chorus" || command === "/chorus-help") {
    // Main help command
    response = HELP_TEXT;
  } else if (command === "/chorus-initiatives" || (command === "/chorus" && text.toLowerCase().startsWith("initiatives"))) {
    // List initiatives
    const textParts = text.toLowerCase().replace(/^initiatives?\s*/i, "");
    const filters: { owner?: string; status?: InitiativeStatusValue } = {};

    if (textParts.includes("mine")) {
      filters.owner = userId;
    }

    for (const status of VALID_STATUSES) {
      if (textParts.includes(status)) {
        filters.status = status;
        break;
      }
    }

    const initiatives = await listInitiatives(env, Object.keys(filters).length > 0 ? filters : undefined);
    response = formatInitiativeList(initiatives);
  } else if (command === "/chorus-search" || (command === "/chorus" && text.toLowerCase().startsWith("search"))) {
    // Search
    const query = text.replace(/^search\s*/i, "").trim();

    if (!query) {
      response = "Please provide a search query. Usage: `/chorus-search <query>`";
    } else {
      // Rate limit search
      if (await isRateLimited(userId, "search", env)) {
        response = "You're searching too quickly. Please wait a moment.";
      } else {
        const [docResults, initiativeResults] = await Promise.all([
          searchDocuments(query, env, 5),
          searchInitiatives(env, query, 5),
        ]);

        const sections: string[] = [];

        if (docResults.length > 0) {
          sections.push(formatSearchResultsForUser(docResults));
        }

        if (initiativeResults.length > 0) {
          const initLines: string[] = [`*Initiative Results* (${initiativeResults.length} found)`];
          for (const result of initiativeResults) {
            const statusEmoji = result.initiative.status === "active" ? "🟢" :
              result.initiative.status === "proposed" ? "🟡" :
              result.initiative.status === "completed" ? "✅" :
              result.initiative.status === "paused" ? "⏸️" : "❌";
            initLines.push(`${statusEmoji} *${result.initiative.name}* (${result.initiative.status})`);
          }
          sections.push(initLines.join("\n"));
        }

        response = sections.length > 0 ? sections.join("\n\n---\n\n") : `No results found for "${query}".`;
      }
    }
  } else if (command === "/chorus-docs") {
    // List docs
    response = await listDocuments(env);
  } else {
    // Unknown command - show help
    response = `Unknown command. Try:\n• 
/chorus - Get help\n• 
/chorus initiatives - List initiatives\n• 
/chorus search <query> - Search everything\n• 
/chorus-docs - List documents`;
  }

  // Return ephemeral response (only visible to the user who triggered the command)
  return c.json({
    response_type: "ephemeral",
    text: response,
  });
}

export async function handleSlackEvents(c: Context<{ Bindings: Env }>): Promise<Response> {
    const env = c.env;
    const body = await c.req.text();

    // Verify Slack signature
    const isValid = await verifySlackSignature(c.req.raw, body, env.SLACK_SIGNING_SECRET);
    if (!isValid) {
      return c.text("Invalid signature", 401);
    }

    const payload = JSON.parse(body) as SlackPayload;

    // Handle URL verification (Slack app setup)
    if (payload.type === "url_verification") {
      return c.text(payload.challenge);
    }

    // Handle event callbacks
    if (payload.type === "event_callback") {
      const event = payload.event;

      // Deduplicate events (Slack may retry)
      if (await isDuplicateEvent(payload.event_id, env)) {
        return c.text("OK");
      }

      if (event.type === "app_mention") {
        // Acknowledge immediately, process in background
        c.executionCtx.waitUntil(handleMention(payload, env));
        return c.text("OK");
      }

      if (event.type === "reaction_added") {
        // Track feedback reactions in background
        c.executionCtx.waitUntil(handleReaction(payload, env));
        return c.text("OK");
      }
    }

    return c.text("OK");
}


async function handleMention(payload: SlackEventCallback, env: Env): Promise<void> {
  const event = payload.event as SlackAppMentionEvent;
  const { channel, ts, thread_ts, text, user, files } = event;

  recordRequestContext({
    userId: user,
    channel,
    messageLength: text.length,
    isThread: !!thread_ts,
    threadTs: thread_ts,
    hasFiles: !!(files && files.length > 0),
    fileCount: files?.length ?? 0,
    eventType: "app_mention",
  });

  const span = trace.getActiveSpan();
  span?.setAttributes({
    "gen_ai.operation.name": "chat",
    "gen_ai.system": "anthropic",
    "gen_ai.request.model": CLAUDE_MODEL,
  });

  try {
    const botUserId = await getBotUserId(env);
    const command = getCommand(event, botUserId);

    if (command) {
      await command.execute(event, botUserId, env);
    }
  } catch (error) {
    console.error("Error handling mention:", error);
    if (error instanceof Error) {
      recordCategorizedError(error, "handleMention");
    }
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

    // Record feedback using OTel best practices
    // This uses span events, span attributes, and structured logging
    recordFeedback(feedback, {
      reaction,
      userId: user,
      channel: item.channel,
      messageTs: item.ts,
    });

  } catch (error) {
    console.error("Error handling reaction:", error);
    if (error instanceof Error) {
      recordCategorizedError(error, "handleReaction");
    }
  }
}

// Cache the bot user ID with TTL (1 hour)
const BOT_ID_CACHE_TTL_MS = 60 * 60 * 1000;
let cachedBotUserId: string | null = null;
let botUserIdCacheExpiry = 0;

export async function getBotUserId(env: Env): Promise<string> {
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
