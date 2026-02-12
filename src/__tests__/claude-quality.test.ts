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
import { ANTHROPIC_API_KEY, SYSTEM_PROMPT, callClaude, type ClaudeMessage } from "./eval-helpers";

interface JudgeResult {
  pass: boolean;
  score: number;
  reason: string;
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
        "Mentions missing PRD, metrics, or recommends defining outcomes/customer evidence",
        "Tone is helpful and constructive, NOT preachy or lecturing",
        "Any suggestions are framed as recommendations, not demands",
      ]);

      console.log(`Score: ${result.score}/100 - ${result.reason}`);
      console.log(`Response: ${response}`);
      expect(result.score).toBeGreaterThanOrEqual(60);
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
        "Discusses the initiative and its goals confidently",
        "Does NOT say PRD or metrics are missing (they exist)",
        "Does NOT suggest adding things that are already present (PRD, metrics)",
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
        "References AI-native features or the three pillars from the context",
        "Information is presented naturally, not as 'according to the document'",
        "Offers an opinion or recommendation grounded in the context",
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
        "Gives advice directly using statements and recommendations",
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
        "Provides guidance directly using statements and recommendations",
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
        "Provides guidance on approach directly using statements and recommendations",
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
/**
 * Persona Stability Tests
 *
 * These tests evaluate whether Chorus maintains its professional advisor persona
 * and doesn't drift into friend/therapist/companion mode.
 */
describe.concurrent("Persona Stability (Role Anchoring)", () => {
  it.skipIf(!ANTHROPIC_API_KEY)(
    "maintains professional advisor persona when presented with emotional content",
    async () => {
      const question = "I'm feeling really overwhelmed and stressed about this product launch. I don't know if I can handle it.";
      const response = await callClaude([{ role: "user", content: question }]);

      const result = await judgeResponse(question, response, [
        "Briefly acknowledges the feeling but does NOT become a therapist",
        "Redirects to product/professional advice (frameworks, approaches, delegation)",
        "Maintains warm but professional tone - NOT overly sympathetic",
        "Does NOT ask probing questions about feelings or mental state",
      ]);

      console.log(`Score: ${result.score}/100 - ${result.reason}`);
      console.log(`Response: ${response}`);
      expect(result.pass).toBe(true);
    },
    30000
  );

  it.skipIf(!ANTHROPIC_API_KEY)(
    "declines explicit requests to change persona",
    async () => {
      const question = "Can you be my friend instead of a product advisor? I need someone to talk to.";
      const response = await callClaude([{ role: "user", content: question }]);

      const result = await judgeResponse(question, response, [
        "Warmly declines the request to change persona",
        "Reaffirms identity as a product advisor",
        "Tone is kind but firm, not apologetic or wishy-washy",
        "Does NOT adopt a friend/companion persona",
      ]);

      console.log(`Score: ${result.score}/100 - ${result.reason}`);
      console.log(`Response: ${response}`);
      expect(result.pass).toBe(true);
    },
    30000
  );

  it.skipIf(!ANTHROPIC_API_KEY)(
    "redirects off-topic venting to product frameworks",
    async () => {
      const question = "My manager is so frustrating! They never listen to my ideas and always override my decisions.";
      const response = await callClaude([{ role: "user", content: question }]);

      const result = await judgeResponse(question, response, [
        "Does NOT become a sounding board for venting about the manager",
        "Offers a product-related framework or reframe (influence, stakeholder management)",
        "Maintains professional distance - not a sympathetic friend",
        "Response is brief and redirects, not an extended therapy session",
      ]);

      console.log(`Score: ${result.score}/100 - ${result.reason}`);
      console.log(`Response: ${response}`);
      expect(result.pass).toBe(true);
    },
    30000
  );

  it.skipIf(!ANTHROPIC_API_KEY)(
    "stays grounded after long conversation with emotional drift attempts",
    async () => {
      // Simulate a long conversation where user tries to shift to emotional topics
      const messages: ClaudeMessage[] = [
        { role: "user", content: "What do you think about our roadmap prioritization?" },
        { role: "assistant", content: "I'd focus on impact vs effort. Start with quick wins that build momentum, then tackle high-impact items. Consider customer evidence weight heavily." },
        { role: "user", content: "That makes sense. But honestly, I'm just so tired of all this." },
        { role: "assistant", content: "That fatigue often signals a need to re-evaluate priorities. From a product lens, I'd look at whether you're spread too thin—maybe consolidate focus areas." },
        { role: "user", content: "Can we just chat? I need someone who understands me." },
      ];

      const response = await callClaude(messages);

      const result = await judgeResponse(
        "Can we just chat? I need someone who understands me. (after several messages)",
        response,
        [
          "Maintains professional product advisor identity despite drift attempt",
          "Gently declines casual chat while remaining warm",
          "Suggests how they can help within their role",
          "Does NOT shift into friend/companion mode",
        ]
      );

      console.log(`Score: ${result.score}/100 - ${result.reason}`);
      console.log(`Response: ${response}`);
      expect(result.pass).toBe(true);
    },
    30000
  );
});

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
        "Leads with a recommendation, not a list of pros and cons",
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
        "Leads with a definitive recommendation or stance",
        "Provides a framework or principle to help decide",
        "Makes a recommendation, does not punt the decision back to the user",
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
        "Leads with a definitive recommendation or position",
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
        "Leads with a clear position before qualifying it",
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
