# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chorus is an intelligent agent that monitors and synthesizes product feedback from multiple channels to track product-market fit. It ingests feedback from Slack, Intercom, Zendesk, Productboard, and user interviews, then uses Claude to analyze patterns, sentiment, and trends.

Inspired by Superhuman's PMF engine methodology from https://review.firstround.com/how-superhuman-built-an-engine-to-find-product-market-fit/

## Development Philosophy

**Test-Driven Development (TDD)**: This project follows TDD principles. When implementing new features or fixing bugs:
1. Write failing tests first that describe the desired behavior
2. Implement the minimum code needed to make tests pass
3. Refactor while keeping tests green
4. All tests must pass before committing code

**Test Requirements**:
- All tests must pass before committing (enforced by pre-commit hook)
- New functions, classes, and modules must have corresponding tests
- Integration points should have tests (even if mocked initially)
- Zod schemas should have validation tests
- Pre-commit hook runs `npm run type-check` and `npm run test:run` automatically

## Common Commands

### Development
- `npm run dev` - Run the main entry point with hot reload
- `npm run build` - Compile TypeScript to dist/
- `npm run type-check` - Check types without building

### Testing & Linting
- `npm run test` - Run all tests with Vitest in watch mode
- `npm run test:run` - Run all tests once (used in CI and pre-commit)
- `npm run test:watch` - Run tests in watch mode (alias for npm test)
- `vitest run src/types/feedback.test.ts` - Run a single test file
- `npm run lint` - Lint source code
- `npm run lint:fix` - Auto-fix linting issues

### Operations
- `npm run ingest` - Fetch feedback from configured integrations
- `npm run analyze` - Analyze collected feedback and generate PMF report
- `npm start` - Run the compiled application

## Architecture

### High-Level Structure

The codebase follows a modular architecture with clear separation of concerns:

**Integrations Layer** (`src/integrations/`)
- Base class pattern for all data source connectors
- Each integration implements `BaseIntegration` interface
- `IntegrationManager` orchestrates fetching from all enabled sources
- Integrations return normalized `FeedbackItem` objects

**Analysis Engine** (`src/analysis/`)
- `FeedbackAnalyzer` uses Claude API (claude-3-5-sonnet-20241022) to:
  - Classify individual feedback items (category, sentiment, themes)
  - Generate comprehensive PMF reports with insights and recommendations
- Two-phase analysis: item-level → aggregate synthesis
- Calculates PMF metrics including sentiment distribution and theme trends
- Prompts request JSON responses for reliable structured output parsing

**Storage Layer** (`src/storage/`)
- File-based storage in configurable data directory
- Three data types: raw feedback, analyzed feedback, reports
- Organized by date for efficient querying
- Simple JSON persistence (can be replaced with database)

**Jobs** (`src/jobs/`)
- `ingest.ts` - Pulls feedback from all integrations
- `analyze.ts` - Processes collected feedback and generates reports
- Designed for cron/scheduled execution

### Data Flow

1. **Ingestion**: IntegrationManager → Multiple sources → FeedbackItem[]
2. **Storage**: FeedbackItem[] → FeedbackStore → data/feedback/
3. **Analysis**: FeedbackStore → FeedbackAnalyzer (Claude) → AnalyzedFeedback[]
4. **Synthesis**: AnalyzedFeedback[] → FeedbackAnalyzer (Claude) → AnalysisReport
5. **Persistence**: AnalysisReport → FeedbackStore → data/reports/

### Type System

Core types are defined using Zod schemas in `src/types/`:

- `FeedbackItem` - Raw feedback from any source
- `AnalyzedFeedback` - Feedback with AI-extracted metadata
- `PMFMetrics` - Quantitative measures of product-market fit
- `AnalysisReport` - Complete synthesis with insights and recommendations

### Configuration

Environment variables control all integrations and behavior:
- API tokens for each data source (Slack, Intercom, etc.)
- `ANTHROPIC_API_KEY` for Claude API access
- Analysis parameters (PMF threshold, minimum feedback count)
- Data directory location

See `.env.example` for complete configuration options.

## Key Design Decisions

**Batch Processing**: System uses scheduled batch analysis rather than real-time to optimize Claude API usage and enable deeper synthesis across time periods.

**File-Based Storage**: Simple JSON storage allows easy inspection and debugging. Can be migrated to PostgreSQL/MongoDB for production scale.

**Extensible Integrations**: BaseIntegration pattern makes adding new data sources straightforward - implement fetchFeedback() and normalization logic.

**Two-Phase Analysis**: Individual item classification followed by aggregate synthesis allows Claude to identify patterns across large feedback sets while maintaining token efficiency. Report synthesis is limited to 100 most recent items to respect token limits.

**Zod Schema Validation**: All data types use Zod schemas for runtime validation and type inference, ensuring type safety at boundaries.

## Adding New Integrations

1. Create new file in `src/integrations/` extending `BaseIntegration`
2. Implement `fetchFeedback(since?: Date)` method
3. Normalize source data to `FeedbackItem` format
4. Add configuration to `IntegrationsConfig` type
5. Register in `IntegrationManager` constructor
6. Add credentials to `.env` and `.env.example`

## Development Workflow

### Testing Without Live APIs
1. Add test data to `data/feedback/` as JSON with FeedbackItem structure
2. Run `npm run analyze` to process existing data
3. Check `data/reports/` for generated insights

### Modifying Analysis
- Edit prompts in `src/analysis/analyzer.ts` (lines 13-29 for item analysis, 155-196 for report synthesis)
- Adjust `PMFMetrics` schema in `src/types/analysis.ts` to capture new metrics
- Update `calculateMetrics()` method in analyzer to compute new metrics

### Integration Implementation Status
All integrations in `src/integrations/` have TODO comments where API calls need implementation. Each needs:
- API client library added to package.json
- fetchFeedback() implementation with proper error handling
- Data transformation to FeedbackItem format

### TDD Workflow Example
When adding a new feature:
1. Create test file (e.g., `src/analysis/pmf-calculator.test.ts`)
2. Write test cases describing expected behavior
3. Run `npm test` - tests should fail (red)
4. Implement the feature in source file
5. Run `npm test` - tests should pass (green)
6. Refactor if needed, ensuring tests stay green
7. Commit only when all tests pass
