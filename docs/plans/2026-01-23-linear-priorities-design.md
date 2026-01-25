# Linear Priorities Integration Design

## Overview

Migrate R&D Priorities from a spreadsheet to Linear, enabling Chorus to answer priority questions with live data from where work actually happens.

## Goals

1. **Discoverability** - Chorus can answer "What's the status of X?", "What are our top priorities?", "Who owns Y?"
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
│  │  - Initiative A  │     │  - Project A1                    │  │
│  │  - Initiative B  │     │  - Project A2                    │  │
│  │  - Initiative C  │     │  - Project B1                    │  │
│  │  - ...           │     │  - ...                           │  │
│  └──────────────────┘     └──────────────────────────────────┘  │
│           │                            │                         │
│           │                            ▼                         │
│           │               ┌──────────────────────────────────┐  │
│           │               │   Parent Initiative (Roadmap)    │  │
│           │               │   (Visual delivery tracking)     │  │
│           │               └──────────────────────────────────┘  │
└───────────┼──────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Chorus                                   │
│                                                                  │
│  Queries Initiatives API for:                                   │
│  - Priority lookups ("What's the status of X?")                 │
│  - List queries ("What's shipping Q4?")                         │
│  - Owner lookups ("Who owns Y?")                                │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Data Model

### Initiative Fields

| Field | Usage |
|-------|-------|
| `name` | Initiative title |
| `description` | Theme + tech risk + Slack channel |
| `owner` | "Who can I talk to about this?" |
| `targetDate` | Target quarter end date |
| `status` | Planned, Active, Completed |
| `projects` | Linked Linear projects for progress rollup |

### Description Template

```markdown
---
**R&D Priority Info**
- Tech Risk: 🌶🌶🌶
- Theme: Q1 - Theme Name
- Slack: #proj-channel
```

## Implementation

### Linear Structure

- **Parent Initiative** acts as the roadmap container
- Child initiatives linked via `initiativeRelations` with `sortOrder` for ranking
- Each child initiative can have multiple projects linked
- Linear deprecated Roadmaps in favor of Initiatives, so we use initiative relations

### Chorus Integration

1. `src/linear-priorities.ts` - Fetches priorities via Linear GraphQL API
2. Filters by parent initiative ID (`RD_PRIORITIES_INITIATIVE_ID`)
3. Sorts by `sortOrder` to maintain ranking
4. Formats as context for Claude's system prompt
5. Caches for 5 minutes to reduce API calls

### API Endpoints

- `GET /api/debug/priorities` - Returns raw Linear priorities data
- `POST /api/ask` - Ask Chorus a question directly via API

### Key Linear Mutations

```graphql
# Update initiative details
initiativeUpdate(id: ID, input: { name, description, ownerId, status })

# Change ranking
initiativeRelationUpdate(id: ID, input: { sortOrder })

# Add/remove from roadmap
initiativeRelationCreate(input: { initiativeId, relatedInitiativeId, sortOrder })
initiativeRelationDelete(id: ID)

# Link/unlink projects
initiativeToProjectCreate(input: { initiativeId, projectId })
initiativeToProjectDelete(id: ID)
```

## Chorus Query Examples

After implementation, Chorus handles:

```
"What's priority #1?"
→ [Returns top ranked initiative with details]

"What's the status of X?"
→ [Returns initiative status, owner, and progress]

"What's shipping in Q1?"
→ [Lists initiatives with Q1 target dates]

"Who owns Y?"
→ [Returns initiative owner]

"What are the top 5 priorities?"
→ [Ordered list of top 5 initiatives by stack rank]
```

## Success Criteria

- [x] Initiatives updated with theme, tech risk, and Slack channel
- [x] Parent initiative created with relations to all priorities
- [x] Chorus can answer basic priority queries
- [x] Debug API endpoints created
- [x] Projects linked to initiatives where applicable
