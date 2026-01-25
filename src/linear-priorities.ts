/**
 * Linear Priorities Integration for Chorus
 *
 * Fetches R&D Priority initiatives from Linear to provide context
 * for answering questions about priorities, status, and ownership.
 */

import type { Env } from "./types";

const LINEAR_API_URL = "https://api.linear.app/graphql";

// The parent initiative ID for R&D Priorities 2026
const RD_PRIORITIES_INITIATIVE_ID = "6aaaa863-a398-4116-ab4f-830606ce4744";

// Cache configuration
const CACHE_KEY = "linear:priorities:context";
const CACHE_TTL_SECONDS = 300; // 5 minutes

interface LinearInitiative {
  id: string;
  name: string;
  description: string | null;
  status: string;
  targetDate: string | null;
  url: string;
  owner: {
    name: string;
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

interface InitiativeRelation {
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
function extractPriorityMetadata(initiative: LinearInitiative): {
  techRisk: string | null;
  theme: string | null;
} {
  const text = `${initiative.description || ""}\n${initiative.content || ""}`;

  // Extract tech risk (look for pepper emojis)
  const riskMatch = text.match(/Tech Risk:\s*(🌶+)/);
  const techRisk = riskMatch ? riskMatch[1] : null;

  // Extract theme
  const themeMatch = text.match(/Theme:\s*(.+?)(?:\n|$)/);
  const theme = themeMatch ? themeMatch[1].trim() : null;

  return { techRisk, theme };
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
    .filter((r) => r.initiative.id === RD_PRIORITIES_INITIATIVE_ID)
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
function formatPrioritiesContext(relations: InitiativeRelation[]): string {
  if (relations.length === 0) {
    return "";
  }

  const lines: string[] = [
    "The following are Honeycomb's R&D Priorities for 2026, in stack rank order:",
    "",
  ];

  for (const relation of relations) {
    const init = relation.relatedInitiative;
    const { techRisk, theme } = extractPriorityMetadata(init);
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

    lines.push(`### #${rank}: ${init.name}`);
    lines.push(`- **Linear**: ${init.url}`);
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

    const context = formatPrioritiesContext(relations);

    // Cache the result
    await env.DOCS_KV.put(CACHE_KEY, context, {
      expirationTtl: CACHE_TTL_SECONDS,
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
