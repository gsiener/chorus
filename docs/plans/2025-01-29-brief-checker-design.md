# Brief Checker Design

**Issue:** [PDD-55](https://linear.app/honeycombio/issue/PDD-55) - DM initiative owners when brief is missing

## Overview

Ensure each R&D Priority initiative has a brief linked. If missing, automatically DM the owner to remind them.

## What Counts as a Brief

An initiative has a brief if it has at least one external link (`links.nodes[]`) where the `label` contains "brief" (case-insensitive).

```typescript
function hasBrief(initiative: Initiative): boolean {
  return initiative.links.nodes.some(
    link => link.label?.toLowerCase().includes('brief')
  );
}
```

## User Mapping

Store user records mapping email (from Linear) to Slack IDs for DMs.

```typescript
// src/user-mapping.ts
interface User {
  email: string;
  name: string;
  linearId: string;
  slackId: string;
}

export const USERS: User[] = [
  {
    email: "shashankpradhan@honeycomb.io",
    name: "Shashank Pradhan",
    linearId: "abc123",
    slackId: "U12345678",
  },
  // ... etc
];

export function findUserByEmail(email: string): User | undefined {
  return USERS.find(u => u.email === email);
}
```

## Check Logic

```typescript
// src/brief-checker.ts
interface BriefCheckResult {
  initiativesChecked: number;
  missingBriefs: Array<{
    initiative: { name: string; url: string };
    owner: { name: string; email: string };
    dmSent: boolean;
    error?: string;
  }>;
  unmappedUsers: string[]; // emails not in USER_MAPPING
}

export async function checkInitiativeBriefs(env: Env): Promise<BriefCheckResult>
```

## Triggers

### Scheduled (Cron)

Add to `wrangler.toml`:
```toml
[triggers]
crons = ["0 14 * * 1-5"]  # 2pm UTC weekdays (9am ET)
```

Handler in `src/index.ts`:
```typescript
async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
  const result = await checkInitiativeBriefs(env);
  console.log(`Brief check: ${result.missingBriefs.length} missing`);
}
```

### On-Demand

Slack command: `@chorus check-briefs`

Response:
```
Brief Check Results

Checked 12 initiatives, 4 missing briefs:
- Agent O11y: Timeline Analysis - DM sent to Shashank Pradhan
- Scale: Usage & Billing - DM sent to Jessica Parsons
- Agentic AI - User not mapped: eleanormeegoda@honeycomb.io
```

## DM Content

```
Hi {name}! Your initiative "{initiative_name}" doesn't have a brief linked yet.

Please add a link labeled "brief" to the initiative: {initiative_url}
```

## Notification Throttling

Track last notification in KV to avoid daily spam:

```typescript
// Key: brief-check:notified:{initiative_id}
// Value: ISO timestamp
// TTL: 7 days (auto-cleanup)

const NOTIFY_COOLDOWN_DAYS = 7;
```

Only re-notify if 7+ days have passed since last notification.

## Error Handling

- Linear API fails: Log error, skip check
- Slack DM fails: Log error, continue with others
- User not in mapping: Add to `unmappedUsers`, continue
- Rate limiting: 500ms delay between Slack DMs

## Files

| File | Action |
|------|--------|
| `src/user-mapping.ts` | Create - user records |
| `src/brief-checker.ts` | Create - core logic |
| `src/index.ts` | Modify - scheduled handler + command |
| `wrangler.toml` | Modify - add cron trigger |
