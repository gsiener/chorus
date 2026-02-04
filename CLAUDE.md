# CLAUDE.md

## Project Overview

Chorus is a Cloudflare Worker Slack bot that responds to @mentions using Claude. It maintains thread context and answers questions about product roadmap and strategy using data from Linear.

## Commands

```bash
npm run dev         # Local development server
npm run deploy      # Deploy to Cloudflare Workers
npm run typecheck   # TypeScript type checking
npm test            # Run tests
npm run test:watch  # Tests in watch mode
```

## Testing

Always write tests and ensure they pass before committing. Tests are in `src/__tests__/` using vitest. CI blocks merges on test failures.

## Architecture

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for system design. Update it when adding modules, changing data flow, or adding integrations.

## Environment Secrets

Set via `npx wrangler secret put <NAME>`:

- `SLACK_BOT_TOKEN` - Bot token (`xoxb-...`)
- `SLACK_SIGNING_SECRET` - Request verification
- `ANTHROPIC_API_KEY` - Claude API key
- `DOCS_API_KEY` - Console document management API
- `LINEAR_API` - Linear API key

## Linear Integration

- API key in `.env` as `LINEAR_API`
- Team ID: `daa91240-92e1-4a78-8cc7-a53684a431b1`
- Project ID (Chorus): `d581ee59-765e-4257-83f8-44e75620bac6`
- See **[docs/linear-api.md](./docs/linear-api.md)** for workflow states and API examples

**Task workflow:** Reference issue ID in commits (e.g., PDD-28). Move issues: In Progress → In Review → Done. Batch commits before pushing (CI costs money).

**Prefer Linear sub-issues over CLI tasks** - keeps work visible to the team.

## R&D Priorities

Chorus fetches priorities from Linear and includes them in Claude's system prompt. Cache refreshes every 5 minutes.

- Source: `src/linear-priorities.ts`
- Parent initiative ID: `RD_PRIORITIES_INITIATIVE_ID` constant
- Debug endpoint: `GET /api/debug/priorities` (requires DOCS_API_KEY)
- Ask endpoint: `POST /api/ask` (requires DOCS_API_KEY)

## Bug Workflow

1. Create Linear issue
2. Write failing test that reproduces the bug
3. Fix and verify test passes
4. Update Linear issue state
