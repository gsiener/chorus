/**
 * Thread context management for conversation memory
 *
 * Stores and retrieves thread context to maintain continuity
 * in long conversations and avoid hitting token limits.
 */

import type { Env, ThreadContext, ClaudeMessage } from "./types";

// KV key prefix for thread context
const THREAD_CONTEXT_PREFIX = "thread:context:";
const THREAD_CONTEXT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

// Threshold for summarization (when thread has more messages than this, summarize)
const SUMMARIZATION_THRESHOLD = 8;

// Maximum messages to keep in full detail (recent messages)
const RECENT_MESSAGES_TO_KEEP = 4;

/**
 * Get thread context from KV
 */
export async function getThreadContext(
  channel: string,
  threadTs: string,
  env: Env
): Promise<ThreadContext | null> {
  const key = `${THREAD_CONTEXT_PREFIX}${channel}:${threadTs}`;
  const data = await env.DOCS_KV.get(key);

  if (!data) {
    return null;
  }

  return JSON.parse(data) as ThreadContext;
}

/**
 * Save thread context to KV
 */
export async function saveThreadContext(
  context: ThreadContext,
  env: Env
): Promise<void> {
  const key = `${THREAD_CONTEXT_PREFIX}${context.channel}:${context.threadTs}`;
  await env.DOCS_KV.put(key, JSON.stringify(context), {
    expirationTtl: THREAD_CONTEXT_TTL_SECONDS,
  });
}

/**
 * Extract key topics from a conversation
 */
function extractKeyTopics(messages: ClaudeMessage[]): string[] {
  const topics = new Set<string>();

  // Simple extraction: look for quoted terms and capitalized phrases
  for (const msg of messages) {
    // Extract quoted terms
    const quotedMatches = msg.content.match(/"([^"]+)"/g);
    if (quotedMatches) {
      quotedMatches.forEach(m => topics.add(m.replace(/"/g, "")));
    }

    // Extract initiative-like references (capitalized multi-word phrases)
    const capitalizedMatches = msg.content.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g);
    if (capitalizedMatches) {
      capitalizedMatches.slice(0, 3).forEach(m => topics.add(m));
    }
  }

  return Array.from(topics).slice(0, 10);
}

/**
 * Generate a summary of earlier messages using a simple approach
 * (In production, you might use Claude to generate this summary)
 */
function generateSimpleSummary(messages: ClaudeMessage[]): string {
  if (messages.length === 0) return "";

  // Get first user question and assistant's response as summary
  const userMessages = messages.filter(m => m.role === "user");
  const assistantMessages = messages.filter(m => m.role === "assistant");

  const parts: string[] = [];

  if (userMessages.length > 0) {
    const firstQuestion = userMessages[0].content.slice(0, 200);
    parts.push(`User initially asked about: ${firstQuestion}`);
  }

  if (assistantMessages.length > 0) {
    const keyPoints = assistantMessages
      .slice(0, 2)
      .map(m => m.content.slice(0, 150))
      .join("; ");
    parts.push(`Key points discussed: ${keyPoints}`);
  }

  return parts.join(". ");
}

/**
 * Process messages for a thread, applying summarization if needed
 * Returns messages optimized for context window
 */
export function processMessagesForContext(
  messages: ClaudeMessage[],
  existingContext: ThreadContext | null
): { messages: ClaudeMessage[]; contextPrefix: string | null; wasTruncated: boolean } {
  // If thread is short, use all messages
  if (messages.length <= SUMMARIZATION_THRESHOLD) {
    return { messages, contextPrefix: null, wasTruncated: false };
  }

  // Split into earlier and recent messages
  const splitPoint = messages.length - RECENT_MESSAGES_TO_KEEP;
  const earlierMessages = messages.slice(0, splitPoint);
  const recentMessages = messages.slice(splitPoint);

  // Generate summary of earlier messages
  let summary: string;

  if (existingContext?.summary && existingContext.messageCount >= splitPoint) {
    // Use existing summary if it covers enough of the conversation
    summary = existingContext.summary;
  } else {
    // Generate new summary
    summary = generateSimpleSummary(earlierMessages);
  }

  // Create context prefix for the system prompt
  // Include persona reinforcement for long threads (research shows persona drift increases with conversation length)
  const personaReminder = "Remember: You are Chorus, a professional product leadership advisor. Stay grounded in that role.";
  const contextPrefix = `## Previous Conversation Context\n\n${summary}\n\nKey topics: ${extractKeyTopics(earlierMessages).join(", ")}\n\n*${personaReminder}*`;

  return { messages: recentMessages, contextPrefix, wasTruncated: true };
}

/**
 * Update thread context after a conversation
 */
export async function updateThreadContext(
  channel: string,
  threadTs: string,
  messages: ClaudeMessage[],
  initiativesMentioned: string[],
  env: Env,
  existingContext?: ThreadContext | null,
): Promise<void> {
  const resolved = existingContext ?? await getThreadContext(channel, threadTs, env);

  // Extract topics from all messages
  const keyTopics = extractKeyTopics(messages);

  // Merge with existing topics
  const allTopics = new Set([
    ...(resolved?.keyTopics || []),
    ...keyTopics,
  ]);

  // Merge initiatives mentioned
  const allInitiatives = new Set([
    ...(resolved?.initiativesMentioned || []),
    ...initiativesMentioned,
  ]);

  // Generate summary if thread is long enough
  let summary = resolved?.summary;
  if (messages.length >= SUMMARIZATION_THRESHOLD) {
    const splitPoint = messages.length - RECENT_MESSAGES_TO_KEEP;
    summary = generateSimpleSummary(messages.slice(0, splitPoint));
  }

  const context: ThreadContext = {
    threadTs,
    channel,
    summary,
    keyTopics: Array.from(allTopics).slice(0, 15),
    initiativesMentioned: Array.from(allInitiatives),
    messageCount: messages.length,
    lastUpdatedAt: new Date().toISOString(),
  };

  await saveThreadContext(context, env);
}

/**
 * Check if thread context exists and is relevant
 */
export function shouldUseThreadContext(
  messages: ClaudeMessage[],
  existingContext: ThreadContext | null
): boolean {
  // Use context if we have it and thread is long
  return (
    existingContext !== null &&
    messages.length > SUMMARIZATION_THRESHOLD
  );
}
