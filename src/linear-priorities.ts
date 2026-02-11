/**
 * Linear Priorities Integration for Chorus
 *
 * Fetches R&D Priority initiatives from Linear to provide context
 * for answering questions about priorities, status, and ownership.
 */

import type { Env } from "./types";
import { PRIORITIES_CACHE_TTL_SECONDS } from "./constants";

const LINEAR_API_URL = "https://api.linear.app/graphql";

// Cache configuration
const CACHE_KEY = "linear:priorities:context";

export interface LinearInitiative {
  id: string;
  name: string;
  description: string | null;
  status: string;
  targetDate: string | null;
  url: string;
  owner: {
    name: string;
    email: string;
  } | null;
  content: string | null;
  projects: {
    nodes: Array<{
      name: string;
      status: { name: string };
      progress: number;
    }>;
  };
}

export interface InitiativeRelation {
  relatedInitiative: LinearInitiative;
  sortOrder: number;
}

interface LinearResponse {
  data?: {
    initiativeRelations?: {
      nodes: Array<{
        sortOrder: number;
        initiative: { id: string };
        relatedInitiative: LinearInitiative;
      }>;
    };
  };
  errors?: Array<{ message: string }>;
}

/**
 * Extract R&D Priority metadata from initiative description or content
 */
export function extractPriorityMetadata(initiative: LinearInitiative): {
  techRisk: string | null;
  theme: string | null;
  slackChannel: string | null;
} {
  const text = `${initiative.description || ""}\n${initiative.content || ""}`;

  // Extract tech risk (look for pepper emojis)
  // Note: Using character class [🌶️]+ to handle emoji variation selectors properly
  const riskMatch = text.match(/Tech Risk:\s*([🌶️]+)/);
  const techRisk = riskMatch ? riskMatch[1] : null;

  // Extract theme (stop before "- Slack:" in case it's on the same line)
  const themeMatch = text.match(/Theme:\s*(.+?)(?:\s*-\s*Slack:|\n|$)/);
  const theme = themeMatch ? themeMatch[1].trim() : null;

  // Extract Slack channel (e.g., "- Slack: #proj-channel")
  const slackMatch = text.match(/Slack:\s*(#[\w-]+)/);
  const slackChannel = slackMatch ? slackMatch[1] : null;

  return { techRisk, theme, slackChannel };
}

/**
 * Fetch R&D Priority initiatives from Linear
 */
export async function fetchPriorityInitiatives(
  env: Env
): Promise<InitiativeRelation[]> {
  if (!env.LINEAR_API_KEY) {
    console.log("LINEAR_API_KEY not configured, skipping priority fetch");
    return [];
  }

  if (!env.RD_PRIORITIES_INITIATIVE_ID) {
    console.log("RD_PRIORITIES_INITIATIVE_ID not configured, skipping priority fetch");
    return [];
  }

  // Query initiativeRelations directly and filter by our parent initiative
  const query = `{
    initiativeRelations(first: 50) {
      nodes {
        sortOrder
        initiative {
          id
        }
        relatedInitiative {
          id
          name
          description
          status
          targetDate
          url
          content
          owner {
            name
            email
          }
          projects(first: 10) {
            nodes {
              name
              status { name }
              progress
            }
          }
        }
      }
    }
  }`;

  const response = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: env.LINEAR_API_KEY,
    },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    console.error(`Linear API error: ${response.status}`);
    return [];
  }

  const data = (await response.json()) as LinearResponse;

  if (data.errors) {
    console.error(`Linear API error: ${data.errors[0].message}`);
    return [];
  }

  // Filter to only relations from our R&D Priorities initiative
  const allRelations = data.data?.initiativeRelations?.nodes || [];
  const priorityRelations = allRelations
    .filter((r) => r.initiative.id === env.RD_PRIORITIES_INITIATIVE_ID)
    .map((r) => ({
      sortOrder: r.sortOrder,
      relatedInitiative: r.relatedInitiative,
    }));

  // Sort by sortOrder
  return priorityRelations.sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * Format priority initiatives as context for Claude
 */
function formatPrioritiesContext(
  relations: InitiativeRelation[],
  companyName: string = "the company"
): string {
  if (relations.length === 0) {
    return "";
  }

  const lines: string[] = [
    `The following are ${companyName}'s R&D Priorities, in stack rank order:`,
    "",
  ];

  for (const relation of relations) {
    const init = relation.relatedInitiative;
    const { techRisk, theme, slackChannel } = extractPriorityMetadata(init);
    const rank = Math.round(relation.sortOrder);

    // Calculate overall progress from linked projects
    const activeProjects = init.projects.nodes.filter(
      (p) => p.status.name === "In Progress"
    );
    const avgProgress =
      activeProjects.length > 0
        ? Math.round(
            activeProjects.reduce((sum, p) => sum + p.progress, 0) /
              activeProjects.length
          )
        : null;

    lines.push(`### #${rank}: <${init.url}|${init.name}>`);
    lines.push(`- **Status**: ${init.status}`);
    if (init.owner) {
      lines.push(`- **Owner**: ${init.owner.name}`);
    }
    if (theme) {
      lines.push(`- **Theme**: ${theme}`);
    }
    if (techRisk) {
      lines.push(`- **Tech Risk**: ${techRisk}`);
    }
    if (slackChannel) {
      lines.push(`- **Slack**: ${slackChannel}`);
    }
    if (init.targetDate) {
      lines.push(`- **Target Date**: ${init.targetDate}`);
    }
    if (avgProgress !== null) {
      lines.push(`- **Progress**: ${avgProgress}%`);
    }
    if (activeProjects.length > 0) {
      lines.push(
        `- **Active Projects**: ${activeProjects.map((p) => p.name).join(", ")}`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Resolve Linear owner emails to Slack user IDs
 */
export async function resolveOwnerSlackIds(
  relations: InitiativeRelation[],
  env: Env
): Promise<Map<string, string>> {
  const emailToSlackId = new Map<string, string>();
  const emails = [
    ...new Set(
      relations
        .map((r) => r.relatedInitiative.owner?.email)
        .filter((e): e is string => !!e)
    ),
  ];

  const lookups = await Promise.all(
    emails.map(async (email) => {
      try {
        const res = await fetch(
          `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`,
          { headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } }
        );
        const data = (await res.json()) as { ok: boolean; user?: { id: string } };
        return { email, slackId: data.ok ? data.user?.id ?? null : null };
      } catch {
        return { email, slackId: null };
      }
    })
  );

  for (const { email, slackId } of lookups) {
    if (slackId) {
      emailToSlackId.set(email.toLowerCase(), slackId);
    }
  }

  return emailToSlackId;
}

/**
 * Clear the priorities cache
 */
export async function clearPrioritiesCache(env: Env): Promise<void> {
  await env.DOCS_KV.delete(CACHE_KEY);
  console.log("Priorities cache cleared");
}

/**
 * Warm the priorities cache by fetching fresh data from Linear.
 * Called from the daily cron handler to ensure the cache is always hot.
 */
export async function warmPrioritiesCache(env: Env): Promise<void> {
  if (!env.LINEAR_API_KEY) return;
  try {
    await clearPrioritiesCache(env);
    await getPrioritiesContext(env);
    console.log("Priorities cache warmed");
  } catch (error) {
    console.error("Failed to warm priorities cache:", error);
  }
}

/**
 * Get R&D Priorities context for Claude, with caching
 */
export async function getPrioritiesContext(env: Env): Promise<string | null> {
  // Check cache first
  const cached = await env.DOCS_KV.get(CACHE_KEY);
  if (cached) {
    console.log("Using cached priorities context");
    return cached;
  }

  try {
    const relations = await fetchPriorityInitiatives(env);
    if (relations.length === 0) {
      return null;
    }

    const context = formatPrioritiesContext(relations, env.COMPANY_NAME);

    // Cache the result
    await env.DOCS_KV.put(CACHE_KEY, context, {
      expirationTtl: PRIORITIES_CACHE_TTL_SECONDS,
    });

    return context;
  } catch (error) {
    console.error("Failed to fetch priorities:", error);
    return null;
  }
}

/**
 * Search for a specific priority by name (fuzzy match)
 */
export async function findPriorityByName(
  name: string,
  env: Env
): Promise<LinearInitiative | null> {
  const relations = await fetchPriorityInitiatives(env);
  const searchLower = name.toLowerCase();

  // Try exact match first
  const exact = relations.find(
    (r) => r.relatedInitiative.name.toLowerCase() === searchLower
  );
  if (exact) return exact.relatedInitiative;

  // Try contains match
  const contains = relations.find(
    (r) =>
      r.relatedInitiative.name.toLowerCase().includes(searchLower) ||
      searchLower.includes(r.relatedInitiative.name.toLowerCase())
  );
  if (contains) return contains.relatedInitiative;

  return null;
}

/**
 * Get the top N priorities
 */
export async function getTopPriorities(
  n: number,
  env: Env
): Promise<InitiativeRelation[]> {
  const relations = await fetchPriorityInitiatives(env);
  return relations.slice(0, n);
}

/**
 * Get priorities by target quarter (e.g., "Q1 2026")
 */
export async function getPrioritiesByQuarter(
  quarter: string,
  env: Env
): Promise<InitiativeRelation[]> {
  const relations = await fetchPriorityInitiatives(env);

  // Parse quarter string (e.g., "Q1 2026" -> 2026-03-31)
  const match = quarter.match(/Q([1-4])\s*(\d{4})/i);
  if (!match) return [];

  const q = parseInt(match[1]);
  const year = parseInt(match[2]);

  // Quarter end dates
  const quarterEndMonth = q * 3;
  const quarterEndDate = new Date(year, quarterEndMonth, 0); // Last day of quarter

  return relations.filter((r) => {
    const target = r.relatedInitiative.targetDate;
    if (!target) return false;
    const targetDate = new Date(target);
    return targetDate <= quarterEndDate && targetDate >= new Date(year, (q - 1) * 3, 1);
  });
}
