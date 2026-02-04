# Linear API Reference

## Workflow State IDs (PDD Leadership)

| State | ID |
|-------|-----|
| Backlog | `fe855cf8-1c24-48e2-98c7-347a001edf35` |
| Todo | `c15f7e13-c1e7-4d44-9baa-5a9eeb73c6a9` |
| In Progress | `c9ac7a4d-ba12-4a55-96c8-62674a1fe91f` |
| In Review | `5041ec12-a4f2-4d38-be9e-5bb7345341c5` |
| Done | `d75b66b4-4d28-4967-9b77-fef9b3d8c4fe` |

## API Examples

All examples require: `source .env` first (for `LINEAR_API` key).

### Create an Issue

```bash
curl -s -X POST https://api.linear.app/graphql \
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

### Update Issue State

Use issue UUID (not identifier like PDD-28):

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API" \
  -d '{
    "query": "mutation { issueUpdate(id: \"ISSUE_UUID\", input: { stateId: \"STATE_ID\" }) { success } }"
  }'
```

### Query Sub-Issues

```bash
curl -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API" \
  -d '{"query": "{ issue(id: \"PARENT_UUID\") { children { nodes { identifier title state { name } } } } }"}'
```

### Create Sub-Issue

```bash
curl -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API" \
  -d '{"query": "mutation { issueCreate(input: { title: \"Step description\", teamId: \"TEAM_ID\", parentId: \"PARENT_UUID\" }) { success } }"}'
```

## Initiative Mutations (for R&D Priorities)

- `initiativeUpdate` - Change initiative details
- `initiativeRelationUpdate` - Change sortOrder (ranking)
- `initiativeRelationCreate/Delete` - Add/remove from roadmap
- `initiativeToProjectCreate/Delete` - Link/unlink projects
