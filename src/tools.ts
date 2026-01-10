/**
 * Tool definitions for Claude tool calling in main flow
 *
 * Allows Claude to proactively retrieve information instead of
 * injecting all context into the system prompt.
 */

import type { Env } from "./types";
import { searchDocuments } from "./embeddings";
import { getInitiative, listInitiatives, formatInitiative } from "./initiatives";

// Tool definitions for Claude's main chat flow
export const MAIN_TOOLS = [
  {
    name: "search_documents",
    description: "Search the knowledge base for documents relevant to a query",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query to find relevant documents",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_initiative_details",
    description: "Get detailed information about a specific initiative by name",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The name of the initiative to look up",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "list_initiatives",
    description: "List all initiatives with optional filters",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["proposed", "active", "paused", "completed", "cancelled"],
          description: "Filter by initiative status",
        },
        owner: {
          type: "string",
          description: "Filter by owner's Slack user ID",
        },
      },
    },
  },
] as const;

// Type for tool use content from Claude
export interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// Type for text content from Claude
export interface TextContent {
  type: "text";
  text: string;
}

// Type for Claude response with tools
export interface ClaudeToolResponse {
  id: string;
  type: string;
  role: string;
  content: (ToolUseContent | TextContent)[];
  model: string;
  stop_reason: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

/**
 * Execute a tool call and return the result as text
 */
export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  env: Env
): Promise<string> {
  switch (toolName) {
    case "search_documents": {
      const query = String(input.query);
      const results = await searchDocuments(query, env, 5);

      if (results.length === 0) {
        return "No documents found matching the search query.";
      }

      const formatted = results
        .slice(0, 3)
        .map(
          (r) =>
            `Document: ${r.title}\nRelevance: ${Math.round(r.score * 100)}%\nContent: ${r.content.slice(0, 300)}${
              r.content.length > 300 ? "..." : ""
            }`
        )
        .join("\n\n");

      return formatted;
    }

    case "get_initiative_details": {
      const name = String(input.name);
      const initiative = await getInitiative(env, name);

      if (!initiative) {
        return `Initiative "${name}" not found.`;
      }

      return formatInitiative(initiative);
    }

    case "list_initiatives": {
      const filters: { owner?: string; status?: "proposed" | "active" | "paused" | "completed" | "cancelled" } = {};

      if (input.status && ["proposed", "active", "paused", "completed", "cancelled"].includes(String(input.status))) {
        filters.status = String(input.status) as "proposed" | "active" | "paused" | "completed" | "cancelled";
      }
      if (input.owner) {
        filters.owner = String(input.owner);
      }

      const result = await listInitiatives(
        env,
        Object.keys(filters).length > 0 ? filters : undefined
      );

      if (result.items.length === 0) {
        return "No initiatives found matching the criteria.";
      }

      // Format as simple text for Claude
      const items = result.items
        .map(
          (i) =>
            `- ${i.name} (status: ${i.status}, owner: <@${i.owner}>${!i.hasPrd ? ", missing PRD" : ""}${!i.hasMetrics ? ", missing metrics" : ""})`
        )
        .join("\n");

      return `Found ${result.totalItems} initiatives:\n${items}`;
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}
