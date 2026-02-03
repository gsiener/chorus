/**
 * Capability Registry for Chorus
 *
 * Provides structured descriptions of what Chorus can do.
 * This helps with:
 * - Self-awareness: Claude can reference capabilities accurately
 * - Discoverability: Users can learn what's available
 * - Agent-native: Other systems can query capabilities
 */

export interface Capability {
  name: string;
  description: string;
  commands?: string[];
}

/**
 * All capabilities Chorus provides
 */
export const CAPABILITIES: Record<string, Capability> = {
  conversation: {
    name: "Natural Conversation",
    description: "I remember context within threads. Just keep chatting naturally.",
  },
  initiatives: {
    name: "Initiative Tracking",
    description: "Create, update, and track status on product work.",
    commands: [
      "initiatives — see all at a glance",
      'initiative "Name" show — view full details',
      'initiative add "Name" - owner @user - description: text',
      "initiative \"Name\" update status [proposed|active|paused|completed|cancelled]",
      'initiative "Name" update prd [url]',
      'initiative "Name" remove',
      "initiatives sync linear — import from Linear",
    ],
  },
  documents: {
    name: "Document Management",
    description: "Build a searchable knowledge base for your team.",
    commands: [
      "docs — list all documents",
      'add doc "Title": content — add inline',
      'update doc "Title": new content — update existing',
      'remove doc "Title"',
      "surprise me — discover a random doc",
      "Upload files (text, markdown, JSON, CSV) to add them",
    ],
  },
  search: {
    name: "Semantic Search",
    description: "Find initiatives, docs, and PRDs using natural language.",
    commands: ['search "query" — find across all content'],
  },
  priorities: {
    name: "R&D Priorities",
    description: "I know the R&D priorities from Linear and can help align work.",
  },
  checkins: {
    name: "Weekly Check-ins",
    description: "Initiative owners get DM check-ins about missing PRDs and metrics.",
    commands: ["checkin history — view your check-in history"],
  },
  admin: {
    name: "Admin Tools",
    description: "Tools for maintaining initiative health.",
    commands: ["check-briefs — check initiatives for missing briefs"],
  },
} as const;

/**
 * Get a formatted string of all capabilities for the system prompt
 */
export function getCapabilityRegistry(): string {
  const lines: string[] = [];

  for (const [, capability] of Object.entries(CAPABILITIES)) {
    lines.push(`**${capability.name}:** ${capability.description}`);
  }

  return lines.join("\n");
}

/**
 * Get capability by command (returns the capability that handles a command)
 */
export function getCapabilityForCommand(command: string): Capability | null {
  const normalizedCommand = command.toLowerCase();

  for (const [, capability] of Object.entries(CAPABILITIES)) {
    if (capability.commands) {
      for (const cmd of capability.commands) {
        // Check if the command starts with the capability's command prefix
        const cmdPrefix = cmd.split(" ")[0].toLowerCase();
        if (normalizedCommand.startsWith(cmdPrefix)) {
          return capability;
        }
      }
    }
  }

  return null;
}

/**
 * Get all capabilities as a structured list (for API responses)
 */
export function listCapabilities(): Capability[] {
  return Object.values(CAPABILITIES);
}
