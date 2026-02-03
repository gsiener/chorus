---
title: Verifying Features Before Marking Done
category: integration-issues
module: workflow
tags:
  - testing
  - verification
  - linear
  - code-review
symptoms:
  - Features marked "Done" without verification
  - Code exists but no tests
  - Linear issues closed prematurely
root_cause: Trusting implementation exists without verifying it works
resolution_type: process
created: 2025-02-03
---

# Verifying Features Before Marking Done

## Problem

During the agent-native architecture implementation (PDD-56 through PDD-63), we discovered that having code in place doesn't mean features are verified working. Several functions were implemented but had no test coverage:

- `fetchUserInfo()` - existed in slack.ts but 0 tests
- `checkAndSyncIfNeeded()` - wired into scheduled handler but no tests
- `backfillIfNeeded()` - wired into scheduled handler but no tests
- `handleStreamApi()` - endpoint existed but no tests

The initial assessment marked these as "In Review" based on file existence checks:

```bash
# This is INSUFFICIENT verification
test -f src/constants.ts && echo "✓ File exists"
grep -q "export async function fetchUserInfo" src/slack.ts && echo "✓ Function exists"
```

## Root Cause

Conflating "code exists" with "feature works". Verification requires:

1. Code exists (necessary but not sufficient)
2. Code is wired up correctly (integration)
3. Tests prove the behavior (verification)
4. Tests pass (confirmation)

## Solution

Before marking any Linear issue as Done, run this verification checklist:

### 1. Check for dedicated tests

```bash
# Search for test coverage of the function
grep -r "functionName" src/__tests__/ | grep -v "import"
```

If count is 0, the feature is NOT verified.

### 2. Verify wiring (for integrations)

```bash
# Check if function is actually called somewhere
grep -n "functionName" src/*.ts | grep -v "export.*function"
```

### 3. Run the specific tests

```bash
npm run test:unit -- src/__tests__/relevant.test.ts
```

### 4. For API endpoints, test manually or add integration tests

```typescript
it("GET /api/endpoint returns expected response", async () => {
  const request = new Request("https://example.com/api/endpoint", {
    headers: { Authorization: "Bearer test-api-key" },
  });
  const response = await handler.fetch(request, mockEnv, mockCtx);
  expect(response.status).toBe(200);
});
```

## Prevention

### Before moving to "In Review"

Ask: "How would I prove this works to a skeptical reviewer?"

- For functions: Point to passing tests
- For endpoints: Show test or manual verification
- For scheduled tasks: Show tests for the trigger logic

### Test coverage checklist for new features

| Feature Type | Minimum Tests |
|--------------|---------------|
| Pure function | Unit tests for happy path + edge cases |
| API endpoint | Auth, validation, success, error cases |
| Scheduled task | Trigger conditions, skip conditions, success recording |
| Integration | End-to-end with mocked externals |

### Linear workflow gate

Only move issues to "Done" when you can answer YES to:

1. Tests exist for this feature?
2. Tests pass?
3. I ran the tests myself (not just trusting CI)?

## Example: Adding Missing Tests

When we discovered `fetchUserInfo()` had no tests, we added:

```typescript
describe("fetchUserInfo", () => {
  it("fetches user info from Slack API", async () => { /* ... */ });
  it("returns cached user info if available", async () => { /* ... */ });
  it("caches fetched user info", async () => { /* ... */ });
  it("returns null on API error", async () => { /* ... */ });
  it("returns null when user not in response", async () => { /* ... */ });
});
```

Key patterns tested:
- Happy path (API returns data)
- Cache hit (skip API call)
- Cache miss + store (verify caching)
- Error handling (API fails gracefully)
- Edge case (malformed response)

## Related

- [CLAUDE.md workflow principles](/CLAUDE.md#workflow-principles) - "Never move to Done without proving it works"
- Linear issues: PDD-56 through PDD-63
