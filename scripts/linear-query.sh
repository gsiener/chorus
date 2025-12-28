#!/bin/bash
source .env
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query": "{ issues(filter: { team: { key: { eq: \"PDD\" } } }, first: 50, orderBy: updatedAt) { nodes { identifier title state { name } priority } } }"}'
