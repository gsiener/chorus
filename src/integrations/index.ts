import { BaseIntegration } from './base.js';
import { SlackIntegration, SlackConfig } from './slack.js';
import { IntercomIntegration, IntercomConfig } from './intercom.js';
import { ZendeskIntegration, ZendeskConfig } from './zendesk.js';
import { ProductboardIntegration, ProductboardConfig } from './productboard.js';

export interface IntegrationsConfig {
  slack?: SlackConfig;
  intercom?: IntercomConfig;
  zendesk?: ZendeskConfig;
  productboard?: ProductboardConfig;
}

export class IntegrationManager {
  private integrations: BaseIntegration[] = [];

  constructor(config: IntegrationsConfig) {
    if (config.slack) {
      this.integrations.push(new SlackIntegration(config.slack));
    }
    if (config.intercom) {
      this.integrations.push(new IntercomIntegration(config.intercom));
    }
    if (config.zendesk) {
      this.integrations.push(new ZendeskIntegration(config.zendesk));
    }
    if (config.productboard) {
      this.integrations.push(new ProductboardIntegration(config.productboard));
    }
  }

  async fetchAllFeedback(since?: Date) {
    const results = await Promise.allSettled(
      this.integrations.map(integration =>
        integration.fetchFeedback(since)
      )
    );

    const feedback = results
      .filter((result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled')
      .flatMap(result => result.value);

    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason);

    if (errors.length > 0) {
      console.error('Some integrations failed:', errors);
    }

    return feedback;
  }
}

export * from './base.js';
export * from './slack.js';
export * from './intercom.js';
export * from './zendesk.js';
export * from './productboard.js';
