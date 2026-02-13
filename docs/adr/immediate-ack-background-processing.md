---
title: Immediate Ack with Background Processing
status: accepted
date: 2025-12-18
updated: 2026-02-10
tags: [slack, latency, background-processing, waituntil, ux]
---

# ADR: Immediate Ack with Background Processing

## Context

Slack requires webhook responses within 3 seconds or it retries the event (up to 3 times). Claude API calls take 2-15 seconds depending on prompt complexity. We need a pattern that satisfies Slack's timing requirements while allowing sufficient time for AI response generation.

## Decision

Return `200 OK` immediately upon receiving a Slack event, then use `ctx.waitUntil()` to process the response in the background. Show a thinking indicator while processing.

## Change History

### 2025-12-18 — Initial pattern

**Commit:** `5c0a58a` (initial commit)

Established the core pattern from day one:
1. Verify Slack signature
2. Check event deduplication (KV)
3. Return `200 OK` immediately
4. `ctx.waitUntil()` → process mention → post response

### 2025-12-26 — Streaming attempt and revert

**Commits:** `8975cac`, `a1fa5fc`

Explored streaming Claude responses to Slack via progressive message updates. Added and removed within 2 minutes — Slack's `chat.update` API has rate limits that make real-time streaming impractical. The "update in place" approach caused flickering and hit rate limits on longer responses.

### 2025-12-26 — Thinking emoji indicator

**Commit:** `9b1ecc4`

Added the thinking emoji (thought balloon) as a placeholder message posted immediately after ack. This gives users instant visual feedback that Chorus received their message and is working on a response. The placeholder is replaced with the full response when Claude finishes.

### 2026-01-04 — Parallelization for latency

**Commits:** `85e0b05`, `84c5e2f`

Reduced p50 latency from ~8s to ~4s by parallelizing independent operations:
- Thread history fetch, KB load, and priorities load run concurrently via `Promise.all()`
- Previously these were sequential, adding unnecessary latency

### 2026-02-10 — Fire-and-forget reactions

**Commit:** `10b9a49`

Moved feedback reaction posting (👍/👎) to fire-and-forget — don't await the Slack API response. Reactions are non-critical UX; if they fail, the response was still delivered. This saved ~200ms on the critical path.

## Pattern

```
Slack POST event
        │
        ▼
┌─────────────────────────────┐
│ 1. Verify signature          │
│ 2. Deduplicate (KV lookup)   │
│ 3. Return 200 OK            │  ← Within 100ms
└──────────────┬──────────────┘
               │
    ctx.waitUntil()
               │
               ▼
┌─────────────────────────────┐
│ 4. Post thinking emoji       │  ← ~200ms
│ 5. Parallel fetch:           │
│    ├─ Thread history         │
│    ├─ Knowledge base         │
│    └─ R&D Priorities (cache) │  ← ~500ms total
│ 6. Call Claude API           │  ← 2-10s
│ 7. Update message with reply │  ← ~200ms
│ 8. Add reactions (fire+forget)│
└─────────────────────────────┘
```

## Decisions

### Thinking emoji over streaming

Streaming would provide better UX (progressive reveal), but Slack's API makes it impractical:
- `chat.update` is rate-limited (Tier 3: ~50/min)
- Frequent updates cause message flickering
- Streaming adds complexity for marginal benefit given Claude's 2-10s response time

The thinking emoji provides "instant acknowledgment" which addresses the primary UX concern — users know Chorus heard them.

### Event deduplication in KV

Slack retries events if the 200 OK is slow. KV-based deduplication (1-minute TTL) prevents processing the same event twice. The key format is `event:{event_id}`.

### 25-second Claude timeout

Set 5 seconds below the Cloudflare Workers 30s CPU limit to leave headroom for post-processing (message posting, telemetry recording, reaction posting). If Claude times out, we post a friendly "taking too long" message instead of silently failing.
