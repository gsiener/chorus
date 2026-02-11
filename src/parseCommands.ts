/**
 * Command parsers for Chorus Slack bot
 *
 * These parsers extract structured commands from Slack message text.
 * Each parser returns null if the message doesn't match its command format.
 */

// Command result types

export type DocCommand =
  | { type: "add"; title: string; content: string }
  | { type: "update"; title: string; content: string }
  | { type: "remove"; title: string }
  | { type: "list"; page?: number }
  | { type: "backfill" };

export type SearchCommand = { query: string };

/**
 * Remove bot mention from text and trim whitespace
 */
function cleanText(text: string, botUserId: string): string {
  return text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
}

/**
 * Parse doc commands from message text
 *
 * Supported commands:
 * - "docs" or "list docs" [--page N] - List all documents
 * - "add doc "Title": content" - Add a document
 * - "remove doc "Title"" - Remove a document
 * - "backfill docs" - Reindex all documents
 *
 * @returns Parsed command or null if not a doc command
 */
export function parseDocCommand(text: string, botUserId: string): DocCommand | null {
  const cleaned = cleanText(text, botUserId);

  // List docs: "docs" or "list docs" with optional --page N
  if (/^(list\s+)?docs(\s+--page\s+\d+)?$/i.test(cleaned)) {
    const pageMatch = cleaned.match(/--page\s+(\d+)/i);
    const page = pageMatch ? parseInt(pageMatch[1], 10) : undefined;
    return { type: "list", page };
  }

  // Backfill docs: "backfill docs"
  if (/^backfill\s+docs$/i.test(cleaned)) {
    return { type: "backfill" };
  }

  // Add doc: add doc "Title": content
  const addMatch = cleaned.match(/^add\s+doc\s+"([^"]+)":\s*(.+)$/is);
  if (addMatch) {
    return { type: "add", title: addMatch[1], content: addMatch[2].trim() };
  }

  // Update doc: update doc "Title": content
  const updateMatch = cleaned.match(/^update\s+doc\s+"([^"]+)":\s*(.+)$/is);
  if (updateMatch) {
    return { type: "update", title: updateMatch[1], content: updateMatch[2].trim() };
  }

  // Remove doc: remove doc "Title"
  const removeMatch = cleaned.match(/^remove\s+doc\s+"([^"]+)"$/i);
  if (removeMatch) {
    return { type: "remove", title: removeMatch[1] };
  }

  return null;
}

/**
 * Parse search command from message text
 *
 * Supported formats:
 * - search "query" - Search with quoted query
 * - search query - Search with unquoted query
 *
 * @returns Parsed command or null if not a search command
 */
export function parseSearchCommand(text: string, botUserId: string): SearchCommand | null {
  const cleaned = cleanText(text, botUserId);

  // Match: search "query" or search query
  const quotedMatch = cleaned.match(/^search\s+"([^"]+)"$/i);
  if (quotedMatch) {
    return { query: quotedMatch[1] };
  }

  const unquotedMatch = cleaned.match(/^search\s+(.+)$/i);
  if (unquotedMatch) {
    return { query: unquotedMatch[1].trim() };
  }

  return null;
}

// Check-in command types
export type CheckInCommand = { type: "history"; limit?: number };

/**
 * Parse check-in commands from message text
 *
 * Supported commands:
 * - "checkin history" or "check-in history" [--limit N] - Show check-in history
 *
 * @returns Parsed command or null if not a check-in command
 */
export function parseCheckInCommand(text: string, botUserId: string): CheckInCommand | null {
  const cleaned = cleanText(text, botUserId);

  // Match: checkin history or check-in history with optional --limit N
  if (/^check-?in\s+history(\s+--limit\s+\d+)?$/i.test(cleaned)) {
    const limitMatch = cleaned.match(/--limit\s+(\d+)/i);
    const limit = limitMatch ? parseInt(limitMatch[1], 10) : undefined;
    return { type: "history", limit };
  }

  return null;
}
