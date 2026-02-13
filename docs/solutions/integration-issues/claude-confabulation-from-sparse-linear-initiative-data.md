---
title: Claude Confabulates Initiative Scope from Sparse Linear Metadata
date: 2026-02-11
category: integration-issues
module: linear-priorities
tags:
  - linear
  - r-and-d-priorities
  - claude
  - hallucination
  - confabulation
  - metadata
  - system-prompt
symptoms:
  - "Chorus claims initiatives have responsibilities they don't actually have"
  - "Initiative scope inferred from quarterly theme labels instead of real descriptions"
  - "Example: Fulcrum Productionisation described as including 'Timeline Analysis' (confabulated from theme 'From transactions to timelines')"
root_cause: "Sparse Linear initiative descriptions (only theme metadata, no real description) cause Claude to infer initiative scope from theme names, which are shared quarterly labels not initiative descriptions"
resolution_type: data-quality
---

# Claude Confabulates Initiative Scope from Sparse Linear Metadata

## Problem

When asked "what are our top initiatives this year?", Chorus responded with:

> **Timeline Analysis** (part of Fulcrum Productionisation, #5) — Purvi's driving this. Critical for "From transactions to timelines."

Fulcrum Productionisation has nothing to do with "Timeline Analysis." Claude fabricated this relationship — the confabulation is subtle because both entities sound plausible together.

## Investigation

Checked the Linear initiative data for Fulcrum. Its entire description was:

```
---
**R&D Priority Info**
- Theme: Q2 - From transactions to timelines
```

No actual description of what Fulcrum covers. No tech risk. No Slack channel. No project scope.

Meanwhile, Agent Observability also had the same theme (`Q2 - From transactions to timelines`) — confirming that themes are shared quarterly labels, not initiative-specific descriptions.

## Root Cause

Three compounding factors:

1. **Sparse initiative metadata.** Fulcrum's Linear description contained only a theme label, no real description of the initiative's scope or purpose.
2. **Theme labels look like descriptions.** "From transactions to timelines" reads like a description of what an initiative does, but it's actually a quarterly planning theme shared across multiple initiatives.
3. **Claude fills gaps with inference.** When the system prompt includes an initiative with no description but a thematic label, Claude interpolates meaning from available fields. It saw "timelines" and invented "Timeline Analysis."

The data flow where this happens:

```
Linear GraphQL API
  → fetchPriorityInitiatives()      # src/linear-priorities.ts
  → extractPriorityMetadata()       # parses description for Theme, Tech Risk, Slack
  → formatPrioritiesContext()       # builds markdown for system prompt
  → Claude system prompt            # Claude infers scope from whatever context exists
```

## Solution

### Immediate fix: enrich initiative metadata in Linear

The user updated Fulcrum's initiative:

1. **Renamed** to "Next Gen Canvas (Fulcrum) Productionisation" — name now indicates scope
2. **Updated theme** to "Q4 - AI that makes teams exceptional" — corrected quarterly alignment
3. **Added Slack channel** `#tmp-proj-fulcrum-architecture` — provides real context reference

With actual descriptive content, Claude no longer infers false relationships.

### Broader fix: ensure all initiatives have real descriptions

Every initiative in the R&D Priorities list needs:
- A real description explaining what the initiative covers (not just metadata fields)
- Tech risk rating (🌶)
- Slack channel for context
- Linked projects in Linear

## Prevention

### For initiative data quality

- **Every initiative must have a real description.** If the only content is theme metadata, Claude will confabulate from theme labels.
- **Descriptions answer "what is this initiative?" not "what quarter is it?"** Theme is for planning cadence, not scope documentation.
- **Include context references.** Slack channel, key owner, linked projects give Claude grounding facts.
- **Audit for sparse entries.** When adding new initiatives to R&D Priorities, verify they have meaningful descriptions before they appear in Chorus responses.

### For the codebase

- Consider adding a warning in `formatPrioritiesContext()` when an initiative has no description beyond metadata fields — this flags confabulation risk.
- Consider including linked project names in the system prompt context for additional grounding.

## Cross-References

- `docs/solutions/pdd-65-nlp-initiative-matching-too-broad.md` — Earlier lesson about dual data sources causing model confusion (now superseded — all initiative data comes from Linear)
- `docs/solutions/test-failures/eval-tests-system-prompt-enforcement.md` — System prompt engineering patterns, including prompt position and contradiction avoidance
- `docs/solutions/performance-issues/n-plus-one-kv-reads-and-api-rate-limits.md` — R&D Priorities caching strategy and `linear-priorities.ts` architecture
- `src/linear-priorities.ts` — Code that fetches, parses, and formats initiative data for Claude's system prompt
