import { z } from 'zod';

export const FeedbackSourceSchema = z.enum([
  'slack',
  'intercom',
  'zendesk',
  'productboard',
  'user_interview',
  'survey',
]);

export type FeedbackSource = z.infer<typeof FeedbackSourceSchema>;

export const FeedbackItemSchema = z.object({
  id: z.string(),
  source: FeedbackSourceSchema,
  timestamp: z.date(),
  author: z.object({
    id: z.string(),
    name: z.string().optional(),
    email: z.string().optional(),
  }),
  content: z.string(),
  metadata: z.record(z.unknown()).optional(),
  rawData: z.unknown().optional(),
});

export type FeedbackItem = z.infer<typeof FeedbackItemSchema>;

export const FeedbackCategorySchema = z.enum([
  'feature_request',
  'bug_report',
  'usability_issue',
  'performance',
  'integration_request',
  'praise',
  'complaint',
  'question',
  'other',
]);

export type FeedbackCategory = z.infer<typeof FeedbackCategorySchema>;

export const SentimentSchema = z.enum([
  'very_positive',
  'positive',
  'neutral',
  'negative',
  'very_negative',
]);

export type Sentiment = z.infer<typeof SentimentSchema>;

export const AnalyzedFeedbackSchema = FeedbackItemSchema.extend({
  category: FeedbackCategorySchema,
  sentiment: SentimentSchema,
  themes: z.array(z.string()),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  summary: z.string(),
  relatedFeatures: z.array(z.string()).optional(),
});

export type AnalyzedFeedback = z.infer<typeof AnalyzedFeedbackSchema>;
