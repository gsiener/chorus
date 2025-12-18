# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chorus is a Cloudflare Worker-based Slack bot that responds to @mentions using Claude for AI-powered responses. It maintains thread context for natural conversations and is focused on internal knowledge about product roadmap and strategy.

## Commands

- `npm run dev` - Start local development server
- `npm run deploy` - Deploy to Cloudflare Workers
- `npm run typecheck` - Run TypeScript type checking

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
