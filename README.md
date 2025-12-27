# Chorus

A Cloudflare Worker-based Slack bot that responds to @mentions using Claude for AI-powered responses. Maintains thread context for natural conversations.

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (`npm install -g wrangler`)
- A Cloudflare account
- An Anthropic API key
- Admin access to a Slack workspace
- A Honeycomb account (optional, for tracing)

## Setup

### 1. Clone and Install Dependencies

```bash
git clone <repository-url>
cd chorus
npm install
```

### 2. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App**
2. Choose **From scratch**
3. Name your app (e.g., "Chorus") and select your workspace

#### Configure OAuth Scopes

1. Navigate to **OAuth & Permissions** in the sidebar
2. Under **Bot Token Scopes**, add these scopes:
   - `app_mentions:read` - Receive mention events
   - `chat:write` - Post messages
   - `channels:history` - Read public channel messages (for thread context)
   - `groups:history` - Read private channel messages (for thread context)

3. Click **Install to Workspace** and authorize the app
4. Copy the **Bot User OAuth Token** (`xoxb-...`) - you'll need this later

#### Get the Signing Secret

1. Navigate to **Basic Information** in the sidebar
2. Under **App Credentials**, copy the **Signing Secret**

### 3. Deploy to Cloudflare

#### Authenticate with Cloudflare

```bash
wrangler login
```

#### Deploy the Worker

```bash
npm run deploy
```

Note the deployment URL (e.g., `https://chorus.your-subdomain.workers.dev`)

#### Set Secrets

```bash
npx wrangler secret put SLACK_BOT_TOKEN
# Paste your Bot User OAuth Token (xoxb-...)

npx wrangler secret put SLACK_SIGNING_SECRET
# Paste your Signing Secret

npx wrangler secret put ANTHROPIC_API_KEY
# Paste your Anthropic API key

npx wrangler secret put HONEYCOMB_API_KEY
# Paste your Honeycomb API key (for tracing)

npx wrangler secret put DOCS_API_KEY
# Create a secure API key for console-based document management
```

### 4. Configure Slack Event Subscriptions

1. In your Slack app settings, navigate to **Event Subscriptions**
2. Toggle **Enable Events** to On
3. Set the **Request URL** to your worker URL:
   ```
   https://chorus.your-subdomain.workers.dev
   ```
   Slack will send a verification request - it should show "Verified" if everything is set up correctly.

4. Under **Subscribe to bot events**, add:
   - `app_mention`

5. Click **Save Changes**

### 5. Invite the Bot to Channels

In Slack, invite the bot to any channel where you want it to respond:

```
/invite @Chorus
```

## Usage

Mention the bot in any channel it's been invited to:

```
@Chorus what's on our product roadmap?
```

The bot maintains context within threads, so you can have follow-up conversations:

```
@Chorus what's the status of feature X?
  └── Can you tell me more about the timeline?
      └── Who's the owner?
```

## Development

### Local Development

```bash
npm run dev
```

This starts a local development server. Use a tool like [ngrok](https://ngrok.com/) to expose it for Slack testing:

```bash
ngrok http 8787
```

Then update your Slack app's Request URL to the ngrok URL.

### Type Checking

```bash
npm run typecheck
```

### Testing

```bash
npm test
npm run test:watch  # Watch mode
```

## Architecture

```
@mention → Cloudflare Worker → ack immediately (200)
                            → waitUntil: fetch thread → Claude API → post response
```

| File | Purpose |
|------|---------|
| `src/index.ts` | Worker entry point with tracing instrumentation |
| `src/handler.ts` | Core request handling logic (untraced, for testing) |
| `src/slack.ts` | Slack API: signature verification, thread fetching, message posting |
| `src/claude.ts` | Claude API integration, system prompt, message conversion |
| `src/types.ts` | TypeScript interfaces |
| `src/tracing.ts` | OpenTelemetry configuration for Honeycomb |

## Observability

Chorus includes OpenTelemetry tracing that exports to Honeycomb. Traces include:

- Request handling spans
- Slack API calls (thread fetching, message posting)
- Claude API calls with token counts and response lengths
- Error tracking with exceptions

To enable tracing, set the `HONEYCOMB_API_KEY` secret (see Setup). View traces in the [Honeycomb UI](https://ui.honeycomb.io/).

## Knowledge Base API

Add documents to the knowledge base from the console using the REST API:

```bash
# Set your API key
export CHORUS_API_KEY="your-docs-api-key"
export CHORUS_URL="https://chorus.your-subdomain.workers.dev"

# Add a document
curl -X POST "$CHORUS_URL/api/docs" \
  -H "Authorization: Bearer $CHORUS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title": "Q1 Strategy", "content": "Our Q1 priorities are..."}'

# List documents
curl "$CHORUS_URL/api/docs" \
  -H "Authorization: Bearer $CHORUS_API_KEY"

# Remove a document
curl -X DELETE "$CHORUS_URL/api/docs" \
  -H "Authorization: Bearer $CHORUS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title": "Q1 Strategy"}'
```

Documents are automatically chunked and indexed for semantic search, so Chorus can find relevant context when answering questions.

## Customization

### Modify the System Prompt

Edit the `SYSTEM_PROMPT` in `src/claude.ts` to change the bot's personality and focus areas.

### Change the Claude Model

Update the `model` field in `src/claude.ts` to use a different Claude model (e.g., `claude-opus-4-20250514`).

## Troubleshooting

### Bot doesn't respond

1. Check that the bot is invited to the channel
2. Verify the Request URL is correct in Slack Event Subscriptions
3. Check Cloudflare Worker logs: `wrangler tail`

### "Invalid signature" errors

- Ensure `SLACK_SIGNING_SECRET` is set correctly
- The secret should be from **Basic Information > App Credentials**, not the OAuth token

### Thread context not working

- Ensure the bot has `channels:history` (public) and/or `groups:history` (private) scopes
- Reinstall the app to your workspace after adding scopes

## License

MIT
