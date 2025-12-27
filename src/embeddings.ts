/**
 * Embedding pipeline for semantic document search
 *
 * Uses Cloudflare Workers AI for embeddings and Vectorize for storage.
 * Implements chunking with contextual prefixes for better retrieval.
 */

import type { Env } from "./types";

// Chunking configuration
const CHUNK_SIZE = 1000; // characters per chunk
const CHUNK_OVERLAP = 200; // overlap between chunks
const MIN_CHUNK_SIZE = 100; // don't create tiny chunks

// Embedding model: bge-base-en-v1.5 produces 768-dimensional vectors
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export interface DocumentChunk {
  id: string; // format: "doc:{sanitized-title}:chunk:{index}"
  title: string;
  chunkIndex: number;
  content: string;
  contextPrefix: string; // describes what the chunk is about
}

export interface SearchResult {
  title: string;
  content: string;
  score: number;
}

/**
 * Create a contextual prefix for a chunk to improve retrieval quality.
 * This follows Anthropic's Contextual Retrieval approach.
 */
function createContextPrefix(title: string, chunkIndex: number, totalChunks: number): string {
  if (totalChunks === 1) {
    return `This is the full content of the document "${title}".`;
  }
  if (chunkIndex === 0) {
    return `This is the beginning of the document "${title}".`;
  }
  if (chunkIndex === totalChunks - 1) {
    return `This is the end of the document "${title}".`;
  }
  return `This is part ${chunkIndex + 1} of ${totalChunks} from the document "${title}".`;
}

/**
 * Sanitize title to create a valid vector ID component
 */
function sanitizeTitleForId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

/**
 * Split a document into overlapping chunks
 */
export function chunkDocument(title: string, content: string): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  const sanitizedTitle = sanitizeTitleForId(title);

  // If content is small enough, return as single chunk
  if (content.length <= CHUNK_SIZE) {
    return [
      {
        id: `doc:${sanitizedTitle}:chunk:0`,
        title,
        chunkIndex: 0,
        content,
        contextPrefix: createContextPrefix(title, 0, 1),
      },
    ];
  }

  // Split into chunks with overlap
  let start = 0;
  let chunkIndex = 0;

  while (start < content.length) {
    let end = start + CHUNK_SIZE;

    // Try to break at a sentence or paragraph boundary
    if (end < content.length) {
      // Look for paragraph break first
      const paragraphBreak = content.lastIndexOf("\n\n", end);
      if (paragraphBreak > start + MIN_CHUNK_SIZE) {
        end = paragraphBreak + 2;
      } else {
        // Look for sentence break
        const sentenceBreak = content.lastIndexOf(". ", end);
        if (sentenceBreak > start + MIN_CHUNK_SIZE) {
          end = sentenceBreak + 2;
        }
      }
    } else {
      end = content.length;
    }

    const chunkContent = content.slice(start, end).trim();

    if (chunkContent.length >= MIN_CHUNK_SIZE || chunks.length === 0) {
      chunks.push({
        id: `doc:${sanitizedTitle}:chunk:${chunkIndex}`,
        title,
        chunkIndex,
        content: chunkContent,
        contextPrefix: "", // Will be set after we know total chunks
      });
      chunkIndex++;
    }

    // Move start position, accounting for overlap
    start = end - CHUNK_OVERLAP;
    if (start >= content.length) break;
  }

  // Now set contextual prefixes with correct total count
  const totalChunks = chunks.length;
  for (let i = 0; i < chunks.length; i++) {
    chunks[i].contextPrefix = createContextPrefix(title, i, totalChunks);
  }

  return chunks;
}

/**
 * Generate embeddings for text using Workers AI
 */
export async function generateEmbedding(text: string, env: Env): Promise<number[]> {
  const result = await env.AI.run(EMBEDDING_MODEL, {
    text: [text],
  });

  // Workers AI returns { data: [[...embedding]] } for text input
  // Type narrow to handle union type (sync response vs async response)
  if ("data" in result && Array.isArray(result.data) && result.data[0]) {
    return result.data[0];
  }

  throw new Error("Failed to generate embedding: unexpected response format");
}

/**
 * Index a document by chunking it and storing embeddings in Vectorize
 */
export async function indexDocument(
  title: string,
  content: string,
  env: Env
): Promise<{ success: boolean; chunksIndexed: number; message: string }> {
  try {
    const chunks = chunkDocument(title, content);

    // Generate embeddings for all chunks
    const vectors: VectorizeVector[] = [];

    for (const chunk of chunks) {
      // Combine context prefix with content for better embedding
      const textToEmbed = `${chunk.contextPrefix}\n\n${chunk.content}`;
      const embedding = await generateEmbedding(textToEmbed, env);

      vectors.push({
        id: chunk.id,
        values: embedding,
        metadata: {
          title: chunk.title,
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
          contextPrefix: chunk.contextPrefix,
        },
      });
    }

    // Insert all vectors into Vectorize
    if (vectors.length > 0) {
      await env.VECTORIZE.insert(vectors);
    }

    return {
      success: true,
      chunksIndexed: vectors.length,
      message: `Indexed "${title}" in ${vectors.length} chunk${vectors.length === 1 ? "" : "s"}.`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      chunksIndexed: 0,
      message: `Failed to index "${title}": ${errorMessage}`,
    };
  }
}

/**
 * Remove a document's vectors from the index
 */
export async function removeDocumentFromIndex(
  title: string,
  env: Env
): Promise<{ success: boolean; message: string }> {
  try {
    const sanitizedTitle = sanitizeTitleForId(title);

    // We need to delete all chunks for this document
    // Vectorize doesn't support wildcard deletes, so we try to delete
    // a reasonable number of potential chunk IDs
    const idsToDelete: string[] = [];
    for (let i = 0; i < 100; i++) {
      idsToDelete.push(`doc:${sanitizedTitle}:chunk:${i}`);
    }

    await env.VECTORIZE.deleteByIds(idsToDelete);

    return {
      success: true,
      message: `Removed vectors for "${title}" from search index.`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Failed to remove vectors for "${title}": ${errorMessage}`,
    };
  }
}

/**
 * Search for relevant document chunks
 */
export async function searchDocuments(
  query: string,
  env: Env,
  limit: number = 5
): Promise<SearchResult[]> {
  try {
    // Generate embedding for the query
    const queryEmbedding = await generateEmbedding(query, env);

    // Search Vectorize
    const results = await env.VECTORIZE.query(queryEmbedding, {
      topK: limit,
      returnMetadata: "all",
    });

    if (!results.matches || results.matches.length === 0) {
      return [];
    }

    // Convert to SearchResult format
    return results.matches.map((match) => ({
      title: (match.metadata?.title as string) || "Unknown",
      content: (match.metadata?.content as string) || "",
      score: match.score,
    }));
  } catch (error) {
    console.error("Search error:", error);
    return [];
  }
}

/**
 * Format search results for inclusion in Claude's context
 */
export function formatSearchResultsForContext(results: SearchResult[]): string | null {
  if (results.length === 0) {
    return null;
  }

  const sections = results.map((r, i) => {
    const scorePercent = Math.round(r.score * 100);
    return `### ${r.title} (${scorePercent}% match)\n${r.content}`;
  });

  return `## Relevant Knowledge Base Excerpts\n\n${sections.join("\n\n---\n\n")}`;
}
