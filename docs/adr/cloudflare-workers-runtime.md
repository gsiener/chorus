---
title: Cloudflare Workers as Runtime Platform
status: accepted
date: 2025-12-18
updated: 2026-02-11
tags: [cloudflare, workers, serverless, runtime, architecture]
---

# ADR: Cloudflare Workers as Runtime Platform

## Context

Chorus needs a serverless runtime to host a Slack bot that responds to @mentions with Claude-powered AI responses. The runtime must handle HTTP webhooks, provide low-latency responses, and integrate with storage and AI services.

## Decision

Use Cloudflare Workers as the sole runtime platform, leveraging its native bindings for KV, Vectorize, Workers AI, and OpenTelemetry.

## Change History

### 2025-12-18 — Initial implementation

**Commit:** `5c0a58a` (initial commit)

Chose Cloudflare Workers over alternatives (AWS Lambda, Vercel Edge Functions, Deno Deploy) for:
- Native KV bindings for state without external databases
- Vectorize for semantic search without a vector DB service
- Workers AI for embeddings without additional API calls
- Global edge deployment with sub-50ms cold starts
- `ctx.waitUntil()` for background processing after returning 200 OK to Slack

### 2025-12-26 — Streaming attempt and revert

**Commits:** `8975cac`, `a1fa5fc`

Attempted streaming responses via Workers — added and removed within 2 minutes. Slack's API doesn't support streaming message updates well; switched to the "thinking emoji → full response update" pattern instead.

### 2026-01-03 — OTel integration challenges (PDD-47)

**Commit:** `cd4d6a5`

Discovered that `@opentelemetry/resources` crashes Workers due to `node:os` import. Switched to `@microlabs/otel-cf-workers` which is purpose-built for the Workers runtime. This locked us into the community library's incomplete Span interface (see PDD-85 solution doc).

### 2026-01-04 — Subrequest budget optimization

**Commits:** `85e0b05`, `84c5e2f`

Hit Cloudflare's 50-subrequest limit on the free plan. Initial request flow made 84-101 subrequests per mention. Optimized to ~20 by:
- Parallelizing independent fetches (thread history, KB, priorities)
- Caching aggressively in KV
- Using cache-only reads on the hot path

### 2026-01-27 — Bundle size optimization

**Commits:** `f19dcc3`, `d1c65fb`

Bundle evolved from 649KB (manual OTel SDK) → 130KB (native CF OTel) → 46KB (current). Removed `@opentelemetry/*` packages entirely in favor of Cloudflare's native `observability` config in `wrangler.toml`.

### 2026-02-10 — 30-second CPU limit management

**Commit:** `10b9a49`

Added latency tracking to monitor proximity to the 30s CPU limit. Claude API timeout set to 25s to leave 5s headroom for post-processing (message posting, telemetry, reactions).

## Constraints

| Constraint | Impact |
|-----------|--------|
| 30s CPU limit | Claude timeout capped at 25s; background work must be fast |
| Subrequest budget | All external calls counted; parallelization + caching essential |
| No `node:os` | Standard OTel SDK unusable; rely on native CF OTel or community wrappers |
| `workerd` test quirks | Vitest pool uses `workerd` runtime; some Node.js APIs unavailable in tests |
| No persistent connections | Each request is stateless; all state lives in KV |

## Tradeoffs

**Benefits:**
- Zero infrastructure management — no servers, load balancers, or scaling config
- Native bindings eliminate external service dependencies for KV, vectors, and embeddings
- Global edge deployment means consistent latency worldwide
- Built-in cron triggers for scheduled tasks (check-ins, cache warming)

**Costs:**
- Locked into Cloudflare ecosystem for storage and AI services
- Community OTel support is immature compared to Node.js SDK
- 30s limit makes complex multi-turn agent loops infeasible
- Testing requires `workerd`-compatible tooling (not standard Node.js test runners)
