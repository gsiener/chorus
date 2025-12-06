// Cloudflare Workers environment bindings
export interface Env {
  // D1 Database
  DB: D1Database;

  // Vectorize for embeddings
  VECTORIZE: VectorizeIndex;

  // R2 for report storage
  REPORTS: R2Bucket;

  // KV for caching
  CACHE: KVNamespace;

  // Durable Object binding
  ANALYSIS_ORCHESTRATOR: DurableObjectNamespace;

  // Secrets
  ANTHROPIC_API_KEY: string;
  HONEYCOMB_API_KEY: string;
  HONEYCOMB_DATASET: string;

  // Integration API keys
  SLACK_BOT_TOKEN?: string;
  INTERCOM_API_TOKEN?: string;
  ZENDESK_API_TOKEN?: string;
  ZENDESK_SUBDOMAIN?: string;
  ZENDESK_EMAIL?: string;
  PRODUCTBOARD_API_TOKEN?: string;

  // Config
  ENVIRONMENT: string;
  LOG_LEVEL: string;
}

// Feedback types (Zod schemas)
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
  timestamp: z.number(), // Unix timestamp
  author: z.object({
    id: z.string(),
    name: z.string().optional(),
    email: z.string().optional(),
  }),
  content: z.string(),
  metadata: z.record(z.unknown()).optional(),
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

export const PrioritySchema = z.enum(['low', 'medium', 'high', 'critical']);

export type Priority = z.infer<typeof PrioritySchema>;

export const AnalyzedFeedbackSchema = FeedbackItemSchema.extend({
  category: FeedbackCategorySchema,
  sentiment: SentimentSchema,
  themes: z.array(z.string()),
  priority: PrioritySchema,
  summary: z.string(),
});

export type AnalyzedFeedback = z.infer<typeof AnalyzedFeedbackSchema>;

// Analysis report types
export const PMFMetricsSchema = z.object({
  period: z.object({
    start: z.number(),
    end: z.number(),
  }),
  totalFeedback: z.number(),
  sentimentBreakdown: z.record(z.number()),
  topThemes: z.array(z.object({
    theme: z.string(),
    count: z.number(),
    sentiment: z.number(),
  })),
  overallScore: z.number(),
});

export type PMFMetrics = z.infer<typeof PMFMetricsSchema>;

export const AnalysisReportSchema = z.object({
  id: z.string(),
  timestamp: z.number(),
  metrics: PMFMetricsSchema,
  insights: z.array(z.string()),
  recommendations: z.array(z.string()),
  investmentAreas: z.array(z.object({
    area: z.string(),
    rationale: z.string(),
    priority: PrioritySchema,
  })),
});

export type AnalysisReport = z.infer<typeof AnalysisReportSchema>;
