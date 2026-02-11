# [CLAUDE.md](http://CLAUDE.md)

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Task Tracking

We use **Linear** to track tasks:

**Starting a task:**

1. Move the Linear issue to "In Progress"
2. Reference the issue ID (e.g., PDD-28) in commits

**Finishing a task:**

1. Commit changes (but batch pushes - see below)
2. Move issue to "In Review"
3. Verify/confirm the fix works
4. If confirmed → move to "Done"
5. If can't confirm → leave in "In Review" for manual verification

**Git push policy:**

- **Batch commits before pushing** - Quality tests run on push and cost money
- Commit frequently, but push less often (batch multiple commits together)
- Only push when explicitly asked or when a logical batch of work is complete

**Creating issues:**

- Associate new issues with the **Chorus Project** (ID: d581ee59-765e-4257-83f8-44e75620bac6)

**Linear API access:**

- API key is in `.env` as `LINEAR_API` (use `source .env` first)
- Use the GraphQL API at `https://api.linear.app/graphql`
- Team ID for PDD Leadership: `daa91240-92e1-4a78-8cc7-a53684a431b1`

Workflow state IDs (PDD Leadership):

- Backlog: `fe855cf8-1c24-48e2-98c7-347a001edf35`
- Todo: `c15f7e13-c1e7-4d44-9baa-5a9eeb73c6a9`
- In Progress: `c9ac7a4d-ba12-4a55-96c8-62674a1fe91f`
- In Review: `5041ec12-a4f2-4d38-be9e-5bb7345341c5`
- Done: `d75b66b4-4d28-4967-9b77-fef9b3d8c4fe`

Example to create an issue:

```bash
source .env && curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API" \
  -d '{
    "query": "mutation CreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }",
    "variables": {
      "input": {
        "title": "Issue title",
        "description": "Issue description",
        "teamId": "daa91240-92e1-4a78-8cc7-a53684a431b1",
        "projectId": "d581ee59-765e-4257-83f8-44e75620bac6"
      }
    }
  }'
```

Example to update issue state (use issue UUID, not identifier):

```bash
source .env && curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API" \
  -d '{
    "query": "mutation { issueUpdate(id: \"ISSUE_UUID\", input: { stateId: \"STATE_ID\" }) { success } }"
  }'
```

## Bug Reporting Workflow

When a bug is reported, follow this workflow:

1. **Create a Linear issue** - Capture the bug in Linear (associated with the Chorus project)
2. **Write a failing test** - Create a test that reproduces the bug and fails
3. **Use subagents to fix** - Launch specialized agents to fix the bug
4. **Verify with passing test** - Confirm the fix works by showing the test now passes
5. **Update Linear issue** - Move through workflow states (In Progress → In Review → Done)

This ensures we:

- Have a clear record of the bug
- Actually reproduce the issue before attempting fixes
- Have verification that the fix works
- Prevent future regressions with the new test coverage

## Workflow Principles

### 1. Plan Mode Default

Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions):

- Create a Linear issue with detailed description including checkable markdown list
- If something goes sideways, STOP and re-plan immediately - don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs in the Linear issue upfront to reduce ambiguity

Example Linear issue structure:

```markdown
## Plan
- [ ] Step 1: Research X
- [ ] Step 2: Implement Y
- [ ] Step 3: Test Z

## Verification
- [ ] Tests pass
- [ ] Behavior diff looks correct
- [ ] Would a staff engineer approve?
```

### 2. Subagent Strategy

Use subagents liberally to keep main context window clean:

- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One focused task per subagent for better execution
- This prevents context pollution and improves performance

### 3. Verification Before Done

Never move a Linear issue to "Done" without proving it works:

- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness
- If you can't verify, leave in "In Review" for manual verification

### 4. Demand Elegance (Balanced)

For non-trivial changes: pause and ask "is there a more elegant way?"

- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes - don't over-engineer
- Challenge your own work before presenting it
- Balance elegance with practicality

### 5. Self-Improvement Loop

After ANY correction from the user, capture the lesson:

- Create a new document in `docs/solutions/` with the pattern
- Use YAML frontmatter (module, tags, symptoms, root_cause, resolution_type)
- Write rules for yourself that prevent the same mistake
- Build institutional knowledge over time
- Review existing solutions at session start for relevant patterns

### 6. Self-Verification

Never tell the user to try something when you can verify it yourself:

- After deploying, check the GitHub Actions status and confirm success
- After fixing a bug, test the fix via API or other available means
- After making changes, run the tests yourself rather than asking the user to
- Use available tools (curl, gh CLI, etc.) to validate your work before reporting done

## Project Overview

Chorus is a Cloudflare Worker-based Slack bot that responds to @mentions using Claude for AI-powered responses. It maintains thread context for natural conversations and is focused on internal knowledge about product roadmap and strategy.

## Commands

- `npm run dev` - Start local development server
- `npm run deploy` - Deploy to Cloudflare Workers
- `npm run typecheck` - Run TypeScript type checking
- `npm test` - Run tests
- `npm run test:watch` - Run tests in watch mode

## Testing Requirements

**Always write tests and ensure they pass before committing.** Tests are located in `src/__tests__/` using vitest with the Cloudflare Workers pool. CI will block merges if tests fail.

## Architecture

See [**ARCHITECTURE.md**](./ARCHITECTURE.md) for the comprehensive system design documentation.

**When to reference ARCHITECTURE.md:**

- Before making significant design decisions or adding new modules
- When modifying data flow between components
- When adding new integrations or storage patterns

**When to update ARCHITECTURE.md:**

- After adding new modules or major features
- After changing data models or storage patterns
- After adding new external integrations
- After modifying the request flow or entry points

**Quick reference:**

```
@mention → Cloudflare Worker → ack immediately (200)
                            → waitUntil: fetch thread → Claude API → post response
```

**Key files:**

- `src/index.ts` - Worker entry point, routes Slack events, handles `app_mention`
- `src/slack.ts` - Slack API: signature verification, thread fetching, message posting
- `src/claude.ts` - Claude API integration, system prompt, message format conversion
- `src/types.ts` - TypeScript interfaces for Slack events and API responses

## Environment Secrets

Set via `npx wrangler secret put <NAME>`:

- `SLACK_BOT_TOKEN` - Bot token for Slack API (`xoxb-...`)
- `SLACK_SIGNING_SECRET` - For request verification
- `ANTHROPIC_API_KEY` - Claude API key
- `DOCS_API_KEY` - API key for console-based document management (REST API)
- `LINEAR_API` - Linear API key for R&D Priorities integration

## R&D Priorities Integration

Chorus fetches R&D Priorities from Linear and includes them in Claude's system prompt. This allows Chorus to answer questions like "What are our top priorities?" or "Who owns X?"

**Key files:**

- `src/linear-priorities.ts` - Fetches and formats priorities from Linear
- Linear parent initiative ID is defined in `RD_PRIORITIES_INITIATIVE_ID` constant

**Linear Structure:**

- Parent Initiative linked to child initiatives via `initiativeRelations` with `sortOrder` for ranking
- Each initiative has: owner, tech risk (🌶), theme, Slack channel in description

**Debug/Test API Endpoints:**

- `GET /api/debug/priorities` - Returns raw Linear priorities data (requires DOCS_API_KEY)
- `POST /api/ask` - Ask Chorus a question directly via API (requires DOCS_API_KEY)

Example:

```bash
curl -s "$CHORUS_URL/api/debug/priorities" \
  -H "Authorization: Bearer $DOCS_API_KEY" | jq '.'

curl -s "$CHORUS_URL/api/ask" \
  -H "Authorization: Bearer $DOCS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"question": "What are our top priorities?"}'
```

**Updating Priorities in Linear:**

- Use `initiativeUpdate` mutation to change initiative details
- Use `initiativeRelationUpdate` mutation to change sortOrder (ranking)
- Use `initiativeRelationCreate/Delete` to add/remove from roadmap
- Use `initiativeToProjectCreate/Delete` to link/unlink projects

The priorities cache refreshes every 5 minutes.

## Task Tracking Preference

**Use Linear sub-issues instead of CLI tasks.** When working on a parent Linear issue:

1. Query existing sub-issues first to avoid duplicates
2. Create sub-issues for each discrete step
3. Update sub-issue states as work progresses (In Progress → Done)
4. Keep the parent issue as the rollup

This keeps work visible to the team and persists beyond the session.

Example workflow:

```bash
# Query sub-issues of parent
curl -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API" \
  -d '{"query": "{ issue(id: \"PARENT_UUID\") { children { nodes { identifier title state { name } } } } }"}'

# Create sub-issue
curl -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API" \
  -d '{"query": "mutation { issueCreate(input: { title: \"Step description\", teamId: \"TEAM_ID\", parentId: \"PARENT_UUID\" }) { success } }"}'
```