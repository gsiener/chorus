# Chorus

A LangChain.js-powered agent running on Cloudflare Workers that monitors and synthesizes product feedback from multiple channels to track product-market fit.

[![Deploy to Cloudflare](https://github.com/gsiener/chorus/actions/workflows/deploy.yml/badge.svg)](https://github.com/gsiener/chorus/actions/workflows/deploy.yml)

## ✨ Features

- 🔗 **Multi-channel ingestion**: Slack, Intercom, Zendesk, Productboard, user interviews
- 🤖 **LangChain.js orchestration**: Composable chains for classification and synthesis
- 🧠 **Claude 3.5 Sonnet**: Advanced sentiment analysis and theme extraction
- 📊 **PMF tracking**: Monitor product-market fit signals over time
- 🔍 **Semantic search**: Vector-based similarity search over feedback (Vectorize)
- 📈 **Full observability**: OpenTelemetry → Honeycomb for distributed tracing
- ⚡ **Edge compute**: Sub-50ms latency on Cloudflare's global network
- 🔄 **Stateful orchestration**: Durable Objects for long-running analysis
- 🚀 **CI/CD**: Automated testing and deployment via GitHub Actions

## 🏗️ Architecture

Built on a modern serverless stack:

- **Cloudflare Workers** - Edge compute
- **Cloudflare Durable Objects** - Stateful analysis coordination
- **Cloudflare D1** - SQLite database for structured data
- **Cloudflare Vectorize** - Vector embeddings for semantic search
- **Cloudflare R2** - Object storage for reports
- **LangChain.js** - Chain-based agent orchestration
- **OpenTelemetry + Honeycomb** - Full observability

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed architecture documentation.

## 🚀 Quick Start

### Prerequisites

- Node.js 20+
- Cloudflare account
- Wrangler CLI: `npm install -g wrangler`
- Anthropic API key
- Honeycomb account (for observability)

### Setup

1. **Clone and install**:
```bash
git clone https://github.com/gsiener/chorus.git
cd chorus
npm install
```

2. **Configure Cloudflare**:
```bash
# Login to Cloudflare
wrangler login

# Create D1 database
wrangler d1 create chorus-db

# Update wrangler.toml with your database_id

# Run migrations
npm run db:migrate:dev
```

3. **Set secrets**:
```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put HONEYCOMB_API_KEY
wrangler secret put HONEYCOMB_DATASET
```

4. **Start development server**:
```bash
npm run dev
```

5. **Test the API**:
```bash
# Health check
curl http://localhost:8787/api/health

# Search feedback
curl "http://localhost:8787/api/feedback/search?q=performance"
```

## 📖 Development

### Common Commands

```bash
# Development
npm run dev                  # Start local server with hot reload
npm run type-check          # TypeScript type checking

# Testing
npm test                    # Run tests in watch mode
npm run test:run            # Run all tests once (CI mode)

# Database
npm run db:create-migration <name>  # Create new migration
npm run db:migrate:dev      # Apply migrations locally
npm run db:migrate          # Apply migrations to production

# Deployment
npm run deploy:preview      # Deploy to preview environment
npm run deploy              # Deploy to production
wrangler tail               # Stream live production logs
```

### TDD Workflow

This project follows Test-Driven Development:

1. Write failing test
2. Implement feature
3. Tests pass
4. Refactor
5. Commit (pre-commit hook enforces passing tests)

See [CLAUDE.md](./CLAUDE.md) for comprehensive development guidance.

## 🔌 API Endpoints

### `GET /api/health`
Health check endpoint

### `POST /api/analyze`
Start new feedback analysis session

### `GET /api/reports/:id`
Retrieve analysis report

### `GET /api/feedback/search?q=query`
Semantic search over feedback (will use Vectorize)

### `POST /api/ingest/:source`
Trigger ingestion from specific source (slack, intercom, etc.)

## 🔧 Configuration

### Environment Variables

Set via `wrangler secret put` or GitHub Secrets:

- `ANTHROPIC_API_KEY` - Claude API key
- `HONEYCOMB_API_KEY` - Honeycomb ingest key
- `HONEYCOMB_DATASET` - Honeycomb dataset name
- `SLACK_BOT_TOKEN` - Slack integration
- `INTERCOM_API_TOKEN` - Intercom integration
- `ZENDESK_API_TOKEN` - Zendesk integration
- `PRODUCTBOARD_API_TOKEN` - Productboard integration

### Cloudflare Resources

Configure in `wrangler.toml`:
- D1 database binding
- Vectorize index binding
- R2 bucket binding
- KV namespace binding
- Durable Object binding

## 📊 Observability

All operations emit OpenTelemetry spans to Honeycomb:

- HTTP request traces
- LangChain chain execution
- LLM API calls with token usage
- Database queries
- Vector search operations

Query in Honeycomb:
```
trace.id = <id>
http.status_code >= 400
langchain.chain = "classification"
```

## 🚀 Deployment

### Automatic (Recommended)

- **Preview**: Automatically deployed on pull requests
- **Production**: Automatically deployed on merge to `main`

### Manual

```bash
npm run deploy
```

## 🧪 Testing

```bash
# Unit tests
npm run test:run

# Integration tests (Cloudflare Workers runtime)
npm run test:e2e

# Specific test file
vitest run src/chains/classification.test.ts
```

## 📚 Documentation

- [CLAUDE.md](./CLAUDE.md) - Development guide for AI assistants
- [ARCHITECTURE.md](./ARCHITECTURE.md) - Detailed technical architecture
- [Superhuman PMF Engine](https://review.firstround.com/how-superhuman-built-an-engine-to-find-product-market-fit/) - Inspiration

## 🤝 Contributing

1. Fork the repository
2. Create feature branch: `git checkout -b feature/amazing-feature`
3. Write tests (TDD!)
4. Implement feature
5. Ensure tests pass: `npm run test:run`
6. Commit changes: `git commit -m 'Add amazing feature'`
7. Push to branch: `git push origin feature/amazing-feature`
8. Open pull request (preview deployment will be automatic)

## 📄 License

MIT

## 🙏 Acknowledgments

Inspired by [Superhuman's PMF Engine](https://review.firstround.com/how-superhuman-built-an-engine-to-find-product-market-fit/)
