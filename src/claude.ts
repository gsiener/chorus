import type { Env, ClaudeMessage, ClaudeResponse, SlackMessage } from "./types";
import { getKnowledgeBase } from "./docs";
import { getInitiativesContext, detectInitiativeGaps } from "./initiatives";
import { getPrioritiesContext } from "./linear-priorities";
import { fetchWithRetry, TimeoutError } from "./http-utils";
import {
  recordGenAiMetrics,
  recordGenAiInput,
  recordGenAiOutput,
  recordGenAiLatency,
  recordCost,
  calculateCost,
  recordConversationQuality,
  recordKnowledgeBaseMetrics,
} from "./telemetry";
import {
  getThreadContext,
  updateThreadContext,
  processMessagesForContext,
} from "./thread-context";
import SYSTEM_PROMPT from "./soul.md";

// Cache configuration
const CACHE_PREFIX = "cache:response:";
const CACHE_TTL_SECONDS = 3600; // 1 hour

/**
 * Generate a cache key from messages
 */
function getCacheKey(messages: ClaudeMessage[]): string {
  const hash = messages.map(m => `${m.role}:${m.content}`).join("|");
  // Simple hash function
  let h = 0;
  for (let i = 0; i < hash.length; i++) {
    h = ((h << 5) - h + hash.charCodeAt(i)) | 0;
  }
  return CACHE_PREFIX + h.toString(16);
}

export interface GenerateResponseResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cached: boolean;
}

export function convertThreadToMessages(
  messages: SlackMessage[],
  botUserId: string
): ClaudeMessage[] {
  return messages
    .map((msg): ClaudeMessage => ({
      role: msg.bot_id ? "assistant" : "user",
      content: cleanSlackMessage(msg.text, botUserId),
    }))
    .filter((msg) => msg.content.trim().length > 0);
}

function cleanSlackMessage(text: string, botUserId: string): string {
  // Remove bot mention from the message
  return text
    .replace(new RegExp(`<@${botUserId}>`, "g"), "")
    .trim();
}

export const CLAUDE_MODEL = "claude-opus-4-5-20251101";
const CLAUDE_MAX_TOKENS = 1024;
// Timeout for Claude API calls - leave margin before Cloudflare's 30s waitUntil limit
const CLAUDE_API_TIMEOUT_MS = 25000;

/**
 * Convert standard markdown to Slack's mrkdwn format
 */
function convertToSlackFormat(text: string): string {
  return text
    // Convert **bold** to *bold* (must do before single asterisk handling)
    .replace(/\*\*([^*]+)\*\*/g, '*$1*')
    // Convert markdown headers to bold
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    // Convert [text](url) links to <url|text>
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');
}

export interface ThreadInfo {
  channel: string;
  threadTs: string;
}

export async function generateResponse(
  messages: ClaudeMessage[],
  env: Env,
  threadInfo?: ThreadInfo
): Promise<GenerateResponseResult> {
  // Check cache first
  const cacheKey = getCacheKey(messages);
  const cached = await env.DOCS_KV.get(cacheKey);
  if (cached) {
    console.log("Cache hit for response");
    recordGenAiMetrics({
      operationName: "chat",
      requestModel: CLAUDE_MODEL,
      inputTokens: 0,
      outputTokens: 0,
      cacheHit: true,
    });
    return { text: cached, inputTokens: 0, outputTokens: 0, cached: true };
  }

  // Extract query from the last user message for semantic search
  const lastUserMessage = messages.filter(m => m.role === "user").pop();
  const query = lastUserMessage?.content || "";

  // Get thread context if we're in a thread
  let threadContext = null;
  if (threadInfo) {
    threadContext = await getThreadContext(threadInfo.channel, threadInfo.threadTs, env);
  }

  // Process messages with thread context (summarize if long)
  const { messages: processedMessages, contextPrefix, wasTruncated } = processMessagesForContext(
    messages,
    threadContext
  );

  // Load full knowledge base, initiatives context, priorities, and detect gaps in parallel
  const kbStartTime = Date.now();
  const [knowledgeBase, initiativesContext, prioritiesContext, gapNudge] = await Promise.all([
    getKnowledgeBase(env),
    getInitiativesContext(env),
    getPrioritiesContext(env),
    query ? detectInitiativeGaps(query, env) : Promise.resolve(null),
  ]);
  const kbLatencyMs = Date.now() - kbStartTime;

  // Record knowledge base metrics
  const kbDocCount = knowledgeBase ? (knowledgeBase.match(/^## /gm) || []).length : 0;
  recordKnowledgeBaseMetrics({
    documentsCount: kbDocCount,
    totalCharacters: knowledgeBase?.length,
    retrievalLatencyMs: kbLatencyMs,
    cacheHit: false, // KV doesn't have cache semantics we can detect
  });

  // Record conversation quality signals
  const totalContextLength = processedMessages.reduce((sum, m) => sum + m.content.length, 0);
  recordConversationQuality({
    turnCount: messages.length,
    contextLength: totalContextLength,
    wasTruncated: wasTruncated ?? false,
  });

  let systemPrompt = SYSTEM_PROMPT;

  // Add thread context summary if available
  if (contextPrefix) {
    systemPrompt += `\n\n${contextPrefix}`;
    console.log(`Using thread context summary (${messages.length} messages -> ${processedMessages.length} recent)`);
  }

  if (prioritiesContext) {
    systemPrompt += `\n\n## R&D Priorities (from Linear)\n\nWhen mentioning any initiative by name, ALWAYS hyperlink it using the Slack format: <url|Name>. Each initiative below has its Linear URL included.\n\n${prioritiesContext}`;
  }
  if (initiativesContext) {
    systemPrompt += `\n\n## Active Initiatives\n\n${initiativesContext}`;
  }
  if (knowledgeBase) {
    systemPrompt += `\n\n## Knowledge Base\n\n${knowledgeBase}`;
  }
  if (gapNudge) {
    systemPrompt += `\n\n## Gentle Reminder\n\n${gapNudge}`;
  }

  // Record input BEFORE the API call so attributes are captured
  recordGenAiInput({
    systemPrompt,
    messages: processedMessages,
  });

  const apiStartTime = Date.now();
  const response = await fetchWithRetry(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: CLAUDE_MAX_TOKENS,
        system: systemPrompt,
        messages: processedMessages,
      }),
    },
    { initialDelayMs: 1000, timeoutMs: CLAUDE_API_TIMEOUT_MS }
  );
  const apiLatencyMs = Date.now() - apiStartTime;

  if (!response.ok) {
    const error = await response.text();
    console.error("Claude API error:", error);
    throw new Error(`Claude API error: ${response.status}`);
  }

  const data = (await response.json()) as ClaudeResponse;

  // Record latency
  recordGenAiLatency({ totalGenerationMs: apiLatencyMs });

  const rawText = data.content[0]?.text ?? "Sorry, I couldn't generate a response.";
  const text = convertToSlackFormat(rawText);

  // Extract token usage
  const inputTokens = data.usage?.input_tokens ?? 0;
  const outputTokens = data.usage?.output_tokens ?? 0;

  // Calculate and record cost
  const estimatedCost = calculateCost(CLAUDE_MODEL, inputTokens, outputTokens);
  recordCost(estimatedCost);

  // Record metrics for observability (OTel GenAI semantic conventions)
  console.log(`Token usage: input=${inputTokens}, output=${outputTokens}, total=${inputTokens + outputTokens}, cost=$${estimatedCost.toFixed(6)}`);
  recordGenAiMetrics({
    operationName: "chat",
    requestModel: CLAUDE_MODEL,
    responseModel: data.model,
    inputTokens,
    outputTokens,
    maxTokens: CLAUDE_MAX_TOKENS,
    responseId: data.id,
    finishReasons: data.stop_reason ? [data.stop_reason] : undefined,
    streaming: false,
    cacheHit: false,
    cacheCreationInputTokens: data.usage?.cache_creation_input_tokens,
    cacheReadInputTokens: data.usage?.cache_read_input_tokens,
  });

  // Record completion output (input was already recorded before API call)
  recordGenAiOutput(rawText);

  // Cache the response
  await env.DOCS_KV.put(cacheKey, text, { expirationTtl: CACHE_TTL_SECONDS });

  // Update thread context for future messages (fire and forget)
  if (threadInfo) {
    // Note: Initiative detection could be enhanced by analyzing the response text
    // For now, we store context without explicit initiative tracking
    updateThreadContext(
      threadInfo.channel,
      threadInfo.threadTs,
      messages,
      [], // Initiative mentions extracted separately if needed
      env
    ).catch(err => console.error("Failed to update thread context:", err));
  }

  return { text, inputTokens, outputTokens, cached: false };
}

/**
 * Generate a response with streaming, calling onChunk for each text delta
 */
export async function generateResponseStreaming(
  messages: ClaudeMessage[],
  env: Env,
  onChunk: (text: string) => Promise<void>
): Promise<GenerateResponseResult> {
  // Check cache first
  const cacheKey = getCacheKey(messages);
  const cached = await env.DOCS_KV.get(cacheKey);
  if (cached) {
    console.log("Cache hit for response");
    recordGenAiMetrics({
      operationName: "chat",
      requestModel: CLAUDE_MODEL,
      inputTokens: 0,
      outputTokens: 0,
      cacheHit: true,
    });
    await onChunk(cached);
    return { text: cached, inputTokens: 0, outputTokens: 0, cached: true };
  }

  // Extract query from the last user message for gap detection
  const lastUserMessage = messages.filter(m => m.role === "user").pop();
  const query = lastUserMessage?.content || "";

  // Load full knowledge base, initiatives context, priorities, and detect gaps in parallel
  const kbStartTime = Date.now();
  const [knowledgeBase, initiativesContext, prioritiesContext, gapNudge] = await Promise.all([
    getKnowledgeBase(env),
    getInitiativesContext(env),
    getPrioritiesContext(env),
    query ? detectInitiativeGaps(query, env) : Promise.resolve(null),
  ]);
  const kbLatencyMs = Date.now() - kbStartTime;

  // Record knowledge base metrics
  const kbDocCount = knowledgeBase ? (knowledgeBase.match(/^## /gm) || []).length : 0;
  recordKnowledgeBaseMetrics({
    documentsCount: kbDocCount,
    totalCharacters: knowledgeBase?.length,
    retrievalLatencyMs: kbLatencyMs,
    cacheHit: false,
  });

  // Record conversation quality signals
  const totalContextLength = messages.reduce((sum, m) => sum + m.content.length, 0);
  recordConversationQuality({
    turnCount: messages.length,
    contextLength: totalContextLength,
    wasTruncated: false, // Streaming doesn't use thread context truncation
  });

  let systemPrompt = SYSTEM_PROMPT;
  if (prioritiesContext) {
    systemPrompt += `\n\n## R&D Priorities (from Linear)\n\nWhen mentioning any initiative by name, ALWAYS hyperlink it using the Slack format: <url|Name>. Each initiative below has its Linear URL included.\n\n${prioritiesContext}`;
  }
  if (initiativesContext) {
    systemPrompt += `\n\n## Active Initiatives\n\n${initiativesContext}`;
  }
  if (knowledgeBase) {
    systemPrompt += `\n\n## Knowledge Base\n\n${knowledgeBase}`;
  }
  if (gapNudge) {
    systemPrompt += `\n\n## Gentle Reminder\n\n${gapNudge}`;
  }

  // Record input BEFORE the API call so attributes are captured
  recordGenAiInput({
    systemPrompt,
    messages,
  });

  const apiStartTime = Date.now();
  let timeToFirstTokenMs: number | undefined;
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: CLAUDE_MAX_TOKENS,
      system: systemPrompt,
      messages,
      stream: true,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error("Claude API error:", error);
    throw new Error(`Claude API error: ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body");
  }

  const decoder = new TextDecoder();
  let fullText = "";
  let inputTokens = 0;
  let outputTokens = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split('\n');

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') continue;

        try {
          const event = JSON.parse(data);

          // Extract text from content_block_delta events
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            // Record time to first token on first text chunk
            if (timeToFirstTokenMs === undefined) {
              timeToFirstTokenMs = Date.now() - apiStartTime;
            }
            fullText += event.delta.text;
            await onChunk(event.delta.text);
          }

          // Extract usage from message_delta event
          if (event.type === 'message_delta' && event.usage) {
            outputTokens = event.usage.output_tokens ?? outputTokens;
          }

          // Extract input tokens from message_start event
          if (event.type === 'message_start' && event.message?.usage) {
            inputTokens = event.message.usage.input_tokens ?? 0;
          }
        } catch {
          // Skip non-JSON lines
        }
      }
    }
  }

  const text = convertToSlackFormat(fullText);
  const apiLatencyMs = Date.now() - apiStartTime;

  // Record latency breakdown
  recordGenAiLatency({
    totalGenerationMs: apiLatencyMs,
    timeToFirstTokenMs,
  });

  // Calculate and record cost
  const estimatedCost = calculateCost(CLAUDE_MODEL, inputTokens, outputTokens);
  recordCost(estimatedCost);

  // Record metrics for observability (OTel GenAI semantic conventions)
  console.log(`Token usage: input=${inputTokens}, output=${outputTokens}, total=${inputTokens + outputTokens}, cost=$${estimatedCost.toFixed(6)}`);
  recordGenAiMetrics({
    operationName: "chat",
    requestModel: CLAUDE_MODEL,
    inputTokens,
    outputTokens,
    maxTokens: CLAUDE_MAX_TOKENS,
    streaming: true,
    cacheHit: false,
  });

  // Record completion output (input was already recorded before API call)
  recordGenAiOutput(fullText);

  // Cache the response
  await env.DOCS_KV.put(cacheKey, text, { expirationTtl: CACHE_TTL_SECONDS });

  return { text, inputTokens, outputTokens, cached: false };
}
