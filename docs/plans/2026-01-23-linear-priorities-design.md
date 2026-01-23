# Linear Priorities Integration Design

## Overview

Migrate the R&D Priorities Google Sheet to Linear, enabling Chorus to answer priority questions with live data from where work actually happens.

## Goals

1. **Discoverability** - Chorus can answer "What's the status of X?", "What are our top priorities?", "Who owns RBAC?"
2. **Freshness** - Priority status stays current because it's sourced from Linear (not a stale spreadsheet)
3. **No duplication** - Leverage existing Linear initiatives rather than creating parallel structures

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Linear                                   │
│  ┌──────────────────┐     ┌──────────────────────────────────┐  │
│  │   Initiatives    │────▶│           Projects               │  │
│  │  (Strategic)     │     │         (Execution)              │  │
│  │                  │     │                                  │  │
│  │  - Metrics GA    │     │  - Metrics 2.0 GA Features       │  │
│  │  - Canvas Q4     │     │  - Canvas Slackbot               │  │
│  │  - RBAC          │     │  - Read-Only Role                │  │
│  │  - ...           │     │  - ...                           │  │
│  └──────────────────┘     └──────────────────────────────────┘  │
│           │                            │                         │
│           │                            ▼                         │
│           │               ┌──────────────────────────────────┐  │
│           │               │   Roadmap: R&D Priorities 2026   │  │
│           │               │   (Visual delivery tracking)     │  │
│           │               └──────────────────────────────────┘  │
└───────────┼──────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Chorus                                   │
│                                                                  │
│  Queries Initiatives API for:                                   │
│  - Priority lookups ("What's the status of RBAC?")              │
│  - List queries ("What's shipping Q4?")                         │
│  - Owner lookups ("Who owns Canvas?")                           │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Data Model

### Initiative Naming Convention

```
[#N] Title [risk]
```

Examples:
- `[#1] Metrics GA [🌶🌶🌶]`
- `[#2] Canvas Q4 Launch [🌶🌶🌶🌶]`
- `[#3] Mature RBAC Offering [🌶🌶🌶🌶]`

### Initiative Fields

| Field | Usage |
|-------|-------|
| `name` | `[#N] Title [risk]` |
| `description` | Theme + detailed description + links |
| `owner` | "Who can I talk to about this?" |
| `targetDate` | Target quarter end date |
| `status` | Planned, Active, Completed |
| `projects` | Linked Linear projects for progress rollup |

### Description Template

```markdown
**Theme:** Works Where You Work

**Next Milestone:** Support for ReInvent Demo and marketing

**Links:**
- Slack: #proj-metrics
- Docs: https://honeycomb.quip.com/...
```

## Priority → Initiative Mapping

All priorities map to existing initiatives (no new initiatives needed):

| Stack Rank | Priority | Initiative | Owner |
|------------|----------|------------|-------|
| 1.1 | Metrics: Storage Engine | Metrics GA | Toni Chou |
| 1.2 | Metrics: UI | Metrics GA | Toni Chou |
| 2 | Data Visualizations | Explore - Q1'26 | TBD |
| 3 | Boards Revamp | Explore - Q1'26 | TBD |
| 4 | HTP – Enhance with Indexing | Cross-team: Enhance Indexing | Amy C. |
| 7 | HTP – RaaS-Ready Pipeline Builder | OKR 1: Pipeline Builder | Jessica P. |
| 8 | HTP – Bindplane | Pipeline Q1 2026 | TBD |
| 9 | Honeycomb Canvas | Canvas Q4 Launch | Morgante Pell |
| 10 | MCP | [mcp] q1 support | Austin Parker |
| 11 | Single Tenant/Self-Hosted | Self-Hosted Honeycomb | Reid Savage |
| 13 | RBAC | Mature RBAC Offering | Brooke Sargent |
| 17 | Anomaly Detection | Unified alerting platform | Maggie La Belle |
| 18 | Migration Tools for APM | App Enablement Full Stack | Grady Salzman |
| 19 | Exec SLO Reporting | Unified alerting platform | Maggie La Belle |
| 20 | SCIM | Mature RBAC Offering | Brooke Sargent |
| 22 | Timeline Analysis | App Enablement Full Stack | Grady Salzman |
| - | Metrics Triggers | Metrics GA | Toni Chou |
| - | Honeycomb for Onboarding | Onboarding | Mei Luo |
| - | Expand Logging Workflows | Explore - Q1'26 | TBD |
| - | Resource-Efficient Refinery | OKR 2: Strengthen OTel and Refinery | Amy C. |
| - | HTP – Pipeline Builder GA | OKR 1: Pipeline Builder | Jessica P. |
| - | OTel Python DX | OKR 2: Strengthen OTel and Refinery | Amy C. |
| - | E&S Migration Tooling | App Enablement Full Stack | Grady Salzman |
| - | More Refinery perf (3.1) | OKR 2: Strengthen OTel and Refinery | Amy C. |

### Deprioritized (Not Migrating)

- HFO Mobile Error Symbolication
- HFO Error Support
- ReactNative SDK
- Tags
- Spaces
- AI-assisted Instrumentation
- Public APIs

## Implementation Plan

### Phase 1: Enhance Existing Initiatives

For each of the 12 initiatives in the mapping:

1. Update `name` to include stack rank and tech risk: `[#N] Title [🌶...]`
2. Update `description` with theme, next milestone, and links
3. Verify `owner` matches the sheet's "Who can I talk to"
4. Set `targetDate` to match target quarter
5. Verify projects are linked

### Phase 2: Create Roadmap

1. Create roadmap: "R&D Priorities 2026"
2. Add all priority-related projects with `sortOrder` matching stack rank
3. Set roadmap owner (Graham Siener / PDD Leadership)

### Phase 3: Wire Up Chorus

1. Add Linear Initiatives query capability to Chorus
2. Implement query patterns:
   - `getInitiativeByName(name)` - fuzzy match on initiative name
   - `getTopInitiatives(n)` - return top N by sortOrder
   - `getInitiativesByTargetDate(quarter)` - filter by target quarter
   - `getInitiativeOwner(name)` - return owner for an initiative

### Phase 4: Deprecate Google Sheet

1. Add note to sheet pointing to Linear as source of truth
2. Archive sheet after 30 days of successful Linear usage

## Chorus Query Examples

After implementation, Chorus should handle:

```
"What's priority #1?"
→ Metrics GA - Storage engine revamp and UI features for metrics analysis

"What's the status of Canvas?"
→ Canvas Q4 Launch is Active, owned by Morgante Pell, targeting Q4 2025

"What's shipping in Q1 2026?"
→ [Lists initiatives with Q1 2026 target dates]

"Who owns RBAC?"
→ Brooke Sargent owns Mature RBAC Offering

"What are the top 5 priorities?"
→ [Ordered list of top 5 initiatives by stack rank]
```

## Open Questions

1. Should stack rank be in initiative name or stored elsewhere?
2. How to handle priorities that span multiple initiatives (e.g., Metrics 1.1 and 1.2)?
3. Cadence for updating stack ranks when priorities change?

## Success Criteria

- [ ] All 12 initiatives updated with naming convention and metadata
- [ ] Roadmap created with all priority projects
- [ ] Chorus can answer basic priority queries
- [ ] Google Sheet marked as deprecated
