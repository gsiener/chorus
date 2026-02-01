/**
 * Initiative management for Chorus
 *
 * Stores and retrieves initiatives via KV.
 * Initiatives track product work with owners, metrics, PRDs, and status.
 */

import { INITIATIVES_KV } from "./kv";
import type {
  Env,
  Initiative,
  InitiativeIndex,
  InitiativeMetadata,
  InitiativeStatus,
  InitiativeStatusValue,
  ExpectedMetric,
} from "./types";

// Limits
const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_INITIATIVES = 100;

import { nameToId } from "./utils";

/**
 * Generate a KV key from an initiative ID
 */
function idToKey(id: string): string {
  return INITIATIVES_KV.prefix + id;
}

/**
 * Get the initiatives index from KV
 */
async function getIndex(env: Env): Promise<InitiativeIndex> {
  const data = await env.DOCS_KV.get(INITIATIVES_KV.index);
  if (!data) {
    return { initiatives: [] };
  }
  return JSON.parse(data) as InitiativeIndex;
}

/**
 * Save the initiatives index to KV
 */
async function saveIndex(env: Env, index: InitiativeIndex): Promise<void> {
  await env.DOCS_KV.put(INITIATIVES_KV.index, JSON.stringify(index));
}

/**
 * Convert full Initiative to InitiativeMetadata for index
 */
function toMetadata(init: Initiative): InitiativeMetadata {
  return {
    id: init.id,
    name: init.name,
    owner: init.owner,
    status: init.status.value,
    hasMetrics: init.expectedMetrics.length > 0,
    hasPrd: !!init.prdLink,
    updatedAt: init.updatedAt,
  };
}

// Default page size for listings
const DEFAULT_PAGE_SIZE = 10;

export interface PaginationOptions {
  page?: number;        // 1-indexed page number
  pageSize?: number;    // Items per page
}

export interface PaginatedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasMore: boolean;
}

/**
 * Get all initiatives metadata (for listing)
 * Supports optional pagination
 */
export async function listInitiatives(
  env: Env,
  filters?: { owner?: string; status?: InitiativeStatusValue },
  pagination?: PaginationOptions
): Promise<PaginatedResult<InitiativeMetadata>> {
  const index = await getIndex(env);
  let initiatives = index.initiatives;

  if (filters?.owner) {
    initiatives = initiatives.filter((i) => i.owner === filters.owner);
  }
  if (filters?.status) {
    initiatives = initiatives.filter((i) => i.status === filters.status);
  }

  const totalItems = initiatives.length;
  const page = Math.max(1, pagination?.page ?? 1);
  const pageSize = Math.max(1, Math.min(50, pagination?.pageSize ?? DEFAULT_PAGE_SIZE));
  const totalPages = Math.ceil(totalItems / pageSize);

  // Apply pagination
  const startIndex = (page - 1) * pageSize;
  const paginatedItems = initiatives.slice(startIndex, startIndex + pageSize);

  return {
    items: paginatedItems,
    page,
    pageSize,
    totalItems,
    totalPages,
    hasMore: page < totalPages,
  };
}

/**
 * Get a single initiative by ID or name
 */
export async function getInitiative(
  env: Env,
  idOrName: string
): Promise<Initiative | null> {
  const index = await getIndex(env);

  // Try to find by ID first, then by name
  let meta = index.initiatives.find((i) => i.id === idOrName);
  if (!meta) {
    meta = index.initiatives.find(
      (i) => i.name.toLowerCase() === idOrName.toLowerCase()
    );
  }

  if (!meta) {
    return null;
  }

  const data = await env.DOCS_KV.get(idToKey(meta.id));
  if (!data) {
    return null;
  }

  return JSON.parse(data) as Initiative;
}

/**
 * Add a new initiative
 */
export async function addInitiative(
  env: Env,
  name: string,
  description: string,
  owner: string,
  createdBy: string
): Promise<{ success: boolean; message: string; initiative?: Initiative }> {
  // Validate name
  if (!name || name.trim().length === 0) {
    return { success: false, message: "Initiative name cannot be empty." };
  }

  if (name.length > MAX_NAME_LENGTH) {
    return {
      success: false,
      message: `Name too long (max ${MAX_NAME_LENGTH} chars).`,
    };
  }

  // Validate description
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return {
      success: false,
      message: `Description too long (max ${MAX_DESCRIPTION_LENGTH} chars).`,
    };
  }

  const index = await getIndex(env);

  // Check limit
  if (index.initiatives.length >= MAX_INITIATIVES) {
    return {
      success: false,
      message: `Too many initiatives (max ${MAX_INITIATIVES}). Complete or remove some first.`,
    };
  }

  // Check for duplicate name
  const existing = index.initiatives.find(
    (i) => i.name.toLowerCase() === name.toLowerCase()
  );
  if (existing) {
    return {
      success: false,
      message: `An initiative named "${name}" already exists.`,
    };
  }

  const now = new Date().toISOString();
  const id = nameToId(name);

  const initiative: Initiative = {
    id,
    name,
    description,
    owner,
    status: {
      value: "proposed",
      updatedAt: now,
      updatedBy: createdBy,
    },
    expectedMetrics: [],
    createdAt: now,
    createdBy,
    updatedAt: now,
  };

  // Store initiative detail
  await env.DOCS_KV.put(idToKey(id), JSON.stringify(initiative));

  // Update index
  index.initiatives.push(toMetadata(initiative));
  await saveIndex(env, index);

  return {
    success: true,
    message: `Created initiative "${name}" with status *proposed*. Owner: <@${owner}>`,
    initiative,
  };
}

/**
 * Update an initiative's status
 */
export async function updateInitiativeStatus(
  env: Env,
  idOrName: string,
  newStatus: InitiativeStatusValue,
  updatedBy: string
): Promise<{ success: boolean; message: string }> {
  const initiative = await getInitiative(env, idOrName);
  if (!initiative) {
    return { success: false, message: `Initiative "${idOrName}" not found.` };
  }

  const now = new Date().toISOString();
  initiative.status = {
    value: newStatus,
    updatedAt: now,
    updatedBy,
  };
  initiative.updatedAt = now;

  // Save updated initiative
  await env.DOCS_KV.put(idToKey(initiative.id), JSON.stringify(initiative));

  // Update index
  const index = await getIndex(env);
  const metaIndex = index.initiatives.findIndex((i) => i.id === initiative.id);
  if (metaIndex >= 0) {
    index.initiatives[metaIndex] = toMetadata(initiative);
    await saveIndex(env, index);
  }

  return {
    success: true,
    message: `Updated "${initiative.name}" status to *${newStatus}*.`,
  };
}

/**
 * Update an initiative's PRD link
 */
export async function updateInitiativePrd(
  env: Env,
  idOrName: string,
  prdLink: string,
  updatedBy: string
): Promise<{ success: boolean; message: string }> {
  const initiative = await getInitiative(env, idOrName);
  if (!initiative) {
    return { success: false, message: `Initiative "${idOrName}" not found.` };
  }

  const now = new Date().toISOString();
  initiative.prdLink = prdLink;
  initiative.updatedAt = now;

  // Save updated initiative
  await env.DOCS_KV.put(idToKey(initiative.id), JSON.stringify(initiative));

  // Update index (hasPrd changed)
  const index = await getIndex(env);
  const metaIndex = index.initiatives.findIndex((i) => i.id === initiative.id);
  if (metaIndex >= 0) {
    index.initiatives[metaIndex] = toMetadata(initiative);
    await saveIndex(env, index);
  }

  return {
    success: true,
    message: `Added PRD link to "${initiative.name}".`,
  };
}

/**
 * Update an initiative's name
 */
export async function updateInitiativeName(
  env: Env,
  idOrName: string,
  newName: string,
  updatedBy: string
): Promise<{ success: boolean; message: string }> {
  const initiative = await getInitiative(env, idOrName);
  if (!initiative) {
    return { success: false, message: `Initiative "${idOrName}" not found.` };
  }

  const oldName = initiative.name;
  const now = new Date().toISOString();
  initiative.name = newName;
  initiative.updatedAt = now;

  // Save updated initiative
  await env.DOCS_KV.put(idToKey(initiative.id), JSON.stringify(initiative));

  // Update index
  const index = await getIndex(env);
  const metaIndex = index.initiatives.findIndex((i) => i.id === initiative.id);
  if (metaIndex >= 0) {
    index.initiatives[metaIndex] = toMetadata(initiative);
    await saveIndex(env, index);
  }

  return {
    success: true,
    message: `Renamed "${oldName}" to "${newName}".`,
  };
}

/**
 * Update an initiative's description
 */
export async function updateInitiativeDescription(
  env: Env,
  idOrName: string,
  newDescription: string,
  updatedBy: string
): Promise<{ success: boolean; message: string }> {
  const initiative = await getInitiative(env, idOrName);
  if (!initiative) {
    return { success: false, message: `Initiative "${idOrName}" not found.` };
  }

  const now = new Date().toISOString();
  initiative.description = newDescription;
  initiative.updatedAt = now;

  // Save updated initiative
  await env.DOCS_KV.put(idToKey(initiative.id), JSON.stringify(initiative));

  return {
    success: true,
    message: `Updated description for "${initiative.name}".`,
  };
}

/**
 * Update an initiative's owner
 */
export async function updateInitiativeOwner(
  env: Env,
  idOrName: string,
  newOwner: string,
  updatedBy: string
): Promise<{ success: boolean; message: string }> {
  const initiative = await getInitiative(env, idOrName);
  if (!initiative) {
    return { success: false, message: `Initiative "${idOrName}" not found.` };
  }

  const now = new Date().toISOString();
  initiative.owner = newOwner;
  initiative.updatedAt = now;

  // Save updated initiative
  await env.DOCS_KV.put(idToKey(initiative.id), JSON.stringify(initiative));

  // Update index (owner changed)
  const index = await getIndex(env);
  const metaIndex = index.initiatives.findIndex((i) => i.id === initiative.id);
  if (metaIndex >= 0) {
    index.initiatives[metaIndex] = toMetadata(initiative);
    await saveIndex(env, index);
  }

  return {
    success: true,
    message: `Updated owner of "${initiative.name}" to <@${newOwner}>.`,
  };
}

/**
 * Add an expected metric to an initiative
 */
export async function addInitiativeMetric(
  env: Env,
  idOrName: string,
  metric: ExpectedMetric,
  updatedBy: string
): Promise<{ success: boolean; message: string }> {
  const initiative = await getInitiative(env, idOrName);
  if (!initiative) {
    return { success: false, message: `Initiative "${idOrName}" not found.` };
  }

  const now = new Date().toISOString();
  initiative.expectedMetrics.push(metric);
  initiative.updatedAt = now;

  // Save updated initiative
  await env.DOCS_KV.put(idToKey(initiative.id), JSON.stringify(initiative));

  // Update index (hasMetrics changed)
  const index = await getIndex(env);
  const metaIndex = index.initiatives.findIndex((i) => i.id === initiative.id);
  if (metaIndex >= 0) {
    index.initiatives[metaIndex] = toMetadata(initiative);
    await saveIndex(env, index);
  }

  const typeLabel = metric.type === "gtm" ? "GTM" : "Product";
  return {
    success: true,
    message: `Added ${typeLabel} metric to "${initiative.name}": ${metric.name} - ${metric.target}`,
  };
}

/**
 * Remove an initiative
 */
export async function removeInitiative(
  env: Env,
  idOrName: string
): Promise<{ success: boolean; message: string }> {
  const initiative = await getInitiative(env, idOrName);
  if (!initiative) {
    return { success: false, message: `Initiative "${idOrName}" not found.` };
  }

  // Remove from KV
  await env.DOCS_KV.delete(idToKey(initiative.id));

  // Update index
  const index = await getIndex(env);
  index.initiatives = index.initiatives.filter((i) => i.id !== initiative.id);
  await saveIndex(env, index);

  return {
    success: true,
    message: `Removed initiative "${initiative.name}".`,
  };
}

/**
 * Format an initiative for display
 */
export function formatInitiative(init: Initiative): string {
  const lines: string[] = [];

  lines.push(`*${init.name}*`);
  lines.push(`Status: ${init.status.value}`);
  lines.push(`Owner: <@${init.owner}>`);

  if (init.description) {
    lines.push(`\n${init.description}`);
  }

  if (init.prdLink) {
    lines.push(`\nPRD: ${init.prdLink}`);
  }

  if (init.expectedMetrics.length > 0) {
    lines.push(`\n*Expected Metrics:*`);
    for (const m of init.expectedMetrics) {
      const typeLabel = m.type === "gtm" ? "GTM" : "Product";
      lines.push(`• [${typeLabel}] ${m.name}: ${m.target}`);
    }
  }

  if (init.strategyDocRef) {
    lines.push(`\nStrategy: ${init.strategyDocRef}`);
  }

  const created = new Date(init.createdAt).toLocaleDateString();
  lines.push(`\n_Created ${created}_`);

  return lines.join("\n");
}

/**
 * Format initiative list for display
 * Accepts either paginated result or raw array (for backward compatibility)
 */
export function formatInitiativeList(
  result: PaginatedResult<InitiativeMetadata> | InitiativeMetadata[]
): string {
  // Handle both paginated and raw array input
  const isPaginated = !Array.isArray(result);
  const initiatives = isPaginated ? result.items : result;
  const paginationInfo = isPaginated ? result : null;

  if (initiatives.length === 0) {
    if (paginationInfo && paginationInfo.totalItems > 0) {
      return `No initiatives on page ${paginationInfo.page}. Total: ${paginationInfo.totalItems}`;
    }
    return "No initiatives found. Create one with:\n`@Chorus initiative add \"Name\" - owner @user - description: Your description`";
  }

  const byStatus: Record<string, InitiativeMetadata[]> = {};
  for (const init of initiatives) {
    if (!byStatus[init.status]) {
      byStatus[init.status] = [];
    }
    byStatus[init.status].push(init);
  }

  // Header with pagination info
  const headerParts = ["*Initiatives*"];
  if (paginationInfo) {
    if (paginationInfo.totalPages > 1) {
      headerParts.push(`(page ${paginationInfo.page}/${paginationInfo.totalPages}, ${paginationInfo.totalItems} total)`);
    } else {
      headerParts.push(`(${paginationInfo.totalItems} total)`);
    }
  } else {
    headerParts.push(`(${initiatives.length} total)`);
  }

  const lines: string[] = [headerParts.join(" ")];

  const statusOrder: InitiativeStatusValue[] = [
    "active",
    "proposed",
    "paused",
    "completed",
    "cancelled",
  ];

  for (const status of statusOrder) {
    const inits = byStatus[status];
    if (!inits || inits.length === 0) continue;

    lines.push(`\n*${status.charAt(0).toUpperCase() + status.slice(1)}*`);
    for (const init of inits) {
      const gaps: string[] = [];
      if (!init.hasPrd) gaps.push("no PRD");
      if (!init.hasMetrics) gaps.push("no metrics");
      const gapStr = gaps.length > 0 ? ` _(${gaps.join(", ")})_` : "";
      lines.push(`• ${init.name} - <@${init.owner}>${gapStr}`);
    }
  }

  // Add pagination hint if there are more pages
  if (paginationInfo?.hasMore) {
    lines.push(`\n_Use \`initiatives --page ${paginationInfo.page + 1}\` for more_`);
  }

  return lines.join("\n");
}

/**
 * Search initiatives by text matching in name and description
 */
export async function searchInitiatives(
  env: Env,
  query: string,
  limit: number = 5
): Promise<{ initiative: InitiativeMetadata; score: number; snippet: string }[]> {
  const index = await getIndex(env);
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

  const results: { initiative: InitiativeMetadata; score: number; snippet: string }[] = [];

  for (const meta of index.initiatives) {
    let score = 0;
    let snippet = "";

    // Check name match (higher weight)
    const nameLower = meta.name.toLowerCase();
    if (nameLower.includes(queryLower)) {
      score += 10;
      snippet = meta.name;
    } else {
      for (const word of queryWords) {
        if (nameLower.includes(word)) {
          score += 3;
        }
      }
    }

    // Load full initiative to search description
    if (score === 0 || !snippet) {
      const data = await env.DOCS_KV.get(idToKey(meta.id));
      if (data) {
        const init = JSON.parse(data) as Initiative;
        const descLower = (init.description || "").toLowerCase();

        if (descLower.includes(queryLower)) {
          score += 5;
          // Extract snippet around match
          const matchIndex = descLower.indexOf(queryLower);
          const start = Math.max(0, matchIndex - 30);
          const end = Math.min(init.description.length, matchIndex + queryLower.length + 50);
          snippet = (start > 0 ? "..." : "") + init.description.slice(start, end) + (end < init.description.length ? "..." : "");
        } else {
          for (const word of queryWords) {
            if (descLower.includes(word)) {
              score += 1;
              if (!snippet) {
                const matchIndex = descLower.indexOf(word);
                const start = Math.max(0, matchIndex - 30);
                const end = Math.min(init.description.length, matchIndex + 60);
                snippet = (start > 0 ? "..." : "") + init.description.slice(start, end) + (end < init.description.length ? "..." : "");
              }
            }
          }
        }
      }
    }

    if (score > 0) {
      results.push({
        initiative: meta,
        score,
        snippet: snippet || meta.name,
      });
    }
  }

  // Sort by score descending and limit
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Detect initiative mentions in text and return gaps for nudges
 * Returns at most one nudge to avoid being preachy
 */
export async function detectInitiativeGaps(
  text: string,
  env: Env
): Promise<string | null> {
  const index = await getIndex(env);

  if (index.initiatives.length === 0) {
    return null;
  }

  // Look for initiative names mentioned in the text (case-insensitive)
  const textLower = text.toLowerCase();
  const mentionedInitiatives: Initiative[] = [];

  for (const meta of index.initiatives) {
    // Check if initiative name is mentioned
    if (textLower.includes(meta.name.toLowerCase())) {
      const data = await env.DOCS_KV.get(idToKey(meta.id));
      if (data) {
        mentionedInitiatives.push(JSON.parse(data) as Initiative);
      }
    }
  }

  // Find the first initiative with gaps
  for (const init of mentionedInitiatives) {
    const gaps: string[] = [];
    if (!init.prdLink) gaps.push("PRD");
    if (init.expectedMetrics.length === 0) gaps.push("success metrics");

    if (gaps.length > 0) {
      // Return a single nudge for the first initiative with gaps
      return `Note: The "${init.name}" initiative is missing ${gaps.join(" and ")}. If relevant, gently suggest adding ${gaps.length === 1 ? "it" : "them"} — but only mention this once and don't be preachy.`;
    }
  }

  return null;
}

/**
 * Get initiatives context for Claude prompt injection
 */
export async function getInitiativesContext(env: Env): Promise<string | null> {
  const index = await getIndex(env);

  const activeInitiatives = index.initiatives.filter(
    (i) => i.status === "active" || i.status === "proposed"
  );

  if (activeInitiatives.length === 0) {
    return null;
  }

  // Load full details for active initiatives
  const detailPromises = activeInitiatives.map(async (meta) => {
    const data = await env.DOCS_KV.get(idToKey(meta.id));
    if (!data) return null;
    return JSON.parse(data) as Initiative;
  });

  const initiatives = (await Promise.all(detailPromises)).filter(
    (i): i is Initiative => i !== null
  );

  if (initiatives.length === 0) {
    return null;
  }

  const lines = initiatives.map((init) => {
    const metrics = init.expectedMetrics
      .map((m) => `${m.name}: ${m.target}`)
      .join(", ");
    const gaps: string[] = [];
    if (!init.prdLink) gaps.push("missing PRD");
    if (init.expectedMetrics.length === 0) gaps.push("no metrics defined");

    let line = `- ${init.name} (${init.status.value}): ${init.description || "No description"}`;
    if (metrics) line += ` | Metrics: ${metrics}`;
    if (gaps.length > 0) line += ` | Gaps: ${gaps.join(", ")}`;
    return line;
  });

  return lines.join("\n");
}
