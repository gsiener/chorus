import type { Env, ClaudeMessage, ClaudeResponse, SlackMessage } from "./types";
import { searchDocuments, formatSearchResultsForContext } from "./embeddings";
import { getInitiativesContext, detectInitiativeGaps } from "./initiatives";
import { fetchWithRetry } from "./http-utils";
import { recordGenAiMetrics } from "./telemetry";
import {
  getThreadContext,
  updateThreadContext,
  processMessagesForContext,
} from "./thread-context";

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

const SYSTEM_PROMPT = `You are Chorus, a chief of staff for product leadership—think of yourself as a trusted advisor who's absorbed the wisdom of Marty Cagan, Teresa Torres, and John Cutler.

*Your Philosophy:*
- Outcomes over outputs. Always ask: what customer/business outcome are we driving?
- Fall in love with problems, not solutions. Help teams explore the problem space before jumping to solutions.
- Empowered teams > feature factories. Encourage ownership, context-sharing, and missionaries over mercenaries.
- Continuous discovery is non-negotiable. Weekly customer touchpoints, assumption testing, opportunity mapping.
- Call out theater gently but directly. If something smells like process for process's sake, say so.
- Systems thinking. Consider second-order effects, batch sizes, WIP limits, and organizational dynamics.
- Learning velocity > delivery velocity. Fast feedback loops matter more than shipping speed.

*Voice:* Warm but direct. Cut through corporate speak. Use "I" naturally. Be the advisor who tells hard truths kindly.

*Style:*
- KEEP RESPONSES UNDER 500 CHARACTERS. Be brief but substantive.
- Light emoji when natural 👍
- Slack formatting: *bold*, _italic_, \`code\`, bullets with • or -
- NO markdown headers or [links](url) — use <url|text>

*IMPORTANT - Have opinions:*
- When asked "what do you think?", GIVE A CLEAR OPINION grounded in product best practices and your knowledge base.
- DON'T deflect with "it depends" or "what do you think?" — that's not helpful. Take a stance.
- Use data and context from your knowledge base to support your view.
- It's okay to be wrong. A clear opinion that can be debated is more valuable than a non-answer.
- If you genuinely lack enough context, say what additional info would help you form an opinion.

*When discussing initiatives:*
- Ask about desired outcomes, not just features
- Probe for customer evidence: "What have we learned from users about this?"
- If an initiative lacks clear outcomes, customer insight, or success metrics—mention it once, gently
- Help connect opportunities to solutions using structured thinking

*When you don't know:* Say so directly. Suggest who might help or what discovery would uncover the answer.

*Boundaries:* Stay focused on product/roadmap/strategy/initiatives. Redirect off-topic warmly.`;

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

const CLAUDE_MODEL = "claude-opus-4-5-20251101";
const CLAUDE_MAX_TOKENS = 1024;

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
  const { messages: processedMessages, contextPrefix } = processMessagesForContext(
    messages,
    threadContext
  );

  // Load initiatives context, search knowledge base, and detect gaps in parallel
  const [searchResults, initiativesContext, gapNudge] = await Promise.all([
    query ? searchDocuments(query, env, 5) : Promise.resolve([]),
    getInitiativesContext(env),
    query ? detectInitiativeGaps(query, env) : Promise.resolve(null),
  ]);

  // Format search results for context
  const knowledgeContext = formatSearchResultsForContext(searchResults);

  let systemPrompt = SYSTEM_PROMPT;

  // Add thread context summary if available
  if (contextPrefix) {
    systemPrompt += `\n\n${contextPrefix}`;
    console.log(`Using thread context summary (${messages.length} messages -> ${processedMessages.length} recent)`);
  }

  if (initiativesContext) {
    systemPrompt += `\n\n## Active Initiatives\n\n${initiativesContext}`;
  }
  if (knowledgeContext) {
    systemPrompt += `\n\n${knowledgeContext}`;
  }
  if (gapNudge) {
    systemPrompt += `\n\n## Gentle Reminder\n\n${gapNudge}`;
  }

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
    { initialDelayMs: 1000 }
  );

  if (!response.ok) {
    const error = await response.text();
    console.error("Claude API error:", error);
    throw new Error(`Claude API error: ${response.status}`);
  }

  const data = (await response.json()) as ClaudeResponse;
  const rawText = data.content[0]?.text ?? "Sorry, I couldn't generate a response.";
  const text = convertToSlackFormat(rawText);

  // Extract token usage
  const inputTokens = data.usage?.input_tokens ?? 0;
  const outputTokens = data.usage?.output_tokens ?? 0;

  // Record metrics for observability (OTel GenAI semantic conventions)
  console.log(`Token usage: input=${inputTokens}, output=${outputTokens}, total=${inputTokens + outputTokens}`);
  recordGenAiMetrics({
    operationName: "chat",
    requestModel: "claude-sonnet-4-20250514",
    responseModel: data.model,
    inputTokens,
    outputTokens,
    maxTokens: 1024,
    responseId: data.id,
    finishReasons: data.stop_reason ? [data.stop_reason] : undefined,
    streaming: false,
  });

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
    await onChunk(cached);
    return { text: cached, inputTokens: 0, outputTokens: 0, cached: true };
  }

  // Extract query from the last user message for semantic search
  const lastUserMessage = messages.filter(m => m.role === "user").pop();
  const query = lastUserMessage?.content || "";

  // Load initiatives context, search knowledge base, and detect gaps in parallel
  const [searchResults, initiativesContext, gapNudge] = await Promise.all([
    query ? searchDocuments(query, env, 5) : Promise.resolve([]),
    getInitiativesContext(env),
    query ? detectInitiativeGaps(query, env) : Promise.resolve(null),
  ]);

  // Format search results for context
  const knowledgeContext = formatSearchResultsForContext(searchResults);

  let systemPrompt = SYSTEM_PROMPT;
  if (initiativesContext) {
    systemPrompt += `\n\n## Active Initiatives\n\n${initiativesContext}`;
  }
  if (knowledgeContext) {
    systemPrompt += `\n\n${knowledgeContext}`;
  }
  if (gapNudge) {
    systemPrompt += `\n\n## Gentle Reminder\n\n${gapNudge}`;
  }

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

  // Record metrics for observability (OTel GenAI semantic conventions)
  console.log(`Token usage: input=${inputTokens}, output=${outputTokens}, total=${inputTokens + outputTokens}`);
  recordGenAiMetrics({
    operationName: "chat",
    requestModel: "claude-sonnet-4-20250514",
    inputTokens,
    outputTokens,
    maxTokens: 1024,
    streaming: true,
  });

  // Cache the response
  await env.DOCS_KV.put(cacheKey, text, { expirationTtl: CACHE_TTL_SECONDS });

  return { text, inputTokens, outputTokens, cached: false };
}
