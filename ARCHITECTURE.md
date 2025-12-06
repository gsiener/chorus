# Chorus Architecture - LangChain + Cloudflare

## Tech Stack Overview

### Runtime & Orchestration
- **LangChain.js** - Chain-based agent orchestration with prompt management
- **Cloudflare Workers** - Edge compute, globally distributed, sub-50ms cold starts
- **Cloudflare Durable Objects** - Stateful coordination for long-running analysis sessions
- **Wrangler** - CLI for local development and deployment

### Data Layer
- **Cloudflare D1** - Serverless SQLite for structured feedback storage
- **Cloudflare Vectorize** - Vector embeddings for semantic similarity search
- **Cloudflare R2** - Object storage for analysis reports and artifacts
- **Cloudflare KV** - Key-value store for caching and rate limiting

### AI & Processing
- **Anthropic Claude** - Primary LLM for analysis and synthesis
- **LangChain Chains** - Sequential processing pipelines:
  - **Ingestion Chain**: Source → Parse → Store → Embed
  - **Analysis Chain**: Retrieve → Classify → Aggregate → Synthesize
  - **Reporting Chain**: Generate → Store → Notify

### Observability
- **OpenTelemetry** - Distributed tracing and metrics
- **Honeycomb** - Trace analysis and debugging
- **Cloudflare Analytics** - Request metrics and performance

### CI/CD
- **GitHub Actions** - Automated testing and deployment
- **Wrangler Deploy** - Production deployments to Cloudflare
- **Vitest** - Unit and integration testing

## Architecture Patterns

### Edge-First Design
All request handling happens at the edge for minimal latency. Heavy processing is coordinated through Durable Objects.

### Event-Driven Ingestion
```
Cron Trigger → Worker → Fetch Sources → Store in D1 → Queue Embeddings → Notify Durable Object
```

### Stateful Analysis Sessions
Durable Objects maintain analysis state across multiple LLM calls, enabling:
- Incremental processing of large feedback sets
- Rate limit management
- Progress tracking
- Result aggregation

### Hybrid Storage Strategy
- **D1**: Structured feedback, metadata, timestamps, categories
- **Vectorize**: Semantic embeddings for similarity search
- **R2**: Full analysis reports, exports, backups

## Component Architecture

### Worker Endpoints
```
POST /api/ingest/:source     - Trigger ingestion from specific source
POST /api/analyze            - Start new analysis session
GET  /api/reports/:id        - Fetch analysis report
GET  /api/feedback/search    - Semantic search over feedback
GET  /api/health             - Health check with OTel metrics
```

### Durable Objects
- **AnalysisOrchestrator**: Coordinates multi-step LangChain analysis
  - Manages LangChain chain execution
  - Handles rate limiting and retries
  - Aggregates results across batches
  - Emits OpenTelemetry spans

### LangChain Chains

**1. IngestionChain**
```typescript
Source API → Parse → Validate Schema → Store D1 → Generate Embeddings → Store Vectorize
```

**2. ClassificationChain**
```typescript
Feedback Item → Claude Prompt → Parse Response → Update D1
```

**3. SynthesisChain**
```typescript
Retrieve Feedback → Build Context → Claude Analysis → Extract Insights → Generate Report
```

### Database Schema (D1)

```sql
-- Core feedback table
CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  content TEXT NOT NULL,
  author_id TEXT,
  timestamp INTEGER NOT NULL,
  category TEXT,
  sentiment TEXT,
  priority TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);

-- Theme associations
CREATE TABLE themes (
  id INTEGER PRIMARY KEY,
  feedback_id TEXT NOT NULL,
  theme TEXT NOT NULL,
  FOREIGN KEY(feedback_id) REFERENCES feedback(id)
);

-- Analysis reports
CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  overall_score REAL,
  feedback_count INTEGER,
  report_data TEXT, -- JSON
  created_at INTEGER DEFAULT (unixepoch())
);

-- Embeddings metadata (actual vectors in Vectorize)
CREATE TABLE embeddings (
  feedback_id TEXT PRIMARY KEY,
  vector_id TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY(feedback_id) REFERENCES feedback(id)
);
```

### OpenTelemetry Integration

Every operation emits traces:
- **Ingestion spans**: Source fetch, parse, store
- **Analysis spans**: Chain execution, LLM calls, aggregation
- **Storage spans**: D1 queries, Vectorize operations
- Custom attributes: feedback_count, source, category, token_usage

## Deployment Strategy

### Environments
- **Development**: `wrangler dev` with local D1/Vectorize
- **Preview**: Auto-deployed on PR via GitHub Actions
- **Production**: Manual promotion from preview

### GitHub Actions Workflow
```yaml
1. On PR: Run tests → Type check → Deploy preview
2. On merge to main: Run tests → Deploy to production
3. Scheduled: Run weekly dependency updates
```

### Secrets Management
- GitHub Secrets for API keys (Anthropic, integrations)
- Cloudflare environment variables for Honeycomb, etc.
- Wrangler secrets for runtime configuration

## Why This Stack?

✅ **Edge Performance**: Sub-50ms latency worldwide
✅ **Infinite Scale**: Workers scale to zero, pay per request
✅ **Stateful When Needed**: Durable Objects for complex workflows
✅ **Type Safety**: Full TypeScript across worker + chains
✅ **Cost Effective**: Cloudflare's generous free tier
✅ **Observable**: OpenTelemetry → Honeycomb for debugging
✅ **Modern DX**: Wrangler for local dev, hot reload, easy deploy
✅ **LangChain Best Practices**: Chains over raw prompts, composable

## Development Workflow

1. **Local Development**:
   ```bash
   npm run dev  # Starts wrangler with local D1/Vectorize
   ```

2. **Testing**:
   ```bash
   npm run test      # Unit tests
   npm run test:e2e  # Integration tests with Miniflare
   ```

3. **Deploy Preview**:
   ```bash
   git push origin feature-branch  # Auto-deploys via Actions
   ```

4. **Deploy Production**:
   ```bash
   npm run deploy  # Or merge to main for automatic deploy
   ```

## Future Enhancements

- **LangGraph**: Upgrade to state machine agents for complex reasoning
- **Streaming**: Real-time analysis updates via SSE
- **Webhooks**: Push notifications on analysis completion
- **Multi-tenant**: Separate Durable Object per organization
