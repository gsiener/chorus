# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Task Tracking

We use **Linear** to track tasks:

**Starting a task:**
1. Move the Linear issue to "In Progress"
2. Reference the issue ID (e.g., PDD-28) in commits

**Finishing a task:**
1. Commit and push changes
2. Move issue to "In Review"
3. Verify/confirm the fix works
4. If confirmed → move to "Done"
5. If can't confirm → leave in "In Review" for manual verification

**Creating issues:**
- Associate new issues with the **Chorus Project** (ID: d581ee59-765e-4257-83f8-44e75620bac6)

## Project Overview

Chorus is a Cloudflare Worker-based Slack bot that responds to @mentions using Claude for AI-powered responses. It maintains thread context for natural conversations and is focused on internal knowledge about product roadmap and strategy.

## Commands

- `npm run dev` - Start local development server
- `npm run deploy` - Deploy to Cloudflare Workers
- `npm run typecheck` - Run TypeScript type checking
- `npm test` - Run tests
- `npm run test:watch` - Run tests in watch mode

## Testing Requirements

**Always write tests and ensure they pass before committing.** Tests are located in `src/__tests__/` using vitest with the Cloudflare Workers pool. CI will block merges if tests fail.

## Architecture

```
@mention → Cloudflare Worker → ack immediately (200)
                            → waitUntil: fetch thread → Claude API → post response
```

**Key files:**
- `src/index.ts` - Worker entry point, routes Slack events, handles `app_mention`
- `src/slack.ts` - Slack API: signature verification, thread fetching, message posting
- `src/claude.ts` - Claude API integration, system prompt, message format conversion
- `src/types.ts` - TypeScript interfaces for Slack events and API responses

**Flow for @mentions:**
1. Slack POSTs to worker with `app_mention` event
2. Worker verifies signature, returns 200 immediately
3. `waitUntil()` continues: fetches thread history if in a thread
4. Converts Slack messages to Claude format, calls Claude API
5. Posts response back to Slack in the same thread

## Environment Secrets

Set via `npx wrangler secret put <NAME>`:
- `SLACK_BOT_TOKEN` - Bot token for Slack API (`xoxb-...`)
- `SLACK_SIGNING_SECRET` - For request verification
- `ANTHROPIC_API_KEY` - Claude API key
- `DOCS_API_KEY` - API key for console-based document management (REST API)
