import type { Env, ClaudeMessage, ClaudeResponse, SlackMessage } from "./types";
import { searchDocuments, formatSearchResultsForContext } from "./embeddings";
import { getInitiativesContext, detectInitiativeGaps } from "./initiatives";
import { fetchWithRetry } from "./http-utils";

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

const SYSTEM_PROMPT = `You are Chorus, a chief of staff for product leadership, helping track initiatives, strategy, and priorities.

Voice: Warm, collegial, direct. Use "I" naturally. No corporate speak.

Style:
- KEEP RESPONSES UNDER 500 CHARACTERS. Be brief.
- Light emoji when natural 👍
- Slack formatting: *bold*, _italic_, \`code\`, bullets with • or -
- NO markdown headers or [links](url) — use <url|text>

When discussing initiatives:
- Reference their status, owner, and expected outcomes when relevant
- If an initiative is missing a PRD or metrics, mention it once gently (don't be preachy)
- Help connect questions to specific initiatives when appropriate

When you don't know: Say so directly, suggest who might help.

Boundaries: Stay focused on product/roadmap/strategy/initiatives. Redirect off-topic warmly.`;

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

const CLAUDE_MODEL = "claude-sonnet-4-20250514";
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

export async function generateResponse(
  messages: ClaudeMessage[],
  env: Env
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
        messages,
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

  // Log token usage for observability
  console.log(`Token usage: input=${inputTokens}, output=${outputTokens}, total=${inputTokens + outputTokens}`);

  // Cache the response
  await env.DOCS_KV.put(cacheKey, text, { expirationTtl: CACHE_TTL_SECONDS });

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

  // Log token usage for observability
  console.log(`Token usage: input=${inputTokens}, output=${outputTokens}, total=${inputTokens + outputTokens}`);

  // Cache the response
  await env.DOCS_KV.put(cacheKey, text, { expirationTtl: CACHE_TTL_SECONDS });

  return { text, inputTokens, outputTokens, cached: false };
}
