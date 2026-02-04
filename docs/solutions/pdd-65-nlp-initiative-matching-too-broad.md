---
title: NLP Initiative Matching Returns Wrong Data
module: initiative-nlp
tags: [nlp, initiatives, linear, r-and-d-priorities, routing]
symptoms:
  - "List initiatives" returns 45 tracked initiatives instead of 12 R&D Priorities
  - General questions about initiatives go through NLP tool path
  - API works correctly but Slack returns wrong data
root_cause: Keyword matching in mightBeInitiativeCommand was too broad
resolution_type: feature-disable
created: 2025-02-04
issue: PDD-65
---

# NLP Initiative Matching Returns Wrong Data

## Problem

When users ask "@Chorus can you list all the initiatives?" in Slack, the bot returns 45 tracked initiatives instead of the 12 strategic R&D Priorities from Linear.

Screenshot showed: "All Initiatives (45 total)" with Proposed (10), Active (6), Paused (2), Completed (22), Cancelled (5).

## Investigation

### The Two Data Sources

1. **R&D Priorities** (12 items) - Strategic initiatives from Linear, fetched via `getRDPriorities()` and injected into Claude's system prompt
2. **Tracked Initiatives** (45 items) - Operational initiatives synced to KV storage, accessed via `listInitiatives()`

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

## Solution

Disabled the NLP initiative feature entirely by making `mightBeInitiativeCommand` always return false:

```typescript
/**
 * PDD-65 FIX: Temporarily disable NLP initiative commands entirely.
 * All initiative queries now go to Claude, which uses R&D Priorities.
 */
export function mightBeInitiativeCommand(_text: string): boolean {
  // DISABLED: Always return false to route all queries to Claude
  return false;
}
```

### Trade-offs

**Lost functionality:**
- Natural language commands like "mark Mobile App as active" no longer work
- Users must use structured commands: `@Chorus initiatives status mobile-app active`

**Gained reliability:**
- All initiative queries now correctly go to Claude
- Claude uses R&D Priorities (12 strategic items) instead of tracked initiatives (45)
- Consistent behavior between API and Slack

## Prevention

1. **Test with production-like data** - The tests used mock data that didn't reveal the keyword matching issue
2. **Log the routing decision** - Add observability to see which path was taken
3. **Separate query vs command intent** - The NLP feature conflated read queries with write commands

## Files Changed

- `src/initiative-nlp.ts` - Disabled `mightBeInitiativeCommand`
- `src/__tests__/initiative-nlp.test.ts` - Updated tests to expect false
- `src/__tests__/parseCommands.test.ts` - Updated tests to expect false

## Future Work

The TODO in the code notes this is a temporary fix. To re-enable NLP:

1. Separate read queries (list, show) from write commands (update, create)
2. Only enable NLP for write commands that require tool calling
3. Add comprehensive regex tests with real Slack message samples
4. Add logging to trace routing decisions in production
