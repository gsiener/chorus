/**
 * Linear API integration for Chorus
 *
 * Syncs Linear projects as initiatives for tracking and context.
 */

import { INITIATIVES_KV } from "./kv";
import type { Env, Initiative, InitiativeStatusValue } from "./types";
import { LINEAR_SYNC_INTERVAL_MS, LAST_LINEAR_SYNC_KEY, LINEAR_PROJECTS_CACHE_TTL_SECONDS } from "./constants";

// Linear GraphQL endpoint
const LINEAR_API_URL = "https://api.linear.app/graphql";

// KV key prefixes
const LINEAR_MAP_PREFIX = "linear-map:";
const LINEAR_PROJECTS_CACHE_KEY = "cache:linear:projects";

interface LinearProject {
  id: string;
  name: string;
  description: string | null;
  state: string;
  slugId: string;
  lead: {
    id: string;
    name: string;
    email: string;
  } | null;
}

interface LinearProjectsResponse {
  data?: {
    projects: {
      nodes: LinearProject[];
    };
  };
  errors?: Array<{ message: string }>;
}

/**
 * Map Linear project state to initiative status
 */
function mapLinearStateToStatus(state: string): InitiativeStatusValue {
  switch (state) {
    case "started":
      return "active";
    case "planned":
      return "proposed";
    case "paused":
      return "paused";
    case "completed":
      return "completed";
    case "canceled":
      return "cancelled";
    case "backlog":
    default:
      return "proposed";
  }
}

import { nameToId } from "./utils";

/**
 * Fetch projects from Linear API
 */
export async function fetchLinearProjects(env: Env): Promise<LinearProject[]> {
  if (!env.LINEAR_API_KEY) {
    throw new Error("LINEAR_API_KEY is not configured");
  }

  // Check cache first
  const cached = await env.DOCS_KV.get(LINEAR_PROJECTS_CACHE_KEY);
  if (cached) {
    return JSON.parse(cached) as LinearProject[];
  }

  const query = `{
    projects(first: 50) {
      nodes {
        id
        name
        description
        state
        slugId
        lead {
          id
          name
          email
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
    throw new Error(`Linear API error: ${response.status}`);
  }

  const data = (await response.json()) as LinearProjectsResponse;

  if (data.errors) {
    throw new Error(`Linear API error: ${data.errors[0].message}`);
  }

  const projects = data.data?.projects.nodes || [];

  // Cache the result
  await env.DOCS_KV.put(LINEAR_PROJECTS_CACHE_KEY, JSON.stringify(projects), {
    expirationTtl: LINEAR_PROJECTS_CACHE_TTL_SECONDS,
  });

  return projects;
}

async function updateExistingInitiative(
  env: Env,
  project: LinearProject,
  existingInitiativeId: string
): Promise<boolean> {
  const initData = await env.DOCS_KV.get(`${INITIATIVES_KV.prefix}${existingInitiativeId}`);
  if (!initData) {
    return false;
  }

  const initiative = JSON.parse(initData) as Initiative;
  const newStatus = mapLinearStateToStatus(project.state);

  if (initiative.status.value !== newStatus) {
    initiative.status = {
      value: newStatus,
      updatedAt: new Date().toISOString(),
      updatedBy: "linear-sync",
    };
    initiative.updatedAt = new Date().toISOString();
    await env.DOCS_KV.put(`${INITIATIVES_KV.prefix}${existingInitiativeId}`, JSON.stringify(initiative));
    return true;
  }
  return false;
}

async function createAndStoreNewInitiative(
  env: Env,
  project: LinearProject,
  syncedBy: string,
  index: any // InitiativeIndex type causes circular dependency, using any for now
): Promise<{ created: boolean; initiativeId?: string }> {
  const now = new Date().toISOString();
  const id = nameToId(project.name);

  // Check if an initiative with this name already exists in our index
  const existingByName = index.initiatives.find(
    (i: { name: string }) => i.name.toLowerCase() === project.name.toLowerCase()
  );

  if (existingByName) {
    // Link existing initiative to Linear project
    await env.DOCS_KV.put(`${LINEAR_MAP_PREFIX}${project.id}`, existingByName.id);
    return { created: false, initiativeId: existingByName.id };
  }

  const initiative: Initiative = {
    id,
    name: project.name,
    description: project.description || "Synced from Linear",
    owner: syncedBy, // Default to whoever triggered the sync
    status: {
      value: mapLinearStateToStatus(project.state),
      updatedAt: now,
      updatedBy: "linear-sync",
    },
    expectedMetrics: [],
    linearProjectId: project.id,
    createdAt: now,
    createdBy: "linear-sync",
    updatedAt: now,
  };

  // Store initiative
  await env.DOCS_KV.put(`${INITIATIVES_KV.prefix}${id}`, JSON.stringify(initiative));

  // Update in-memory index (written once at end of syncLinearProjects)
  index.initiatives.push({
    id,
    name: project.name,
    owner: syncedBy,
    status: initiative.status.value,
    hasMetrics: false,
    hasPrd: false,
    updatedAt: now,
  });

  // Store mapping
  await env.DOCS_KV.put(`${LINEAR_MAP_PREFIX}${project.id}`, id);

  return { created: true, initiativeId: id };
}

/**
 * Sync Linear projects as initiatives
 * Creates new initiatives for projects not yet tracked,
 * updates existing ones that were synced from Linear.
 */
export async function syncLinearProjects(
  env: Env,
  syncedBy: string
): Promise<{ success: boolean; message: string; synced: number; created: number; updated: number }> {
  try {
    const projects = await fetchLinearProjects(env);

    let created = 0;
    let updated = 0;

    // Fetch the index once
    const indexData = await env.DOCS_KV.get(INITIATIVES_KV.index);
    const index = indexData ? JSON.parse(indexData) : { initiatives: [] };

    for (const project of projects) {
      // Check if we already have a mapping for this Linear project
      const existingInitiativeId = await env.DOCS_KV.get(`${LINEAR_MAP_PREFIX}${project.id}`);

      if (existingInitiativeId) {
        if (await updateExistingInitiative(env, project, existingInitiativeId)) {
          updated++;
        }
      } else {
        const { created: newCreated } = await createAndStoreNewInitiative(env, project, syncedBy, index);
        if (newCreated) {
          created++;
        }
      }
    }

    // Update last sync timestamp (after all projects are processed)
    index.lastSyncedWithLinear = new Date().toISOString();
    await env.DOCS_KV.put(INITIATIVES_KV.index, JSON.stringify(index));

    return {
      success: true,
      message: `Synced ${projects.length} Linear projects: ${created} created, ${updated} updated.`,
      synced: projects.length,
      created,
      updated,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Failed to sync Linear projects: ${errorMessage}`,
      synced: 0,
      created: 0,
      updated: 0,
    };
  }
}

/**
 * Get the Linear project URL for an initiative
 */
export function getLinearProjectUrl(linearProjectId: string): string {
  return `https://linear.app/project/${linearProjectId}`;
}

/**
 * Check if Linear sync is needed and perform it if so
 * Returns true if sync was performed
 */
export async function checkAndSyncIfNeeded(env: Env): Promise<boolean> {
  const lastSync = await env.DOCS_KV.get(LAST_LINEAR_SYNC_KEY);
  const now = Date.now();

  if (lastSync) {
    const lastSyncTime = parseInt(lastSync, 10);
    if (now - lastSyncTime < LINEAR_SYNC_INTERVAL_MS) {
      console.log(`Skipping Linear sync (last sync ${Math.round((now - lastSyncTime) / 1000 / 60)} minutes ago)`);
      return false;
    }
  }

  // Check if LINEAR_API_KEY is configured
  if (!env.LINEAR_API_KEY) {
    console.log("LINEAR_API_KEY not configured, skipping scheduled sync");
    return false;
  }

  console.log("Running scheduled Linear sync...");
  const result = await syncLinearProjects(env, "scheduled");

  if (result.success) {
    // Record sync time
    await env.DOCS_KV.put(LAST_LINEAR_SYNC_KEY, now.toString());
    console.log(`Scheduled Linear sync complete: ${result.message}`);
  } else {
    console.error(`Scheduled Linear sync failed: ${result.message}`);
  }

  return result.success;
}
