# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chorus is a LangChain.js-powered agent running on Cloudflare Workers that monitors and synthesizes product feedback from multiple channels to track product-market fit. Built on modern serverless infrastructure with full observability via OpenTelemetry and Honeycomb.

Inspired by Superhuman's PMF engine: https://review.firstround.com/how-superhuman-built-an-engine-to-find-product-market-fit/

## Development Philosophy

**Test-Driven Development (TDD)**: This project follows TDD principles:
1. Write failing tests first that describe desired behavior
2. Implement minimum code to make tests pass
3. Refactor while keeping tests green
4. All tests must pass before committing (enforced by pre-commit hook)

**LangChain Best Practices**:
- Use Chains over raw LLM prompts for composability
- Structured output parsing with Zod schemas
- Trace all LLM calls with OpenTelemetry
- Rate limiting and retry logic in Durable Objects

## Common Commands

### Development
- `npm run dev` - Start Wrangler dev server with hot reload and local D1
- `npm run type-check` - TypeScript type checking
- `wrangler dev --remote` - Dev mode with remote D1/Vectorize

### Testing
- `npm run test` - Run tests in watch mode
- `npm run test:run` - Run all tests once (used in CI and pre-commit)
- `npm run test:e2e` - Run integration tests with Cloudflare Workers runtime
- `vitest run src/chains/classification.test.ts` - Run specific test file

### Database
- `npm run db:create-migration <name>` - Create new D1 migration
- `npm run db:migrate:dev` - Apply migrations to local D1
- `npm run db:migrate` - Apply migrations to remote D1
- `wrangler d1 execute chorus-db --local --command="SELECT * FROM feedback LIMIT 5"` - Query local D1

### Deployment
- `npm run deploy:preview` - Deploy to preview environment
- `npm run deploy` - Deploy to production (or push to main for auto-deploy)
- `wrangler tail` - Stream live logs from production

### Linting
- `npm run lint` - Lint source code
- `npm run lint:fix` - Auto-fix linting issues

## Tech Stack

### Core Runtime
- **Cloudflare Workers** - Edge compute, globally distributed
- **Wrangler** - Local development and deployment CLI
- **TypeScript** - Full type safety across the stack

### Data & Storage
- **Cloudflare D1** - Serverless SQLite database for structured feedback
- **Cloudflare Vectorize** - Vector embeddings for semantic search
- **Cloudflare R2** - Object storage for analysis reports
- **Cloudflare KV** - Caching and rate limiting
- **Cloudflare Durable Objects** - Stateful analysis orchestration

### AI & Chains
- **LangChain.js** - Chain-based agent orchestration
- **@langchain/anthropic** - Claude integration
- **Anthropic Claude 3.5 Sonnet** - Primary LLM for analysis
- **Zod** - Schema validation for structured outputs

### Observability
- **OpenTelemetry** - Distributed tracing and spans
- **Honeycomb** - Trace analysis and debugging
- Custom spans for: HTTP requests, LLM calls, DB queries, chain execution

### CI/CD
- **GitHub Actions** - Automated testing and deployment
- **Husky** - Pre-commit hooks for tests and type checking

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed architecture documentation.

### High-Level Data Flow

1. **Ingestion** (Cron → Worker):
   - Scheduled triggers fetch from Slack/Intercom/Zendesk/Productboard
   - Store raw feedback in D1
   - Generate embeddings and store in Vectorize

2. **Analysis** (API → Durable Object → LangChain):
   - POST /api/analyze triggers Durable Object
   - DO fetches unanalyzed feedback from D1
   - LangChain Classification Chain processes each item
   - Results stored back in D1 with categories/sentiment/themes
   - Synthesis Chain generates aggregate report
   - Report stored in D1 and R2

3. **Retrieval** (API → D1/R2):
   - GET /api/reports/:id fetches from R2 or D1
   - GET /api/feedback/search uses Vectorize for semantic search

### Key Components

**LangChain Chains** (`src/chains/`)
- `classification.ts` - Single feedback item classification with structured output
- `synthesis.ts` - Aggregate analysis and PMF report generation

**Durable Objects** (`src/durable-objects/`)
- `AnalysisOrchestrator` - Stateful coordination for long-running analysis
  - Manages batching and rate limiting
  - Maintains progress across multiple LLM calls
  - Handles retries and error recovery

**OpenTelemetry** (`src/telemetry.ts`)
- Wraps all operations in traced spans
- Exports to Honeycomb for visualization
- Custom attributes: feedback_count, source, category, token_usage

**Worker Entry Point** (`src/index.ts`)
- HTTP request routing
- Cron trigger handling
- Telemetry initialization

### Database Schema

Located in `migrations/0001_initial_schema.sql`:
- `feedback` - Core feedback items with classification
- `themes` - Many-to-many theme associations
- `reports` - Analysis reports with metrics
- `embeddings` - Vector metadata (vectors in Vectorize)
- `analysis_sessions` - Durable Object session tracking

## Development Workflow

### Local Development
```bash
# Install dependencies
npm install

# Start local dev server (with local D1)
npm run dev

# In another terminal, test the API
curl http://localhost:8787/api/health
```

### Adding a New Feature (TDD)
1. Create test file: `src/feature.test.ts`
2. Write failing tests
3. Run `npm test` - should fail (red)
4. Implement feature
5. Run `npm test` - should pass (green)
6. Refactor while keeping tests green
7. Commit (pre-commit hook runs tests automatically)

### Adding a New LangChain Chain
1. Create chain file in `src/chains/`
2. Define Zod schema for structured output
3. Create PromptTemplate with format instructions
4. Build RunnableSequence: prompt → model → parser
5. Add OpenTelemetry spans
6. Write tests with mocked LLM responses

### Adding a New Integration Source
1. Create handler in `src/integrations/`
2. Fetch data from external API
3. Transform to FeedbackItem schema
4. Store in D1 with source metadata
5. Generate embeddings for Vectorize
6. Add to cron trigger in `src/index.ts`

### Deploying
**Preview (PR)**: Automatically deployed via GitHub Actions
**Production (main)**: Automatically deployed on merge to main

Manual deploy:
```bash
npm run deploy
```

## Required Secrets

Configure in GitHub Secrets for CI/CD:
- `CLOUDFLARE_API_TOKEN` - Cloudflare API token
- `CLOUDFLARE_ACCOUNT_ID` - Your Cloudflare account ID
- `ANTHROPIC_API_KEY` - Claude API key
- `HONEYCOMB_API_KEY` - Honeycomb ingest key
- `HONEYCOMB_DATASET` - Honeycomb dataset name
- Integration API keys (Slack, Intercom, Zendesk, Productboard)

Configure via `wrangler secret put` for local/production:
```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put HONEYCOMB_API_KEY
```

## Key Design Decisions

**Edge-First Architecture**: All request handling at the edge for minimal latency. Heavy processing coordinated through Durable Objects.

**LangChain Chains over Raw Prompts**: Composable, testable, observable chains instead of inline prompt strings.

**Hybrid Storage (D1 + Vectorize + R2)**: Structured data in D1, semantic search in Vectorize, large reports in R2.

**Stateful Durable Objects**: Long-running analysis requires state across multiple LLM calls. Durable Objects provide single-region coordination.

**OpenTelemetry Everywhere**: Every operation emits spans. Critical for debugging distributed systems and understanding LLM behavior.

**Zod for Runtime Safety**: All data at boundaries validated with Zod. Type inference provides compile-time safety.

**Test Requirements**:
- All tests must pass before committing (pre-commit hook enforces)
- New chains must have tests with mocked LLM responses
- Integration points should have tests (can mock external APIs)
- Zod schemas require validation tests

## Common Tasks

### Debugging Production Issues
```bash
# Stream live logs
wrangler tail

# Query Honeycomb for traces
# Filter by trace.id, http.status_code, error attributes
```

### Testing Chains Locally
```bash
# Create test data in local D1
wrangler d1 execute chorus-db --local --command="INSERT INTO feedback ..."

# Run analysis
curl -X POST http://localhost:8787/api/analyze
```

### Updating Claude Prompts
Edit prompts in `src/chains/classification.ts` or `src/chains/synthesis.ts`. Changes take effect immediately on next LLM call.

## Future Enhancements

- **LangGraph**: Upgrade from Chains to state machine agents for complex reasoning
- **Streaming**: Real-time analysis updates via SSE
- **Vector Search**: Full semantic search with query embeddings
- **Multi-tenant**: Durable Object per organization
- **Webhooks**: Push notifications on analysis completion
