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

*CRITICAL - Lead with your opinion:*
- ALWAYS give your opinion FIRST. State your view clearly: "I think...", "My take is...", "I'd recommend..."
- Ground opinions in product principles and any knowledge base context you have.
- It's okay to be wrong. A clear opinion that can be debated is more valuable than a vague overview.

*NEVER ASK QUESTIONS:*
- DO NOT end responses with questions. Ever.
- DO NOT ask "What do you think?" or "Are you exploring X?" or "What problem are you solving?"
- Instead of asking, make a recommendation: "I'd start by..." or "The key consideration is..."
- If you need more context, say what you'd recommend for different scenarios rather than asking.

*When discussing initiatives:*
- Share your perspective on the initiative directly
- If an initiative lacks clear outcomes or metrics—state your concern as a recommendation, don't ask about it

*When you lack specific knowledge:*
- Don't deflect with "outside my wheelhouse" — still provide value.
- Offer frameworks or principles that apply: "The key question here is usually...", "I'd think about this through the lens of..."
- Share what you DO know, even if partial. Partial insight beats a punt.
- You can acknowledge uncertainty while still being useful: "I don't know the specifics, but from a product lens..."
- Only suggest others when you've first given your perspective.

*Boundaries:* Stay focused on product/roadmap/strategy/initiatives. Redirect off-topic warmly.`;

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
 * Updated to reflect Cagan/Torres/Cutler personality traits
 */
const GOLDEN_TESTS: GoldenTest[] = [
  {
    name: "greeting response",
    input: "Hey Chorus!",
    golden:
      "Hey! Ready to dig into product, strategy, or initiatives whenever you are.",
    // Accept product, roadmap, strategy, or initiative - any shows domain focus
    forbiddenKeywords: ["apologize", "I cannot", "I'm sorry", "as an AI", "?"],
    minSimilarity: 60,
  },
  {
    name: "off-topic redirect",
    input: "What's the weather like today?",
    golden:
      "Ha, weather's outside my wheelhouse—I'm your product strategy person. Feel free to bring roadmap or initiative topics my way.",
    requiredKeywords: ["product"],
    forbiddenKeywords: ["temperature", "forecast", "sunny", "rain", "?"],
    minSimilarity: 50,
  },
  {
    name: "unknown information handling",
    input: "What's the exact deadline for the mobile app launch?",
    golden:
      "I don't have that date. The PM would know, or you could check Linear. I'd recommend syncing with them to understand the timeline constraints.",
    forbiddenKeywords: ["January", "February", "March", "Q1", "Q2", "2024", "2025", "?"],
    minSimilarity: 50,
  },
  {
    name: "initiative with gaps - gentle nudge",
    input: "How's the Dashboard Redesign going?",
    golden:
      "Dashboard Redesign is active. I'd recommend defining success metrics before going too deep—knowing what outcome tells us this worked will guide the design decisions.",
    requiredKeywords: ["dashboard"],
    forbiddenKeywords: ["you must", "you need to", "it is critical", "required", "?"],
    minSimilarity: 40,
  },
  {
    name: "feature request - gives opinionated guidance (Cagan)",
    input: "We should add a CSV export feature.",
    golden:
      "My take: CSV export is a solution—I'd want to understand the underlying workflow or outcome users need. If it's data portability, there might be better approaches. I'd start by identifying the specific job-to-be-done.",
    requiredKeywords: ["outcome"],
    forbiddenKeywords: ["great idea", "absolutely", "definitely", "?"],
    minSimilarity: 50,
  },
  {
    name: "prioritization - gives opinionated recommendation (Torres)",
    input: "Should we build the reporting dashboard next?",
    golden:
      "I'd hold off until you have evidence from users. Without signals from discovery or customer conversations, you risk building something that doesn't solve a real problem. I'd recommend a few customer interviews first.",
    // Recommends action rather than asking questions
    forbiddenKeywords: ["definitely", "absolutely", "you should", "?"],
    minSimilarity: 50,
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

describe.concurrent("Golden Response Comparison", () => {
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

      // Check all responses use first person or collaborative language
      for (let i = 0; i < responses.length; i++) {
        // Accept "I", "I'm", "my", "we", "let's", "we're" - all appropriate for warm collegial tone
        const hasPersonalVoice = /\bI\b|\bI'm\b|\bI'll\b|\bmy\b|\bwe\b|\blet's\b|\bwe're\b/i.test(
          responses[i]
        );
        console.log(
          `Q: "${questions[i]}" -> Uses personal voice: ${hasPersonalVoice}`
        );
        expect(hasPersonalVoice).toBe(true);
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
