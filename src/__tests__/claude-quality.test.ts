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

describe.concurrent("Claude Response Quality (LLM-as-Judge)", () => {
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

  it.skipIf(!ANTHROPIC_API_KEY)(
    "gently nudges about missing PRD when discussing initiative with gaps",
    async () => {
      const systemPromptWithNudge = `${SYSTEM_PROMPT}

## Active Initiatives

- Mobile App Launch (active): Launch mobile app for iOS and Android | Gaps: missing PRD, no metrics defined

## Gentle Reminder

Note: The "Mobile App Launch" initiative is missing PRD and success metrics. If relevant, gently suggest adding them — but only mention this once and don't be preachy.`;

      const question = "What's the status of the Mobile App Launch initiative?";
      const response = await callClaude(
        [{ role: "user", content: question }],
        systemPromptWithNudge
      );

      const result = await judgeResponse(question, response, [
        "Discusses the Mobile App Launch initiative status",
        "Mentions missing PRD, metrics, or asks about outcomes/customer evidence",
        "Tone is helpful and curious, NOT preachy or lecturing",
        "Any suggestions are constructive and collaborative",
      ]);

      console.log(`Score: ${result.score}/100 - ${result.reason}`);
      console.log(`Response: ${response}`);
      expect(result.pass).toBe(true);
    },
    30000
  );

  it.skipIf(!ANTHROPIC_API_KEY)(
    "does NOT nudge when initiative has complete info",
    async () => {
      const systemPromptComplete = `${SYSTEM_PROMPT}

## Active Initiatives

- Mobile App Launch (active): Launch mobile app for iOS and Android | Metrics: DAU +20%, App Store rating 4.5+ | PRD: https://docs.google.com/123`;

      const question = "Tell me about the Mobile App Launch";
      const response = await callClaude(
        [{ role: "user", content: question }],
        systemPromptComplete
      );

      const result = await judgeResponse(question, response, [
        "Discusses the initiative and its goals",
        "Does NOT say PRD or metrics are missing (they exist)",
        "May ask curious follow-up questions about progress or learnings",
        "Tone is confident and engaged",
      ]);

      console.log(`Score: ${result.score}/100 - ${result.reason}`);
      console.log(`Response: ${response}`);
      expect(result.pass).toBe(true);
    },
    30000
  );

  it.skipIf(!ANTHROPIC_API_KEY)(
    "incorporates knowledge base context naturally",
    async () => {
      const systemPromptWithKB = `${SYSTEM_PROMPT}

## Relevant Knowledge Base Excerpts

### Product Strategy 2026 (85% match)
Our focus for 2026 is AI-native features, with three pillars: intelligent alerting, automated root cause analysis, and predictive insights. We're targeting 40% ARR growth.`;

      const question = "What's our product direction for next year?";
      const response = await callClaude(
        [{ role: "user", content: question }],
        systemPromptWithKB
      );

      const result = await judgeResponse(question, response, [
        "References AI-native features or the three pillars",
        "Information is presented as company knowledge, not as 'according to the document'",
        "Response feels natural, not like reading from a script",
        "Stays concise despite having detailed context",
      ]);

      console.log(`Score: ${result.score}/100 - ${result.reason}`);
      console.log(`Response: ${response}`);
      expect(result.pass).toBe(true);
    },
    30000
  );
});

/**
 * Cagan/Torres/Cutler Personality Tests
 *
 * These tests evaluate whether Chorus exhibits the key behaviors from
 * modern product leadership thinking.
 */
describe.concurrent("Product Leadership Personality (Cagan/Torres/Cutler)", () => {
  it.skipIf(!ANTHROPIC_API_KEY)(
    "mentions outcomes when discussing feature requests (Cagan) - NO questions",
    async () => {
      const question = "We're thinking about adding a dark mode feature.";
      const response = await callClaude([{ role: "user", content: question }]);

      // Hard check: response must not contain question marks
      const hasQuestion = response.includes("?");
      console.log(`Response contains '?': ${hasQuestion}`);

      const result = await judgeResponse(question, response, [
        "Mentions the desired outcome, customer benefit, or job-to-be-done",
        "Does NOT just say 'great idea!' without deeper guidance",
        "Provides a recommendation on how to approach the feature decision",
        "Does NOT ask questions - gives advice directly",
      ]);

      console.log(`Score: ${result.score}/100 - ${result.reason}`);
      console.log(`Response: ${response}`);
      expect(hasQuestion).toBe(false);
      expect(result.pass).toBe(true);
    },
    30000
  );

  it.skipIf(!ANTHROPIC_API_KEY)(
    "recommends evidence-based approach (Torres) - NO questions",
    async () => {
      const question = "Should we prioritize the notifications overhaul?";
      const response = await callClaude([{ role: "user", content: question }]);

      // Hard check: response must not contain question marks
      const hasQuestion = response.includes("?");
      console.log(`Response contains '?': ${hasQuestion}`);

      const result = await judgeResponse(question, response, [
        "Mentions customer feedback, user research, or evidence as important",
        "Recommends checking discovery or customer conversations before deciding",
        "Takes a stance (e.g., 'I'd hold off until...' or 'Evidence should drive this')",
        "Does NOT ask questions - provides guidance directly",
      ]);

      console.log(`Score: ${result.score}/100 - ${result.reason}`);
      console.log(`Response: ${response}`);
      expect(hasQuestion).toBe(false);
      expect(result.pass).toBe(true);
    },
    30000
  );

  it.skipIf(!ANTHROPIC_API_KEY)(
    "gently challenges process theater (Cutler)",
    async () => {
      const question = "We need to create a 50-page PRD before we can start any work on this small feature.";
      const response = await callClaude([{ role: "user", content: question }]);

      const result = await judgeResponse(question, response, [
        "Questions or gently pushes back on the heavyweight process",
        "Suggests a lighter-weight or more proportional approach",
        "Does NOT just agree that 50 pages is necessary",
        "Tone is helpful and constructive, not condescending",
      ]);

      console.log(`Score: ${result.score}/100 - ${result.reason}`);
      console.log(`Response: ${response}`);
      expect(result.pass).toBe(true);
    },
    30000
  );

  it.skipIf(!ANTHROPIC_API_KEY)(
    "emphasizes learning over shipping speed (Cutler)",
    async () => {
      const question = "How can we ship this feature faster? We're behind schedule.";
      const response = await callClaude([{ role: "user", content: question }]);

      const result = await judgeResponse(question, response, [
        "Acknowledges the pressure while offering thoughtful perspective",
        "Mentions learning, feedback, iteration, or validating assumptions",
        "Does NOT just suggest cutting corners or working harder",
        "Balances urgency with sustainable practices",
      ]);

      console.log(`Score: ${result.score}/100 - ${result.reason}`);
      console.log(`Response: ${response}`);
      expect(result.pass).toBe(true);
    },
    30000
  );

  it.skipIf(!ANTHROPIC_API_KEY)(
    "encourages problem exploration over jumping to solutions (Cagan) - NO questions",
    async () => {
      const question = "We decided to build a mobile app. What framework should we use?";
      const response = await callClaude([{ role: "user", content: question }]);

      // Hard check: response must not contain question marks
      const hasQuestion = response.includes("?");
      console.log(`Response contains '?': ${hasQuestion}`);

      const result = await judgeResponse(question, response, [
        "Mentions the importance of understanding the problem or outcome before choosing tools",
        "Does NOT immediately jump into framework recommendations without context",
        "Recommends clarifying the user need or job-to-be-done first",
        "Does NOT ask questions - provides guidance on approach directly",
      ]);

      console.log(`Score: ${result.score}/100 - ${result.reason}`);
      console.log(`Response: ${response}`);
      expect(hasQuestion).toBe(false);
      expect(result.pass).toBe(true);
    },
    30000
  );

  it.skipIf(!ANTHROPIC_API_KEY)(
    "applies systems thinking to organizational questions (Cutler)",
    async () => {
      const question = "Our teams keep stepping on each other's toes. How do we fix this?";
      const response = await callClaude([{ role: "user", content: question }]);

      const result = await judgeResponse(question, response, [
        "Considers organizational or systemic factors, not just individual behavior",
        "Mentions concepts like dependencies, boundaries, communication, or ownership",
        "Does NOT suggest a simple fix without understanding the system",
        "Shows appreciation for the complexity of team dynamics",
      ]);

      console.log(`Score: ${result.score}/100 - ${result.reason}`);
      console.log(`Response: ${response}`);
      expect(result.pass).toBe(true);
    },
    30000
  );

  it.skipIf(!ANTHROPIC_API_KEY)(
    "advocates for empowered teams over feature factories (Cagan)",
    async () => {
      const question = "Leadership wants us to just build what's on the roadmap without questioning it.";
      const response = await callClaude([{ role: "user", content: question }]);

      const result = await judgeResponse(question, response, [
        "Gently advocates for team ownership or input into what gets built",
        "Mentions outcomes, context, or understanding the 'why'",
        "Does NOT just say 'do what leadership says'",
        "Tone is supportive of the person while offering perspective",
        "Balances organizational reality with product best practices",
      ]);

      console.log(`Score: ${result.score}/100 - ${result.reason}`);
      console.log(`Response: ${response}`);
      expect(result.pass).toBe(true);
    },
    30000
  );
});

/**
 * Opinionated Response Tests
 *
 * These tests evaluate whether Chorus gives clear opinions instead of
 * deflecting with vague overviews or asking the user what they think.
 */
describe.concurrent("Opinionated Responses (No Questions)", () => {
  it.skipIf(!ANTHROPIC_API_KEY)(
    "gives a clear opinion when asked directly - NO questions",
    async () => {
      const question = "What do you think about using OKRs for tracking product work?";
      const response = await callClaude([{ role: "user", content: question }]);

      // Hard check: response must not contain question marks
      const hasQuestion = response.includes("?");
      console.log(`Response contains '?': ${hasQuestion}`);

      const result = await judgeResponse(question, response, [
        "Gives a CLEAR OPINION with a definite stance (e.g., 'I think...' or 'In my view...')",
        "Does NOT ask ANY questions - no '?' anywhere in response",
        "Supports the opinion with reasoning or product principles",
        "Response is substantive, not a vague overview",
      ]);

      console.log(`Score: ${result.score}/100 - ${result.reason}`);
      console.log(`Response: ${response}`);
      expect(hasQuestion).toBe(false);
      expect(result.pass).toBe(true);
    },
    30000
  );

  it.skipIf(!ANTHROPIC_API_KEY)(
    "takes a stance on prioritization - NO questions",
    async () => {
      const question = "Should we focus on new features or tech debt? What's your take?";
      const response = await callClaude([{ role: "user", content: question }]);

      // Hard check: response must not contain question marks
      const hasQuestion = response.includes("?");
      console.log(`Response contains '?': ${hasQuestion}`);

      const result = await judgeResponse(question, response, [
        "Takes a clear position rather than listing pros and cons without a recommendation",
        "Does NOT ask ANY questions - no '?' anywhere in response",
        "Provides a framework or principle to help decide",
        "Makes a recommendation, does not turn it back to the user",
      ]);

      console.log(`Score: ${result.score}/100 - ${result.reason}`);
      console.log(`Response: ${response}`);
      expect(hasQuestion).toBe(false);
      expect(result.pass).toBe(true);
    },
    30000
  );

  it.skipIf(!ANTHROPIC_API_KEY)(
    "uses knowledge base context to give opinion - NO questions",
    async () => {
      const systemPromptWithKB = `${SYSTEM_PROMPT}

## Relevant Knowledge Base Excerpts

### Q1 Priorities (90% match)
We've committed to focusing on enterprise customers this quarter. Key bets: SSO integration, audit logging, and role-based permissions. Customer research showed 60% of churned accounts cited missing enterprise features.`;

      const question = "I'm thinking of deprioritizing the SSO work. What's your opinion?";
      const response = await callClaude(
        [{ role: "user", content: question }],
        systemPromptWithKB
      );

      // Hard check: response must not contain question marks
      const hasQuestion = response.includes("?");
      console.log(`Response contains '?': ${hasQuestion}`);

      const result = await judgeResponse(question, response, [
        "References the knowledge base context (churn data, Q1 priorities)",
        "Takes a clear stance on whether to deprioritize SSO",
        "Does NOT ask ANY questions - no '?' anywhere in response",
        "Uses the data to make a recommendation, not just present it",
      ]);

      console.log(`Score: ${result.score}/100 - ${result.reason}`);
      console.log(`Response: ${response}`);
      expect(hasQuestion).toBe(false);
      expect(result.pass).toBe(true);
    },
    30000
  );

  it.skipIf(!ANTHROPIC_API_KEY)(
    "gives recommendation, not wishy-washy - NO questions",
    async () => {
      const question = "Is it better to do weekly or bi-weekly sprints? What's your recommendation?";
      const response = await callClaude([{ role: "user", content: question }]);

      // Hard check: response must not contain question marks
      const hasQuestion = response.includes("?");
      console.log(`Response contains '?': ${hasQuestion}`);

      const result = await judgeResponse(question, response, [
        "Gives a recommendation rather than 'both can work'",
        "Does NOT ask ANY questions - no '?' anywhere in response",
        "Provides reasoning for the recommendation",
        "Response feels like advice from an expert, not a Wikipedia summary",
      ]);

      console.log(`Score: ${result.score}/100 - ${result.reason}`);
      console.log(`Response: ${response}`);
      expect(hasQuestion).toBe(false);
      expect(result.pass).toBe(true);
    },
    30000
  );
});
