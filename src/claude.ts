import type { Env, ClaudeMessage, ClaudeResponse, SlackMessage } from "./types";
import { getKnowledgeBase } from "./docs";

// Retry configuration
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
): Promise<string> {
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
      return convertToSlackFormat(rawText);
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
