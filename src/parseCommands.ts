/**
 * Command parsers for Chorus Slack bot
 *
 * These parsers extract structured commands from Slack message text.
 * Each parser returns null if the message doesn't match its command format.
 */

import type { InitiativeStatusValue, ExpectedMetric } from "./types";

// Valid initiative statuses
export const VALID_STATUSES: InitiativeStatusValue[] = [
  "proposed",
  "active",
  "paused",
  "completed",
  "cancelled",
];

// Command result types

export type DocCommand =
  | { type: "add"; title: string; content: string }
  | { type: "update"; title: string; content: string }
  | { type: "remove"; title: string }
  | { type: "list"; page?: number }
  | { type: "backfill" };

export type InitiativeCommand =
  | { type: "list"; filters?: { owner?: string; status?: InitiativeStatusValue }; page?: number }
  | { type: "add"; name: string; owner: string; description: string }
  | { type: "show"; name: string }
  | { type: "update-status"; name: string; status: InitiativeStatusValue }
  | { type: "update-prd"; name: string; prdLink: string }
  | { type: "update-name"; name: string; newName: string }
  | { type: "update-description"; name: string; newDescription: string }
  | { type: "update-owner"; name: string; newOwner: string }
  | { type: "add-metric"; name: string; metric: ExpectedMetric }
  | { type: "remove"; name: string }
  | { type: "sync-linear" };

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
 * Parse initiative commands from message text
 *
 * Supported commands:
 * - "initiatives" [--mine] [--status X] [--page N] - List initiatives
 * - "initiative add "Name" - owner @user - description: text" - Add initiative
 * - "initiative "Name" show" - Show initiative details
 * - "initiative "Name" update status [status]" - Update status
 * - "initiative "Name" update prd [url]" - Set PRD link
 * - "initiative "Name" update name "New Name"" - Rename
 * - "initiative "Name" update description "text"" - Update description
 * - "initiative "Name" update owner @user" - Change owner
 * - "initiative "Name" add metric: [gtm|product] [name] - target: [target]" - Add metric
 * - "initiative "Name" remove" - Remove initiative
 * - "initiatives sync linear" - Sync from Linear
 *
 * @returns Parsed command or null if not an initiative command
 */
export function parseInitiativeCommand(text: string, botUserId: string): InitiativeCommand | null {
  const cleaned = cleanText(text, botUserId);

  // Sync from Linear: "initiatives sync linear"
  if (/^initiatives?\s+sync\s+linear$/i.test(cleaned)) {
    return { type: "sync-linear" };
  }

  // List initiatives: "initiatives" or "initiative list" with optional flags
  // Supports: --mine, --status X, --page N
  if (/^initiatives?(\s+|$)/i.test(cleaned)) {
    const filters: { owner?: string; status?: InitiativeStatusValue } = {};
    let page: number | undefined;

    // Extract --mine flag
    if (/--mine/i.test(cleaned)) {
      filters.owner = "__CURRENT_USER__";
    }

    // Extract --status flag
    const statusMatch = cleaned.match(/--status\s+(\w+)/i);
    if (statusMatch && VALID_STATUSES.includes(statusMatch[1].toLowerCase() as InitiativeStatusValue)) {
      filters.status = statusMatch[1].toLowerCase() as InitiativeStatusValue;
    }

    // Extract --page flag
    const pageMatch = cleaned.match(/--page\s+(\d+)/i);
    if (pageMatch) {
      page = parseInt(pageMatch[1], 10);
    }

    // Only return if this is a list command (not another initiative subcommand)
    if (/^initiatives?(\s+list)?(\s+--|\s*$)/i.test(cleaned)) {
      return { type: "list", filters: Object.keys(filters).length > 0 ? filters : undefined, page };
    }
  }

  // Add initiative: initiative add "Name" - owner @user - description: text
  const addMatch = cleaned.match(
    /^initiative\s+add\s+"([^"]+)"\s*-\s*owner\s+<@(\w+)>\s*-\s*description:\s*(.+)$/is
  );
  if (addMatch) {
    return {
      type: "add",
      name: addMatch[1],
      owner: addMatch[2],
      description: addMatch[3].trim(),
    };
  }

  // Show initiative: initiative "Name" show OR initiative show "Name"
  const showMatch =
    cleaned.match(/^initiative\s+"([^"]+)"\s+show$/i) ||
    cleaned.match(/^initiative\s+show\s+"([^"]+)"$/i);
  if (showMatch) {
    return { type: "show", name: showMatch[1] };
  }

  // Update status: initiative "Name" update status [status]
  const updateStatusMatch = cleaned.match(/^initiative\s+"([^"]+)"\s+update\s+status\s+(\w+)$/i);
  if (updateStatusMatch) {
    const status = updateStatusMatch[2].toLowerCase();
    if (VALID_STATUSES.includes(status as InitiativeStatusValue)) {
      return {
        type: "update-status",
        name: updateStatusMatch[1],
        status: status as InitiativeStatusValue,
      };
    }
  }

  // Update PRD: initiative "Name" update prd [url]
  const prdMatch = cleaned.match(/^initiative\s+"([^"]+)"\s+update\s+prd\s+(.+)$/i);
  if (prdMatch) {
    return {
      type: "update-prd",
      name: prdMatch[1],
      prdLink: prdMatch[2].trim().replace(/^<|>$/g, ""), // Remove Slack URL formatting
    };
  }

  // Update name: initiative "Name" update name "New Name"
  const nameMatch = cleaned.match(/^initiative\s+"([^"]+)"\s+update\s+name\s+"([^"]+)"$/i);
  if (nameMatch) {
    return {
      type: "update-name",
      name: nameMatch[1],
      newName: nameMatch[2],
    };
  }

  // Update description: initiative "Name" update description "New Description"
  const descMatch = cleaned.match(/^initiative\s+"([^"]+)"\s+update\s+description\s+"([^"]+)"$/is);
  if (descMatch) {
    return {
      type: "update-description",
      name: descMatch[1],
      newDescription: descMatch[2],
    };
  }

  // Update owner: initiative "Name" update owner @user
  const ownerMatch = cleaned.match(/^initiative\s+"([^"]+)"\s+update\s+owner\s+<@(\w+)>$/i);
  if (ownerMatch) {
    return {
      type: "update-owner",
      name: ownerMatch[1],
      newOwner: ownerMatch[2],
    };
  }

  // Add metric: initiative "Name" add metric: [gtm|product] [name] - target: [target]
  const metricMatch = cleaned.match(
    /^initiative\s+"([^"]+)"\s+add\s+metric:\s*(gtm|product)\s+(.+?)\s*-\s*target:\s*(.+)$/i
  );
  if (metricMatch) {
    return {
      type: "add-metric",
      name: metricMatch[1],
      metric: {
        type: metricMatch[2].toLowerCase() as "gtm" | "product",
        name: metricMatch[3].trim(),
        target: metricMatch[4].trim(),
      },
    };
  }

  // Remove initiative: initiative "Name" remove
  const removeMatch = cleaned.match(/^initiative\s+"([^"]+)"\s+remove$/i);
  if (removeMatch) {
    return { type: "remove", name: removeMatch[1] };
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
