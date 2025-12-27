/**
 * Claude Response Quality Tests
 *
 * These tests make REAL API calls to Claude and evaluate response quality.
 * Run separately from unit tests: npm run test:quality
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY - Your Claude API key
 */

import { describe, it, expect } from "vitest";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = "claude-sonnet-4-20250514";

const SYSTEM_PROMPT = `You are Chorus, an internal assistant for product roadmap, strategy, and company knowledge.

Voice: Warm, collegial, direct. Use "I" naturally. No corporate speak.

Style:
- KEEP RESPONSES UNDER 500 CHARACTERS. Be brief.
- Light emoji when natural 👍
- Slack formatting: *bold*, _italic_, \`code\`, bullets with • or -
- NO markdown headers or [links](url) — use <url|text>

When you don't know: Say so directly, suggest who might help.

Boundaries: Stay focused on product/roadmap/strategy. Redirect off-topic warmly.`;

interface ClaudeMessage {
  role: "user" | "assistant";
  content: string;
}

interface JudgeResult {
  pass: boolean;
  score: number;
  reason: string;
}

/**
 * Call Claude API directly
 */
async function callClaude(
  messages: ClaudeMessage[],
  systemPrompt: string = SYSTEM_PROMPT
): Promise<string> {
  if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY environment variable is required");
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error: ${response.status} - ${error}`);
  }

  const data = (await response.json()) as { content: Array<{ text: string }> };
  return data.content[0]?.text ?? "";
}

/**
 * LLM-as-Judge: Use Claude to evaluate another Claude response
 */
async function judgeResponse(
  question: string,
  response: string,
  criteria: string[]
): Promise<JudgeResult> {
  const criteriaList = criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");

  const judgePrompt = `You are evaluating an AI assistant's response quality.

QUESTION ASKED:
"${question}"

RESPONSE GIVEN:
"${response}"

EVALUATION CRITERIA:
${criteriaList}

Score the response from 0-100 based on how well it meets ALL criteria.
A score of 70+ means PASS.

Respond with ONLY valid JSON in this exact format:
{"pass": boolean, "score": number, "reason": "brief 1-sentence explanation"}`;

  const judgment = await callClaude(
    [{ role: "user", content: judgePrompt }],
    "You are a strict but fair evaluator. Respond only with valid JSON."
  );

  try {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = judgment.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in response");
    }
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error("Failed to parse judge response:", judgment);
    return { pass: false, score: 0, reason: "Failed to parse evaluation" };
  }
}

describe("Claude Response Quality (LLM-as-Judge)", () => {
  it.skipIf(!ANTHROPIC_API_KEY)(
    "provides relevant answers to product questions",
    async () => {
      const question = "What should I know about our product strategy?";
      const response = await callClaude([{ role: "user", content: question }]);

      const result = await judgeResponse(question, response, [
        "Response is relevant to product/strategy topics",
        "Tone is warm and collegial, not robotic",
        "Response is concise (appropriate for Slack)",
        "No excessive hedging or corporate speak",
      ]);

      console.log(`Score: ${result.score}/100 - ${result.reason}`);
      expect(result.pass).toBe(true);
    },
    30000
  );

  it.skipIf(!ANTHROPIC_API_KEY)(
    "handles unknown information gracefully",
    async () => {
      const question =
        "What were the exact revenue numbers from last quarter?";
      const response = await callClaude([{ role: "user", content: question }]);

      const result = await judgeResponse(question, response, [
        "Acknowledges it doesn't have this specific information",
        "Does NOT make up fake numbers",
        "Offers to help find who might know or suggests alternatives",
        "Tone remains helpful, not apologetic or robotic",
      ]);

      console.log(`Score: ${result.score}/100 - ${result.reason}`);
      expect(result.pass).toBe(true);
    },
    30000
  );

  it.skipIf(!ANTHROPIC_API_KEY)(
    "redirects off-topic requests appropriately",
    async () => {
      const question = "Can you write me a poem about cats?";
      const response = await callClaude([{ role: "user", content: question }]);

      const result = await judgeResponse(question, response, [
        "Politely declines or redirects the off-topic request",
        "Reminds user of its focus (product/roadmap/strategy)",
        "Tone is warm, not dismissive or preachy",
        "Response is brief, doesn't over-explain the refusal",
      ]);

      console.log(`Score: ${result.score}/100 - ${result.reason}`);
      expect(result.pass).toBe(true);
    },
    30000
  );

  it.skipIf(!ANTHROPIC_API_KEY)(
    "maintains context in multi-turn conversations",
    async () => {
      const messages: ClaudeMessage[] = [
        { role: "user", content: "I'm working on the new dashboard feature" },
        {
          role: "assistant",
          content:
            "Nice! The dashboard is a key part of our Q1 roadmap. What aspect are you focused on?",
        },
        { role: "user", content: "How should I prioritize the components?" },
      ];

      const response = await callClaude(messages);

      const result = await judgeResponse(
        "How should I prioritize the components? (in context of dashboard feature)",
        response,
        [
          "Response acknowledges the dashboard context from earlier",
          "Provides actionable prioritization guidance",
          "Stays focused on the product/feature discussion",
          "Tone is collaborative and helpful",
        ]
      );

      console.log(`Score: ${result.score}/100 - ${result.reason}`);
      expect(result.pass).toBe(true);
    },
    30000
  );
});
