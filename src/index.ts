/**
 * Chorus - LangChain-powered feedback analysis on Cloudflare Workers
 *
 * Main worker entry point with API endpoints
 */

import { createTelemetry } from './telemetry';
import type { Env } from './types';

export { AnalysisOrchestrator } from './durable-objects/analysis-orchestrator';

export default {
  /**
   * Handle HTTP requests
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const telemetry = createTelemetry(env);
    const url = new URL(request.url);

    try {
      return await telemetry.span(
        'http.request',
        async (span) => {
          span.setAttribute('http.method', request.method);
          span.setAttribute('http.url', url.pathname);

          // Health check
          if (url.pathname === '/api/health') {
            return new Response(
              JSON.stringify({
                status: 'healthy',
                environment: env.ENVIRONMENT,
                timestamp: Date.now(),
              }),
              { headers: { 'Content-Type': 'application/json' } }
            );
          }

          // Start new analysis
          if (url.pathname === '/api/analyze' && request.method === 'POST') {
            return handleAnalyze(request, env, telemetry);
          }

          // Get report
          if (url.pathname.startsWith('/api/reports/')) {
            const reportId = url.pathname.split('/')[3];
            return handleGetReport(reportId, env, telemetry);
          }

          // Semantic search
          if (url.pathname === '/api/feedback/search' && request.method === 'GET') {
            const query = url.searchParams.get('q');
            if (!query) {
              return new Response('Missing query parameter', { status: 400 });
            }
            return handleSearch(query, env, telemetry);
          }

          // Ingest feedback
          if (url.pathname.startsWith('/api/ingest/')) {
            const source = url.pathname.split('/')[3];
            return handleIngest(source, env, telemetry);
          }

          return new Response('Not Found', { status: 404 });
        },
        { 'http.route': url.pathname }
      );
    } catch (error) {
      console.error('Request error:', error);
      return new Response(
        JSON.stringify({
          error: error instanceof Error ? error.message : 'Internal Server Error',
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    } finally {
      ctx.waitUntil(telemetry.shutdown());
    }
  },

  /**
   * Handle scheduled cron triggers
   */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const telemetry = createTelemetry(env);

    try {
      await telemetry.span('cron.ingest', async () => {
        // Trigger ingestion from all sources
        const sources = ['slack', 'intercom', 'zendesk', 'productboard'];

        for (const source of sources) {
          await telemetry.span(
            `ingest.${source}`,
            async () => {
              // TODO: Implement source-specific ingestion
              console.log(`Ingesting from ${source}`);
            },
            { source }
          );
        }
      });
    } catch (error) {
      console.error('Cron error:', error);
    } finally {
      ctx.waitUntil(telemetry.shutdown());
    }
  },
};

/**
 * Start a new analysis session
 */
async function handleAnalyze(_request: Request, env: Env, telemetry: import('./telemetry').Telemetry): Promise<Response> {
  return telemetry.span('api.analyze', async () => {
    // Get recent unanalyzed feedback
    const result = await env.DB.prepare(
      'SELECT id FROM feedback WHERE category IS NULL ORDER BY timestamp DESC LIMIT 100'
    ).all<{ id: string }>();

    if (!result.results || result.results.length === 0) {
      return new Response(
        JSON.stringify({ message: 'No feedback to analyze' }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    const feedbackIds = result.results.map((r) => r.id);

    // Get Durable Object instance
    const doId = env.ANALYSIS_ORCHESTRATOR.idFromName('primary');
    const stub = env.ANALYSIS_ORCHESTRATOR.get(doId);

    // Start analysis (TODO: expose DO method via fetch)
    const response = await stub.fetch('https://fake/start', {
      method: 'POST',
      body: JSON.stringify({ feedbackIds }),
    });

    return response;
  });
}

/**
 * Get analysis report
 */
async function handleGetReport(reportId: string, env: Env, telemetry: import('./telemetry').Telemetry): Promise<Response> {
  return telemetry.span('api.get_report', async (span) => {
    span.setAttribute('report.id', reportId);

    // Try R2 first (full report)
    const r2Object = await env.REPORTS.get(`reports/${reportId}.json`);
    if (r2Object) {
      return new Response(await r2Object.text(), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Fallback to D1 (report data)
    const result = await env.DB.prepare('SELECT report_data FROM reports WHERE id = ?')
      .bind(reportId)
      .first<{ report_data: string }>();

    if (!result) {
      return new Response('Report not found', { status: 404 });
    }

    return new Response(result.report_data, {
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

/**
 * Semantic search over feedback
 */
async function handleSearch(query: string, env: Env, telemetry: import('./telemetry').Telemetry): Promise<Response> {
  return telemetry.span('api.search', async (span) => {
    span.setAttribute('search.query', query);

    // TODO: Generate embedding for query and search Vectorize
    // For now, return basic text search
    const result = await env.DB.prepare(
      "SELECT * FROM feedback WHERE content LIKE ? ORDER BY timestamp DESC LIMIT 20"
    )
      .bind(`%${query}%`)
      .all();

    return new Response(JSON.stringify(result.results), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

/**
 * Ingest feedback from a source
 */
async function handleIngest(source: string, _env: Env, telemetry: import('./telemetry').Telemetry): Promise<Response> {
  return telemetry.span('api.ingest', async (span) => {
    span.setAttribute('ingest.source', source);

    // TODO: Implement source-specific ingestion logic
    return new Response(
      JSON.stringify({ message: `Ingestion from ${source} not yet implemented` }),
      { status: 501, headers: { 'Content-Type': 'application/json' } }
    );
  });
}
