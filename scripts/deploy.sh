#!/bin/bash
set -e

# Deploy to Cloudflare Workers
echo "Deploying to Cloudflare Workers..."
npx wrangler deploy

# Bust the priorities cache so the new deploy gets fresh data
if [ -n "$DOCS_API_KEY" ] && [ -n "$CHORUS_URL" ]; then
  echo "Busting priorities cache..."
  curl -s "$CHORUS_URL/api/debug/priorities?refresh=1" \
    -H "Authorization: Bearer $DOCS_API_KEY" \
    > /dev/null
  echo "✓ Cache busted"
else
  echo "Warning: DOCS_API_KEY or CHORUS_URL not set, skipping cache bust"
fi

# Create Honeycomb deploy marker
if [ -z "$HONEYCOMB_API_KEY" ]; then
  echo "Warning: HONEYCOMB_API_KEY not set, skipping marker creation"
  exit 0
fi

DATASET="chorus"
TIMESTAMP=$(date +%s)
VERSION=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
MESSAGE="Deploy $VERSION"

echo "Creating Honeycomb marker..."
curl -s -X POST "https://api.honeycomb.io/1/markers/$DATASET" \
  -H "X-Honeycomb-Team: $HONEYCOMB_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"$MESSAGE\", \"type\": \"deploy\", \"start_time\": $TIMESTAMP}" \
  > /dev/null

echo "✓ Marker created: $MESSAGE"
