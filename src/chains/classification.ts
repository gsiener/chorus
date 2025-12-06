import { ChatAnthropic } from '@langchain/anthropic';
import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { StructuredOutputParser } from 'langchain/output_parsers';
import { z } from 'zod';
import type { FeedbackItem, AnalyzedFeedback } from '../types';

// Schema for Claude's structured output
const ClassificationOutputSchema = z.object({
  category: z.enum([
    'feature_request',
    'bug_report',
    'usability_issue',
    'performance',
    'integration_request',
    'praise',
    'complaint',
    'question',
    'other',
  ]),
  sentiment: z.enum(['very_positive', 'positive', 'neutral', 'negative', 'very_negative']),
  themes: z.array(z.string()),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  summary: z.string(),
});

/**
 * LangChain chain for classifying individual feedback items
 */
export function createClassificationChain(apiKey: string) {
  const model = new ChatAnthropic({
    apiKey,
    model: 'claude-3-5-sonnet-20241022',
    temperature: 0.3,
    maxTokens: 1024,
  });

  const parser = StructuredOutputParser.fromZodSchema(ClassificationOutputSchema);

  const prompt = PromptTemplate.fromTemplate(`
Analyze this customer feedback and extract structured information.

Feedback:
Source: {source}
Author: {author}
Date: {timestamp}
Content: {content}

{format_instructions}

Respond only with valid JSON matching the schema.
`);

  return RunnableSequence.from([
    {
      source: (input: FeedbackItem) => input.source,
      author: (input: FeedbackItem) => input.author.name || input.author.email || 'Anonymous',
      timestamp: (input: FeedbackItem) => new Date(input.timestamp).toISOString(),
      content: (input: FeedbackItem) => input.content,
      format_instructions: () => parser.getFormatInstructions(),
    },
    prompt,
    model,
    parser,
  ]);
}

/**
 * Process a single feedback item through the classification chain
 */
export async function classifyFeedback(
  item: FeedbackItem,
  apiKey: string
): Promise<AnalyzedFeedback> {
  const chain = createClassificationChain(apiKey);
  const result = await chain.invoke(item);

  return {
    ...item,
    category: result.category,
    sentiment: result.sentiment,
    themes: result.themes,
    priority: result.priority,
    summary: result.summary,
  };
}
