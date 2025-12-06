import { DurableObject } from 'cloudflare:workers';
import type { Env, AnalyzedFeedback } from '../types';
import { classifyFeedback } from '../chains/classification';
import { synthesizeReport, calculateMetrics } from '../chains/synthesis';
import { createTelemetry, Telemetry } from '../telemetry';

/**
 * Durable Object for orchestrating long-running analysis sessions
 * Maintains state across multiple LLM calls and manages rate limiting
 */
export class AnalysisOrchestrator extends DurableObject<Env> {
  private sessionId: string | null = null;
  private analyzedFeedback: AnalyzedFeedback[] = [];
  private status: 'idle' | 'running' | 'completed' | 'failed' = 'idle';

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  /**
   * Start a new analysis session
   */
  async startAnalysis(feedbackIds: string[]): Promise<{ sessionId: string }> {
    if (this.status === 'running') {
      throw new Error('Analysis already in progress');
    }

    this.sessionId = crypto.randomUUID();
    this.status = 'running';
    this.analyzedFeedback = [];

    const telemetry = createTelemetry(this.env);

    try {
      await telemetry.span(
        'analysis.session',
        async (span) => {
          span.setAttribute('session.id', this.sessionId!);
          span.setAttribute('feedback.count', feedbackIds.length);

          // Store session in D1
          await this.env.DB.prepare(
            'INSERT INTO analysis_sessions (id, status, started_at, feedback_count) VALUES (?, ?, ?, ?)'
          )
            .bind(this.sessionId, 'running', Date.now(), feedbackIds.length)
            .run();

          // Process feedback in batches
          const batchSize = 10;
          for (let i = 0; i < feedbackIds.length; i += batchSize) {
            const batch = feedbackIds.slice(i, i + batchSize);
            await this.processBatch(batch, telemetry);

            // Add delay for rate limiting
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }

          // Generate synthesis
          const synthesis = await telemetry.span('synthesis.generate', async () => {
            return synthesizeReport(this.analyzedFeedback, this.env.ANTHROPIC_API_KEY);
          });

          // Calculate metrics
          const metrics = calculateMetrics(this.analyzedFeedback);

          // Create report
          const reportId = crypto.randomUUID();
          const report = {
            id: reportId,
            timestamp: Date.now(),
            metrics,
            ...synthesis,
          };

          // Store report in D1
          await this.env.DB.prepare(
            'INSERT INTO reports (id, timestamp, overall_score, feedback_count, report_data) VALUES (?, ?, ?, ?, ?)'
          )
            .bind(
              reportId,
              report.timestamp,
              metrics.overallScore,
              metrics.totalFeedback,
              JSON.stringify(report)
            )
            .run();

          // Store report JSON in R2
          await this.env.REPORTS.put(`reports/${reportId}.json`, JSON.stringify(report, null, 2));

          // Update session
          await this.env.DB.prepare(
            'UPDATE analysis_sessions SET status = ?, completed_at = ?, report_id = ? WHERE id = ?'
          )
            .bind('completed', Date.now(), reportId, this.sessionId)
            .run();

          this.status = 'completed';

          return { reportId };
        },
        { 'analysis.type': 'full' }
      );

      return { sessionId: this.sessionId! };
    } catch (error) {
      this.status = 'failed';

      // Update session with error
      await this.env.DB.prepare(
        'UPDATE analysis_sessions SET status = ?, completed_at = ?, error = ? WHERE id = ?'
      )
        .bind(
          'failed',
          Date.now(),
          error instanceof Error ? error.message : 'Unknown error',
          this.sessionId
        )
        .run();

      throw error;
    } finally {
      await telemetry.shutdown();
    }
  }

  /**
   * Process a batch of feedback items
   */
  private async processBatch(feedbackIds: string[], telemetry: Telemetry): Promise<void> {
    await telemetry.span(
      'batch.process',
      async (span) => {
        span.setAttribute('batch.size', feedbackIds.length);

        for (const id of feedbackIds) {
          await telemetry.span(
            'feedback.classify',
            async () => {
              // Fetch feedback from D1
              const result = await this.env.DB.prepare('SELECT * FROM feedback WHERE id = ?')
                .bind(id)
                .first<any>();

              if (!result) {
                throw new Error(`Feedback ${id} not found`);
              }

              // Convert to FeedbackItem
              const feedbackItem = {
                id: result.id,
                source: result.source,
                timestamp: result.timestamp,
                author: {
                  id: result.author_id,
                  name: result.author_name,
                  email: result.author_email,
                },
                content: result.content,
                metadata: result.metadata ? JSON.parse(result.metadata) : undefined,
              };

              // Classify using LangChain
              const analyzed = await classifyFeedback(
                feedbackItem,
                this.env.ANTHROPIC_API_KEY
              );

              // Update D1 with classification
              await this.env.DB.prepare(
                'UPDATE feedback SET category = ?, sentiment = ?, priority = ?, summary = ? WHERE id = ?'
              )
                .bind(analyzed.category, analyzed.sentiment, analyzed.priority, analyzed.summary, id)
                .run();

              // Store themes
              for (const theme of analyzed.themes) {
                await this.env.DB.prepare('INSERT INTO themes (feedback_id, theme) VALUES (?, ?)')
                  .bind(id, theme)
                  .run();
              }

              this.analyzedFeedback.push(analyzed);
            },
            { 'feedback.id': id }
          );
        }
      },
      { 'batch.index': this.analyzedFeedback.length / feedbackIds.length }
    );
  }

  /**
   * Get current session status
   */
  async getStatus(): Promise<{
    sessionId: string | null;
    status: string;
    processed: number;
  }> {
    return {
      sessionId: this.sessionId,
      status: this.status,
      processed: this.analyzedFeedback.length,
    };
  }
}
