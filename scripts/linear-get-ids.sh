#!/bin/bash
source .env
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query": "{ teams { nodes { id key name } } projects(first: 10) { nodes { id name slugId } } }"}'
