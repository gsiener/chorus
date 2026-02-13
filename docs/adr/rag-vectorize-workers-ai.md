---
title: RAG with Vectorize and Workers AI
status: accepted
date: 2025-12-27
updated: 2026-01-04
tags: [rag, vectorize, embeddings, workers-ai, knowledge-base]
---

# ADR: RAG with Vectorize and Workers AI

## Context

Chorus maintains a knowledge base of internal documents. Users can add documents and expect Chorus to reference them when answering questions. We need a retrieval strategy that surfaces relevant context without exceeding Claude's context window.

## Decision

Use Cloudflare Vectorize for vector storage and Workers AI (`bge-base-en-v1.5`) for embeddings, following Anthropic's Contextual Retrieval chunking pattern. However, for the current small corpus, include full document context in every prompt rather than relying on semantic retrieval.

## Change History

### 2025-12-27 — Full RAG implementation (PDD-10 through PDD-15)

**Commits:** `d1dda40` through `17be362` (13-minute session)

Built the complete RAG pipeline in a single session:
- **Chunking** (`embeddings.ts`): 1000-char chunks with 200-char overlap, breaking at paragraph then sentence boundaries
- **Context prefix**: Each chunk includes "This is part X of Y from document Z" — Anthropic's Contextual Retrieval pattern for improved relevance
- **Embedding model**: `@cf/baai/bge-base-en-v1.5` via Workers AI (768 dimensions)
- **Vector storage**: Cloudflare Vectorize index `chorus-docs`
- **Search**: Cosine similarity with top-K retrieval

### 2026-01-04 — Revert to full-document context (PDD-48)

**Commit:** `5a5cb1e`

With only ~5 documents in the KB (well under Claude's 200K context window), RAG retrieval was less effective than including all documents in full. Changed `claude.ts` to load the entire knowledge base into the system prompt.

The RAG infrastructure (Vectorize index, embedding generation, chunk storage) remains in place for when the corpus grows large enough to benefit from selective retrieval. The `searchDocuments()` function still works and is exposed via the `/chorus-search` slash command.

## Architecture

```
Document Add Flow:
  doc → chunkDocument() → chunks[]
                            │
                    ┌───────┴───────┐
                    ▼               ▼
              Workers AI      KV Storage
          (bge-base-en-v1.5)  (docs:content:*)
                    │
                    ▼
              Vectorize
          (chorus-docs index)

Current Query Flow (small corpus):
  mention → load ALL docs from KV → include in system prompt

Future Query Flow (large corpus):
  mention → embed query → Vectorize search → top-K chunks → include in prompt
```

## Decisions

### Full context over RAG for small corpus

Including all documents produces better answers than chunk retrieval when the total KB fits comfortably in the context window. RAG introduces retrieval errors (missed relevant chunks, irrelevant chunks included) that aren't worth the tradeoff at our current scale.

The crossover point is roughly when total KB exceeds ~50KB of text — at that point, selective retrieval becomes necessary to stay within token budgets and maintain response quality.

### Contextual Retrieval pattern

Each chunk is prefixed with document-level context so it's interpretable without the surrounding text. This follows Anthropic's published pattern and improves retrieval relevance when we do use vector search.

### Workers AI for embeddings

Using Cloudflare's built-in AI binding avoids an external API call and its associated latency/cost. The `bge-base-en-v1.5` model produces quality embeddings for general English text at 768 dimensions.
