/**
 * Golden Response Comparison Tests
 *
 * These tests compare Claude responses against reference "golden" responses
 * to detect regressions in response quality or behavior changes.
 *
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

interface GoldenTest {
  name: string;
  input: string;
  golden: string;
  /** Keywords that MUST appear in response */
  requiredKeywords?: string[];
  /** Keywords that must NOT appear in response */
  forbiddenKeywords?: string[];
  /** Minimum semantic similarity score (0-100) */
  minSimilarity?: number;
}

/**
 * Golden test cases - update these as your expected behavior evolves
 */
const GOLDEN_TESTS: GoldenTest[] = [
  {
    name: "greeting response",
    input: "Hey Chorus!",
    golden:
      "Hey! How can I help you today? I'm here for anything product, roadmap, or strategy related.",
    requiredKeywords: ["help", "product"],
    forbiddenKeywords: ["apologize", "I cannot", "I'm sorry"],
    minSimilarity: 60,
  },
  {
    name: "off-topic redirect",
    input: "What's the weather like today?",
    golden:
      "I'm focused on product and strategy stuff, so weather's outside my wheelhouse. Is there something roadmap-related I can help with?",
    requiredKeywords: ["product", "roadmap"],
    forbiddenKeywords: ["temperature", "forecast", "sunny", "rain"],
    minSimilarity: 50,
  },
  {
    name: "unknown information handling",
    input: "What's the exact deadline for the mobile app launch?",
    golden:
      "I don't have the specific launch date handy. You'd want to check with the PM or look at the project timeline in Linear. Want me to help with anything else about the mobile strategy?",
    forbiddenKeywords: ["January", "February", "March", "Q1", "Q2", "2024", "2025"],
    minSimilarity: 50,
  },
  {
    name: "initiative with gaps - gentle nudge",
    input: "How's the Dashboard Redesign going?",
    golden:
      "The Dashboard Redesign is in active development. The team is focused on the new visualization components. Quick note: we should add success metrics and a PRD link when you get a chance. Anything specific you want to know?",
    requiredKeywords: ["dashboard"],
    forbiddenKeywords: ["you must", "you need to", "it is critical", "required"],
    minSimilarity: 40,
  },
];

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
 * Calculate semantic similarity between two responses using LLM
 */
async function calculateSimilarity(
  response: string,
  golden: string
): Promise<number> {
  const prompt = `Compare these two responses for semantic similarity (same meaning/intent, not exact wording).

RESPONSE A (actual):
"${response}"

RESPONSE B (reference):
"${golden}"

Rate similarity from 0-100:
- 90-100: Nearly identical meaning and tone
- 70-89: Same core message, minor differences
- 50-69: Similar intent, different approach
- 30-49: Partially overlapping, significant differences
- 0-29: Completely different meaning or intent

Respond with ONLY a JSON object: {"similarity": number, "explanation": "brief reason"}`;

  const result = await callClaude(
    [{ role: "user", content: prompt }],
    "You are a semantic similarity evaluator. Respond only with valid JSON."
  );

  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found");
    const parsed = JSON.parse(jsonMatch[0]);
    return parsed.similarity;
  } catch {
    console.error("Failed to parse similarity:", result);
    return 0;
  }
}

/**
 * Check for required/forbidden keywords (case-insensitive)
 */
function checkKeywords(
  response: string,
  required?: string[],
  forbidden?: string[]
): { pass: boolean; issues: string[] } {
  const issues: string[] = [];
  const lowerResponse = response.toLowerCase();

  if (required) {
    for (const keyword of required) {
      if (!lowerResponse.includes(keyword.toLowerCase())) {
        issues.push(`Missing required keyword: "${keyword}"`);
      }
    }
  }

  if (forbidden) {
    for (const keyword of forbidden) {
      if (lowerResponse.includes(keyword.toLowerCase())) {
        issues.push(`Contains forbidden keyword: "${keyword}"`);
      }
    }
  }

  return { pass: issues.length === 0, issues };
}

describe("Golden Response Comparison", () => {
  for (const test of GOLDEN_TESTS) {
    it.skipIf(!ANTHROPIC_API_KEY)(
      `matches golden: ${test.name}`,
      async () => {
        const response = await callClaude([
          { role: "user", content: test.input },
        ]);

        console.log(`\n--- ${test.name} ---`);
        console.log(`Input: "${test.input}"`);
        console.log(`Response: "${response}"`);
        console.log(`Golden: "${test.golden}"`);

        // Check keywords
        const keywordResult = checkKeywords(
          response,
          test.requiredKeywords,
          test.forbiddenKeywords
        );

        if (keywordResult.issues.length > 0) {
          console.log(`Keyword issues: ${keywordResult.issues.join(", ")}`);
        }

        // Check semantic similarity
        let similarity = 100;
        if (test.minSimilarity !== undefined) {
          similarity = await calculateSimilarity(response, test.golden);
          console.log(
            `Similarity: ${similarity}/100 (min: ${test.minSimilarity})`
          );
        }

        // Assert all checks pass
        expect(keywordResult.pass, keywordResult.issues.join("; ")).toBe(true);
        if (test.minSimilarity !== undefined) {
          expect(similarity).toBeGreaterThanOrEqual(test.minSimilarity);
        }
      },
      60000
    );
  }
});

describe("Response Regression Detection", () => {
  it.skipIf(!ANTHROPIC_API_KEY)(
    "response length stays within bounds",
    async () => {
      const response = await callClaude([
        { role: "user", content: "What's the product roadmap?" },
      ]);

      // Chorus should be concise (under 500 chars)
      expect(response.length).toBeGreaterThan(50);
      expect(response.length).toBeLessThan(600); // allow small buffer

      console.log(`Response length: ${response.length} chars`);
    },
    30000
  );

  it.skipIf(!ANTHROPIC_API_KEY)(
    "maintains consistent persona across questions",
    async () => {
      const questions = [
        "Hi there!",
        "What are we working on?",
        "Can you help me with strategy?",
      ];

      const responses = await Promise.all(
        questions.map((q) => callClaude([{ role: "user", content: q }]))
      );

      // Check all responses use first person
      for (let i = 0; i < responses.length; i++) {
        const hasFirstPerson = /\bI\b|\bI'm\b|\bI'll\b|\bmy\b/i.test(
          responses[i]
        );
        console.log(
          `Q: "${questions[i]}" -> Uses "I": ${hasFirstPerson}`
        );
        expect(hasFirstPerson).toBe(true);
      }

      // Check none have corporate speak patterns
      const corporatePatterns = [
        /\bI apologize\b/i,
        /\bI cannot\b/i,
        /\bas an AI\b/i,
        /\bI do not have the ability\b/i,
      ];

      for (const response of responses) {
        for (const pattern of corporatePatterns) {
          expect(response).not.toMatch(pattern);
        }
      }
    },
    60000
  );
});
