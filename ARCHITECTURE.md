# Chorus Architecture

This document provides a comprehensive technical overview of Chorus, an AI-powered Slack bot built on Cloudflare Workers.

## Table of Contents

1. [Overview](#overview)
2. [System Architecture](#system-architecture)
3. [Request Flow](#request-flow)
4. [Core Modules](#core-modules)
5. [Data Storage](#data-storage)
6. [External Integrations](#external-integrations)
7. [Observability](#observability)
8. [Testing](#testing)
9. [Deployment](#deployment)

---

## Overview

**Chorus** is a Cloudflare Worker-based Slack bot that serves as an AI-powered assistant for product leadership. It responds to @mentions using Claude, maintains thread context for natural conversations, and manages internal knowledge about product roadmap, strategy, and initiatives.

### Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Cloudflare Workers (serverless) |
| Language | TypeScript (ES2022) |
| AI Model | Claude Opus 4.5 (`claude-opus-4-5-20251101`) |
| Storage | Cloudflare KV |
| Vector Search | Cloudflare Vectorize + Workers AI |
| Messaging | Slack API |
| Integration | Linear GraphQL API |
| Observability | OpenTelemetry → Honeycomb |

### Project Structure

```
chorus/
├── src/
│   ├── index.ts           # Worker entry point
│   ├── types.ts           # TypeScript interfaces
│   ├── slack.ts           # Slack API integration
│   ├── claude.ts          # Claude API integration
│   ├── docs.ts            # Document management
│   ├── embeddings.ts      # Semantic search
│   ├── thread-context.ts  # Conversation memory
│   ├── checkins.ts        # Weekly DM check-ins
│   ├── linear-priorities.ts # R&D Priorities from Linear
│   ├── files.ts           # File extraction
│   ├── parseCommands.ts   # Command parsing
│   ├── telemetry.ts       # OpenTelemetry instrumentation
│   ├── http-utils.ts      # HTTP retry/error handling
│   ├── soul.md            # System prompt (AI personality)
│   ├── primitives/        # Shared utilities and patterns
│   │   ├── index.ts       # Barrel exports
│   │   ├── validators.ts  # Error classes, ValidationResult type
│   │   ├── indexed-store.ts # Generic indexed KV store pattern
│   │   └── formatters.ts  # Pagination, date, text utilities
│   └── __tests__/         # Test files
├── wrangler.toml          # Cloudflare Worker config
├── package.json
└── tsconfig.json
```

---

## System Architecture

### High-Level Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Slack                                       │
│  (Events: @mentions, reactions, slash commands)                         │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     Cloudflare Worker (index.ts)                        │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ 1. Verify Slack signature                                        │   │
│  │ 2. Deduplicate events (KV)                                       │   │
│  │ 3. Rate limit check (KV)                                         │   │
│  │ 4. Return 200 OK immediately                                     │   │
│  │ 5. Process in background via ctx.waitUntil()                     │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└────────┬──────────────────────────────────────────────────────┬────────┘
         │                                                      │
         ▼                                                      ▼
┌─────────────────────┐                              ┌───────────────────┐
│  Command Handlers   │                              │  Claude Response  │
│  ├─ docs (add/rm)   │                              │  Generation       │
│  ├─ initiatives     │                              │  ┌─────────────┐  │
│  ├─ search          │                              │  │ Load KB     │  │
│  └─ help            │                              │  │ Load Inits  │  │
└─────────┬───────────┘                              │  │ Get Context │  │
          │                                          │  │ Call Claude │  │
          ▼                                          │  └─────────────┘  │
┌─────────────────────────────────────────────┐     └─────────┬─────────┘
│            Storage Layer                     │               │
│  ┌─────────────────┐  ┌──────────────────┐  │               │
│  │  Cloudflare KV  │  │ Vectorize Index  │  │               │
│  │  - Documents    │  │ - Embeddings     │  │               │
│  │  - Context      │  │ - Chunk vectors  │  │               │
│  │  - Cache        │  │                  │  │               │
│  └─────────────────┘  └──────────────────┘  │               │
└─────────────────────────────────────────────┘               │
                                                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         External Services                                │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐               │
│  │ Claude API    │  │ Workers AI    │  │ Linear API   │               │
│  │ (Anthropic)   │  │ (Embeddings)  │  │ (GraphQL)    │               │
│  └───────────────┘  └───────────────┘  └───────────────┘               │
└─────────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Honeycomb (Observability)                            │
│  - OpenTelemetry traces                                                 │
│  - GenAI metrics (tokens, latency, cost)                               │
│  - Error tracking                                                       │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Request Flow

### Entry Points

The worker handles four types of requests:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/` | POST | Slack event webhooks |
| `/slack/slash` | POST | Slash commands |
| `/api/*` | Various | REST API (protected) |
| Cron trigger | - | Scheduled check-ins |

### @Mention Flow (Primary)

```
1. Slack POSTs app_mention event
                    │
                    ▼
2. Worker verifies HMAC-SHA256 signature
                    │
                    ▼
3. Check event deduplication (KV lookup)
                    │
                    ▼
4. Return 200 OK immediately ◄──── Slack requires response within 3 seconds
                    │
                    ▼
5. ctx.waitUntil() continues processing:
   │
   ├─► Parse cleaned text (remove bot mention)
   │
   ├─► Check for special commands:
   │   ├─ help, surprise me
   │   ├─ search <query>
   │   └─ docs (add/remove/list)
   │
   ├─► If file upload: extract content, add as document
   │
   └─► Otherwise: Generate AI response
       │
       ├─► Fetch thread history (if in thread)
       ├─► Load thread context (for summarization)
       ├─► Build Claude prompt:
       │   ├─ System prompt (soul.md)
       │   ├─ R&D Priorities (from Linear)
       │   ├─ Knowledge base
       │   └─ Conversation messages
       ├─► Call Claude API (25s timeout)
       ├─► Post response to Slack
       └─► Add feedback reactions (👍 👎)
```

### Slash Command Flow

```
POST /slack/slash
        │
        ▼
┌───────────────────────────────────────┐
│ /chorus or /chorus-help → Help text   │
│ /chorus-search <q> → Search KB        │
│ /chorus-docs → List documents         │
└───────────────────────────────────────┘
```

### REST API Endpoints

Protected by `DOCS_API_KEY` header:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/docs` | POST | Add document |
| `/api/docs` | GET | List documents |
| `/api/docs` | DELETE | Remove document |
| `/api/test-feedback-digest` | POST | Trigger manual feedback digest |
| `/api/test-telemetry` | POST | Test Claude telemetry |

### Scheduled Check-ins

**Schedule:** Daily at 9 AM ET (14:00 UTC)

```
Cron trigger (0 14 * * *)
        │
        ▼
sendWeeklyCheckins()
        │
        ▼
For each initiative owner:
├─► Check if 6+ days since last check-in
├─► Load owner's initiatives
├─► Identify gaps (missing PRD, metrics)
├─► Generate summary message
├─► Send DM via Slack API
└─► Record check-in timestamp
```

---

## Core Modules

### slack.ts - Slack Integration

**Responsibilities:**
- Request signature verification (HMAC-SHA256)
- Thread history fetching
- Message posting, updating, and reactions
- Direct messages for check-ins

**Key Functions:**

| Function | Purpose |
|----------|---------|
| `verifySlackSignature()` | Validate request authenticity |
| `fetchThreadMessages()` | Get all messages in a thread |
| `postMessage()` | Send message to channel/thread |
| `updateMessage()` | Edit existing message |
| `addReaction()` | Add emoji reaction |
| `postDirectMessage()` | Send private message |

**Error Handling:**
- `SignatureVerificationError` - Invalid signature
- `SlackApiError` - API call failures (graceful fallback)

---

### claude.ts - Claude Integration

**Responsibilities:**
- Generate AI responses (standard and streaming)
- Convert Slack messages to Claude format
- Response caching (1-hour TTL)
- Token usage tracking and telemetry

**Prompt Composition:**

```
┌─────────────────────────────────────────────┐
│ System Prompt (soul.md)                     │
│ - Personality and behavior guidelines       │
├─────────────────────────────────────────────┤
│ Thread Context (if available)               │
│ - Summarized older messages                 │
│ - Key topics extracted                      │
├─────────────────────────────────────────────┤
│ R&D Priorities (from Linear)                │
│ - Strategic initiatives, owners, status     │
├─────────────────────────────────────────────┤
│ Knowledge Base                              │
│ - All indexed documents                     │
├─────────────────────────────────────────────┤
│ User Messages                               │
│ - Recent messages (full)                    │
│ - Older messages (summarized)               │
└─────────────────────────────────────────────┘
```

**Key Features:**
- **Prompt caching:** System prompt cached for efficiency
- **Streaming:** Progressive updates for long responses
- **Response cache:** KV-backed with content hash key

---

### docs.ts - Document Management

**Responsibilities:**
- Add/remove documents from knowledge base
- Index documents for semantic search
- Enforce size limits
- Serve "surprise me" random document feature

**Data Model:**

```typescript
interface DocMetadata {
  title: string;
  addedBy: string;
  addedAt: string;
  charCount: number;
}

// Storage Keys:
// docs:index → DocMetadata[]
// docs:content:{title} → string (content)
```

**Limits:**

| Limit | Value |
|-------|-------|
| Max document size | 50 KB |
| Max total KB | 200 KB |
| Max title length | 100 chars |

---

### embeddings.ts - Semantic Search

**Architecture:**

```
Document → Chunker → Embeddings → Vectorize
                         │            │
                    Workers AI    768-dim vectors
                         │            │
                    bge-base-en-v1.5  │
                                      ▼
                              Cosine Similarity Search
```

**Chunking Strategy:**
- **Chunk size:** 1000 characters
- **Overlap:** 200 characters
- **Break points:** Paragraph boundaries, then sentences
- **Context prefix:** "This is part X of Y from document Z" (Anthropic Contextual Retrieval pattern)

**Key Functions:**

| Function | Purpose |
|----------|---------|
| `generateEmbedding()` | Get vector via Workers AI |
| `chunkDocument()` | Split into overlapping chunks |
| `indexDocument()` | Store chunks in Vectorize |
| `searchDocuments()` | Vector similarity search |

---

### linear-priorities.ts - R&D Priorities

**Purpose:** Fetch R&D Priorities from Linear and include them in Claude's system prompt.

**Data Source:** Linear parent initiative linked to child initiatives via `initiativeRelations`.

**Cache:** 25-hour TTL in KV (`linear:priorities:context`), warmed daily on cron via `warmPrioritiesCache()`. The mention path reads from cache and falls back to fetching from Linear only on cache miss.

---

### thread-context.ts - Conversation Memory

**Purpose:** Avoid token limit issues by summarizing older messages while keeping recent ones in full detail.

**Strategy:**
- Keep last 4 messages verbatim
- Summarize earlier messages if thread > 8 messages
- Extract key topics (quoted terms, capitalized phrases)
- 7-day TTL on stored context

**Storage:** `thread:context:{channel}:{thread_ts}`

---

### checkins.ts - Weekly Check-ins

**Purpose:** Proactive DM reminders to initiative owners with status summaries and gap identification.

**Rate Limiting:**
- Production: 6 days minimum between check-ins
- Test mode: 20 hours

**Message Content:**
- Initiative status summary (grouped)
- Missing PRD/metrics warnings
- Nudges for stale initiatives
- Action links

---

### files.ts - File Processing

**Supported Formats:**
- `.txt`, `.md`, `.json`, `.csv` - Direct text extraction
- `.pdf` - Claude document understanding

**Limits:**
- Max file size: 1 MB
- Download timeout: 10 seconds

---

### telemetry.ts - Observability

**OpenTelemetry Semantic Conventions:**

| Namespace | Attributes |
|-----------|------------|
| `gen_ai.*` | Model, tokens, cache info, cost |
| `slack.*` | User, channel, thread, API calls |
| `chorus.*` | Commands, files, rate limiting |
| `conversation.*` | Turn count, context length |
| `knowledge_base.*` | Doc count, retrieval latency |
| `error.*` | Category, retryability |

---

### primitives/ - Shared Utilities

**Purpose:** Reusable building blocks that eliminate code duplication across modules.

**Modules:**

| Module | Purpose |
|--------|---------|
| `validators.ts` | Error classes with `_tag` discriminator, `ValidationResult<T>` type, validation functions |
| `indexed-store.ts` | Generic indexed KV store pattern (index + prefixed items) |
| `formatters.ts` | Pagination calculation, date formatting, text truncation, snippet extraction |

**Key Patterns:**

**1. Discriminated Error Union:**
```typescript
export class EmptyValueError extends Error {
  readonly _tag = "EmptyValueError" as const;
  constructor(public readonly fieldName: string) {
    super(`${fieldName} cannot be empty`);
  }
}

// Type-safe result handling
export type ValidationResult<T, E extends Error = Error> =
  | { success: true; value: T }
  | { success: false; error: E };
```

**2. Generic Indexed Store:**
```typescript
// Abstraction for the index + prefixed items KV pattern
const store = createIndexedStore<DocsIndex, Document, DocMetadata>({
  indexKey: "docs:index",
  itemPrefix: "docs:content:",
  itemIdToKey: (id) => `docs:content:${id}`,
  getItemId: (doc) => sanitizeTitle(doc.title),
  // ...
});

// Provides: getIndex, saveIndex, getItem, saveItem,
//           findInIndex, upsertIndexEntry, removeFromIndex
```

**3. Pagination Utilities:**
```typescript
const { paginatedItems, pagination } = calculatePagination(
  items, page, pageSize, maxPageSize
);
const header = formatPaginationHeader(pagination, "docs");
const hint = formatMorePagesHint(pagination, "docs");
```

**Usage:** Import from `./primitives`:
```typescript
import {
  calculatePagination, formatDate,
  ValidationResult, ok, err
} from "./primitives";
```

---

## Data Storage

### Cloudflare KV (DOCS_KV)

**Key Patterns:**

| Key Pattern | Purpose | TTL |
|-------------|---------|-----|
| `docs:index` | Document metadata list | - |
| `docs:content:{title}` | Document content | - |
| `thread:context:{ch}:{ts}` | Thread summaries | 7 days |
| `cache:response:{hash}` | Claude response cache | 1 hour |
| `event:{id}` | Event deduplication | 1 minute |
| `ratelimit:{type}:{user}` | Rate limit counter | 60 seconds |
| `checkin:last:{user}` | Last check-in time | 14 days |

### Cloudflare Vectorize

**Index:** `chorus-docs`
- **Dimensions:** 768 (bge-base-en-v1.5)
- **Chunk IDs:** `doc:{title}:chunk:{index}`
- **Metadata:** title, chunk index, context prefix

---

## External Integrations

### Slack API

| Endpoint | Purpose |
|----------|---------|
| `conversations.replies` | Fetch thread history |
| `chat.postMessage` | Send messages |
| `chat.update` | Edit messages |
| `reactions.add` | Add emoji reactions |
| `conversations.open` | Start DM |
| `auth.test` | Get bot user ID (cached 1 hour) |

**Authentication:** Bot token (`xoxb-...`) in header
**Verification:** HMAC-SHA256 with 5-minute timestamp window

### Anthropic Claude API

- **Model:** `claude-opus-4-5-20251101`
- **Endpoint:** `https://api.anthropic.com/v1/messages`
- **Timeout:** 25 seconds (Cloudflare limit is 30s)
- **Features:** Streaming, prompt caching, token counting

### Cloudflare Workers AI

- **Model:** `@cf/baai/bge-base-en-v1.5`
- **Purpose:** Generate 768-dimensional embeddings

### Linear GraphQL API

- **Endpoint:** `https://api.linear.app/graphql`
- **Purpose:** Fetch R&D Priorities for Claude's system prompt (cached with 25-hour TTL, warmed daily)

---

## Observability

### Honeycomb Integration

Traces exported via native OpenTelemetry:

**Metrics Tracked:**
- Token usage (input, output, cached)
- API latencies (Claude, Slack, KB retrieval)
- Cache hit rates
- Error categories
- Rate limiting decisions
- User feedback (reactions)

**Configuration:**
```toml
[observability.traces]
enabled = true
destinations = ["honeycomb-traces"]

[observability.logs]
enabled = true
destinations = ["honeycomb-logs"]
```

---

## Testing

### Test Structure

| Suite | Config | Purpose |
|-------|--------|---------|
| Unit | `vitest.unit.config.ts` | Pure function tests |
| Integration | `vitest.config.ts` | Full handler flow |
| Quality | `vitest.quality.config.ts` | Golden response regression |

### Running Tests

```bash
npm test              # All tests
npm run test:unit     # Unit only
npm run test:watch    # Watch mode
npm run test:quality  # Golden tests
```

---

## Deployment

### Cloudflare Worker Bindings

```toml
# KV Namespace
[[kv_namespaces]]
binding = "DOCS_KV"

# Vector Search
[[vectorize]]
binding = "VECTORIZE"
index_name = "chorus-docs"

# Embeddings AI
[ai]
binding = "AI"

# Scheduled Cron
[triggers]
crons = ["0 14 * * *"]  # 9 AM ET
```

### Secrets (via `wrangler secret put`)

| Secret | Purpose |
|--------|---------|
| `SLACK_BOT_TOKEN` | OAuth token |
| `SLACK_SIGNING_SECRET` | Request verification |
| `ANTHROPIC_API_KEY` | Claude API |
| `HONEYCOMB_API_KEY` | Trace export |
| `LINEAR_API_KEY` | Linear sync |
| `DOCS_API_KEY` | REST API protection |

### Deploy Command

```bash
npm run deploy  # Runs typecheck, tests, then wrangler deploy
```

---

## Rate Limiting

### User-Level Limits (per minute)

| Operation | Limit |
|-----------|-------|
| Doc operations | 10/min |
| Search | 20/min |
| Other commands | 30/min |

### Document Limits

| Limit | Value |
|-------|-------|
| Per document | 50 KB |
| Total KB | 200 KB |

### API Timeouts

| Service | Timeout |
|---------|---------|
| Claude API | 25 seconds |
| File download | 10 seconds |
| Default fetch | 3 retries, exponential backoff |

---

## Error Handling

### Typed Error Classes

```typescript
// HTTP errors (http-utils.ts)
type FetchError =
  | NetworkError
  | RateLimitError
  | ServerError
  | HttpError
  | TimeoutError;

// Slack errors (slack.ts)
class SignatureVerificationError extends Error {}
class SlackApiError extends Error {}
```

### Recovery Strategy

| Failure | Response |
|---------|----------|
| Slack API error | Graceful fallback, continue processing |
| Claude timeout | User-friendly timeout message |
| File extraction error | Report individual errors, continue with others |
| Rate limit hit | Return rate limit message |

All errors are categorized and sent to Honeycomb with full context for debugging.
