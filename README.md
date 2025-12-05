# Chorus

An intelligent agent for monitoring and synthesizing product feedback from various channels to track product-market fit.

Inspired by [Superhuman's PMF Engine](https://review.firstround.com/how-superhuman-built-an-engine-to-find-product-market-fit/).

## Features

- **Multi-channel feedback ingestion**: Slack, Intercom, Zendesk, user interviews, Productboard
- **AI-powered analysis**: Uses Claude to identify themes, sentiment, and trends
- **PMF tracking**: Monitors signals of product-market fit over time
- **Trend detection**: Identifies emerging patterns and areas for investment
- **Scheduled batch processing**: Runs analysis on a configurable schedule

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables:
```bash
cp .env.example .env
# Edit .env with your API keys and configuration
```

3. Build the project:
```bash
npm run build
```

## Development

- **Run in development mode**: `npm run dev`
- **Type checking**: `npm run type-check`
- **Linting**: `npm run lint`
- **Tests**: `npm run test`

## Usage

### Ingest feedback from sources
```bash
npm run ingest
```

### Run analysis
```bash
npm run analyze
```

### Start scheduled service
```bash
npm start
```

## Architecture

See [CLAUDE.md](./CLAUDE.md) for detailed architecture documentation.
