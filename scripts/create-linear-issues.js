#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// Load .env
const envPath = path.join(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf8');
const env = {};
envContent.split('\n').forEach(line => {
  const [key, ...valueParts] = line.split('=');
  if (key && valueParts.length) env[key.trim()] = valueParts.join('=').trim();
});

const LINEAR_API_KEY = env.LINEAR_API_KEY;
const TEAM_ID = "daa91240-92e1-4a78-8cc7-a53684a431b1";
const PROJECT_ID = "d581ee59-765e-4257-83f8-44e75620bac6";

const issues = [
  {
    title: "Add pagination to initiative and doc listings",
    description: `Currently, listing initiatives and documents returns all items without pagination. With 100+ items, this will become slow.

**Tasks:**
- Add cursor-based pagination to listInitiatives()
- Add pagination to listDocuments()
- Update Slack command responses to show page info

**Acceptance criteria:**
- Default page size of 10 items
- Users can request specific pages
- Response includes total count`
  },
  {
    title: "Add initiative editing commands",
    description: `Currently initiatives can only be created and deleted. Users cannot edit name, description, or owner after creation.

**Tasks:**
- Add updateInitiative function to initiatives.ts
- Add command parsing for editing
- Update initiative index when name changes
- Add tests for editing functionality

**Acceptance criteria:**
- Users can update initiative name, description, and owner
- Changes are logged with updatedBy and updatedAt`
  },
  {
    title: "Add rate limiting to search commands",
    description: `Only doc commands are currently rate-limited. Search commands can be abused and put excessive load on Vectorize.

**Tasks:**
- Extend isRateLimited to cover search commands
- Consider different limits for search vs doc commands
- Add telemetry for rate limit hits
- Add tests for search rate limiting

**Acceptance criteria:**
- Search commands are rate-limited (e.g., 20/min)
- Users get friendly message when rate limited`
  },
  {
    title: "Fix N+1 queries in getInitiativesContext and checkins",
    description: `Both getInitiativesContext in claude.ts and getInitiativesByOwner in checkins.ts load full initiative details sequentially, causing N+1 query patterns.

**Tasks:**
- Batch KV.get calls using Promise.all
- Consider caching initiative details in memory during request
- Profile before/after to measure improvement

**Acceptance criteria:**
- Initiative loading uses batch fetching
- Response time improves for 10+ initiatives`
  }
];

async function createIssue(issue) {
  const query = `mutation CreateIssue($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue {
        identifier
        title
      }
    }
  }`;

  const response = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': LINEAR_API_KEY
    },
    body: JSON.stringify({
      query,
      variables: {
        input: {
          teamId: TEAM_ID,
          projectId: PROJECT_ID,
          title: issue.title,
          description: issue.description
        }
      }
    })
  });

  return response.json();
}

async function main() {
  console.log('Creating 4 new Linear issues...\n');

  for (const issue of issues) {
    const result = await createIssue(issue);
    if (result.data?.issueCreate?.success) {
      console.log(`✓ Created ${result.data.issueCreate.issue.identifier}: ${result.data.issueCreate.issue.title}`);
    } else {
      console.log(`✗ Failed to create "${issue.title}":`, result.errors?.[0]?.message || 'Unknown error');
    }
  }

  console.log('\nDone!');
}

main();
