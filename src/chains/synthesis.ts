import { ChatAnthropic } from '@langchain/anthropic';
import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { StructuredOutputParser } from 'langchain/output_parsers';
import { z } from 'zod';
import type { AnalyzedFeedback, PMFMetrics } from '../types';

// Schema for synthesis output
const SynthesisOutputSchema = z.object({
  insights: z.array(z.string()),
  recommendations: z.array(z.string()),
  investmentAreas: z.array(
    z.object({
      area: z.string(),
      rationale: z.string(),
      priority: z.enum(['low', 'medium', 'high', 'critical']),
    })
  ),
});

/**
 * Calculate PMF metrics from analyzed feedback
 */
export function calculateMetrics(feedback: AnalyzedFeedback[]): PMFMetrics {
  const timestamps = feedback.map((f) => f.timestamp);
  const start = Math.min(...timestamps);
  const end = Math.max(...timestamps);

  const sentimentBreakdown: Record<string, number> = {
    very_positive: 0,
    positive: 0,
    neutral: 0,
    negative: 0,
    very_negative: 0,
  };

  const themeCount: Record<string, number> = {};

  for (const item of feedback) {
    sentimentBreakdown[item.sentiment]++;

    for (const theme of item.themes) {
      themeCount[theme] = (themeCount[theme] || 0) + 1;
    }
  }

  const topThemes = Object.entries(themeCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([theme, count]) => ({
      theme,
      count,
      sentiment: 0, // TODO: Calculate weighted sentiment
    }));

  const positiveCount = sentimentBreakdown.very_positive + sentimentBreakdown.positive;
  const overallScore = feedback.length > 0 ? positiveCount / feedback.length : 0;

  return {
    period: { start, end },
    totalFeedback: feedback.length,
    sentimentBreakdown,
    topThemes,
    overallScore,
  };
}

/**
 * LangChain chain for synthesizing feedback into insights
 */
export function createSynthesisChain(apiKey: string) {
  const model = new ChatAnthropic({
    apiKey,
    model: 'claude-3-5-sonnet-20241022',
    temperature: 0.5,
    maxTokens: 4096,
  });

  const parser = StructuredOutputParser.fromZodSchema(SynthesisOutputSchema);

  const prompt = PromptTemplate.fromTemplate(`
You are analyzing product feedback to assess product-market fit and identify investment opportunities.

Current Period: {period}
Total Feedback: {totalFeedback}
Overall Score: {overallScore}%

Sentiment Distribution:
{sentimentDistribution}

Top Themes:
{topThemes}

Recent Feedback Summary (last 100 items):
{feedbackSummary}

{format_instructions}

Focus on:
1. Signals of product-market fit (or lack thereof)
2. Emerging trends and patterns
3. Most impactful areas for improvement
4. User segments with strongest/weakest fit

Respond only with valid JSON matching the schema.
`);

  return RunnableSequence.from([prompt, model, parser]);
}

/**
 * Generate a comprehensive analysis report from analyzed feedback
 */
export async function synthesizeReport(
  feedback: AnalyzedFeedback[],
  apiKey: string
): Promise<{ insights: string[]; recommendations: string[]; investmentAreas: any[] }> {
  const metrics = calculateMetrics(feedback);
  const chain = createSynthesisChain(apiKey);

  const feedbackSummary = feedback
    .slice(0, 100)
    .map((f) => `- [${f.category}] ${f.summary} (${f.sentiment})`)
    .join('\n');

  const sentimentDistribution = Object.entries(metrics.sentimentBreakdown)
    .map(([sentiment, count]) => `- ${sentiment}: ${count}`)
    .join('\n');

  const topThemes = metrics.topThemes.map((t) => `- ${t.theme} (${t.count} mentions)`).join('\n');

  const result = await chain.invoke({
    period: `${new Date(metrics.period.start).toISOString()} to ${new Date(metrics.period.end).toISOString()}`,
    totalFeedback: metrics.totalFeedback.toString(),
    overallScore: (metrics.overallScore * 100).toFixed(1),
    sentimentDistribution,
    topThemes,
    feedbackSummary,
    format_instructions: StructuredOutputParser.fromZodSchema(
      SynthesisOutputSchema
    ).getFormatInstructions(),
  });

  return result;
}
