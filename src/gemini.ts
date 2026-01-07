import type { Env, GeminiMessage, GeminiResponse, SlackMessage, AIChatMessage } from "./types";
import { getKnowledgeBase } from "./docs"; // Assuming these are still relevant
import { getInitiativesContext, detectInitiativeGaps } from "./initiatives"; // Assuming these are still relevant
import { fetchWithRetry } from "./http-utils"; // Re-use existing utility
import { recordGenAiMetrics } from "./telemetry"; // Re-use existing utility
import {
  getThreadContext,
  updateThreadContext,
  processMessagesForContext,
} from "./thread-context"; // Re-use existing utility
import SYSTEM_PROMPT from "./soul.md"; // Re-use existing system prompt

// Cache configuration
const CACHE_PREFIX = "cache:response:gemini:";
const CACHE_TTL_SECONDS = 3600; // 1 hour

/**
 * Generate a cache key from messages
 */
function getCacheKey(messages: GeminiMessage[]): string {
  const hash = messages.map(m => `${m.role}:${m.parts.map(p => p.text).join(" ")}`).join("|");
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
): GeminiMessage[] {
  return messages
    .map((msg): GeminiMessage => ({
      role: msg.bot_id ? "model" : "user", // Gemini uses "model" for assistant
      parts: [{ text: cleanSlackMessage(msg.text, botUserId) }],
    }))
    .filter((msg) => msg.parts[0].text.trim().length > 0);
}

function cleanSlackMessage(text: string, botUserId: string): string {
  // Remove bot mention from the message
  return text
    .replace(new RegExp(`<@${botUserId}>`, "g"), "")
    .trim();
}

export const GEMINI_MODEL = "gemini-pro";
const GEMINI_MAX_TOKENS = 1024; // This might need adjustment based on Gemini's actual max output tokens

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
    .replace(/ \[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');
}

export interface ThreadInfo {
  channel: string;
  threadTs: string;
}

function toAIChatMessages(geminiMessages: GeminiMessage[]): AIChatMessage[] {
  return geminiMessages.map(msg => ({
    role: msg.role === "model" ? "assistant" : "user",
    content: msg.parts.map(p => p.text).join(" "),
  }));
}

export async function generateResponse(
  messages: GeminiMessage[],
  env: Env,
  threadInfo?: ThreadInfo
): Promise<GenerateResponseResult> {
  // Check cache first
  const cacheKey = getCacheKey(messages);
  const cached = await env.DOCS_KV.get(cacheKey);
  if (cached) {
    console.log("Cache hit for Gemini response");
    recordGenAiMetrics({
      operationName: "chat",
      requestModel: GEMINI_MODEL,
      inputTokens: 0,
      outputTokens: 0,
      cacheHit: true,
    });
    return { text: cached, inputTokens: 0, outputTokens: 0, cached: true };
  }

  // Extract query from the last user message for semantic search
  const lastUserMessage = messages.filter(m => m.role === "user").pop();
  const query = lastUserMessage?.parts[0].text || "";

  // Get thread context if we're in a thread
  let threadContext = null;
  if (threadInfo) {
    threadContext = await getThreadContext(threadInfo.channel, threadInfo.threadTs, env);
  }

  // Convert Gemini messages to AIChatMessages for thread context processing
  const aiChatMessages = toAIChatMessages(messages);

  // Process messages with thread context (summarize if long)
  const { messages: processedAIChatMessages, contextPrefix } = processMessagesForContext(
    aiChatMessages,
    threadContext
  );

  // Convert processed AIChatMessages back to GeminiMessage format for the API call
  // This is a simplified conversion, assuming role and content are sufficient.
  const processedGeminiMessages: GeminiMessage[] = processedAIChatMessages.map(msg => ({
    role: msg.role === "assistant" ? "model" : "user",
    parts: [{ text: msg.content }],
  }));

  // Load full knowledge base, initiatives context, and detect gaps in parallel
  const [knowledgeBase, initiativesContext, gapNudge] = await Promise.all([
    getKnowledgeBase(env),
    getInitiativesContext(env),
    query ? detectInitiativeGaps(query, env) : Promise.resolve(null),
  ]);

  let systemPrompt = SYSTEM_PROMPT;

  // Add thread context summary if available
  if (contextPrefix) {
    systemPrompt += `\n\n${contextPrefix}`;
    console.log(`Using thread context summary (${messages.length} messages -> ${processedAIChatMessages.length} recent)`);
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

  const geminiMessages = [{ role: "user", parts: [{ text: systemPrompt }] }, ...processedGeminiMessages];


  const response = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: geminiMessages,
        generationConfig: {
          maxOutputTokens: GEMINI_MAX_TOKENS,
        },
      }),
    },
    { initialDelayMs: 100 } // Reduced initial delay for faster retries
  );

  if (!response.ok) {
    const error = await response.text();
    console.error("Gemini API error:", error);
    throw new Error(`Gemini API error: ${response.status}`);
  }

  const data = (await response.json()) as GeminiResponse;
  const rawText = data.candidates[0]?.content.parts[0]?.text ?? "Sorry, I couldn\'t generate a response.";
  const text = convertToSlackFormat(rawText);

  // Extract token usage
  const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;

  // Record metrics for observability (OTel GenAI semantic conventions)
  console.log(`Gemini Token usage: input=${inputTokens}, output=${outputTokens}, total=${inputTokens + outputTokens}`);
  recordGenAiMetrics({
    operationName: "chat",
    requestModel: GEMINI_MODEL,
    responseModel: GEMINI_MODEL, // Gemini API does not return model name in response
    inputTokens,
    outputTokens,
    maxTokens: GEMINI_MAX_TOKENS,
    responseId: data.candidates[0]?.index.toString(), // Using candidate index as a proxy for response ID
    finishReasons: data.candidates[0]?.finishReason ? [data.candidates[0]?.finishReason] : undefined,
    streaming: false,
    cacheHit: false,
  });

  // Cache the response
  await env.DOCS_KV.put(cacheKey, text, { expirationTtl: CACHE_TTL_SECONDS });

  // Update thread context for future messages (fire and forget)
  if (threadInfo) {
    updateThreadContext(
      threadInfo.channel,
      threadInfo.threadTs,
      aiChatMessages,
      [],
      env
    ).catch(err => console.error("Failed to update thread context:", err));
  }

  return { text, inputTokens, outputTokens, cached: false };
}

// TODO: Implement generateResponseStreaming for Gemini if needed.
