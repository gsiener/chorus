---
title: "N+1 KV Reads and API Rate Limits: Multi-Layer Caching Strategy"
date: 2026-02-07
module: caching
category: performance-issues
tags:
  - performance
  - n-plus-one
  - rate-limiting
  - cloudflare-kv
  - amplitude-api
  - linear-api
  - cache-aside
symptoms:
  - Amplitude API 429 (Too Many Requests) when sending metrics reports
  - Excessive KV reads per @mention (N+1 for KB assembly)
  - Repeated initiative index parsing on every operation
  - Redundant Linear GraphQL API calls during sync windows
root_cause: Missing cache layer between hot read paths and KV/external APIs
resolution_type: cache-aside with TTL-based expiration and write-through invalidation
---

# N+1 KV Reads and API Rate Limits

## Problem

Every `@mention` to Chorus triggered excessive reads:

1. **Knowledge Base assembly** — `getKnowledgeBase()` read the docs index + every individual document from KV (N+1 pattern). A 10-doc KB meant ~11 KV reads per mention.
2. **Initiative index** — `getIndex()` re-read and re-parsed the initiatives JSON on every call (listing, gap detection, context generation).
3. **Amplitude metrics** — `sendWeeklyMetricsReport()` and `sendTestMetricsReport()` called `fetchAllMetrics()` directly, making ~22 parallel Amplitude API requests. Back-to-back triggers caused 429 rate limit errors.
4. **Linear projects** — `fetchLinearProjects()` hit the GraphQL API on every sync, even when synced recently.

## Root Cause

No intermediate cache between consumers and the underlying KV/API data sources. Each read path went directly to the source every time, with no memoization or TTL-based caching.

## Solution

Applied the **cache-aside pattern** consistently across four modules, with centralized TTL constants.

### Cache TTL Constants (`src/constants.ts`)

```typescript
export const KB_CACHE_TTL_SECONDS = 600;              // 10 minutes
export const AMPLITUDE_CACHE_TTL_SECONDS = 3600;      // 1 hour (data is weekly)
export const LINEAR_PROJECTS_CACHE_TTL_SECONDS = 1800; // 30 minutes
export const INITIATIVES_CACHE_TTL_SECONDS = 300;      // 5 minutes
```

### Cache-Aside Pattern (applied in all four modules)

```typescript
// 1. Check cache
const cached = await env.DOCS_KV.get(CACHE_KEY);
if (cached) return JSON.parse(cached);

// 2. Fetch from source
const data = await expensiveFetch();

// 3. Store in cache with TTL
await env.DOCS_KV.put(CACHE_KEY, JSON.stringify(data), {
  expirationTtl: TTL_SECONDS,
});

return data;
```

### Invalidation Strategy

| Module | Cache Key | TTL | Invalidation |
|--------|-----------|-----|--------------|
| `docs.ts` | `cache:kb:assembled` | 10 min | Delete on add/update/remove |
| `initiatives.ts` | `cache:initiatives:index` | 5 min | Delete on `saveIndex()` |
| `linear.ts` | `cache:linear:projects` | 30 min | TTL expiration only |
| `amplitude.ts` | `amplitude:metrics:weekly` | 1 hour | TTL expiration only |

**Rule of thumb**: Mutable internal data gets explicit invalidation on writes. External API data relies on TTL expiration.

### Amplitude Rate Limit Fix

Added `getCachedOrFetchMetrics()` helper that both report functions use:

```typescript
async function getCachedOrFetchMetrics(env: Env): Promise<AmplitudeMetrics> {
  const cached = await env.DOCS_KV.get(CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch {}
  }
  const data = await fetchAllMetrics(env);
  await env.DOCS_KV.put(CACHE_KEY, JSON.stringify(data), {
    expirationTtl: AMPLITUDE_CACHE_TTL_SECONDS,
  });
  return data;
}
```

Previously `sendWeeklyMetricsReport` and `sendTestMetricsReport` each called `fetchAllMetrics()` unconditionally. Now they share cached data.

## Impact

| Metric | Before | After |
|--------|--------|-------|
| KV reads per @mention | 10-30 | 2-4 (cache hits) |
| Amplitude API calls per report | ~22 | 0 (within 1hr window) |
| Linear API calls per sync window | 1 per trigger | 1 per 30 min |
| Rate limit (429) errors | Frequent on back-to-back sends | Eliminated |

## Cache Key Convention

All cache keys follow `cache:<domain>:<resource>`:
- `cache:kb:assembled`
- `cache:initiatives:index`
- `cache:linear:projects`

Exception: `amplitude:metrics:weekly` predates the convention and was kept for backward compatibility.

## Prevention

- Always add a cache layer between hot read paths and KV/external APIs
- Centralize TTLs in `constants.ts` — no magic numbers in module code
- For external APIs with rate limits, prefer cache-first over fetch-first
- Write-through invalidation for mutable data; TTL-only for read-only synced data

## Related

- [ARCHITECTURE.md — KV Storage Patterns](../../ARCHITECTURE.md) (lines 546-562)
- [Amplitude REST API V2 Segment Filtering](../integration-issues/amplitude-rest-api-v2-segment-filtering.md)
- [Primitives Extraction Pattern](../refactoring/primitives-extraction-pattern-20260204.md) — reusable KV store abstractions

## Commits

- `8abaa45` — `fix: Use cached metrics for report sending to avoid rate limits`
- `543edbe` — `perf: Add caching for KB assembly, initiative index, and Linear projects`
