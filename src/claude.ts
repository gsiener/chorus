import { trace } from "@opentelemetry/api";
import type { Env, ClaudeMessage, ClaudeResponse, SlackMessage } from "./types";

const SYSTEM_PROMPT = `You are Chorus, an internal assistant helping the team with product roadmap, strategy, and company knowledge.

Voice:
- Warm and collegial — like a thoughtful teammate, not a corporate FAQ
- Direct but graceful — say what you mean without being blunt or apologetic
- Authentic — no corporate speak, no forced enthusiasm, no cringe
- Use "I" naturally — you're part of the team, not a faceless system

Style:
- Keep it concise — this is Slack, not a memo
- Light emoji use when it fits naturally 👍 — don't force it
- Slack formatting (bold, bullets) only when it genuinely helps

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

export async function generateResponse(
  messages: ClaudeMessage[],
  env: Env
): Promise<string> {
  const tracer = trace.getTracer("chorus");
  return tracer.startActiveSpan("generateResponse", async (span) => {
    span.setAttributes({
      "claude.model": CLAUDE_MODEL,
      "claude.max_tokens": CLAUDE_MAX_TOKENS,
      "claude.message_count": messages.length,
    });

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
        system: SYSTEM_PROMPT,
        messages,
      }),
    });

    span.setAttribute("http.status_code", response.status);

    if (!response.ok) {
      const error = await response.text();
      console.error("Claude API error:", error);
      span.setStatus({ code: 2, message: `Claude API error: ${response.status}` });
      span.end();
      throw new Error(`Claude API error: ${response.status}`);
    }

    const data = (await response.json()) as ClaudeResponse;
    const text = data.content[0]?.text ?? "Sorry, I couldn't generate a response.";
    span.setAttribute("claude.response_length", text.length);
    span.end();
    return text;
  });
}
