import Anthropic from '@anthropic-ai/sdk';
import { FeedbackItem, AnalyzedFeedback } from '../types/feedback.js';
import { AnalysisReport, PMFMetrics } from '../types/analysis.js';

export class FeedbackAnalyzer {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async analyzeFeedbackItem(item: FeedbackItem): Promise<AnalyzedFeedback> {
    const prompt = `Analyze this customer feedback and extract structured information.

Feedback:
Source: ${item.source}
Author: ${item.author.name || item.author.email || 'Anonymous'}
Date: ${item.timestamp.toISOString()}
Content: ${item.content}

Please analyze and respond with JSON in this exact format:
{
  "category": "feature_request|bug_report|usability_issue|performance|integration_request|praise|complaint|question|other",
  "sentiment": "very_positive|positive|neutral|negative|very_negative",
  "themes": ["array", "of", "themes"],
  "priority": "low|medium|high|critical",
  "summary": "one sentence summary",
  "relatedFeatures": ["optional", "feature", "names"]
}`;

    const response = await this.client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: prompt,
      }],
    });

    const content = response.content[0];
    if (content.type !== 'text') {
      throw new Error('Unexpected response type from Claude');
    }

    const analysis = JSON.parse(content.text);

    return {
      ...item,
      category: analysis.category,
      sentiment: analysis.sentiment,
      themes: analysis.themes,
      priority: analysis.priority,
      summary: analysis.summary,
      relatedFeatures: analysis.relatedFeatures,
    };
  }

  async generateReport(
    analyzedFeedback: AnalyzedFeedback[],
    previousReport?: AnalysisReport
  ): Promise<AnalysisReport> {
    const metrics = this.calculateMetrics(analyzedFeedback);

    const prompt = this.buildReportPrompt(analyzedFeedback, metrics, previousReport);

    const response = await this.client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: prompt,
      }],
    });

    const content = response.content[0];
    if (content.type !== 'text') {
      throw new Error('Unexpected response type from Claude');
    }

    const synthesis = JSON.parse(content.text);

    return {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      metrics,
      insights: synthesis.insights,
      recommendations: synthesis.recommendations,
      investmentAreas: synthesis.investmentAreas,
    };
  }

  private calculateMetrics(feedback: AnalyzedFeedback[]): PMFMetrics {
    const timestamps = feedback.map(f => f.timestamp);
    const start = new Date(Math.min(...timestamps.map(d => d.getTime())));
    const end = new Date(Math.max(...timestamps.map(d => d.getTime())));

    const sentimentBreakdown = {
      very_positive: 0,
      positive: 0,
      neutral: 0,
      negative: 0,
      very_negative: 0,
    };

    const categoryBreakdown: Record<string, number> = {};
    const themeCount: Record<string, number> = {};

    for (const item of feedback) {
      sentimentBreakdown[item.sentiment]++;
      categoryBreakdown[item.category] = (categoryBreakdown[item.category] || 0) + 1;

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
        sentiment: 0, // TODO: Calculate average sentiment for theme
        examples: feedback
          .filter(f => f.themes.includes(theme))
          .slice(0, 3)
          .map(f => f.summary),
        trend: 'stable' as const, // TODO: Compare with previous period
      }));

    const positiveCount = sentimentBreakdown.very_positive + sentimentBreakdown.positive;
    const totalCount = feedback.length;
    const overallScore = totalCount > 0 ? positiveCount / totalCount : 0;

    return {
      period: { start, end },
      totalFeedback: totalCount,
      sentimentBreakdown,
      topThemes,
      categoryBreakdown,
      overallScore,
    };
  }

  private buildReportPrompt(
    feedback: AnalyzedFeedback[],
    metrics: PMFMetrics,
    previousReport?: AnalysisReport
  ): string {
    const feedbackSummary = feedback
      .slice(0, 100) // Limit to avoid token limits
      .map(f => `- [${f.category}] ${f.summary} (${f.sentiment})`)
      .join('\n');

    return `You are analyzing product feedback to assess product-market fit and identify investment opportunities.

Current Period: ${metrics.period.start.toISOString()} to ${metrics.period.end.toISOString()}
Total Feedback: ${metrics.totalFeedback}
Overall Score: ${(metrics.overallScore * 100).toFixed(1)}%

Sentiment Distribution:
- Very Positive: ${metrics.sentimentBreakdown.very_positive}
- Positive: ${metrics.sentimentBreakdown.positive}
- Neutral: ${metrics.sentimentBreakdown.neutral}
- Negative: ${metrics.sentimentBreakdown.negative}
- Very Negative: ${metrics.sentimentBreakdown.very_negative}

Top Themes:
${metrics.topThemes.map(t => `- ${t.theme} (${t.count} mentions)`).join('\n')}

Recent Feedback Summary:
${feedbackSummary}

${previousReport ? `
Previous Period Insights:
${previousReport.insights.join('\n')}
` : ''}

Based on this feedback, provide a comprehensive analysis in JSON format:
{
  "insights": ["array of 5-10 key insights about the product and user sentiment"],
  "recommendations": ["array of 3-7 specific, actionable recommendations"],
  "investmentAreas": [
    {
      "area": "name of area",
      "rationale": "why this deserves investment",
      "priority": "low|medium|high|critical"
    }
  ]
}

Focus on:
1. Signals of product-market fit (or lack thereof)
2. Emerging trends and patterns
3. Most impactful areas for improvement
4. User segments with strongest/weakest fit`;
  }
}
