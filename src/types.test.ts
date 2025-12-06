import { describe, it, expect } from 'vitest';
import { FeedbackItemSchema, FeedbackSourceSchema, AnalyzedFeedbackSchema } from './types';

describe('FeedbackItemSchema', () => {
  it('should validate a valid feedback item', () => {
    const validItem = {
      id: '123',
      source: 'slack',
      timestamp: Date.now(),
      author: {
        id: 'user-1',
        name: 'John Doe',
        email: 'john@example.com',
      },
      content: 'This feature is great!',
    };

    const result = FeedbackItemSchema.safeParse(validItem);
    expect(result.success).toBe(true);
  });

  it('should reject invalid source', () => {
    const invalidItem = {
      id: '123',
      source: 'invalid-source',
      timestamp: Date.now(),
      author: { id: 'user-1' },
      content: 'Test',
    };

    const result = FeedbackItemSchema.safeParse(invalidItem);
    expect(result.success).toBe(false);
  });

  it('should require timestamp as number', () => {
    const invalidItem = {
      id: '123',
      source: 'slack',
      timestamp: '2024-01-01', // should be number
      author: { id: 'user-1' },
      content: 'Test',
    };

    const result = FeedbackItemSchema.safeParse(invalidItem);
    expect(result.success).toBe(false);
  });
});

describe('FeedbackSourceSchema', () => {
  it('should accept valid sources', () => {
    const validSources = ['slack', 'intercom', 'zendesk', 'productboard', 'user_interview', 'survey'];

    validSources.forEach((source) => {
      const result = FeedbackSourceSchema.safeParse(source);
      expect(result.success).toBe(true);
    });
  });

  it('should reject invalid sources', () => {
    const result = FeedbackSourceSchema.safeParse('twitter');
    expect(result.success).toBe(false);
  });
});

describe('AnalyzedFeedbackSchema', () => {
  it('should validate analyzed feedback with all fields', () => {
    const analyzedFeedback = {
      id: '123',
      source: 'slack',
      timestamp: Date.now(),
      author: {
        id: 'user-1',
        name: 'John Doe',
      },
      content: 'Great feature!',
      category: 'praise',
      sentiment: 'very_positive',
      themes: ['user-experience', 'performance'],
      priority: 'low',
      summary: 'User loves the new feature',
    };

    const result = AnalyzedFeedbackSchema.safeParse(analyzedFeedback);
    expect(result.success).toBe(true);
  });
});
