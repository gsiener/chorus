---
title: Claude Confabulates Initiative Details from Sparse Linear Data
module: linear-priorities
tags: [llm, data-quality, linear, r-and-d-priorities, context-injection, confabulation]
symptoms:
  - "Chorus responds with initiative relationships that don't exist in Linear"
  - "Example: When asked about top initiatives, mentions 'Timeline Analysis (part of Fulcrum)' but Fulcrum is unrelated"
  - "Claude appears to infer structure from sparse metadata instead of actual descriptions"
root_cause: Initiative descriptions in Linear were extremely sparse (only theme metadata), forcing Claude to infer meaning from quarterly theme labels that are shared across multiple initiatives
resolution_type: data-validation
created: 2026-02-13
issue: PDD-XX
---

# Claude Confabulates Initiative Details from Sparse Linear Data

## Problem

When asked "What are our top initiatives this year?", Chorus (via Claude) responded:

> "Timeline Analysis (part of Fulcrum Productionisation, #5)"

However, Fulcrum and Timeline Analysis are unrelated initiatives. Fulcrum's description in Linear contained no actual content describing the initiative — only a quarterly theme label: `Theme: Q2 - From transactions to timelines`.

Claude interpreted "timelines" in the theme label and created a false association between Timeline Analysis and Fulcrum that never existed in the source data.

## Investigation

### The Data Source Chain

1. **Linear Initiatives** — Each R&D Priority initiative has a `description` field (nullable)
2. **Metadata Extraction** — `extractPriorityMetadata()` parses description for structured fields (Theme, Tech Risk, Slack channel)
3. **Context Formatting** — `formatPrioritiesContext()` builds Markdown for Claude's system prompt
4. **Claude Inference** — Claude includes this context when answering questions about priorities

### Why Confabulation Occurred

Fulcrum's initiative in Linear had:
- **Initiative Name**: "Fulcrum Productionisation"
- **Description**: Only contained `Theme: Q2 - From transactions to timelines`
- **Missing**: Actual description of work scope, tech risk, Slack channel, or any details about what "Fulcrum" covers

The `Theme` field is a **quarterly label** applied to many initiatives (e.g., "Agent Observability" has the same Q2 theme). It's metadata for planning cadence, not a description of initiative scope.

Claude, seeing:
1. Initiative name: "Fulcrum Productionisation"
2. Theme metadata: "From transactions to timelines"
3. No other context

...inferred that Fulcrum must be about "timeline analysis" because the theme contains "timelines". This is a reasonable inference for Claude given the sparse context, but it invented a relationship that doesn't exist.

### Code Flow

```
Linear GraphQL Query (via fetchPriorityInitiatives)
  ↓
LinearInitiative object with sparse description
  ↓
extractPriorityMetadata(initiative)
  → Parses: Theme: Q2 - From transactions to timelines
  → Returns: { theme: "Q2 - From transactions to timelines", ... }
  ↓
formatPrioritiesContext()
  → Includes theme in Markdown: "- **Theme**: Q2 - From transactions to timelines"
  ↓
Claude System Prompt
  → Claude reads theme, has no other context about Fulcrum
  → Claude infers meaning from theme label
  → Claude confabulates the relationship when answering questions
```

### Why This Is Hard to Detect

The confabulation was subtle:
- Not a complete hallucination (Fulcrum and Timeline Analysis are both real)
- Not obviously wrong in isolation (themes do indicate quarterly direction)
- Only revealed when someone familiar with Linear structure noticed the relationship doesn't exist
- Would fail external validation ("Who owns Fulcrum?") but pass internal coherence checks

## Solution

**Fix the source data, not the inference engine.**

User updated the Linear initiative:

1. **Renamed initiative** from "Fulcrum Productionisation" to "**Next Gen Canvas (Fulcrum) Productionisation**" — now the name clearly indicates scope
2. **Changed theme** from "Q2 - From transactions to timelines" to "Q4" — removed misleading metadata
3. **Added Slack channel** to description: `#tmp-proj-fulcrum-architecture` — provides real context

Result: When Claude reads the updated context, it has actual initiative scope (name clearly includes "Canvas"), the theme is generic (Q4), and a Slack channel provides a real reference point.

### What Changed in Linear

**Before:**
```
Name: Fulcrum Productionisation
Description: Theme: Q2 - From transactions to timelines
```

**After:**
```
Name: Next Gen Canvas (Fulcrum) Productionisation
Description: Theme: Q4
           - Slack: #tmp-proj-fulcrum-architecture
```

The cache was warmed with the updated data, and confabulation stopped.

## Lesson Learned

### Theme Fields Are Not Initiative Descriptions

- **Theme**: Quarterly planning label, shared across initiatives (e.g., Q2 theme might apply to 5+ initiatives)
- **Description**: Actual scope and context of the initiative (what the initiative covers, why, who's involved)

When initiatives have only theme metadata and no description, Claude must infer meaning from the theme. This works fine for some inferences but fails when:
- Theme contains words that evoke unrelated concepts (e.g., "timelines" → assumes timeline analysis)
- Initiative name is vague (e.g., "Fulcrum Productionisation" — what is Fulcrum?)
- Multiple initiatives could match the same theme keywords

### Prevention Rules

1. **Every initiative must have a real description** — not just theme metadata
2. **Description should answer**: What is this initiative about? What's the scope? (not "what quarter is it?")
3. **Include contact/context**: Slack channel, key owner, or related projects
4. **Use theme for planning cadence only**, not as initiative documentation

### Code Context

The confabulation risk exists in these functions:

- **`extractPriorityMetadata()`** (`src/linear-priorities.ts:58-79`) — Parses description for structured fields
  - Only uses `Theme`, `Tech Risk`, `Slack` if present in description
  - If description is sparse, fewer fields are extracted

- **`formatPrioritiesContext()`** (`src/linear-priorities.ts:166-225`) — Builds Markdown context for Claude
  - Includes theme, tech risk, Slack, owner, status
  - If only theme is available, Claude has minimal context
  - Lines 201-209 show what gets included in system prompt

### Future Validation

Consider adding a validation step when fetching initiatives from Linear:

```typescript
// Pseudocode: validate initiative data quality
if (!init.description || init.description.length < 50) {
  console.warn(`Initiative ${init.name} has sparse description, confabulation risk`);
  // Options: skip from context, mark as incomplete, or fetch expanded notes
}
```

Or at initiative creation time in Linear:
- Enforce minimum description length
- Require Slack channel reference
- Provide description template: "What is this initiative? What's in/out of scope?"

## Timeline

- **Reported**: User noticed Chorus claiming "Timeline Analysis (part of Fulcrum)"
- **Diagnosed**: Sparse Linear data + theme-only metadata → Claude inference
- **Fixed**: User updated Linear initiative with real name, scope indicators, and Slack channel
- **Resolved**: Chorus no longer confabulates (cache warmed with new data)

## Related Issues

- **PDD-65**: Earlier issue where NLP routing mishandled initiatives entirely (eliminated in Feb 2026)
  - Different problem (wrong data source) but same domain (initiatives)
  - This issue is about data quality within the correct source
