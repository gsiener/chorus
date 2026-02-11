---
title: NLP Initiative Matching Returns Wrong Data
module: initiative-nlp
tags: [nlp, initiatives, linear, r-and-d-priorities, routing]
symptoms:
  - "List initiatives" returns 45 tracked initiatives instead of 12 R&D Priorities
  - General questions about initiatives go through NLP tool path
  - API works correctly but Slack returns wrong data
root_cause: Keyword matching in mightBeInitiativeCommand was too broad
resolution_type: feature-disable → full-removal
created: 2025-02-04
superseded: 2026-02-11
issue: PDD-65
---

# NLP Initiative Matching Returns Wrong Data

> **SUPERSEDED**: The entire KV initiative store, NLP routing, and Linear sync system were removed in February 2026. All initiative queries now go through Claude with R&D Priorities from `linear-priorities.ts`. The deleted files include `initiative-nlp.ts`, `initiatives.ts`, `linear.ts`, and `kv.ts`. This doc is preserved as a historical lesson on NLP routing pitfalls.

## Problem

When users ask "@Chorus can you list all the initiatives?" in Slack, the bot returns 45 tracked initiatives instead of the 12 strategic R&D Priorities from Linear.

Screenshot showed: "All Initiatives (45 total)" with Proposed (10), Active (6), Paused (2), Completed (22), Cancelled (5).

## Investigation

### The Two Data Sources

1. **R&D Priorities** (12 items) - Strategic initiatives from Linear, fetched via `getRDPriorities()` and injected into Claude's system prompt
2. **Tracked Initiatives** (45 items) - Operational initiatives synced to KV storage, accessed via `listInitiatives()` *(now deleted)*

### The Code Flow

```
Slack @mention
  → handleMention()
    → mightBeInitiativeCommand(text)  // <-- The problem
      → if true: processNaturalLanguageCommand()
        → Claude with INITIATIVE_TOOLS
        → list_initiatives tool
        → listInitiatives() → returns ALL 45 tracked initiatives
      → if false: generateResponse()
        → Claude with R&D Priorities in context → returns 12 priorities
```

### Root Cause

The original `mightBeInitiativeCommand` (from commit eb24527, Dec 2025) was too broad:

```typescript
export function mightBeInitiativeCommand(text: string): boolean {
  const keywords = ["initiative", "project", "mark as", "set status", ...];
  return keywords.some(keyword => cleanText.includes(keyword));
}
```

Any text containing "initiative" would match, including general questions like "can you list all the initiatives?" This routed queries to the NLP tool path which returned tracked initiatives instead of R&D Priorities.

### Why Query Patterns Didn't Fix It

An earlier fix attempted to add query patterns to return false for general questions:

```typescript
const queryPatterns = [
  /^what are (our|the|all)?\s*initiatives/i,
  /^list (all|the)?\s*initiatives/i,
  // ...
];
if (queryPatterns.some(pattern => pattern.test(cleanText))) {
  return false;
}
```

This passed tests but didn't work in production. The exact reason is unclear, but possible causes include:
- Regex pattern edge cases with Slack message formatting
- Text cleaning differences between test and production
- Race conditions in the request handling

## Solution Timeline

**Phase 1 (PDD-65, Feb 2025):** Disabled the NLP initiative feature by making `mightBeInitiativeCommand` always return false.

**Phase 2 (Feb 2026):** Removed the entire KV initiative store system. All deleted:
- `src/initiative-nlp.ts` — NLP routing and tool dispatch
- `src/initiatives.ts` — Full CRUD for KV initiatives
- `src/linear.ts` — Linear project sync to KV
- `src/kv.ts` — KV key constants

Now all initiative queries go through Claude with R&D Priorities injected into the system prompt via `linear-priorities.ts`. No more dual data sources, no more routing decisions.

## Lesson Learned

When you have two data sources for the same concept (strategic priorities vs. operational initiatives), routing logic between them will inevitably confuse users. The fix wasn't better routing — it was eliminating the wrong data source entirely.
