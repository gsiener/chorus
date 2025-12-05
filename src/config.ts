import dotenv from 'dotenv';
import { IntegrationsConfig } from './integrations/index.js';

dotenv.config();

export interface Config {
  anthropicApiKey: string;
  dataDir: string;
  integrations: IntegrationsConfig;
  analysis: {
    minFeedbackCount: number;
    pmfThreshold: number;
  };
}

export function loadConfig(): Config {
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    throw new Error('ANTHROPIC_API_KEY is required');
  }

  return {
    anthropicApiKey,
    dataDir: process.env.DATA_DIR || './data',
    integrations: {
      slack: {
        enabled: !!process.env.SLACK_BOT_TOKEN,
        botToken: process.env.SLACK_BOT_TOKEN || '',
        channels: process.env.SLACK_CHANNELS?.split(',') || [],
      },
      intercom: {
        enabled: !!process.env.INTERCOM_API_TOKEN,
        apiToken: process.env.INTERCOM_API_TOKEN || '',
      },
      zendesk: {
        enabled: !!(process.env.ZENDESK_SUBDOMAIN && process.env.ZENDESK_API_TOKEN),
        subdomain: process.env.ZENDESK_SUBDOMAIN || '',
        email: process.env.ZENDESK_EMAIL || '',
        apiToken: process.env.ZENDESK_API_TOKEN || '',
      },
      productboard: {
        enabled: !!process.env.PRODUCTBOARD_API_TOKEN,
        apiToken: process.env.PRODUCTBOARD_API_TOKEN || '',
      },
    },
    analysis: {
      minFeedbackCount: parseInt(process.env.MIN_FEEDBACK_COUNT || '10'),
      pmfThreshold: parseFloat(process.env.PMF_THRESHOLD || '0.4'),
    },
  };
}
