import { BaseIntegration, IntegrationConfig } from './base.js';
import { FeedbackItem } from '../types/feedback.js';

export interface SlackConfig extends IntegrationConfig {
  botToken: string;
  channels: string[];
}

export class SlackIntegration extends BaseIntegration {
  constructor(private _slackConfig: SlackConfig) {
    super(_slackConfig);
  }

  getName(): string {
    return 'slack';
  }

  async fetchFeedback(since?: Date): Promise<FeedbackItem[]> {
    if (!this.isEnabled()) {
      return [];
    }

    // TODO: Implement Slack API integration
    // Use @slack/web-api to fetch messages from configured channels
    // Filter for feedback-related messages
    console.log(`Fetching Slack feedback since ${since} from channels:`, this._slackConfig.channels);
    return [];
  }
}
