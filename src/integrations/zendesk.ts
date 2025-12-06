import { BaseIntegration, IntegrationConfig } from './base.js';
import { FeedbackItem } from '../types/feedback.js';

export interface ZendeskConfig extends IntegrationConfig {
  subdomain: string;
  email: string;
  apiToken: string;
}

export class ZendeskIntegration extends BaseIntegration {
  constructor(private _zendeskConfig: ZendeskConfig) {
    super(_zendeskConfig);
  }

  getName(): string {
    return 'zendesk';
  }

  async fetchFeedback(since?: Date): Promise<FeedbackItem[]> {
    if (!this.isEnabled()) {
      return [];
    }

    // TODO: Implement Zendesk API integration
    // Fetch tickets with feedback tags or specific views
    console.log(`Fetching Zendesk feedback since ${since} from subdomain:`, this._zendeskConfig.subdomain);
    return [];
  }
}
