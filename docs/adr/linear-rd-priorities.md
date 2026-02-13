---
title: Linear as R&D Priorities Source of Truth
status: accepted
date: 2025-12-27
updated: 2026-02-11
tags: [linear, priorities, initiatives, integration, caching]
---

# ADR: Linear as R&D Priorities Source of Truth

## Context

Chorus answers questions about R&D priorities and initiative ownership. This data needs a single source of truth that leadership can edit directly without going through a bot interface.

## Decision

Use Linear initiatives as the canonical source of R&D Priorities data, fetched via GraphQL API and cached in KV. Removed all KV-based CRUD for managing priorities through the bot.

## Change History

### 2025-12-27 — Initial KV initiative store (PDD-17)

**Commit:** `d1dda40`

First implementation stored initiatives directly in KV with a full CRUD interface accessible via Slack commands (`@chorus add initiative ...`, `@chorus remove initiative ...`, etc.). This included:
- `src/initiatives.ts` — KV-backed initiative store
- CRUD commands in `src/index.ts`
- ~3,371 lines of initiative management code

### 2026-01-23 — Linear integration begins (PDD-59)

**Commit:** `9bbb45d`

Created `src/linear-priorities.ts` to fetch priorities from Linear's GraphQL API. The parent initiative is linked to child initiatives via `initiativeRelations` with `sortOrder` for ranking. Each initiative carries: owner, tech risk (hot pepper emoji scale), theme, and Slack channel in its description.

### 2026-01-28 — Weekly check-ins rewritten for Linear (PDD-85)

**Commit:** `98d8a36`

Rewrote `src/checkins.ts` to generate check-in messages from Linear priorities instead of the KV store. Check-ins now reflect the live state of initiatives in Linear.

### 2026-02-07 — KV initiative store removed

**Commit:** `9078a00`

Removed `src/initiatives.ts` and all KV CRUD commands (~3,371 lines). Linear is now the sole source of truth. The bot can read priorities but cannot modify them — edits happen in Linear's UI where leadership already works.

### 2026-02-11 — Cache warming and owner display

**Commits:** `c6fa7ef`, `9078a00`

Added daily cache warming via cron handler. Switched from displaying Slack @mention handles to displaying owner names, since Linear stores real names and the @mention format was noisy in bot responses.

## Architecture

```
Linear (source of truth)
        │
        ▼ (GraphQL API)
linear-priorities.ts
        │
        ├─► warmPrioritiesCache()  ← cron trigger (daily)
        │         │
        │         ▼
        │   KV: linear:priorities:context (25-hour TTL)
        │
        └─► getPrioritiesContext()  ← mention path
                  │
                  ▼
            Read from KV cache (cache-only on hot path)
                  │
                  ▼
            Included in Claude's system prompt
```

## Decisions

### Linear over KV CRUD

Managing priorities through Slack commands created a parallel data store that drifted from what leadership tracked in Linear. By making Linear the single source of truth:
- No data synchronization problems
- Leadership edits initiatives where they already work
- Bot always reflects the current state
- Removed ~3,371 lines of CRUD code

### Cache-only reads on mention path

The mention handler never fetches from Linear directly — it reads from KV cache and returns stale data (or nothing) on cache miss. This prevents Linear API latency or failures from blocking Slack responses. The cache is warmed daily by the cron handler, so it's always reasonably fresh.

### 25-hour TTL with daily warming

The cache TTL (25 hours) is slightly longer than the warming interval (24 hours) to ensure overlap. If a cron run fails, the previous cache entry still serves for an extra hour before expiring.

### Owner names over @mentions

Linear stores real names (`"Graham Siener"`) not Slack handles (`"<@U12345>"`). Rather than adding a Slack API lookup to resolve user IDs, we display the plain name. This is cleaner in bot responses and avoids unnecessary API calls.
