---
title: "otel-cf-workers: Incomplete Span Interface Causes TypeError"
date: 2026-02-13
category: integration-issues
module: telemetry
tags:
  - opentelemetry
  - cloudflare-workers
  - otel-cf-workers
  - span-instrumentation
  - defensive-coding
symptoms:
  - "TypeError: span.setAttributes is not a function"
  - "TypeError: span.setAttribute is not a function"
  - "TypeError: span.setStatus is not a function"
  - "Stream API error: span.setAttributes is not a function in integration tests"
root_cause: |
  `@microlabs/otel-cf-workers` wraps the Cloudflare Worker handler to provide OTel
  tracing, but the span objects it creates don't always implement the full OTel Span
  interface. In test environments and certain edge cases, `trace.getActiveSpan()` returns
  an object that is truthy but lacks methods like `setAttributes`, `setAttribute`,
  `setStatus`, `addEvent`, and `recordException`. Calling these methods directly throws
  a TypeError.
resolution_type: defensive-coding
issue: PDD-85
severity: medium
confidence: verified
solution: |
  ## Defensive Wrapper Pattern

  Create wrapper functions that check method existence before calling:

  ```typescript
  function safeSetAttributes(span: Span | undefined, attributes: Attributes): void {
    if (!span || typeof span.setAttributes !== "function") return;
    try {
      span.setAttributes(attributes);
    } catch {
      // Silently ignore - telemetry should never break the app
    }
  }
  ```

  Apply the same pattern for all five span methods:
  - `safeSetAttributes(span, {...})`
  - `safeSetAttribute(span, key, value)`
  - `safeSetStatus(span, {code, message})`
  - `safeAddEvent(span, name, attributes)`
  - `safeRecordException(span, error)`

  Then replace every direct `span.method()` call in telemetry helpers with the
  corresponding safe wrapper. The wrappers accept `Span | undefined` so callers
  don't need their own null checks either.

  ## Key Rule

  **Never call span methods directly outside the wrapper definitions.** Grep for
  `span\.(setAttributes|setAttribute|setStatus|addEvent|recordException)\(` to
  verify — only the 5 wrapper internals should match.
prevention: |
  - Treat all OTel span objects as potentially incomplete in Cloudflare Workers
  - Add a CI grep check: any new `span.set` call outside telemetry.ts wrappers is a lint error
  - When adding new telemetry functions, always use the safe wrappers
  - The `otel-cf-workers` library is a thin community wrapper, not an official OTel SDK —
    expect rough edges
related:
  - docs/adr/otel-genai-semantic-conventions.md
  - https://github.com/open-telemetry/semantic-conventions/issues/1959
  - https://github.com/Effect-TS/effect/issues/5862
---

# otel-cf-workers: Incomplete Span Interface Causes TypeError

## Symptom

Integration tests and production logs show:

```
Stream API error: span.setAttributes is not a function
TypeError: span.setAttributes is not a function
```

The error appears intermittently — some telemetry functions work while others crash depending on which span methods they call.

## Investigation

1. `trace.getActiveSpan()` returns a truthy object (not `undefined`)
2. The object is a proxy/wrapper from `otel-cf-workers`, not a standard OTel `Span`
3. Some methods exist on the wrapper, others don't — it's not a complete implementation
4. The OTel `Span` TypeScript interface says the methods exist, but at runtime they don't
5. This only manifests when `@microlabs/otel-cf-workers` instruments the worker — unit tests with mocked OTel don't reproduce it

## Root Cause

`@microlabs/otel-cf-workers` creates span objects that pass TypeScript's structural typing but don't implement all runtime methods. The library focuses on trace propagation and export, not full span manipulation. When our telemetry helpers call `span.setAttributes()` on these incomplete objects, it throws.

## Fix

Created 5 defensive wrappers in `src/telemetry.ts` (lines 78-133) and replaced all ~80 direct span method calls throughout the file. See the `solution` field above for the pattern.

Commit: `6a0dc29` (PDD-85)

## Verification

- `npm run typecheck` passes
- All 233 tests pass (190 unit + 43 integration)
- No `span.setAttributes is not a function` errors in test stderr output
- `grep 'span\.(setAttributes|setAttribute|setStatus|addEvent|recordException)\('` only matches the 5 wrapper internals
