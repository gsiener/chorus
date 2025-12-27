/**
 * Document management for Chorus
 *
 * Stores and retrieves knowledge base documents via KV.
 * Documents are added/removed via Slack commands.
 */

import type { Env } from "./types";
import { indexDocument, removeDocumentFromIndex } from "./embeddings";

const DOCS_INDEX_KEY = "docs:index";
const DOCS_PREFIX = "docs:content:";

// Limits
const MAX_DOC_SIZE = 50000; // 50KB per document
const MAX_TOTAL_KB_SIZE = 200000; // 200KB total knowledge base
const MAX_TITLE_LENGTH = 100;

export interface DocMetadata {
  title: string;
  addedBy: string;
  addedAt: string;
  charCount: number;
}

export interface DocsIndex {
  documents: DocMetadata[];
}

/**
 * Sanitize a document title for use as a KV key
 * - Removes dangerous characters
 * - Limits length
 * - Normalizes whitespace
 */
function sanitizeTitle(title: string): string {
  return title
    .slice(0, MAX_TITLE_LENGTH)
    .replace(/[^\w\s-]/g, '') // Remove special characters except hyphen
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Collapse multiple hyphens
    .replace(/^-|-$/g, '') // Remove leading/trailing hyphens
    .toLowerCase();
}

/**
 * Generate a safe KV key from a title
 */
function titleToKey(title: string): string {
  const sanitized = sanitizeTitle(title);
  if (!sanitized) {
    throw new Error('Invalid title: results in empty key after sanitization');
  }
  return DOCS_PREFIX + sanitized;
}

/**
 * Get the docs index from KV
 */
async function getIndex(env: Env): Promise<DocsIndex> {
  const data = await env.DOCS_KV.get(DOCS_INDEX_KEY);
  if (!data) {
    return { documents: [] };
  }
  return JSON.parse(data) as DocsIndex;
}

/**
 * Save the docs index to KV
 */
async function saveIndex(env: Env, index: DocsIndex): Promise<void> {
  await env.DOCS_KV.put(DOCS_INDEX_KEY, JSON.stringify(index));
}

/**
 * Add a document to the knowledge base
 */
export async function addDocument(
  env: Env,
  title: string,
  content: string,
  addedBy: string
): Promise<{ success: boolean; message: string }> {
  // Validate title
  if (!title || title.trim().length === 0) {
    return { success: false, message: 'Title cannot be empty.' };
  }

  if (title.length > MAX_TITLE_LENGTH) {
    return { success: false, message: `Title too long (max ${MAX_TITLE_LENGTH} chars).` };
  }

  // Validate content size
  if (content.length > MAX_DOC_SIZE) {
    return {
      success: false,
      message: `Document too large (${content.length} chars). Max size is ${MAX_DOC_SIZE} chars.`,
    };
  }

  const index = await getIndex(env);

  // Check total knowledge base size
  const currentTotal = index.documents.reduce((sum, d) => sum + d.charCount, 0);
  if (currentTotal + content.length > MAX_TOTAL_KB_SIZE) {
    return {
      success: false,
      message: `Knowledge base full. Current: ${currentTotal} chars, limit: ${MAX_TOTAL_KB_SIZE} chars. Remove some documents first.`,
    };
  }

  // Check if doc with this title already exists
  const existing = index.documents.find(
    (d) => d.title.toLowerCase() === title.toLowerCase()
  );
  if (existing) {
    return {
      success: false,
      message: `A document titled "${title}" already exists. Remove it first or use a different title.`,
    };
  }

  // Store the content with sanitized key
  const key = titleToKey(title);
  await env.DOCS_KV.put(key, content);

  // Update the index
  index.documents.push({
    title,
    addedBy,
    addedAt: new Date().toISOString(),
    charCount: content.length,
  });
  await saveIndex(env, index);

  // Index for semantic search (non-blocking)
  let indexMessage = "";
  try {
    const indexResult = await indexDocument(title, content, env);
    if (indexResult.success) {
      indexMessage = ` Indexed in ${indexResult.chunksIndexed} chunk${indexResult.chunksIndexed === 1 ? "" : "s"} for semantic search.`;
    } else {
      console.error(`Failed to index document: ${indexResult.message}`);
    }
  } catch (error) {
    console.error("Error indexing document:", error);
  }

  return {
    success: true,
    message: `Added "${title}" (${content.length} chars) to the knowledge base.${indexMessage}`,
  };
}

/**
 * Remove a document from the knowledge base
 */
export async function removeDocument(
  env: Env,
  title: string
): Promise<{ success: boolean; message: string }> {
  const index = await getIndex(env);

  const docIndex = index.documents.findIndex(
    (d) => d.title.toLowerCase() === title.toLowerCase()
  );

  if (docIndex === -1) {
    return {
      success: false,
      message: `No document titled "${title}" found.`,
    };
  }

  // Remove from KV using the original title from index (for correct key generation)
  const removed = index.documents[docIndex];
  const key = titleToKey(removed.title);
  await env.DOCS_KV.delete(key);

  // Update index
  index.documents.splice(docIndex, 1);
  await saveIndex(env, index);

  // Remove from vector index (non-blocking)
  try {
    await removeDocumentFromIndex(removed.title, env);
  } catch (error) {
    console.error("Error removing document from vector index:", error);
  }

  return {
    success: true,
    message: `Removed "${removed.title}" from the knowledge base.`,
  };
}

/**
 * List all documents in the knowledge base
 */
export async function listDocuments(env: Env): Promise<string> {
  const index = await getIndex(env);

  if (index.documents.length === 0) {
    return "The knowledge base is empty. Add documents with:\n`@Chorus add doc \"Title\": Your content here...`";
  }

  const lines = index.documents.map((doc) => {
    const date = new Date(doc.addedAt).toLocaleDateString();
    return `• *${doc.title}* (${doc.charCount} chars, added ${date})`;
  });

  return `*Knowledge Base* (${index.documents.length} docs)\n\n${lines.join("\n")}`;
}

/**
 * Get all documents combined as knowledge base for Claude
 * Uses parallel KV reads for better performance
 */
export async function getKnowledgeBase(env: Env): Promise<string | null> {
  const index = await getIndex(env);

  if (index.documents.length === 0) {
    return null;
  }

  // Batch read all documents in parallel (fixes N+1 query issue)
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
