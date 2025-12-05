import { BaseIntegration, IntegrationConfig } from './base.js';
import { FeedbackItem } from '../types/feedback.js';

export interface ProductboardConfig extends IntegrationConfig {
  apiToken: string;
}

export class ProductboardIntegration extends BaseIntegration {
  constructor(private productboardConfig: ProductboardConfig) {
    super(productboardConfig);
  }

  getName(): string {
    return 'productboard';
  }

  async fetchFeedback(since?: Date): Promise<FeedbackItem[]> {
    if (!this.isEnabled()) {
      return [];
    }

    // TODO: Implement Productboard API integration
    // Fetch notes and feature requests
    console.log(`Fetching Productboard feedback since ${since}`);
    return [];
  }
}
