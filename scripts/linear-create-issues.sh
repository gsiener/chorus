#!/bin/bash
source .env

TEAM_ID="daa91240-92e1-4a78-8cc7-a53684a431b1"
PROJECT_ID="d581ee59-765e-4257-83f8-44e75620bac6"

# Issue 1: Add pagination
DESC1="Currently, listing initiatives and documents returns all items without pagination. With 100+ items, this will become slow.\\n\\n**Tasks:**\\n- Add cursor-based pagination to listInitiatives()\\n- Add pagination to listDocuments()\\n- Update Slack command responses to show page info\\n\\n**Acceptance criteria:**\\n- Default page size of 10 items\\n- Users can request specific pages\\n- Response includes total count"

curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d "{\"query\": \"mutation { issueCreate(input: { teamId: \\\"$TEAM_ID\\\", projectId: \\\"$PROJECT_ID\\\", title: \\\"Add pagination to initiative and doc listings\\\", description: \\\"$DESC1\\\" }) { success issue { identifier title } } }\"}"

echo ""

# Issue 2: Add initiative editing
DESC2="Currently initiatives can only be created and deleted. Users cannot edit name, description, or owner after creation.\\n\\n**Tasks:**\\n- Add updateInitiative function to initiatives.ts\\n- Add command parsing for editing\\n- Update initiative index when name changes\\n- Add tests for editing functionality\\n\\n**Acceptance criteria:**\\n- Users can update initiative name, description, and owner\\n- Changes are logged with updatedBy and updatedAt"

curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d "{\"query\": \"mutation { issueCreate(input: { teamId: \\\"$TEAM_ID\\\", projectId: \\\"$PROJECT_ID\\\", title: \\\"Add initiative editing commands\\\", description: \\\"$DESC2\\\" }) { success issue { identifier title } } }\"}"

echo ""

# Issue 3: Add rate limiting to search
DESC3="Only doc commands are currently rate-limited. Search commands can be abused and put excessive load on Vectorize.\\n\\n**Tasks:**\\n- Extend isRateLimited to cover search commands\\n- Consider different limits for search vs doc commands\\n- Add telemetry for rate limit hits\\n- Add tests for search rate limiting\\n\\n**Acceptance criteria:**\\n- Search commands are rate-limited (e.g., 20/min)\\n- Users get friendly message when rate limited"

curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d "{\"query\": \"mutation { issueCreate(input: { teamId: \\\"$TEAM_ID\\\", projectId: \\\"$PROJECT_ID\\\", title: \\\"Add rate limiting to search commands\\\", description: \\\"$DESC3\\\" }) { success issue { identifier title } } }\"}"

echo ""

# Issue 4: Fix N+1 queries
DESC4="Both getInitiativesContext in claude.ts and getInitiativesByOwner in checkins.ts load full initiative details sequentially, causing N+1 query patterns.\\n\\n**Tasks:**\\n- Batch KV.get calls using Promise.all\\n- Consider caching initiative details in memory during request\\n- Profile before/after to measure improvement\\n\\n**Acceptance criteria:**\\n- Initiative loading uses batch fetching\\n- Response time improves for 10+ initiatives"

curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d "{\"query\": \"mutation { issueCreate(input: { teamId: \\\"$TEAM_ID\\\", projectId: \\\"$PROJECT_ID\\\", title: \\\"Fix N+1 queries in getInitiativesContext and checkins\\\", description: \\\"$DESC4\\\" }) { success issue { identifier title } } }\"}"

echo ""
echo "Done!"
