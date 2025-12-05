import { loadConfig } from '../config.js';
import { IntegrationManager } from '../integrations/index.js';
import { FeedbackStore } from '../storage/store.js';

async function main() {
  console.log('Starting feedback ingestion...');

  const config = loadConfig();
  const store = new FeedbackStore(config.dataDir);
  await store.initialize();

  const integrationManager = new IntegrationManager(config.integrations);

  // Fetch feedback from last 7 days
  const since = new Date();
  since.setDate(since.getDate() - 7);

  console.log(`Fetching feedback since ${since.toISOString()}`);
  const feedback = await integrationManager.fetchAllFeedback(since);

  console.log(`Collected ${feedback.length} feedback items`);

  if (feedback.length > 0) {
    await store.saveFeedback(feedback);
    console.log('Feedback saved successfully');
  }
}

main().catch(error => {
  console.error('Ingestion failed:', error);
  process.exit(1);
});
