import { loadConfig } from './config.js';

async function main() {
  console.log('Chorus - Product Feedback Analysis Agent');
  console.log('========================================\n');

  const config = loadConfig();

  console.log('Configuration loaded:');
  console.log(`- Data directory: ${config.dataDir}`);
  console.log(`- Enabled integrations:`, Object.entries(config.integrations)
    .filter(([_, cfg]) => cfg.enabled)
    .map(([name]) => name)
    .join(', ') || 'none');

  console.log('\nTo ingest feedback: npm run ingest');
  console.log('To run analysis: npm run analyze');
  console.log('\nFor scheduled operation, set up a cron job or use a scheduler service.');
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
