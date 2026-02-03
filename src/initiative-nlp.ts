/**
 * Natural language initiative commands using Claude tool use
 *
 * Allows users to manage initiatives with natural language instead of
 * structured commands. Uses Claude's tool calling capability.
 */

import type { Env, InitiativeStatusValue, ExpectedMetric } from "./types";
import {
  addInitiative,
  updateInitiativeStatus,
  updateInitiativePrd,
  updateInitiativeName,
  updateInitiativeDescription,
  updateInitiativeOwner,
  addInitiativeMetric,
  removeInitiative,
  getInitiative,
  listInitiatives,
  formatInitiative,
  formatInitiativeList,
} from "./initiatives";
import { fetchWithRetry } from "./http-utils";

// Tool definitions for Claude
const INITIATIVE_TOOLS = [
  {
    name: "list_initiatives",
    description: "List all initiatives, optionally filtered by status or owner",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["proposed", "active", "paused", "completed", "cancelled"],
          description: "Filter by status",
        },
        owner_id: {
          type: "string",
          description: "Filter by owner's Slack user ID",
        },
      },
    },
  },
  {
    name: "show_initiative",
    description: "Show details of a specific initiative",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The name of the initiative to show",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "create_initiative",
    description: "Create a new initiative",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The name of the initiative",
        },
        description: {
          type: "string",
          description: "Description of the initiative",
        },
        owner_id: {
          type: "string",
          description: "Slack user ID of the owner",
        },
      },
      required: ["name", "description", "owner_id"],
    },
  },
  {
    name: "update_initiative_status",
    description: "Update the status of an initiative",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The name of the initiative",
        },
        status: {
          type: "string",
          enum: ["proposed", "active", "paused", "completed", "cancelled"],
          description: "The new status",
        },
      },
      required: ["name", "status"],
    },
  },
  {
    name: "update_initiative_owner",
    description: "Change the owner of an initiative",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The name of the initiative",
        },
        new_owner_id: {
          type: "string",
          description: "Slack user ID of the new owner",
        },
      },
      required: ["name", "new_owner_id"],
    },
  },
  {
    name: "update_initiative_name",
    description: "Rename an initiative",
    input_schema: {
      type: "object",
      properties: {
        current_name: {
          type: "string",
          description: "The current name of the initiative",
        },
        new_name: {
          type: "string",
          description: "The new name for the initiative",
        },
      },
      required: ["current_name", "new_name"],
    },
  },
  {
    name: "update_initiative_description",
    description: "Update an initiative's description",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The name of the initiative",
        },
        description: {
          type: "string",
          description: "The new description",
        },
      },
      required: ["name", "description"],
    },
  },
  {
    name: "update_initiative_prd",
    description: "Add or update the PRD link for an initiative",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The name of the initiative",
        },
        prd_url: {
          type: "string",
          description: "The URL of the PRD document",
        },
      },
      required: ["name", "prd_url"],
    },
  },
  {
    name: "add_initiative_metric",
    description: "Add a success metric to an initiative",
    input_schema: {
      type: "object",
      properties: {
        initiative_name: {
          type: "string",
          description: "The name of the initiative",
        },
        metric_type: {
          type: "string",
          enum: ["gtm", "product"],
          description: "Type of metric (GTM or Product)",
        },
        metric_name: {
          type: "string",
          description: "Name of the metric",
        },
        target: {
          type: "string",
          description: "Target value for the metric",
        },
      },
      required: ["initiative_name", "metric_type", "metric_name", "target"],
    },
  },
  {
    name: "remove_initiative",
    description: "Remove/delete an initiative",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The name of the initiative to remove",
        },
      },
      required: ["name"],
    },
  },
];

const NLP_SYSTEM_PROMPT = `You are Chorus, helping manage product initiatives. When users ask to manage initiatives in natural language, use the available tools.

Examples of natural language requests you should handle:
- "Mark the mobile app initiative as active" → update_initiative_status
- "Create an initiative for Q1 growth owned by @user" → create_initiative
- "Show me what's happening with the API redesign" → show_initiative
- "Assign the dashboard project to @newowner" → update_initiative_owner
- "Add a revenue metric of $1M to the Enterprise initiative" → add_initiative_metric
- "List all active initiatives" → list_initiatives
- "Rename Platform Stability to Platform Reliability" → update_initiative_name

Always use the tools when the user's intent maps to an initiative action. Extract Slack user IDs from @mentions (format: <@U123ABC>).`;

interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface TextContent {
  type: "text";
  text: string;
}

interface ClaudeToolResponse {
  id: string;
  type: string;
  role: string;
  content: (ToolUseContent | TextContent)[];
  model: string;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * Check if a message might be an initiative-related natural language command
 *
 * PDD-65: We need to be careful here. General questions about initiatives like
 * "what are the initiatives?" or "list all initiatives" should go to Claude,
 * which has R&D priorities in its context. Only management commands that
 * modify a specific initiative should trigger NLP tool calling.
 *
 * Trigger NLP for: "mark Project X as active", "set status of X to completed"
 * Don't trigger for: "what are our initiatives?", "list all initiatives"
 */
export function mightBeInitiativeCommand(text: string): boolean {
  const cleanText = text.toLowerCase();

  // Patterns that indicate READ-ONLY/QUERY intent - let Claude handle these
  const queryPatterns = [
    /\blist\s+(all\s+)?(the\s+)?initiatives?\b/,  // "list all initiatives", "list the initiatives"
    /\bwhat\s+(are|is)\s+(our|the|my)\s+initiatives?\b/,  // "what are our initiatives"
    /\bshow\s+(me\s+)?(the\s+)?initiatives\b/,  // "show me the initiatives"
    /\btell\s+me\s+about\s+(the\s+)?initiatives\b/,  // "tell me about the initiatives"
    /\bwhat\s+initiatives\b/,  // "what initiatives are we working on"
    /\bcan\s+you\s+list\b.*\binitiatives?\b/,  // "can you list all the initiatives"
  ];

  // If it matches a query pattern, let Claude handle it
  if (queryPatterns.some(pattern => pattern.test(cleanText))) {
    return false;
  }

  // Patterns that suggest initiative MANAGEMENT intent (not just queries)
  // These require a specific initiative name or action
  const managementPatterns = [
    /\bmark\s+\S+.*\s+as\s+(active|paused|completed|cancelled|proposed)\b/,  // "mark X as active"
    /\bset\s+status\b/,
    /\bchange\s+status\b/,
    /\bassign\s+to\b/,
    /\bowned\s+by\b/,
    /\badd\s+metric\b/,
    /\bupdate\s+status\b/,
    /\brename\s+initiative\b/,
    /\bremove\s+initiative\b/,
    /\bdelete\s+initiative\b/,
    /\bcreate\s+initiative\b/,
    /\bwhat's\s+happening\s+with\b/,  // asking about a specific initiative
    /\bstatus\s+of\b/,  // asking about a specific initiative's status
  ];

  return managementPatterns.some(pattern => pattern.test(cleanText));
}

/**
 * Execute a tool call from Claude
 */
async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  userId: string,
  env: Env
): Promise<string> {
  switch (toolName) {
    case "list_initiatives": {
      const filters: { owner?: string; status?: InitiativeStatusValue } = {};
      if (input.owner_id) filters.owner = String(input.owner_id);
      if (input.status) filters.status = input.status as InitiativeStatusValue;
      const result = await listInitiatives(env, Object.keys(filters).length > 0 ? filters : undefined);
      return formatInitiativeList(result);
    }

    case "show_initiative": {
      const initiative = await getInitiative(env, String(input.name));
      return initiative ? formatInitiative(initiative) : `Initiative "${input.name}" not found.`;
    }

    case "create_initiative": {
      const result = await addInitiative(
        env,
        String(input.name),
        String(input.description),
        String(input.owner_id),
        userId
      );
      return result.message;
    }

    case "update_initiative_status": {
      const result = await updateInitiativeStatus(
        env,
        String(input.name),
        input.status as InitiativeStatusValue,
        userId
      );
      return result.message;
    }

    case "update_initiative_owner": {
      const result = await updateInitiativeOwner(
        env,
        String(input.name),
        String(input.new_owner_id),
        userId
      );
      return result.message;
    }

    case "update_initiative_name": {
      const result = await updateInitiativeName(
        env,
        String(input.current_name),
        String(input.new_name),
        userId
      );
      return result.message;
    }

    case "update_initiative_description": {
      const result = await updateInitiativeDescription(
        env,
        String(input.name),
        String(input.description),
        userId
      );
      return result.message;
    }

    case "update_initiative_prd": {
      const result = await updateInitiativePrd(
        env,
        String(input.name),
        String(input.prd_url),
        userId
      );
      return result.message;
    }

    case "add_initiative_metric": {
      const metric: ExpectedMetric = {
        type: input.metric_type as "gtm" | "product",
        name: String(input.metric_name),
        target: String(input.target),
      };
      const result = await addInitiativeMetric(
        env,
        String(input.initiative_name),
        metric,
        userId
      );
      return result.message;
    }

    case "remove_initiative": {
      const result = await removeInitiative(env, String(input.name));
      return result.message;
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}

/**
 * Process a natural language initiative command
 * Returns null if Claude doesn't want to use a tool (not an initiative command)
 */
export async function processNaturalLanguageCommand(
  text: string,
  userId: string,
  env: Env
): Promise<string | null> {
  // Call Claude with tool use
  const response = await fetchWithRetry(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: NLP_SYSTEM_PROMPT,
        tools: INITIATIVE_TOOLS,
        messages: [
          {
            role: "user",
            content: text,
          },
        ],
      }),
    },
    { initialDelayMs: 500 }
  );

  if (!response.ok) {
    const error = await response.text();
    console.error("Claude API error in NLP:", error);
    return null;
  }

  const data = await response.json() as ClaudeToolResponse;

  // Check if Claude wants to use a tool
  const toolUse = data.content.find(
    (block): block is ToolUseContent => block.type === "tool_use"
  );

  if (!toolUse) {
    // Claude didn't recognize this as an initiative command
    // Check if there's a text response instead
    const textBlock = data.content.find(
      (block): block is TextContent => block.type === "text"
    );

    // If Claude provided guidance text (like asking for clarification), return it
    if (textBlock && textBlock.text.trim()) {
      return textBlock.text;
    }

    return null;
  }

  // Execute the tool
  console.log(`NLP: Executing tool ${toolUse.name} with input:`, JSON.stringify(toolUse.input));
  const result = await executeTool(toolUse.name, toolUse.input, userId, env);

  return result;
}
