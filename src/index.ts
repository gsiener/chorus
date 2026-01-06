import type { Env, SlackPayload, SlackEventCallback, SlackReactionAddedEvent, SlackAppMentionEvent, InitiativeStatusValue } from "./types";
import {
  parseDocCommand,
  parseInitiativeCommand,
  parseSearchCommand,
  VALID_STATUSES,
  type InitiativeCommand,
} from "./parseCommands";
import { verifySlackSignature, fetchThreadMessages, postMessage, updateMessage, addReaction } from "./slack";
import { convertThreadToMessages, generateResponse, ThreadInfo, CLAUDE_MODEL } from "./claude";
import { addDocument, removeDocument, listDocuments, backfillDocuments, getRandomDocument } from "./docs";
import { extractFileContent, titleFromFilename } from "./files";
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
} from "./initiatives";
import { searchDocuments, formatSearchResultsForUser } from "./embeddings";
import { syncLinearProjects } from "./linear";
import { sendWeeklyCheckins } from "./checkins";
import { trace } from "@opentelemetry/api";
import { instrument, ResolveConfigFn } from "@microlabs/otel-cf-workers";
import {
  recordCommand,
  recordError,
  recordFeedback,
  recordRequestContext,
  recordThreadContext,
  recordSearchResults,
  recordClaudeResponse,
  recordFileProcessing,
  recordRateLimit,
} from "./telemetry";
import { mightBeInitiativeCommand, processNaturalLanguageCommand } from "./initiative-nlp";

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

// Rate limiting configuration (per user, per minute)
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_KEY_PREFIX = "ratelimit:";

// Command-specific rate limits
const RATE_LIMITS: Record<string, number> = {
  doc: 10,      // Doc add/remove: 10 per minute
  search: 20,   // Search commands: 20 per minute (more lenient)
  default: 30,  // Default for other commands
};

// Event deduplication (prevent duplicate responses from Slack retries)
const EVENT_DEDUP_TTL_SECONDS = 60; // 1 minute
const EVENT_DEDUP_KEY_PREFIX = "event:";

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
Just ask me anything about your product strategy, roadmap, or initiatives in natural language! I have context on your knowledge base and can help answer questions.

*Search Everything:*
• \`@Chorus search "query"\` — find initiatives, docs, and PRDs

*Track Initiatives:*
• \`@Chorus initiatives\` — see all initiatives at a glance
• \`@Chorus initiative "Name" show\` — view full details
• \`@Chorus initiative add "Name" - owner @user - description: text\`
• \`@Chorus initiative "Name" update status [proposed|active|paused|completed|cancelled]\`
• \`@Chorus initiative "Name" update prd [url]\` — link your PRD
• \`@Chorus initiative "Name" update name "New Name"\` — rename
• \`@Chorus initiative "Name" update description "New description"\`
• \`@Chorus initiative "Name" update owner @newuser\` — reassign
• \`@Chorus initiative "Name" add metric: [gtm|product] [name] - target: [target]\`
• \`@Chorus initiative "Name" remove\`
• \`@Chorus initiatives sync linear\` — import from Linear

*Knowledge Base:*
• \`@Chorus docs\` — list all documents
• \`@Chorus add doc "Title": content\` — add inline
• \`@Chorus remove doc "Title"\`
• \`@Chorus surprise me\` — discover a random doc
• Upload files (text, markdown, JSON, CSV) to add them as docs
• \`@Chorus backfill docs\` — reindex for semantic search

*Pro Tips:*
• I remember context within threads — just keep chatting!
• I'll nudge you about missing PRDs or metrics when relevant
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
    response = `Unknown command. Try:\n• \`/chorus\` - Get help\n• \`/chorus initiatives\` - List initiatives\n• \`/chorus search <query>\` - Search everything\n• \`/chorus-docs\` - List documents`;
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
   * Handle scheduled cron triggers (weekly check-ins)
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log("Running scheduled check-ins at", new Date(controller.scheduledTime).toISOString());
    ctx.waitUntil(sendWeeklyCheckins(env));
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

  // Record rich request context for wide events
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

  // Add GenAI context to the current trace span
  const span = trace.getActiveSpan();
  span?.setAttributes({
    // GenAI context (OTel semantic conventions)
    "gen_ai.operation.name": "chat",
    "gen_ai.system": "anthropic",
    "gen_ai.request.model": CLAUDE_MODEL,
  });

  try {
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

      // Search both documents and initiatives in parallel
      const [docResults, initiativeResults] = await Promise.all([
        searchDocuments(query, env, 5),
        searchInitiatives(env, query, 5),
      ]);

      // Record search results for observability
      recordSearchResults({
        query,
        docResultsCount: docResults.length,
        initiativeResultsCount: initiativeResults.length,
        topDocScore: docResults[0]?.score,
        topInitiativeScore: initiativeResults[0]?.score,
      });

      const sections: string[] = [];

      // Format document results
      if (docResults.length > 0) {
        sections.push(formatSearchResultsForUser(docResults));
      }

      // Format initiative results
      if (initiativeResults.length > 0) {
        const initLines: string[] = [`*Initiative Results* (${initiativeResults.length} found)`];
        for (const result of initiativeResults) {
          const statusEmoji = result.initiative.status === "active" ? "🟢" :
            result.initiative.status === "proposed" ? "🟡" :
            result.initiative.status === "completed" ? "✅" :
            result.initiative.status === "paused" ? "⏸️" : "❌";
          initLines.push(`\n${statusEmoji} *${result.initiative.name}* (${result.initiative.status})`);
          initLines.push(`  Owner: <@${result.initiative.owner}>`);
          if (result.snippet !== result.initiative.name) {
            initLines.push(`  _${result.snippet}_`);
          }
        }
        sections.push(initLines.join("\n"));
      }

      if (sections.length === 0) {
        await postMessage(channel, `No results found for "${query}".`, threadTs, env);
      } else {
        await postMessage(channel, sections.join("\n\n---\n\n"), threadTs, env);
      }
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
            recordFileProcessing({
              fileName: file.name,
              fileType: file.mimetype,
              fileSizeKb: Math.round((file.size || 0) / 1024),
              extractedLength: extracted.content.length,
              success: true,
            });
          } else {
            results.push(`Couldn't extract text from "${file.name}" (unsupported format or empty).`);
            recordFileProcessing({
              fileName: file.name,
              fileType: file.mimetype,
              fileSizeKb: Math.round((file.size || 0) / 1024),
              success: false,
              errorMessage: "unsupported format or empty",
            });
          }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          results.push(`Error processing "${file.name}": ${errMsg}`);
          recordFileProcessing({
            fileName: file.name,
            fileType: file.mimetype,
            fileSizeKb: Math.round((file.size || 0) / 1024),
            success: false,
            errorMessage: errMsg,
          });
        }
      }

      await postMessage(channel, results.join("\n"), threadTs, env);
      return;
    }

    // Check for initiative commands
    const initCommand = parseInitiativeCommand(text, botUserId);

    if (initCommand) {
      recordCommand(`initiative:${initCommand.type}`);
      let response: string;

      switch (initCommand.type) {
        case "list": {
          const filters = initCommand.filters;
          if (filters?.owner === "__CURRENT_USER__") {
            filters.owner = user;
          }
          const pagination = initCommand.page ? { page: initCommand.page } : undefined;
          const initiatives = await listInitiatives(env, filters, pagination);
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
        case "update-name": {
          const result = await updateInitiativeName(
            env,
            initCommand.name,
            initCommand.newName,
            user
          );
          response = result.message;
          break;
        }
        case "update-description": {
          const result = await updateInitiativeDescription(
            env,
            initCommand.name,
            initCommand.newDescription,
            user
          );
          response = result.message;
          break;
        }
        case "update-owner": {
          const result = await updateInitiativeOwner(
            env,
            initCommand.name,
            initCommand.newOwner,
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
        case "sync-linear": {
          // Post initial acknowledgment
          await postMessage(channel, "🔄 Syncing initiatives from Linear...", threadTs, env);
          const result = await syncLinearProjects(env, user);
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

    // Try natural language initiative commands before falling back to Claude
    if (mightBeInitiativeCommand(cleanedText)) {
      recordCommand("nlp:initiative");
      const nlpResult = await processNaturalLanguageCommand(cleanedText, user, env);
      if (nlpResult) {
        await postMessage(channel, nlpResult, threadTs, env);
        return;
      }
      // If NLP didn't handle it, fall through to regular Claude
    }

    // Regular message - route to Claude
    let messages;
    let threadMessageCount = 1;

    if (thread_ts) {
      // Fetch existing thread history
      const threadMessages = await fetchThreadMessages(channel, thread_ts, env);
      messages = convertThreadToMessages(threadMessages, botUserId);
      threadMessageCount = threadMessages.length;

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
    }

    // Post a "thinking" message
    const thinkingTs = await postMessage(channel, "✨ Thinking...", threadTs, env);

    if (!thinkingTs) {
      throw new Error("Failed to post thinking message");
    }

    // Generate response with thread context
    const threadInfo: ThreadInfo | undefined = threadTs ? { channel, threadTs } : undefined;
    const result = await generateResponse(messages, env, threadInfo);

    // Update with final response
    await updateMessage(channel, thinkingTs, result.text, env);

    // Add feedback reactions to the response
    await addReaction(channel, thinkingTs, "thumbsup", env);
    await addReaction(channel, thinkingTs, "thumbsdown", env);

    // Record comprehensive Claude response context for wide events
    recordClaudeResponse({
      responseLength: result.text.length,
      cached: result.cached,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      messagesCount: messages.length,
      hasKnowledgeBase: true, // Knowledge base is always searched for context
    });
  } catch (error) {
    console.error("Error handling mention:", error);
    if (error instanceof Error) {
      recordError(error, "handleMention");
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
      recordError(error, "handleReaction");
    }
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
