---
title: Honeycomb Wide Events over Traditional Metrics
status: accepted
date: 2026-01-03
updated: 2026-02-13
tags: [honeycomb, observability, wide-events, otel, telemetry]
---

# ADR: Honeycomb Wide Events over Traditional Metrics

## Context

The OTel GenAI spec defines both span attributes and histogram metrics (`gen_ai.client.token.usage`, `gen_ai.client.operation.duration`). We need an observability strategy that works within Cloudflare Workers constraints and leverages Honeycomb's strengths.

## Decision

Use span attributes exclusively (wide events) rather than histogram metrics. Pack every span with rich, high-cardinality attributes across 6 namespaces so each trace event is a self-contained queryable record in Honeycomb.

## Change History

### 2026-01-03 — Manual OTel SDK (PDD-33)

**Commit:** `d1dda40`

First attempt used `@opentelemetry/sdk-trace-base` and `@opentelemetry/exporter-trace-otlp-http` directly. Bundle size: 649KB. Functional but heavyweight.

### 2026-01-03 — Switch to otel-cf-workers (PDD-47)

**Commit:** `cd4d6a5`

`@opentelemetry/resources` crashes in Workers due to `node:os` dependency. Switched to `@microlabs/otel-cf-workers` — a community wrapper purpose-built for Workers. Bundle dropped to 130KB. This library supports span attributes but not metrics export, which cemented the wide events approach.

### 2026-01-03 — Wide events adoption

**Commit:** `7a291df`

Added comprehensive span attributes across multiple namespaces:
- `gen_ai.*` — model, tokens, cost, cache info (per OTel spec)
- `slack.*` — user, channel, thread, API call count
- `chorus.*` — commands, files, rate limiting, data sources
- `conversation.*` — turn count, context length
- `knowledge_base.*` — doc count, retrieval latency
- `error.*` — category, retryability

### 2026-01-27 — Native Cloudflare OTel

**Commits:** `f19dcc3`, `d1c65fb`

Removed `@microlabs/otel-cf-workers` in favor of Cloudflare's native `observability` config in `wrangler.toml`. Bundle dropped to 46KB. Span attributes continue to work; metrics still unsupported.

### 2026-02-13 — 95+ attributes across 6 namespaces (PDD-84)

**Commit:** `99fa12a`

Full audit established namespace discipline: `gen_ai.*` for OTel-standard attributes, `chorus.*` for custom. Moved non-standard attributes out of `gen_ai.*` to prevent future spec collisions. Current count: 95+ distinct span attributes.

## Architecture

```
Each Chorus request produces one wide event:

┌──────────────────────────────────────────────────────────┐
│ Span: invoke_agent                                        │
│                                                           │
│  gen_ai.operation.name: "invoke_agent"                    │
│  gen_ai.agent.name: "chorus"                              │
│  gen_ai.request.model: "claude-opus-4-5-20251101"         │
│  gen_ai.usage.input_tokens: 12453                         │
│  gen_ai.usage.output_tokens: 847                          │
│  gen_ai.response.finish_reasons: ["end_turn"]             │
│                                                           │
│  chorus.usage.cache_read_input_tokens: 8192               │
│  chorus.latency.total_generation_ms: 3420                 │
│  chorus.response.tool_calls_count: 0                      │
│  chorus.request.has_knowledge_base: true                  │
│                                                           │
│  slack.user_id: "U12345"                                  │
│  slack.channel_id: "C67890"                               │
│  slack.thread_ts: "1234567890.123456"                     │
│  slack.is_thread_reply: true                              │
│                                                           │
│  error.category: null                                     │
│  server.address: "api.anthropic.com"                      │
└──────────────────────────────────────────────────────────┘
                          │
                          ▼
                    Honeycomb
              (queryable on any attribute)
```

## Decisions

### Wide events over histogram metrics

**Why not metrics:**
1. `otel-cf-workers` (and later native CF OTel) doesn't support metrics export
2. `@opentelemetry/resources` crashes Workers (`node:os` dependency)
3. Honeycomb's query engine is optimized for high-cardinality span attributes — GROUP BY on any attribute, HEATMAP on numeric values
4. Wide events let us correlate across dimensions (e.g., "show me p99 latency for thread replies in #product-strategy with cache misses") without pre-aggregation

**Why this works well:**
- Each span is a complete record — no need to join metrics with traces
- Honeycomb's BubbleUp surfaces anomalies across all 95+ attributes automatically
- Adding a new attribute is a one-line code change, no schema migration

### Namespace discipline

Six namespaces keep attributes organized and prevent spec collisions:
- `gen_ai.*` — OTel GenAI semantic conventions (spec-governed)
- `chorus.*` — Custom application attributes
- `slack.*` — Slack platform context
- `conversation.*` — Thread and context metrics
- `knowledge_base.*` — RAG and document retrieval
- `error.*` — Error categorization

See [otel-genai-semantic-conventions.md](./otel-genai-semantic-conventions.md) for the full attribute naming decisions.
