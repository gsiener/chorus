---
title: "Cloudflare Worker Subrequest Budgets and Response Latency"
date: 2026-02-10
module: mention-handler
category: performance-issues
tags:
  - performance
  - cloudflare-workers
  - subrequests
  - latency
  - claude-api
  - amplitude
  - caching
  - parallelization
  - model-selection
symptoms:
  - Slack mentions take 5-15 seconds for Chorus to respond
  - "Sorry, I couldn't generate a response" errors in Slack
  - Cloudflare Worker fails with "Too many subrequests" (84-101 observed)
  - Amplitude fetch cascades exhaust subrequest budget on cold cache
root_cause: >
  Two compounding issues: (1) Sequential I/O operations and slow model choice
  caused 5-15s latency; (2) Amplitude integration made ~27 API calls on cache
  miss during mention path, pushing subrequest count past Cloudflare limits.
resolution_type: performance-optimization and caching-strategy
related:
  - docs/solutions/performance-issues/n-plus-one-kv-reads-and-api-rate-limits.md
  - docs/solutions/integration-issues/amplitude-rest-api-v2-segment-filtering.md
commits:
  - 10b9a49: "perf: Optimize response latency (~2-10s improvement)"
  - 01998ca: "fix: Add daily Amplitude cache warming"
  - 943f0a5: "fix: Bump max_tokens from 300 to 1000"
---

# Cloudflare Worker Subrequest Budgets and Response Latency

## Problem

Two related failures in the Chorus mention handler:

### Symptom 1: Slow responses (5-15s)

Users mentioned @Chorus in Slack and waited 5-15 seconds. The hot path was:

```
200 ack → getBotUserId → parse → fetchThread → postThinking → generateResponse → updateMessage → addReactions
```

The Claude API call dominated (~3-12s with Opus), but sequential Slack API calls and KV reads added 500ms+.

### Symptom 2: "Too many subrequests" failures

Some mentions failed entirely with "Sorry, I couldn't generate a response." Honeycomb traces showed `cloudflare.invocation.sequence.number` reaching 84-101 — Cloudflare Workers have a subrequest limit per invocation.

The error cascade: Amplitude fetch fails → updateMessage fails → error handler fails → metrics flush fails.

## Root Cause

### Latency

1. **Model**: Claude Opus is 3-5x slower than Sonnet 4.5 for conversational tasks
2. **max_tokens**: Set to 1024, far exceeding the 500-char response guideline
3. **Sequential I/O**: Thread fetch and thinking message posted serially
4. **Thread context**: KV read ran before the parallel batch, not inside it
5. **Retries**: 3 Claude API retries × 25s timeout = 78s worst case
6. **Redundant KV read**: `updateThreadContext()` re-fetched context already in memory
7. **Short cache TTL**: Linear priorities cached 5 minutes, causing frequent cold fetches

### Subrequest budget

`getAmplitudeContext()` called `fetchAllMetrics()` on cache miss, which makes ~27 Amplitude API calls (9 metrics × batches of 6, some internally making 3-4 sub-calls each). Combined with Slack, KV, Claude, and Linear calls, this exceeded the subrequest limit.

The Amplitude cache only populated on Monday weekly reports. After the 2-hour KV TTL expired, every mention triggered a full refresh.

## Solution

### 8 latency optimizations (commit `10b9a49`)

**1. Switch model: Opus → Sonnet 4.5** (`src/claude.ts:70`)
```typescript
export const CLAUDE_MODEL = "claude-sonnet-4-5-20250929";
```

**2. Reduce max_tokens: 1024 → 1000** (`src/claude.ts:71`)
```typescript
const CLAUDE_MAX_TOKENS = 1000;
```
Initially tried 300, but responses truncated mid-sentence. 1000 gives headroom while letting the model stop naturally.

**3. Fire-and-forget reactions** (`src/index.ts`)
```typescript
// Before: await Promise.all([addReaction(...), addReaction(...)]);
// After:
Promise.all([
  addReaction(channel, thinkingTs, "thumbsup", env),
  addReaction(channel, thinkingTs, "thumbsdown", env),
]).catch(err => console.warn("Reaction add failed:", err));
```

**4. Parallelize thread fetch + thinking message** (`src/index.ts`)
```typescript
const [threadMessages, thinkingResult] = await Promise.all([
  fetchThreadMessages(channel, thread_ts, env),
  postMessage(channel, "Thinking...", threadTs, env),
]);
```

**5. Move thread context KV read into Promise.all** (`src/claude.ts`)
```typescript
const [threadContext, knowledgeBase, prioritiesContext, amplitudeContext, gapNudge, userInfo] = await Promise.all([
  threadInfo ? getThreadContext(threadInfo.channel, threadInfo.threadTs, env) : Promise.resolve(null),
  getKnowledgeBase(env),
  getPrioritiesContext(env),
  getAmplitudeContext(env),
  query ? detectInitiativeGaps(query, env) : Promise.resolve(null),
  userId ? fetchUserInfo(userId, env) : Promise.resolve(null),
]);
```

**6. Reduce Claude API retries: 3 → 1** (`src/claude.ts`)
```typescript
{ maxRetries: 1, initialDelayMs: 1000, timeoutMs: CLAUDE_API_TIMEOUT_MS }
```

**7. Eliminate redundant KV read** (`src/thread-context.ts`)
```typescript
export async function updateThreadContext(
  ..., existingContext?: ThreadContext | null,
): Promise<void> {
  const resolved = existingContext ?? await getThreadContext(channel, threadTs, env);
```

**8. Increase Linear priorities cache TTL: 5min → 15min** (`src/linear-priorities.ts`)

### Subrequest fix (commit `01998ca`)

**cacheOnly default on mention path** (`src/amplitude.ts`):
```typescript
export async function getAmplitudeContext(
  env: Env,
  { allowRefresh = false } = {},  // cacheOnly=true by default
): Promise<string | null> {
```

On the mention path, Amplitude now costs exactly 1 KV read — returns cached/stale data or null, never triggers API calls.

**Daily cache warming** added to the cron handler:
```typescript
export async function warmAmplitudeCache(env: Env): Promise<void> {
  await getOrRefreshMetrics(env); // cacheOnly=false, refreshes if stale
}
```

### Subrequest budget after fix

| Operation | Subrequests |
|-----------|-------------|
| KV reads (cache, dedup, context, etc.) | ~8 |
| Slack API (thread, thinking, update, reactions) | ~6 |
| Claude API | 1 |
| KV writes (context, dedup, metrics) | ~4 |
| **Total** | **~20** |

Well under Cloudflare's limit.

## Verification

Confirmed via Honeycomb traces after deploy:

| Metric | Before | After |
|--------|--------|-------|
| Model | claude-opus-4-5-20251101 | claude-sonnet-4-5-20250929 |
| Claude API P50 | 9,179ms | 7,480ms |
| Short response (184 tokens) | — | 7.5s e2e |
| Long response (584 tokens) | — | 16.8s e2e |
| Truncated responses | 300 tokens (cut off) | Natural stop |
| Subrequest count | 84-101 (failure) | ~20 (success) |
| Subrequest errors | Yes | None |

## Prevention

1. **cacheOnly pattern**: Any external API integration called from the mention path must default to cache-only mode. Only cron jobs or debug endpoints should trigger fresh fetches.
2. **Subrequest awareness**: Count expected subrequests when adding new integrations. Cloudflare Workers have per-invocation limits.
3. **Cache warming**: External data sources need a cron to keep caches warm, not just lazy population from report endpoints.
4. **max_tokens tuning**: Test with real queries before committing to aggressive limits. Natural stop is better than forced truncation.
5. **Honeycomb deploy markers**: Every deploy creates a marker — use it to correlate timing changes.
