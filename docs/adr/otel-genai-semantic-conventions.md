---
title: OTel GenAI Semantic Conventions Adoption
status: accepted
date: 2025-12-27
updated: 2026-02-13
tags: [telemetry, otel, genai, observability, honeycomb]
---

# ADR: OTel GenAI Semantic Conventions Adoption

## Context

Chorus uses OpenTelemetry to export traces to Honeycomb for observability. As a GenAI application (Claude-powered Slack bot), we follow the OTel GenAI semantic conventions to ensure our telemetry is interoperable with standard tooling and aligns with industry practice.

## Spec References

The following specs govern our telemetry attribute naming:

| Spec | URL | Used for |
|------|-----|----------|
| GenAI Spans | https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/ | Inference + embeddings span attributes |
| GenAI Agent Spans | https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/ | Agent invocation attributes (`invoke_agent`) |
| GenAI Metrics | https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-metrics/ | Metric naming (not implemented — see below) |
| GenAI Events | https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-events/ | Event naming for inputs/outputs |

### Upstream issues we track

| Issue | Topic | Status |
|-------|-------|--------|
| [semantic-conventions #1959](https://github.com/open-telemetry/semantic-conventions/issues/1959) | Detailed token type attributes (cached, reasoning, multi-modal) | Open — active discussion |
| [Effect-TS/effect #5862](https://github.com/Effect-TS/effect/issues/5862) | `@effect/opentelemetry` version conflict with `sdk-logs` | Open — no movement |

## Change History

### 2025-12-27 — Initial adoption (PDD-33)

**Commit:** `d1dda40`

Created `src/telemetry.ts` with GenAI semantic conventions based on **v1.29.0** of the spec. Added:
- `gen_ai.operation.name` (chat, embeddings)
- `gen_ai.system` (provider identifier — later deprecated by spec)
- `gen_ai.request.model`, `gen_ai.response.model`
- `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`
- `gen_ai.request.max_tokens`, `gen_ai.request.temperature`, etc.
- `gen_ai.response.finish_reasons`, `gen_ai.response.id`

Reference: https://opentelemetry.io/docs/specs/semconv/gen-ai/

### 2026-01-03 — Switch to otel-cf-workers (PDD-47)

**Commit:** `cd4d6a5`

Migrated from basic Cloudflare Workers logging to `@microlabs/otel-cf-workers` for full OTel span attribute support. Added caching token attributes (`gen_ai.usage.cache_creation_input_tokens`, `gen_ai.usage.cache_read_input_tokens`).

### 2026-01-03 — Wide events approach

**Commit:** `7a291df`

Added comprehensive span attributes for Honeycomb wide events: Slack context (`slack.*`), conversation quality signals, knowledge base metrics, error categorization. These used custom namespaces (`chorus.*`, `slack.*`, `knowledge_base.*`).

### 2026-01-06 — GenAI message capture

**Commits:** `ca17b78`, `5cd549e`, `0d3e6d2`

Added opt-in content attributes based on **v1.37.0+** of the spec:
- `gen_ai.system_instructions` — system prompt
- `gen_ai.input.messages` — serialized conversation
- `gen_ai.output.content` — generated completion (later renamed to `gen_ai.output.messages`)

Added cost tracking (`gen_ai.usage.estimated_cost_usd`) and latency breakdown attributes.

### 2026-02-10 — Latency optimization

**Commit:** `10b9a49`

Added latency tracking attributes: `gen_ai.latency.total_generation_ms`, `gen_ai.server.time_to_first_token_s`, `gen_ai.client.operation.duration_s`. These were initially placed in the `gen_ai.*` namespace (later moved to `chorus.*`).

### 2026-02-13 — Spec alignment audit (PDD-84)

**Commit:** `99fa12a`

Full audit against current spec. Changes:

1. **Agent span conventions adopted** — Top-level request span now uses `gen_ai.operation.name: "invoke_agent"` with `gen_ai.agent.name: "chorus"` and `gen_ai.agent.description`. Claude API calls retain `gen_ai.operation.name: "chat"`.

2. **Removed `gen_ai.system`** — Spec now requires `gen_ai.provider.name` as the canonical provider identifier. We had been setting both; dropped the deprecated one.

3. **Fixed attribute names:**
   - `gen_ai.request.embedding_dimensions` → `gen_ai.embeddings.dimension.count`
   - `gen_ai.response.finish_reason` (singular) → `gen_ai.response.finish_reasons` (plural, string array)
   - `gen_ai.output.content` → `gen_ai.output.messages`

4. **Namespace cleanup** — Moved non-standard attributes from `gen_ai.*` to `chorus.*` to prevent collisions with future spec additions:
   - `gen_ai.usage.total_tokens` → removed (derived)
   - `gen_ai.usage.cache_*` → `chorus.usage.cache_*`
   - `gen_ai.response.cache_hit` → `chorus.response.cache_hit`
   - `gen_ai.response.tool_calls_count` → `chorus.response.tool_calls_count`
   - `gen_ai.request.streaming` → `chorus.request.streaming`
   - `gen_ai.request.messages_count` → `chorus.request.messages_count`
   - `gen_ai.request.has_knowledge_base` → `chorus.request.has_knowledge_base`
   - `gen_ai.data_source.*` → `chorus.data_source.*`
   - `gen_ai.latency.*` → `chorus.latency.*`
   - `gen_ai.client.operation.duration_s` → `chorus.client.operation.duration_s`
   - `gen_ai.server.time_to_first_token_s` → `chorus.server.time_to_first_token_s`

5. **Added `server.address`** — Set to `api.anthropic.com` for Anthropic provider (recommended attribute).

### 2026-02-13 — Defensive span method calls (PDD-85)

**Commit:** (this commit)

Fixed `span.setAttributes is not a function` errors in Cloudflare Workers integration tests. The `otel-cf-workers` library sometimes provides span objects without standard OTel methods. Replaced all direct `span.setAttributes()`, `span.setAttribute()`, `span.setStatus()`, `span.addEvent()`, and `span.recordException()` calls with defensive wrappers (`safeSetAttributes`, `safeSetAttribute`, `safeSetStatus`, `safeAddEvent`, `safeRecordException`) that check for method existence before calling.

## Decisions

### Span attributes over histogram metrics

The spec defines `gen_ai.client.token.usage` and `gen_ai.client.operation.duration` as histogram metrics. We use span attributes instead because `otel-cf-workers` doesn't support metrics export. This works well with Honeycomb's wide events model — every span is a rich event with all attributes queryable.

### Namespace discipline

All standard OTel attributes use their spec-defined names. Custom attributes use the `chorus.*` namespace. This prevents collisions as the GenAI spec evolves (it has added new attributes in every recent version).

### Agent span hierarchy

The top-level span for each Chorus request is an `invoke_agent` span. Child spans from the Claude API call use `chat` as the operation name. This matches the spec's intended hierarchy where agent spans wrap one or more inference spans.
