import { describe, it, expect } from 'vitest';
import { FeedbackItemSchema, FeedbackSourceSchema } from './feedback.js';

describe('FeedbackItemSchema', () => {
  it('should validate a valid feedback item', () => {
    const validItem = {
      id: '123',
      source: 'slack',
      timestamp: new Date(),
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
      timestamp: new Date(),
      author: { id: 'user-1' },
      content: 'Test',
    };

    const result = FeedbackItemSchema.safeParse(invalidItem);
    expect(result.success).toBe(false);
  });
});

describe('FeedbackSourceSchema', () => {
  it('should accept valid sources', () => {
    const validSources = ['slack', 'intercom', 'zendesk', 'productboard', 'user_interview'];

    validSources.forEach(source => {
      const result = FeedbackSourceSchema.safeParse(source);
      expect(result.success).toBe(true);
    });
  });
});
