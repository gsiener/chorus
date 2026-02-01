---
module: System
date: 2026-02-01
problem_type: best_practice
component: tooling
symptoms:
  - "TypeScript compilation error: Declaration or statement expected in linear.ts"
  - "KV prefix changed from initiatives:detail: to initiatives:id: breaking backward compatibility"
  - "Error handling changed from returning null/false to throwing, breaking caller expectations"
  - "Two tests failing in slack.test.ts for postDirectMessage"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [code-review, refactoring, backward-compatibility, error-handling, typescript]
---

# Troubleshooting: Code Refactoring Review - Common Pitfalls

## Problem
An engineer's refactoring branch introduced three categories of issues: a breaking data compatibility change, orphaned duplicate code causing compilation errors, and behavioral changes that broke existing callers.

## Environment
- Module: System-wide (kv.ts, linear.ts, slack.ts, checkins.ts, initiatives.ts, utils.ts)
- Branch: refactor/codebase-improvements
- Date: 2026-02-01

## Symptoms
- TypeScript compilation failed with "Declaration or statement expected" errors in linear.ts (lines 258, 268)
- KV storage prefix silently changed from `initiatives:detail:` to `initiatives:id:` - would make existing data inaccessible
- Slack API functions changed from returning `null`/`false` on error to throwing exceptions
- Two tests failing: `postDirectMessage > returns error when DM channel cannot be opened` and `postDirectMessage > returns error when message post fails`

## What Didn't Work

**Direct merge of the branch:**
- **Why it failed:** Branch had compilation errors and breaking changes that would have caused data loss and runtime failures

## Solution

**Issue 1: KV Prefix Breaking Change**

```typescript
// Before (broken - changes storage key prefix):
export const INITIATIVES_KV = {
  index: "initiatives:index",
  prefix: "initiatives:id:",  // WRONG - changes from original
};

// After (fixed - maintains backward compatibility):
export const INITIATIVES_KV = {
  index: "initiatives:index",
  prefix: "initiatives:detail:",  // Matches original prefix
};
```

**Issue 2: Orphaned Duplicate Code**

The refactoring left duplicate return/catch blocks at the end of `syncLinearProjects()`:

```typescript
// Before (broken - lines 249-268 were orphaned duplicates):
  }
}

    return {  // Orphaned - function already closed
      success: true,
      ...
    };
  } catch (error) {  // Orphaned catch
    ...
  }
}

// After (fixed - removed duplicate code):
  }
}

/**
 * Get the Linear project URL...
```

**Issue 3: Error Handling Behavior Change**

```typescript
// Before (refactored - throws instead of returning):
} catch (error) {
  console.error(`Failed to fetch thread messages...`, error);
  throw error; // Re-throw the error for the caller to handle
}

// After (fixed - maintains original return behavior):
} catch (error) {
  console.error(`Failed to fetch thread messages...`, error);
  return [];  // Original behavior - callers expect this
}
```

Also restored the `postDirectMessage` error handling:

```typescript
// Before (refactored - removed null check):
const ts = await postMessage(openData.channel.id, text, undefined, env);
return { ts };

// After (fixed - restored null check):
const ts = await postMessage(openData.channel.id, text, undefined, env);
if (!ts) {
  console.error(`postMessage failed for user ${userId}`);
  return { ts: null, error: "message_post_failed" };
}
return { ts };
```

**Good changes kept:**
- `GEMINI.md` symlink for multi-AI-tool support
- `src/kv.ts` for centralized KV key constants
- `src/utils.ts` with extracted `nameToId` utility (DRY)
- Function extractions in `checkins.ts`: `sendTestCheckin`, `processOwnerCheckin`
- Function extractions in `linear.ts`: `updateExistingInitiative`, `createAndStoreNewInitiative`
- Index prefetching optimization in `linear.ts`
- `addReaction` using `slackFetch` for consistency
- Error logging additions (while preserving return behavior)

## Why This Works

1. **KV Prefix**: Storage keys are part of the data contract. Changing `initiatives:detail:` to `initiatives:id:` would mean all existing initiative data in KV storage becomes inaccessible since lookups would use the new prefix while data is stored under the old one.

2. **Orphaned Code**: During function extraction refactoring, the original return/catch block was left behind instead of being deleted. The function was already properly closed at line 249.

3. **Error Handling Contract**: Functions like `fetchThreadMessages`, `postMessage`, and `updateMessage` have implicit contracts - callers expect them to return `null`/`false`/`[]` on failure, not throw. Changing to throw breaks all existing callers that don't have try/catch blocks.

## Prevention

**When reviewing refactoring PRs, check for:**

1. **Data compatibility**: Any changes to storage keys, prefixes, or data structures should be flagged. Ask: "Will existing data still be accessible?"

2. **Orphaned code**: After extracting functions, verify the original code block is fully removed. Run `npm run typecheck` before committing.

3. **Behavioral contracts**: If a function returns a value on error (like `null` or `false`), changing to throw is a breaking change. Check all callers or maintain the original behavior.

4. **Run tests before committing**: The test suite caught the error handling changes immediately.

**Code review checklist for refactoring:**
- [ ] Storage keys/prefixes unchanged (or migration provided)
- [ ] TypeScript compiles (`npm run typecheck`)
- [ ] All tests pass (`npm test`)
- [ ] Function signatures and return types unchanged
- [ ] No orphaned code after extractions

## Related Issues

No related issues documented yet.
