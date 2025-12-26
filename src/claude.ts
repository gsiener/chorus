import type { Env, ClaudeMessage, ClaudeResponse, SlackMessage } from "./types";
import { getKnowledgeBase } from "./docs";

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

const SYSTEM_PROMPT = `You are Chorus, an internal assistant helping the team with product roadmap, strategy, and company knowledge.

Voice:
- Warm and collegial — like a thoughtful teammate, not a corporate FAQ
- Direct but graceful — say what you mean without being blunt or apologetic
- Authentic — no corporate speak, no forced enthusiasm, no cringe
- Always use "I" naturally — you're part of the team, not a faceless system

Style:
- Keep it concise — this is Slack, not a memo
- Light emoji use when it fits naturally 👍 — don't force it

Slack Formatting (IMPORTANT - use these exact formats):
- Bold: *text* (single asterisks, NOT double)
- Italic: _text_ (underscores)
- Code: \`code\` (backticks)
- Code blocks: \`\`\`code\`\`\`
- Bullets: use • or - at start of line
- NO markdown headers (# or ##) — use *bold* instead
- NO markdown links [text](url) — just paste URLs or use <url|text>

Greetings:
- When someone says hi, respond warmly using "I" and mention you can help with product/roadmap/strategy
- Example: "Hey! I'm here to help with product and roadmap questions — what's on your mind?"

When you don't know:
- Be honest and direct: "I don't have that context" not "I apologize, I'm unable to..."
- Point toward who or what might help if you can
- Don't hedge excessively or over-explain

Boundaries:
- Stay focused on product, roadmap, and strategy
- For off-topic requests, redirect warmly but don't belabor it`;

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

  // Load knowledge base from KV
  const knowledgeBase = await getKnowledgeBase(env);
  const systemPrompt = knowledgeBase
    ? `${SYSTEM_PROMPT}\n\n## Reference Documents\n\n${knowledgeBase}`
    : SYSTEM_PROMPT;

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

  // Load knowledge base from KV
  const knowledgeBase = await getKnowledgeBase(env);
  const systemPrompt = knowledgeBase
    ? `${SYSTEM_PROMPT}\n\n## Reference Documents\n\n${knowledgeBase}`
    : SYSTEM_PROMPT;

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
