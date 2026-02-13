---
title: KV-First Caching with TTL and Cache Warming
status: accepted
date: 2025-12-18
updated: 2026-02-11
tags: [kv, caching, ttl, cache-warming, performance]
---

# ADR: KV-First Caching with TTL and Cache Warming

## Context

Cloudflare Workers have a limited subrequest budget and a 30-second CPU limit. External API calls (Slack, Claude, Linear) add latency and consume subrequests. We need a caching strategy that minimizes external calls on the critical path while keeping data reasonably fresh.

## Decision

Use Cloudflare KV as a universal cache layer with TTL-based expiration. Cache warming on cron for predictable data (priorities). Cache-aside for request-scoped data (responses, bot user ID). Cache-only reads on the hot path for non-critical data.

## Change History

### 2025-12-18 — Foundation: dedup and rate limits

**Commit:** `5c0a58a`

Initial KV usage for operational concerns:
- `event:{id}` — 1-minute TTL for event deduplication
- `ratelimit:{type}:{user}` — 60-second TTL for per-user rate limiting

### 2025-12-27 — Cache-aside for KB and responses

**Commits:** `d1dda40`, `17be362`

Added cache-aside pattern for:
- `docs:index` / `docs:content:{title}` — no TTL (permanent until explicitly removed)
- `cache:response:{hash}` — 1-hour TTL, keyed by content hash of the prompt

### 2026-01-03 — Bot user ID caching

**Commit:** `cd4d6a5`

Cached `auth.test` response for bot user ID (1-hour TTL). Previously fetched on every request to strip the bot mention from messages.

### 2026-01-04 — Parallelization and subrequest optimization

**Commits:** `85e0b05`, `84c5e2f`

Hit the 50-subrequest limit. Optimized by:
- Moving KV reads to happen in parallel via `Promise.all()`
- Cache-only reads for priorities (no fallback fetch on miss during mention handling)
- Reduced total subrequests from 84-101 to ~20 per mention

### 2026-01-23 — Priorities cache with warming

**Commit:** `9bbb45d`

Added `linear:priorities:context` with 25-hour TTL. The cron handler calls `warmPrioritiesCache()` daily to pre-populate the cache. The mention path reads from cache only — never fetches from Linear directly.

### 2026-01-28 — Thread context caching

**Commit:** `f19dcc3`

Added `thread:context:{channel}:{ts}` with 7-day TTL for conversation summaries. Prevents re-summarizing the same thread history on every message in a long conversation.

### 2026-02-07 — Check-in rate limiting

**Commit:** `9078a00`

Added `checkin:last:{user}` with 14-day TTL to enforce minimum 6-day intervals between DM check-ins per user.

## KV Key Inventory

| Key Pattern | Purpose | TTL | Write Path | Read Path |
|------------|---------|-----|------------|-----------|
| `event:{id}` | Event deduplication | 1 min | Mention handler | Mention handler |
| `ratelimit:{type}:{user}` | Per-user rate limiting | 60s | Rate limit check | Rate limit check |
| `docs:index` | Document metadata list | None | Doc add/remove | Every mention |
| `docs:content:{title}` | Document full text | None | Doc add | Every mention |
| `cache:response:{hash}` | Claude response cache | 1 hour | After Claude call | Before Claude call |
| `cache:botUserId` | Slack bot user ID | 1 hour | After auth.test | Mention handler |
| `linear:priorities:context` | R&D Priorities text | 25 hours | Cron warming | Every mention |
| `thread:context:{ch}:{ts}` | Thread summary | 7 days | After summarization | Thread reply handler |
| `checkin:last:{user}` | Last check-in timestamp | 14 days | After check-in sent | Check-in scheduler |

## Decisions

### Cache-only reads on hot path

For data like R&D Priorities that's warmed by cron, the mention handler reads from KV cache only. If the cache is empty (warming failed), the response proceeds without priorities rather than making a synchronous Linear API call. This prevents external service failures from blocking Slack responses.

### TTL overlap for warming

Cache TTLs are set slightly longer than their warming intervals. Priorities: 25-hour TTL with daily (24-hour) warming. This ensures the old entry is still valid if a warming run fails or is delayed.

### Content-hash response cache

Claude response caching uses a hash of the full prompt (system prompt + messages + context) as the key. This means identical questions in the same context return cached responses, but any change in context (new thread message, updated KB, new priorities) produces a cache miss and fresh response.

### No external cache services

KV provides sufficient caching for our needs. Adding Redis or another cache layer would add complexity, cost, and an external dependency. KV's eventual consistency (propagation delay up to 60s) is acceptable for our use cases — none require strong consistency.
