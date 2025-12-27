import type { Env, ClaudeMessage, ClaudeResponse, SlackMessage } from "./types";
import { getKnowledgeBase } from "./docs";
import { getInitiativesContext } from "./initiatives";

// Retry configuration
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;

// Cache configuration
const CACHE_PREFIX = "cache:response:";
const CACHE_TTL_SECONDS = 3600; // 1 hour

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

  // Load knowledge base and initiatives context from KV
  const [knowledgeBase, initiativesContext] = await Promise.all([
    getKnowledgeBase(env),
    getInitiativesContext(env),
  ]);

  let systemPrompt = SYSTEM_PROMPT;
  if (initiativesContext) {
    systemPrompt += `\n\n## Active Initiatives\n\n${initiativesContext}`;
  }
  if (knowledgeBase) {
    systemPrompt += `\n\n## Reference Documents\n\n${knowledgeBase}`;
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
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
        }),
      });

      // Retry on rate limit or server errors
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = response.headers.get('retry-after');
        const delay = retryAfter
          ? parseInt(retryAfter) * 1000
          : INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);

        if (attempt < MAX_RETRIES - 1) {
          console.log(`Claude API ${response.status}, retrying after ${delay}ms`);
          await sleep(delay);
          continue;
        }
      }

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
    } catch (error) {
      lastError = error as Error;
      if (attempt < MAX_RETRIES - 1 && !(error instanceof Error && error.message.includes('Claude API error'))) {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
        console.log(`Claude fetch error, retrying after ${delay}ms: ${lastError.message}`);
        await sleep(delay);
      }
    }
  }

  throw lastError ?? new Error('Claude API failed after retries');
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

  // Load knowledge base and initiatives context from KV
  const [knowledgeBase, initiativesContext] = await Promise.all([
    getKnowledgeBase(env),
    getInitiativesContext(env),
  ]);

  let systemPrompt = SYSTEM_PROMPT;
  if (initiativesContext) {
    systemPrompt += `\n\n## Active Initiatives\n\n${initiativesContext}`;
  }
  if (knowledgeBase) {
    systemPrompt += `\n\n## Reference Documents\n\n${knowledgeBase}`;
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
