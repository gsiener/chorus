import type { Env, SlackPayload, SlackEventCallback, SlackReactionAddedEvent, SlackAppMentionEvent } from "./types";
import {
  parseDocCommand,
  parseSearchCommand,
  parseCheckInCommand,
} from "./parseCommands";
import { verifySlackSignature, fetchThreadMessages, postMessage, updateMessage, addReaction } from "./slack";
import { convertThreadToMessages, generateResponse, generateResponseStreaming, ThreadInfo, CLAUDE_MODEL } from "./claude";
import { TimeoutError } from "./http-utils";
import { addDocument, updateDocument, removeDocument, listDocuments, backfillDocuments, getRandomDocument, backfillIfNeeded } from "./docs";
import { extractFileContent, titleFromFilename } from "./files";
import { searchDocuments, formatSearchResultsForUser } from "./embeddings";
import { sendWeeklyCheckins, listUserCheckIns, formatCheckInHistory } from "./checkins";
import { getPrioritiesContext, fetchPriorityInitiatives, clearPrioritiesCache, warmPrioritiesCache } from "./linear-priorities";
import { getAmplitudeMetrics, clearAmplitudeCache, sendWeeklyMetricsReport, sendTestMetricsReport, warmAmplitudeCache } from "./amplitude";
import { checkInitiativeBriefs, formatBriefCheckResults } from "./brief-checker";
import { storeFeedbackRecord, updateFeedbackWithReaction, handleFeedbackPage } from "./feedback";
import { instrument, ResolveConfigFn } from "@microlabs/otel-cf-workers";
import {
  recordAgentInvocation,
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
} from "./telemetry";
import {
  RATE_LIMIT_WINDOW_SECONDS,
  RATE_LIMIT_KEY_PREFIX,
  RATE_LIMITS,
  EVENT_DEDUP_TTL_SECONDS,
  EVENT_DEDUP_KEY_PREFIX,
  BOT_ID_CACHE_TTL_MS,
} from "./constants";

// OpenTelemetry configuration for Honeycomb export
const otelConfig: ResolveConfigFn = (env: Env, _trigger) => ({
  exporter: {
    url: "https://api.honeycomb.io/v1/traces",
    headers: {
      "x-honeycomb-team": env.HONEYCOMB_API_KEY,
      "x-honeycomb-dataset": "chorus",
    },
  },
  service: {
    name: "chorus",
  },
});

// Rate limiting and event deduplication constants imported from ./constants

/**
 * Check if user is rate limited for a specific command type
 * Uses KV for global state across workers
 */
async function isRateLimited(
  userId: string,
  commandType: string,
  env: Env
): Promise<boolean> {
  const key = `${RATE_LIMIT_KEY_PREFIX}${commandType}:${userId}`;
  const now = Date.now();
  const limit = RATE_LIMITS[commandType] ?? RATE_LIMITS.default;

  const stored = await env.DOCS_KV.get<{ count: number; resetTime: number }>(key, "json");

  if (!stored || now > stored.resetTime) {
    // Start new window
    await env.DOCS_KV.put(key, JSON.stringify({ count: 1, resetTime: now + RATE_LIMIT_WINDOW_SECONDS * 1000 }), {
      expirationTtl: RATE_LIMIT_WINDOW_SECONDS,
    });
    return false;
  }

  if (stored.count >= limit) {
    console.log(`Rate limit hit for ${commandType} by user ${userId}: ${stored.count}/${limit}`);
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

const HELP_TEXT = `*Chorus* — your AI chief of staff for product leadership.

*Quick Start:*
Just ask me anything about your product strategy, roadmap, or initiatives in natural language! I have context on your knowledge base and R&D Priorities from Linear.

*Search:*
• \`@Chorus search "query"\` — find docs and PRDs

*Knowledge Base:*
• \`@Chorus docs\` — list all documents
• \`@Chorus add doc "Title": content\` — add inline
• \`@Chorus remove doc "Title"\`
• \`@Chorus surprise me\` — discover a random doc
• Upload files (text, markdown, JSON, CSV) to add them as docs
• \`@Chorus backfill docs\` — reindex for semantic search

*Admin Commands:*
• \`@Chorus check-briefs\` — check initiatives for missing briefs, DM owners

*Pro Tips:*
• I remember context within threads — just keep chatting!
• Initiative owners get weekly DM check-ins
• 👍 or 👎 my responses to help me improve`;

/**
 * Verify API key from Authorization header
 */
function verifyApiKey(request: Request, env: Env): boolean {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return false;
  }
  const token = authHeader.slice(7);
  return token === env.DOCS_API_KEY;
}

/**
 * Handle /api/test-checkin - trigger a test check-in DM
 */
async function handleTestCheckin(request: Request, env: Env): Promise<Response> {
  // Verify API key
  if (!verifyApiKey(request, env)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  console.log("Manual test check-in triggered via API");
  const result = await sendWeeklyCheckins(env);

  return new Response(JSON.stringify(result), {
    status: result.success ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Handle /api/debug/priorities - debug Linear priorities integration
 */
async function handleDebugPriorities(request: Request, env: Env): Promise<Response> {
  // Verify API key
  if (!verifyApiKey(request, env)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  console.log("Debug priorities triggered via API");

  // Check for refresh parameter
  const url = new URL(request.url);
  const shouldRefresh = url.searchParams.get("refresh") === "1";

  try {
    // First, check if LINEAR_API_KEY is configured
    if (!env.LINEAR_API_KEY) {
      return new Response(JSON.stringify({
        success: false,
        error: "LINEAR_API_KEY not configured",
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Clear cache if refresh requested
    if (shouldRefresh) {
      await clearPrioritiesCache(env);
      console.log("Cache cleared due to refresh parameter");
    }

    // Fetch raw relations
    const relations = await fetchPriorityInitiatives(env);

    // Also fetch the formatted context (will re-fetch from Linear if cache was cleared)
    const context = await getPrioritiesContext(env);

    return new Response(JSON.stringify({
      success: true,
      relationsCount: relations.length,
      relations: relations.map(r => ({
        sortOrder: r.sortOrder,
        name: r.relatedInitiative.name,
        status: r.relatedInitiative.status,
        owner: r.relatedInitiative.owner?.name,
        url: r.relatedInitiative.url,
      })),
      formattedContext: context,
    }, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

/**
 * Handle /api/debug/amplitude - debug Amplitude metrics integration
 */
async function handleDebugAmplitude(request: Request, env: Env): Promise<Response> {
  if (!verifyApiKey(request, env)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  console.log("Debug Amplitude triggered via API");

  const url = new URL(request.url);
  const shouldRefresh = url.searchParams.get("refresh") === "1";

  try {
    if (!env.AMPLITUDE_API_KEY || !env.AMPLITUDE_API_SECRET) {
      return new Response(JSON.stringify({
        success: false,
        error: "Amplitude API credentials not configured",
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (shouldRefresh) {
      await clearAmplitudeCache(env);
      console.log("Amplitude cache cleared due to refresh parameter");
    }

    const metrics = await getAmplitudeMetrics(env);

    return new Response(JSON.stringify({
      success: true,
      metrics,
    }, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

/**
 * Handle /api/test-metrics - post a test metrics report to the test channel
 */
async function handleTestMetrics(request: Request, env: Env): Promise<Response> {
  if (!verifyApiKey(request, env)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const url = new URL(request.url);
  const channel = url.searchParams.get("channel");

  if (channel === "production") {
    console.log("Weekly metrics report triggered via API (production)");
    const result = await sendWeeklyMetricsReport(env);
    return new Response(JSON.stringify(result, null, 2), {
      status: result.success ? 200 : 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  console.log("Test metrics report triggered via API");
  const result = await sendTestMetricsReport(env);

  return new Response(JSON.stringify(result, null, 2), {
    status: result.success ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Handle /api/test-telemetry - trigger a Claude call to test telemetry
 */
async function handleTestTelemetry(request: Request, env: Env): Promise<Response> {
  // Verify API key
  if (!verifyApiKey(request, env)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  console.log("Test telemetry triggered via API");

  // Make a simple Claude API call to test telemetry
  const messages = [{ role: "user" as const, content: "Say hello in exactly 3 words." }];
  const result = await generateResponse(messages, env);

  return new Response(JSON.stringify({
    success: true,
    response: result.text,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cached: result.cached,
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Handle /api/ask - ask Chorus a question directly via API
 */
async function handleAsk(request: Request, env: Env): Promise<Response> {
  // Verify API key
  if (!verifyApiKey(request, env)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: { question?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!body.question) {
    return new Response(JSON.stringify({ error: "Missing required field: question" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  console.log("Ask API triggered:", body.question);

  const messages = [{ role: "user" as const, content: body.question }];
  const result = await generateResponse(messages, env);

  return new Response(JSON.stringify({
    success: true,
    question: body.question,
    response: result.text,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cached: result.cached,
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Handle /api/stream - SSE streaming endpoint for Chorus responses
 *
 * GET /api/stream?question=<encoded question>
 *
 * Returns Server-Sent Events with progressive response:
 * - data: {"chunk": "text"} for each text chunk
 * - data: {"done": true, "inputTokens": N, "outputTokens": N} when complete
 */
async function handleStreamApi(request: Request, env: Env): Promise<Response> {
  // Verify API key
  if (!verifyApiKey(request, env)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed. Use GET with ?question= parameter" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const url = new URL(request.url);
  const question = url.searchParams.get("question");

  if (!question) {
    return new Response(JSON.stringify({ error: "Missing required parameter: question" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  console.log("Stream API triggered:", question);

  // Create a TransformStream for SSE
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Send SSE formatted data
  const sendEvent = async (data: object) => {
    await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };

  // Start streaming response in the background
  const messages = [{ role: "user" as const, content: question }];

  // Process the stream
  (async () => {
    try {
      const result = await generateResponseStreaming(
        messages,
        env,
        async (chunk) => {
          await sendEvent({ chunk });
        }
      );

      // Send final event with completion info
      await sendEvent({
        done: true,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cached: result.cached,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("Stream API error:", errorMessage);
      await sendEvent({ error: errorMessage });
    } finally {
      await writer.close();
    }
  })();

  // Return SSE response
  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

/**
 * Handle /api/docs requests for console-based document management
 */
async function handleDocsApi(request: Request, env: Env): Promise<Response> {
  // Verify API key
  if (!verifyApiKey(request, env)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const method = request.method;

  // GET /api/docs - list documents
  if (method === "GET") {
    const list = await listDocuments(env);
    return new Response(JSON.stringify({ documents: list }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // POST /api/docs - add document
  if (method === "POST") {
    let body: { title?: string; content?: string };
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!body.title || !body.content) {
      return new Response(JSON.stringify({ error: "Missing required fields: title, content" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = await addDocument(env, body.title, body.content, "api");
    return new Response(JSON.stringify(result), {
      status: result.success ? 200 : 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // DELETE /api/docs - remove document
  if (method === "DELETE") {
    let body: { title?: string };
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!body.title) {
      return new Response(JSON.stringify({ error: "Missing required field: title" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = await removeDocument(env, body.title);
    return new Response(JSON.stringify(result), {
      status: result.success ? 200 : 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Handle Slack slash commands
 * Slash commands are sent as application/x-www-form-urlencoded POST requests
 */
async function handleSlashCommand(request: Request, env: Env): Promise<Response> {
  const body = await request.text();

  // Verify Slack signature
  const isValid = await verifySlackSignature(request, body, env.SLACK_SIGNING_SECRET);
  if (!isValid) {
    return new Response("Invalid signature", { status: 401 });
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
        const docResults = await searchDocuments(query, env, 5);

        if (docResults.length > 0) {
          response = formatSearchResultsForUser(docResults);
        } else {
          response = `No results found for "${query}".`;
        }
      }
    }
  } else if (command === "/chorus-docs") {
    // List docs
    response = await listDocuments(env);
  } else {
    // Unknown command - show help
    response = `Unknown command. Try:\n• \`/chorus\` - Get help\n• \`/chorus search <query>\` - Search docs\n• \`/chorus-docs\` - List documents`;
  }

  // Return ephemeral response (only visible to the user who triggered the command)
  return new Response(JSON.stringify({
    response_type: "ephemeral",
    text: response,
  }), {
    headers: { "Content-Type": "application/json" },
  });
}

// Export handler for testing
export const handler = {
  /**
   * Handle scheduled cron triggers (weekly check-ins and brief checker)
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log("Running scheduled tasks at", new Date(controller.scheduledTime).toISOString());

    // Run tasks sequentially in a single waitUntil to avoid exceeding Worker CPU limits.
    // Previously, parallel ctx.waitUntil() calls caused exceededCpu kills.
    ctx.waitUntil((async () => {
      await sendWeeklyCheckins(env);

      if (new Date(controller.scheduledTime).getUTCDay() === 1) {
        await sendWeeklyMetricsReport(env);
      }

      const briefResult = await checkInitiativeBriefs(env);
      console.log(
        `Brief check complete: ${briefResult.initiativesChecked} checked, ` +
          `${briefResult.missingBriefs.filter((m) => m.dmSent).length} DMs sent, ` +
          `${briefResult.unmappedUsers.length} unmapped users`
      );

      await backfillIfNeeded(env);
      await warmPrioritiesCache(env);
      await warmAmplitudeCache(env);
    })());
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Route /api/docs to the docs API handler
    if (url.pathname === "/api/docs") {
      return handleDocsApi(request, env);
    }

    // Route /api/test-checkin to trigger manual check-in
    if (url.pathname === "/api/test-checkin") {
      return handleTestCheckin(request, env);
    }

    // Route /api/test-telemetry to test Claude telemetry
    if (url.pathname === "/api/test-telemetry") {
      return handleTestTelemetry(request, env);
    }

    // Route /api/debug/priorities to debug Linear priorities
    if (url.pathname === "/api/debug/priorities") {
      return handleDebugPriorities(request, env);
    }

    // Route /api/debug/amplitude to debug Amplitude metrics
    if (url.pathname === "/api/debug/amplitude") {
      return handleDebugAmplitude(request, env);
    }

    // Route /api/test-metrics to post test report to test channel
    if (url.pathname === "/api/test-metrics") {
      return handleTestMetrics(request, env);
    }

    // Route /api/ask to ask Chorus a question directly
    if (url.pathname === "/api/ask") {
      return handleAsk(request, env);
    }

    // Route /api/stream to SSE streaming endpoint
    if (url.pathname === "/api/stream") {
      return handleStreamApi(request, env);
    }

    // Route /feedback to the feedback log page
    if (url.pathname === "/feedback") {
      if (!verifyApiKey(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }
      return handleFeedbackPage(env);
    }

    // Route /slack/slash to slash command handler
    if (url.pathname === "/slack/slash") {
      return handleSlashCommand(request, env);
    }

    // Slack webhook requires POST
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

// Default export wrapped with OpenTelemetry instrumentation
// This sends traces directly to Honeycomb with full custom span attribute support
export default instrument(handler, otelConfig);

async function handleMention(payload: SlackEventCallback, env: Env): Promise<void> {
  const event = payload.event as SlackAppMentionEvent;
  const { channel, ts, thread_ts, text, user, files } = event;

  // Track thinking message for error handling
  let thinkingTs: string | null = null;

  try {
    // Record rich request context for wide events (inside try to catch OTel errors)
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

    // Record agent invocation context (OTel GenAI agent span conventions)
    recordAgentInvocation({
      name: "chorus",
      description: "PDD chief of staff Slack bot",
      requestModel: CLAUDE_MODEL,
      conversationId: thread_ts ?? ts,
    });
    const threadTs = thread_ts ?? ts;
    const botUserId = await getBotUserId(env);
    const cleanedText = text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();

    // Handle help command
    if (/^help$/i.test(cleanedText)) {
      recordCommand("help");
      await postMessage(channel, HELP_TEXT, threadTs, env);
      return;
    }

    // Handle surprise me command - surface a random document for discovery
    if (/^surprise\s*me$/i.test(cleanedText)) {
      recordCommand("surprise");
      const result = await getRandomDocument(env);
      await postMessage(channel, result.message, threadTs, env);
      return;
    }

    // Handle search command
    const searchCommand = parseSearchCommand(text, botUserId);
    if (searchCommand) {
      recordCommand("search");

      // Rate limit search commands
      const searchLimited = await isRateLimited(user, "search", env);
      recordRateLimit({ userId: user, action: "search", wasLimited: searchLimited });
      if (searchLimited) {
        await postMessage(
          channel,
          "You're searching too quickly. Please wait a moment before trying again.",
          threadTs,
          env
        );
        return;
      }

      const { query } = searchCommand;

      const docResults = await searchDocuments(query, env, 5);

      // Record search results for observability
      recordSearchResults({
        query,
        docResultsCount: docResults.length,
        topDocScore: docResults[0]?.score,
      });

      if (docResults.length > 0) {
        await postMessage(channel, formatSearchResultsForUser(docResults), threadTs, env);
      } else {
        await postMessage(channel, `No results found for "${query}".`, threadTs, env);
      }
      return;
    }

    // Handle file uploads - add them as docs
    if (files && files.length > 0) {
      // Send immediate acknowledgment
      const fileNames = files.map(f => f.name).join(", ");
      await postMessage(channel, `📄 Processing ${files.length > 1 ? "files" : "file"}: ${fileNames}...`, threadTs, env);

      const results = await Promise.all(files.map(async (file) => {
        try {
          const extracted = await extractFileContent(file, env);
          if (extracted) {
            const title = titleFromFilename(extracted.filename);
            const result = await addDocument(env, title, extracted.content, user);
            recordFileProcessing({
              fileName: file.name,
              fileType: file.mimetype,
              fileSizeKb: Math.round((file.size || 0) / 1024),
              extractedLength: extracted.content.length,
              success: true,
            });
            return result.message;
          } else {
            recordFileProcessing({
              fileName: file.name,
              fileType: file.mimetype,
              fileSizeKb: Math.round((file.size || 0) / 1024),
              success: false,
              errorMessage: "unsupported format or empty",
            });
            return `Couldn't extract text from "${file.name}" (unsupported format or empty).`;
          }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          recordFileProcessing({
            fileName: file.name,
            fileType: file.mimetype,
            fileSizeKb: Math.round((file.size || 0) / 1024),
            success: false,
            errorMessage: errMsg,
          });
          return `Error processing "${file.name}": ${errMsg}`;
        }
      }));

      await postMessage(channel, results.join("\n"), threadTs, env);
      return;
    }

    // Check for doc commands
    const docCommand = parseDocCommand(text, botUserId);

    if (docCommand) {
      recordCommand(`docs:${docCommand.type}`);
      // Rate limit doc commands (except list)
      if (docCommand.type !== "list") {
        const docLimited = await isRateLimited(user, "doc", env);
        recordRateLimit({ userId: user, action: "doc", wasLimited: docLimited });
        if (docLimited) {
          await postMessage(
            channel,
            "You're adding documents too quickly. Please wait a minute before trying again.",
            threadTs,
            env
          );
          return;
        }
      }

      let response: string;

      if (docCommand.type === "list") {
        const pagination = docCommand.page ? { page: docCommand.page } : undefined;
        response = await listDocuments(env, pagination);
      } else if (docCommand.type === "add") {
        const result = await addDocument(env, docCommand.title, docCommand.content, user);
        response = result.message;
      } else if (docCommand.type === "update") {
        const result = await updateDocument(env, docCommand.title, docCommand.content, user);
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

    // Check for check-in commands
    const checkInCommand = parseCheckInCommand(text, botUserId);

    if (checkInCommand) {
      recordCommand(`checkin:${checkInCommand.type}`);

      if (checkInCommand.type === "history") {
        const history = await listUserCheckIns(user, env, checkInCommand.limit);
        const response = formatCheckInHistory(history);
        await postMessage(channel, response, threadTs, env);
        return;
      }
    }

    // Check for check-briefs command
    if (/^check[- ]?briefs$/i.test(cleanedText)) {
      recordCommand("check-briefs");

      // Post acknowledgment
      await postMessage(channel, "Checking initiatives for missing briefs...", threadTs, env);

      const result = await checkInitiativeBriefs(env);
      const response = formatBriefCheckResults(result);
      await postMessage(channel, response, threadTs, env);
      return;
    }

    // Regular message - route to Claude
    let messages;
    let threadMessageCount = 1;
    let threadFetchMs: number | undefined;

    if (thread_ts) {
      // Fetch thread history and post thinking message in parallel
      const threadFetchStart = Date.now();
      const [threadMessages, thinkingResult] = await Promise.all([
        fetchThreadMessages(channel, thread_ts, env),
        postMessage(channel, "✨ Thinking...", threadTs, env),
      ]);
      threadFetchMs = Date.now() - threadFetchStart;
      recordSlackLatency({ threadFetchMs });

      messages = convertThreadToMessages(threadMessages, botUserId);
      threadMessageCount = threadMessages.length;
      thinkingTs = thinkingResult;

      // Record thread context for observability
      const userMessages = threadMessages.filter(m => m.user !== botUserId).length;
      const botMessages = threadMessages.filter(m => m.user === botUserId).length;
      recordThreadContext({
        messageCount: threadMessages.length,
        userMessageCount: userMessages,
        botMessageCount: botMessages,
      });
    } else {
      // New thread - just use the current message
      messages = [
        {
          role: "user" as const,
          content: cleanedText,
        },
      ];
      thinkingTs = await postMessage(channel, "✨ Thinking...", threadTs, env);
    }

    if (!thinkingTs) {
      throw new Error("Failed to post thinking message");
    }

    // Generate response with thread context and user info
    const threadInfo: ThreadInfo | undefined = threadTs ? { channel, threadTs } : undefined;
    const result = await generateResponse(messages, env, threadInfo, user);

    // Update with final response (with timing)
    const updateStart = Date.now();
    await updateMessage(channel, thinkingTs, result.text, env);
    const messageUpdateMs = Date.now() - updateStart;
    recordSlackLatency({ messageUpdateMs });

    // Add feedback reactions (fire-and-forget — user already sees the response)
    Promise.all([
      addReaction(channel, thinkingTs, "thumbsup", env),
      addReaction(channel, thinkingTs, "thumbsdown", env),
    ]).catch(err => console.warn("Reaction add failed:", err));

    // Record comprehensive Claude response context for wide events
    recordClaudeResponse({
      responseLength: result.text.length,
      cached: result.cached,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      messagesCount: messages.length,
      hasKnowledgeBase: true, // Knowledge base is always searched for context
    });

    // Store feedback record for the feedback log (fire-and-forget)
    storeFeedbackRecord(env, {
      prompt: cleanedText,
      response: result.text,
      user,
      channel,
      ts: thinkingTs,
      timestamp: new Date().toISOString(),
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    }).catch(err => console.warn("Feedback record store failed:", err));
  } catch (error) {
    console.error("Error handling mention:", error);
    if (error instanceof Error) {
      recordCategorizedError(error, "handleMention");
    }

    // Provide user-friendly message for timeout errors
    let errorMessage = "Sorry, I encountered an error processing your request.";
    if (error instanceof TimeoutError) {
      errorMessage = "Sorry, my response took too long and timed out. This can happen with complex questions. Please try again or simplify your question.";
    }

    // Update the thinking message if it was posted, otherwise post a new message
    if (thinkingTs) {
      await updateMessage(channel, thinkingTs, errorMessage, env);
    } else {
      await postMessage(channel, errorMessage, thread_ts ?? ts, env);
    }
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

    // Update feedback record with reaction (fire-and-forget)
    updateFeedbackWithReaction(env, item.channel, item.ts, feedback, user)
      .catch(err => console.warn("Feedback record update failed:", err));

  } catch (error) {
    console.error("Error handling reaction:", error);
    if (error instanceof Error) {
      recordCategorizedError(error, "handleReaction");
    }
  }
}

// Cache the bot user ID with TTL (imported from constants)
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
