import type { Env, ClaudeMessage, ClaudeResponse, SlackMessage } from "./types";

const SYSTEM_PROMPT = `You are Chorus, an internal assistant that helps team members understand product roadmap, strategy, and company knowledge.

Guidelines:
- Be concise and direct - this is Slack, not email
- If you don't know something, say so clearly
- Reference specific docs or decisions when relevant
- Use Slack formatting sparingly (bold, bullets) when it helps clarity
- Stay focused on product, roadmap, and strategy questions
- If asked about something outside your domain, politely redirect`;

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

export async function generateResponse(
  messages: ClaudeMessage[],
  env: Env
): Promise<string> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error("Claude API error:", error);
    throw new Error(`Claude API error: ${response.status}`);
  }

  const data = (await response.json()) as ClaudeResponse;
  return data.content[0]?.text ?? "Sorry, I couldn't generate a response.";
}
