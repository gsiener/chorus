import { FeedbackItem } from '../types/feedback.js';

export interface IntegrationConfig {
  enabled: boolean;
  [key: string]: unknown;
}

export abstract class BaseIntegration {
  constructor(protected config: IntegrationConfig) {}

  abstract getName(): string;

  abstract fetchFeedback(since?: Date): Promise<FeedbackItem[]>;

  isEnabled(): boolean {
    return this.config.enabled;
  }
}
