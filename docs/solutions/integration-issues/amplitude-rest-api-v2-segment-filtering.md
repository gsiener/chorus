---
title: "Amplitude REST API V2: Segment Filtering with group_by Issues"
date: 2026-02-07
category: integration-issues
module: amplitude
tags:
  - amplitude-api
  - rest-api-v2
  - segment-filtering
  - data-format
  - product-analytics
symptoms:
  - "Enterprise segment filter silently ignored when used with group_by parameter"
  - "Non-enterprise accounts appear in filtered results despite filter conditions"
  - "DAU/MAU metric returns fractions (0.0-1.0) instead of percentages"
  - "Retention API returns nested series[0].values structure instead of flat retentionPercents"
  - "Grouped segmentation results have double-wrapped seriesCollapsed arrays"
  - "Default group limit is 999, requiring explicit limit parameter for larger result sets"
root_cause: |
  Multiple quirks in Amplitude REST API V2:

  1. **Segment filter bug with group_by**: When a `group_by` parameter is present in the event
     definition AND a segment filter `s` is applied via the query parameters, the segment
     filter is silently ignored by the API. This appears to be a known limitation where
     segment-level filtering doesn't work properly when results are grouped by event properties.

  2. **Data format inconsistencies**: The API returns data in different formats depending on
     the metric type and parameters used:
     - `pct_dau` metric returns decimal fractions (0.5 = 50%) not percentages
     - Retention API returns series[0].values as `{ date: [{count, outof, incomplete}, ...] }`
     - When using group_by, seriesCollapsed entries are wrapped twice: `[[{value: N}]]`
       instead of `[{value: N}]`
     - Default group limit of 999 is insufficient for some datasets
resolution_type: code-fix
severity: medium
confidence: verified
solution: |
  ## For Segment Filtering with group_by

  **Problem**: Using the `s` (segment) parameter with group_by silently filters nothing.

  **Fix**: Move the filter from segment level to event-level `filters` inside the event definition:

  **Before (doesn't work)**:
  ```typescript
  {
    e: {
      event_type: "_active",
      group_by: [{ type: "event", value: "team_slug" }]
    },
    s: [{ prop: "gp:team_plan", op: "is", values: ["Enterprise"] }]  // Ignored!
  }
  ```

  **After (works correctly)**:
  ```typescript
  {
    e: {
      event_type: "_active",
      group_by: [{ type: "event", value: "team_slug" }],
      filters: [{
        group_type: "User",
        subprop_type: "user",
        subprop_key: "gp:team_plan",
        subprop_op: "is",
        subprop_value: ["Enterprise"]
      }]
    }
  }
  ```

  ## For Data Format Issues

  ### 1. DAU/MAU Percentage Conversion
  `pct_dau` metric returns fractions (0.0-1.0), not percentages:
  ```typescript
  // API returns 0.456, which means 45.6%
  const percentageValue = Math.round(fraction * 1000) / 10;  // 45.6
  ```

  ### 2. Retention API Response Format
  Retention API returns nested structure with date-keyed objects:
  ```typescript
  // API structure:
  result.data.series[0].values = {
    "20260101": [
      { count: 100, outof: 100, incomplete: false },  // Day 0
      { count: 45, outof: 100, incomplete: false }     // Day 7 (week 1)
    ],
    "20260108": [...]
  }

  // Extract week-1 retention:
  const week1 = entries[1];  // Index 1 is day 7 in 7-day interval
  const retention = Math.round((week1.count / week1.outof) * 1000) / 10;  // As percentage
  ```

  ### 3. Grouped Results Double-Wrap
  When using `group_by`, seriesCollapsed entries are wrapped in an extra array:
  ```typescript
  // seriesLabels: [[0, "team-a"], [0, "team-b"], ...]
  // seriesCollapsed: [[{value: 100}], [{value: 200}], ...]  // Double-wrapped!

  // Handle both wrapped and unwrapped:
  const entry = collapsed[i];
  const value = Array.isArray(entry) ? entry[0]?.value ?? 0 : entry?.value ?? 0;
  ```

  ### 4. Group By Default Limit
  Always set explicit `limit` parameter (default 999 may be insufficient):
  ```typescript
  {
    e: { ... },
    limit: 5000  // Explicitly set for safety
  }
  ```

## Prevention Rules

1. **Always use event-level `filters` with `group_type` when combining filters and `group_by`** — the `s` segment parameter is silently ignored in this context
2. **Test API responses against known data** — Amplitude silently ignores malformed filters without returning errors; always cross-check results with the Amplitude UI or MCP
3. **Handle both wrapped and unwrapped array formats** in `seriesCollapsed` — defensive parsing prevents silent data loss
4. **Set explicit `limit` for grouped queries** — the default 999 truncates results without warning
5. **Check Amplitude MCP `query_dataset` docs for correct filter format** — the dataset API uses `segments.conditions` format which differs from REST API V2's `s` parameter

## Cross-References

- [Verifying Features Before Marking Done](./verifying-features-before-marking-done.md) — testing patterns used to validate API responses
- [Refactoring Review Pitfalls](../best-practices/refactoring-review-pitfalls-System-20260201.md) — behavioral contract changes apply to API response parsing
- Linear: [PDD-77](https://linear.app/honeycombio/issue/PDD-77) (EPIC), [PDD-78](https://linear.app/honeycombio/issue/PDD-78) (weekly report), [PDD-79](https://linear.app/honeycombio/issue/PDD-79) (KPI context)

## Implementation Location
- **File**: `src/amplitude.ts`
- **Key functions**:
  - `fetchGrowingAccounts()` - Uses event-level filters instead of segment parameter
  - `parseGroupedResults()` - Handles double-wrapped seriesCollapsed arrays
  - `fetchDAUMAU()` - Converts fraction to percentage
  - `fetchWeek1Retention()` - Parses nested retention response structure

## Verification
- All metrics fetch correctly with Enterprise filter applied
- Grouped results properly exclude non-enterprise accounts
- Data matches expected percentages and formats
- Tests in `src/__tests__/amplitude.test.ts` validate response parsing
