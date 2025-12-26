/**
 * Document management for Chorus
 *
 * Stores and retrieves knowledge base documents via KV.
 * Documents are added/removed via Slack commands.
 */

import type { Env } from "./types";

const DOCS_INDEX_KEY = "docs:index";
const DOCS_PREFIX = "docs:content:";

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
  const index = await getIndex(env);

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

  // Store the content
  const key = DOCS_PREFIX + title.toLowerCase().replace(/\s+/g, "-");
  await env.DOCS_KV.put(key, content);

  // Update the index
  index.documents.push({
    title,
    addedBy,
    addedAt: new Date().toISOString(),
    charCount: content.length,
  });
  await saveIndex(env, index);

  return {
    success: true,
    message: `Added "${title}" (${content.length} chars) to the knowledge base.`,
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

  // Remove from KV
  const key = DOCS_PREFIX + title.toLowerCase().replace(/\s+/g, "-");
  await env.DOCS_KV.delete(key);

  // Update index
  const removed = index.documents.splice(docIndex, 1)[0];
  await saveIndex(env, index);

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
 */
export async function getKnowledgeBase(env: Env): Promise<string | null> {
  const index = await getIndex(env);

  if (index.documents.length === 0) {
    return null;
  }

  const docs: string[] = [];

  for (const meta of index.documents) {
    const key = DOCS_PREFIX + meta.title.toLowerCase().replace(/\s+/g, "-");
    const content = await env.DOCS_KV.get(key);
    if (content) {
      docs.push(`## ${meta.title}\n\n${content}`);
    }
  }

  return docs.join("\n\n---\n\n");
}
