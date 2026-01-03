/**
 * Document management with typed errors using Effect
 */

import { Effect, Context, Option, pipe } from "effect";
import type { Env } from "./types";
import { indexDocument, removeDocumentFromIndex } from "./embeddings";

// Constants
const DOCS_INDEX_KEY = "docs:index";
const DOCS_PREFIX = "docs:content:";
const MAX_DOC_SIZE = 50000;
const MAX_TOTAL_KB_SIZE = 200000;
const MAX_TITLE_LENGTH = 100;
const DEFAULT_DOC_PAGE_SIZE = 10;

// Typed error classes

export class EmptyTitleError extends Error {
  readonly _tag = "EmptyTitleError" as const;
  constructor() {
    super("Title cannot be empty");
    this.name = "EmptyTitleError";
  }
}

export class TitleTooLongError extends Error {
  readonly _tag = "TitleTooLongError" as const;
  constructor(
    public readonly length: number,
    public readonly maxLength: number
  ) {
    super(`Title too long (${length} chars). Max is ${maxLength} chars.`);
    this.name = "TitleTooLongError";
  }
}

export class DocumentTooLargeError extends Error {
  readonly _tag = "DocumentTooLargeError" as const;
  constructor(
    public readonly size: number,
    public readonly maxSize: number
  ) {
    super(`Document too large (${size} chars). Max size is ${maxSize} chars.`);
    this.name = "DocumentTooLargeError";
  }
}

export class KnowledgeBaseFullError extends Error {
  readonly _tag = "KnowledgeBaseFullError" as const;
  constructor(
    public readonly currentSize: number,
    public readonly maxSize: number
  ) {
    super(`Knowledge base full. Current: ${currentSize} chars, limit: ${maxSize} chars.`);
    this.name = "KnowledgeBaseFullError";
  }
}

export class DuplicateTitleError extends Error {
  readonly _tag = "DuplicateTitleError" as const;
  constructor(public readonly title: string) {
    super(`A document titled "${title}" already exists.`);
    this.name = "DuplicateTitleError";
  }
}

export class DocumentNotFoundError extends Error {
  readonly _tag = "DocumentNotFoundError" as const;
  constructor(public readonly title: string) {
    super(`No document titled "${title}" found.`);
    this.name = "DocumentNotFoundError";
  }
}

export class InvalidTitleError extends Error {
  readonly _tag = "InvalidTitleError" as const;
  constructor(public readonly title: string) {
    super(`Invalid title: "${title}" results in empty key after sanitization`);
    this.name = "InvalidTitleError";
  }
}

export type DocsError =
  | EmptyTitleError
  | TitleTooLongError
  | DocumentTooLargeError
  | KnowledgeBaseFullError
  | DuplicateTitleError
  | DocumentNotFoundError
  | InvalidTitleError;

// Types

export interface DocMetadata {
  title: string;
  addedBy: string;
  addedAt: string;
  charCount: number;
}

export interface DocsIndex {
  documents: DocMetadata[];
}

// Helpers

function sanitizeTitle(title: string): string {
  return title
    .slice(0, MAX_TITLE_LENGTH)
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function titleToKey(title: string): string {
  const sanitized = sanitizeTitle(title);
  if (!sanitized) {
    throw new Error("Invalid title: results in empty key after sanitization");
  }
  return DOCS_PREFIX + sanitized;
}

async function getIndex(env: Env): Promise<DocsIndex> {
  const data = await env.DOCS_KV.get(DOCS_INDEX_KEY);
  if (!data) {
    return { documents: [] };
  }
  return JSON.parse(data) as DocsIndex;
}

async function saveIndex(env: Env, index: DocsIndex): Promise<void> {
  await env.DOCS_KV.put(DOCS_INDEX_KEY, JSON.stringify(index));
}

// Main functions

export async function addDocument(
  env: Env,
  title: string,
  content: string,
  addedBy: string
): Promise<{ success: boolean; message: string }> {
  if (!title || title.trim().length === 0) {
    return { success: false, message: "Title cannot be empty." };
  }

  if (title.length > MAX_TITLE_LENGTH) {
    return { success: false, message: `Title too long (max ${MAX_TITLE_LENGTH} chars).` };
  }

  if (content.length > MAX_DOC_SIZE) {
    return {
      success: false,
      message: `Document too large (${content.length} chars). Max size is ${MAX_DOC_SIZE} chars.`,
    };
  }

  const index = await getIndex(env);

  const currentTotal = index.documents.reduce((sum, d) => sum + d.charCount, 0);
  if (currentTotal + content.length > MAX_TOTAL_KB_SIZE) {
    return {
      success: false,
      message: `Knowledge base full. Current: ${currentTotal} chars, limit: ${MAX_TOTAL_KB_SIZE} chars. Remove some documents first.`,
    };
  }

  const existing = index.documents.find(
    (d) => d.title.toLowerCase() === title.toLowerCase()
  );
  if (existing) {
    return {
      success: false,
      message: `A document titled "${title}" already exists. Remove it first or use a different title.`,
    };
  }

  const key = titleToKey(title);
  await env.DOCS_KV.put(key, content);

  index.documents.push({
    title,
    addedBy,
    addedAt: new Date().toISOString(),
    charCount: content.length,
  });
  await saveIndex(env, index);

  let indexMessage = "";
  try {
    const indexResult = await indexDocument(title, content, env);
    if (indexResult.success) {
      indexMessage = ` Indexed in ${indexResult.chunksIndexed} chunk${indexResult.chunksIndexed === 1 ? "" : "s"} for semantic search.`;
    }
  } catch {
    // Ignore indexing errors
  }

  return {
    success: true,
    message: `Added "${title}" (${content.length} chars) to the knowledge base.${indexMessage}`,
  };
}

export async function removeDocument(
  env: Env,
  title: string
): Promise<{ success: boolean; message: string }> {
  const index = await getIndex(env);

  const docIndex = index.documents.findIndex(
    (d) => d.title.toLowerCase() === title.toLowerCase()
  );

  if (docIndex === -1) {
    return { success: false, message: `No document titled "${title}" found.` };
  }

  const removed = index.documents[docIndex];
  const key = titleToKey(removed.title);
  await env.DOCS_KV.delete(key);

  index.documents.splice(docIndex, 1);
  await saveIndex(env, index);

  try {
    await removeDocumentFromIndex(removed.title, env);
  } catch {
    // Ignore
  }

  return { success: true, message: `Removed "${removed.title}" from the knowledge base.` };
}

export interface DocPaginationOptions {
  page?: number;
  pageSize?: number;
}

export async function listDocuments(
  env: Env,
  pagination?: DocPaginationOptions
): Promise<string> {
  const index = await getIndex(env);

  if (index.documents.length === 0) {
    return "The knowledge base is empty. Add documents with:\n`@Chorus add doc \"Title\": Your content here...`";
  }

  const totalItems = index.documents.length;
  const page = Math.max(1, pagination?.page ?? 1);
  const pageSize = Math.max(1, Math.min(50, pagination?.pageSize ?? DEFAULT_DOC_PAGE_SIZE));
  const totalPages = Math.ceil(totalItems / pageSize);

  const startIndex = (page - 1) * pageSize;
  const paginatedDocs = index.documents.slice(startIndex, startIndex + pageSize);
  const hasMore = page < totalPages;

  const lines = paginatedDocs.map((doc) => {
    const date = new Date(doc.addedAt).toLocaleDateString();
    return `• *${doc.title}* (${doc.charCount} chars, added ${date})`;
  });

  const headerParts = ["*Knowledge Base*"];
  if (totalPages > 1) {
    headerParts.push(`(page ${page}/${totalPages}, ${totalItems} docs)`);
  } else {
    headerParts.push(`(${totalItems} docs)`);
  }

  let result = `${headerParts.join(" ")}\n\n${lines.join("\n")}`;

  if (hasMore) {
    result += `\n\n_Use \`docs --page ${page + 1}\` for more_`;
  }

  return result;
}

export async function getKnowledgeBase(env: Env): Promise<string | null> {
  const index = await getIndex(env);

  if (index.documents.length === 0) {
    return null;
  }

  const contentPromises = index.documents.map(async (meta) => {
    const key = titleToKey(meta.title);
    const content = await env.DOCS_KV.get(key);
    return { title: meta.title, content };
  });

  const results = await Promise.all(contentPromises);

  const docs = results
    .filter((r) => r.content !== null)
    .map((r) => `## ${r.title}\n\n${r.content}`);

  if (docs.length === 0) {
    return null;
  }

  return docs.join("\n\n---\n\n");
}

export async function getRandomDocument(
  env: Env
): Promise<{ success: boolean; title?: string; content?: string; message: string }> {
  const index = await getIndex(env);

  if (index.documents.length === 0) {
    return { success: false, message: "The knowledge base is empty. Add some documents first!" };
  }

  const randomIndex = Math.floor(Math.random() * index.documents.length);
  const doc = index.documents[randomIndex];
  const key = titleToKey(doc.title);
  const content = await env.DOCS_KV.get(key);

  if (!content) {
    return { success: false, message: `Couldn't retrieve document "${doc.title}".` };
  }

  return {
    success: true,
    title: doc.title,
    content,
    message: `🎲 *${doc.title}*\n\n${content}`,
  };
}

export async function backfillDocuments(
  env: Env
): Promise<{ success: boolean; message: string; indexed: number; failed: number }> {
  const index = await getIndex(env);

  if (index.documents.length === 0) {
    return { success: true, message: "No documents to backfill.", indexed: 0, failed: 0 };
  }

  let indexed = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const doc of index.documents) {
    const key = titleToKey(doc.title);
    const content = await env.DOCS_KV.get(key);

    if (!content) {
      errors.push(`${doc.title}: content not found`);
      failed++;
      continue;
    }

    try {
      const result = await indexDocument(doc.title, content, env);
      if (result.success) {
        indexed++;
      } else {
        errors.push(`${doc.title}: ${result.message}`);
        failed++;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`${doc.title}: ${msg}`);
      failed++;
    }
  }

  const message = `Backfill complete. Indexed: ${indexed}, Failed: ${failed}${errors.length > 0 ? `\n\nErrors:\n• ${errors.slice(0, 5).join("\n• ")}${errors.length > 5 ? `\n... and ${errors.length - 5} more` : ""}` : ""}`;

  return { success: failed === 0, message, indexed, failed };
}
