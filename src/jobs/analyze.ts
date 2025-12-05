import { loadConfig } from '../config.js';
import { FeedbackAnalyzer } from '../analysis/analyzer.js';
import { FeedbackStore } from '../storage/store.js';
import { FeedbackItem } from '../types/feedback.js';

async function main() {
  console.log('Starting feedback analysis...');

  const config = loadConfig();
  const store = new FeedbackStore(config.dataDir);
  await store.initialize();

  const analyzer = new FeedbackAnalyzer(config.anthropicApiKey);

  // Get recent feedback to analyze
  const recentFeedback = await store.getRecentFeedback(7);
  console.log(`Found ${recentFeedback.length} recent feedback items`);

  if (recentFeedback.length < config.analysis.minFeedbackCount) {
    console.log(`Not enough feedback to analyze (minimum: ${config.analysis.minFeedbackCount})`);
    return;
  }

  // Get items that haven't been analyzed yet (for initial implementation, re-analyze all)
  console.log('Analyzing feedback items...');
  const analyzed = [];

  for (const item of recentFeedback) {
    try {
      // Skip if already analyzed (has category field)
      if ('category' in item) {
        analyzed.push(item);
        continue;
      }

      const result = await analyzer.analyzeFeedbackItem(item as FeedbackItem);
      analyzed.push(result);
      console.log(`Analyzed: ${result.summary}`);
    } catch (error) {
      console.error(`Failed to analyze item ${item.id}:`, error);
    }
  }

  await store.saveAnalyzedFeedback(analyzed);
  console.log(`Saved ${analyzed.length} analyzed items`);

  // Generate comprehensive report
  console.log('Generating analysis report...');
  const previousReport = await store.getLatestReport();
  const report = await analyzer.generateReport(analyzed, previousReport || undefined);

  await store.saveReport(report);
  console.log('Report generated successfully');

  // Print summary
  console.log('\n=== Analysis Summary ===');
  console.log(`Overall Score: ${(report.metrics.overallScore * 100).toFixed(1)}%`);
  console.log(`Total Feedback: ${report.metrics.totalFeedback}`);
  console.log('\nTop Insights:');
  report.insights.forEach((insight, i) => console.log(`${i + 1}. ${insight}`));
  console.log('\nInvestment Areas:');
  report.investmentAreas.forEach(area => {
    console.log(`- [${area.priority}] ${area.area}: ${area.rationale}`);
  });
}

main().catch(error => {
  console.error('Analysis failed:', error);
  process.exit(1);
});
