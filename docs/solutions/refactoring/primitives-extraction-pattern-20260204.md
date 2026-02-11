---
module: System Architecture
date: 2026-02-04
problem_type: code_duplication
component: typescript_architecture
symptoms:
  - "Duplicate pagination logic across docs.ts and initiatives.ts"
  - "6 nearly identical update functions in initiatives.ts"
  - "Repeated KV index + prefixed item storage pattern"
  - "Manual date formatting duplicated in multiple places"
root_cause: missing_abstraction
severity: medium
tags: [refactoring, dry, primitives, typescript, architecture]
resolution_type: extraction
linear_issue: PDD-64
---

# Primitives Extraction Pattern

## Problem

Both `docs.ts` and the now-removed `initiatives.ts` had evolved with nearly identical patterns:
- Manual pagination logic (normalize page, calculate totals, slice items)
- KV storage pattern: index in one key, items with prefixed keys
- Error handling with discriminated unions (`_tag` pattern)
- 6 update functions in `initiatives.ts` that were 80% identical boilerplate

> **Note (Feb 2026):** `initiatives.ts` was deleted when the KV initiative store was removed. The primitives in `src/primitives/` remain useful — `docs.ts` still uses `formatters.ts` and `validators.ts`. The `indexed-store.ts` abstraction is available but currently only used by `docs.ts`.

**Impact:** Code duplication made maintenance difficult and created inconsistency risks. A pagination bug fixed in one file might not be fixed in the other.

## Investigation

Analyzed both files and identified 3 extractable patterns:

1. **Validation & Error Handling** - Type-safe error classes with discriminator tags
2. **Indexed KV Store Pattern** - Generic abstraction for index + prefixed items
3. **Formatting Utilities** - Pagination, dates, text snippets

## Solution

Created `src/primitives/` with three modules:

### 1. validators.ts - Error Classes & Validation

```typescript
// Error classes with _tag for exhaustive type checking
export class EmptyValueError extends Error {
  readonly _tag = "EmptyValueError" as const;
  constructor(public readonly fieldName: string) {
    super(`${fieldName} cannot be empty`);
  }
}

// Type-safe result type
export type ValidationResult<T, E extends Error = Error> =
  | { success: true; value: T }
  | { success: false; error: E };

// Result helpers
export function ok<T>(value: T): ValidationResult<T, never> {
  return { success: true, value };
}

export function err<E extends Error>(error: E): ValidationResult<never, E> {
  return { success: false, error };
}

// Validation functions
export function validateNotEmpty(
  value: string,
  fieldName: string
): ValidationResult<string, EmptyValueError>

export function validateMaxLength(
  value: string,
  maxLength: number,
  fieldName: string
): ValidationResult<string, ValueTooLongError>
```

### 2. indexed-store.ts - Generic KV Pattern

```typescript
export interface IndexedStoreConfig<TIndex, TItem, TMeta> {
  indexKey: string;
  itemPrefix: string;
  itemIdToKey: (id: string) => string;
  getItemId: (item: TItem) => string;
  getMetaId: (meta: TMeta) => string;
  toMetadata: (item: TItem) => TMeta;
  emptyIndex: () => TIndex;
  getItems: (index: TIndex) => TMeta[];
  setItems: (index: TIndex, items: TMeta[]) => TIndex;
}

export function createIndexedStore<TIndex, TItem, TMeta>(
  config: IndexedStoreConfig<TIndex, TItem, TMeta>
): IndexedStore<TIndex, TItem, TMeta> {
  // Returns: getIndex, saveIndex, getItem, saveItem, deleteItem,
  //          findInIndex, upsertIndexEntry, removeFromIndex, getCount
}
```

### 3. formatters.ts - Display Utilities

```typescript
export function calculatePagination<T>(
  items: T[],
  page: number = 1,
  pageSize: number = 10,
  maxPageSize: number = 50
): { paginatedItems: T[]; pagination: PaginationInfo }

export function formatPaginationHeader(
  pagination: PaginationInfo,
  itemLabel: string = "items"
): string

export function formatMorePagesHint(
  pagination: PaginationInfo,
  command: string
): string | null

export function formatDate(isoString: string): string

export function extractSnippet(
  text: string,
  matchIndex: number,
  matchLength: number,
  contextBefore?: number,
  contextAfter?: number
): string
```

## Key Refactoring: The Updater Callback Pattern

The biggest win was consolidating 6 update functions into one helper:

**Before** (repeated 6 times with slight variations):
```typescript
export async function updateInitiativeStatus(
  env: Env, idOrName: string, newStatus: InitiativeStatusValue, updatedBy: string
): Promise<{ success: boolean; message: string }> {
  const initiative = await getInitiative(env, idOrName);
  if (!initiative) {
    return { success: false, message: `Initiative "${idOrName}" not found.` };
  }

  const now = new Date().toISOString();
  initiative.status = { value: newStatus, updatedAt: now, updatedBy };
  initiative.updatedAt = now;

  await env.DOCS_KV.put(idToKey(initiative.id), JSON.stringify(initiative));

  const index = await getIndex(env);
  const metaIndex = index.initiatives.findIndex((i) => i.id === initiative.id);
  if (metaIndex >= 0) {
    index.initiatives[metaIndex] = toMetadata(initiative);
    await saveIndex(env, index);
  }

  return { success: true, message: `Updated status to *${newStatus}*.` };
}
```

**After** - Generic helper with updater callback:
```typescript
async function updateInitiativeField(
  env: Env,
  idOrName: string,
  updater: (initiative: Initiative, now: string) => void,
  updateIndex: boolean = false
): Promise<{ success: boolean; message: string; initiative?: Initiative }> {
  const initiative = await getInitiative(env, idOrName);
  if (!initiative) {
    return { success: false, message: `Initiative "${idOrName}" not found.` };
  }

  const now = new Date().toISOString();
  updater(initiative, now);  // Caller defines what to update
  initiative.updatedAt = now;

  await env.DOCS_KV.put(idToKey(initiative.id), JSON.stringify(initiative));

  if (updateIndex) {
    const index = await getIndex(env);
    const metaIndex = index.initiatives.findIndex((i) => i.id === initiative.id);
    if (metaIndex >= 0) {
      index.initiatives[metaIndex] = toMetadata(initiative);
      await saveIndex(env, index);
    }
  }

  return { success: true, message: "", initiative };
}

// Each function now just calls the helper
export async function updateInitiativeStatus(...) {
  const result = await updateInitiativeField(
    env,
    idOrName,
    (initiative, now) => {
      initiative.status = { value: newStatus, updatedAt: now, updatedBy };
    },
    true  // updateIndex - status appears in metadata
  );
  if (!result.success) return result;
  return { success: true, message: `Updated status to *${newStatus}*.` };
}
```

## Results

| Metric | Before | After |
|--------|--------|-------|
| docs.ts pagination logic | 38 lines | 20 lines |
| initiatives.ts update functions | ~100 lines each × 6 | ~15 lines each × 6 |
| Shared primitives | 0 | 519 lines (reusable) |
| Net line change | - | -26 lines |

## Prevention

**When to extract primitives:**
1. Same pattern appears in 2+ files
2. Logic is domain-agnostic (pagination, validation, storage)
3. Variations are minimal (just different field names or callbacks)

**Extraction checklist:**
- [ ] Create new module in `src/primitives/`
- [ ] Export from `src/primitives/index.ts`
- [ ] Update callers to use new primitive
- [ ] Run `pnpm run typecheck`
- [ ] Run `pnpm test` - all 255 tests pass
- [ ] Update linter suppressions if needed

## Related Documentation

- [Refactoring Review Pitfalls](../best-practices/refactoring-review-pitfalls-System-20260201.md) - Code review checklist for refactoring
- [Verifying Features Before Marking Done](../integration-issues/verifying-features-before-marking-done.md) - Testing requirements

## Files Changed

- `src/primitives/validators.ts` - NEW: Error classes and validation
- `src/primitives/indexed-store.ts` - NEW: Generic KV store pattern
- `src/primitives/formatters.ts` - NEW: Display utilities
- `src/primitives/index.ts` - NEW: Public exports
- `src/docs.ts` - Refactored to use formatters
- `src/initiatives.ts` - Consolidated update functions + uses formatters *(deleted Feb 2026)*
