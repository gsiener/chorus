import { z } from 'zod';

export const ThemeSummarySchema = z.object({
  theme: z.string(),
  count: z.number(),
  sentiment: z.number(), // -1 to 1
  examples: z.array(z.string()),
  trend: z.enum(['increasing', 'stable', 'decreasing']),
});

export type ThemeSummary = z.infer<typeof ThemeSummarySchema>;

export const PMFMetricsSchema = z.object({
  period: z.object({
    start: z.date(),
    end: z.date(),
  }),
  totalFeedback: z.number(),
  sentimentBreakdown: z.object({
    very_positive: z.number(),
    positive: z.number(),
    neutral: z.number(),
    negative: z.number(),
    very_negative: z.number(),
  }),
  topThemes: z.array(ThemeSummarySchema),
  categoryBreakdown: z.record(z.number()),
  // Superhuman-style PMF score: % who would be very disappointed
  disappointmentScore: z.number().optional(),
  overallScore: z.number(), // 0-1
});

export type PMFMetrics = z.infer<typeof PMFMetricsSchema>;

export const AnalysisReportSchema = z.object({
  id: z.string(),
  timestamp: z.date(),
  metrics: PMFMetricsSchema,
  insights: z.array(z.string()),
  recommendations: z.array(z.string()),
  investmentAreas: z.array(z.object({
    area: z.string(),
    rationale: z.string(),
    priority: z.enum(['low', 'medium', 'high', 'critical']),
  })),
});

export type AnalysisReport = z.infer<typeof AnalysisReportSchema>;
