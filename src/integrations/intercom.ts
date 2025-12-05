import { BaseIntegration, IntegrationConfig } from './base.js';
import { FeedbackItem } from '../types/feedback.js';

export interface IntercomConfig extends IntegrationConfig {
  apiToken: string;
}

export class IntercomIntegration extends BaseIntegration {
  constructor(private intercomConfig: IntercomConfig) {
    super(intercomConfig);
  }

  getName(): string {
    return 'intercom';
  }

  async fetchFeedback(since?: Date): Promise<FeedbackItem[]> {
    if (!this.isEnabled()) {
      return [];
    }

    // TODO: Implement Intercom API integration
    // Fetch conversations, filter for customer feedback
    console.log(`Fetching Intercom feedback since ${since}`);
    return [];
  }
}
