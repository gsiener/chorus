/**
 * Brief Checker Module
 *
 * Checks R&D Priority initiatives for missing briefs and sends DM reminders
 * to initiative owners.
 */

import type { Env } from "./types";
import { postDirectMessage } from "./slack";
import { findUserByEmail } from "./user-mapping";

const LINEAR_API_URL = "https://api.linear.app/graphql";

// Cooldown period: 7 days in milliseconds
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

// KV key prefix for tracking notifications
const NOTIFIED_KEY_PREFIX = "brief-check:notified:";

export interface InitiativeLink {
  id: string;
  label: string | null;
  url: string;
}

export interface InitiativeWithLinks {
  id: string;
  name: string;
  url: string;
  owner: { name: string; email?: string } | null;
  links: { nodes: InitiativeLink[] };
}

export interface BriefCheckResult {
  initiativesChecked: number;
  missingBriefs: Array<{
    initiative: { name: string; url: string };
    owner: { name: string; email: string };
    dmSent: boolean;
    error?: string;
  }>;
  unmappedUsers: string[];
}

interface LinearInitiativeRelation {
  sortOrder: number;
  initiative: { id: string };
  relatedInitiative: InitiativeWithLinks;
}

interface LinearResponse {
  data?: {
    initiativeRelations?: {
      nodes: LinearInitiativeRelation[];
    };
  };
  errors?: Array<{ message: string }>;
}

/**
 * Check if an initiative has a brief linked
 * @param initiative - The initiative to check
 * @returns true if any link has "brief" in its label (case-insensitive)
 */
export function hasBrief(initiative: InitiativeWithLinks): boolean {
  return initiative.links.nodes.some(
    (link) => link.label?.toLowerCase().includes("brief") ?? false
  );
}

/**
 * Fetch initiatives with their links from Linear
 */
async function fetchInitiativesWithLinks(env: Env): Promise<InitiativeWithLinks[]> {
  if (!env.LINEAR_API_KEY) {
    console.log("LINEAR_API_KEY not configured, skipping brief check");
    return [];
  }

  if (!env.RD_PRIORITIES_INITIATIVE_ID) {
    console.log("RD_PRIORITIES_INITIATIVE_ID not configured, skipping brief check");
    return [];
  }

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
          url
          owner {
            name
            email
          }
          links {
            nodes {
              id
              label
              url
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
  const priorityRelations = allRelations.filter(
    (r) => r.initiative.id === env.RD_PRIORITIES_INITIATIVE_ID
  );

  return priorityRelations.map((r) => r.relatedInitiative);
}

/**
 * Check if we're within the notification cooldown period
 */
async function isInCooldown(initiativeId: string, env: Env): Promise<boolean> {
  const key = `${NOTIFIED_KEY_PREFIX}${initiativeId}`;
  const lastNotified = await env.DOCS_KV.get(key);

  if (!lastNotified) {
    return false;
  }

  const lastNotifiedTime = parseInt(lastNotified, 10);
  const now = Date.now();

  return now - lastNotifiedTime < COOLDOWN_MS;
}

/**
 * Record that we've sent a notification for an initiative
 */
async function recordNotification(initiativeId: string, env: Env): Promise<void> {
  const key = `${NOTIFIED_KEY_PREFIX}${initiativeId}`;
  // Store for slightly longer than cooldown to ensure coverage
  await env.DOCS_KV.put(key, Date.now().toString(), {
    expirationTtl: Math.ceil(COOLDOWN_MS / 1000) + 3600, // cooldown + 1 hour buffer
  });
}

/**
 * Generate the DM message for a missing brief
 */
function generateBriefReminderMessage(
  initiativeName: string,
  initiativeUrl: string
): string {
  return (
    `Hi! This is a friendly reminder that your initiative *<${initiativeUrl}|${initiativeName}>* ` +
    `doesn't have a brief linked yet.\n\n` +
    `Adding a brief helps ensure everyone understands the initiative's goals, scope, and success criteria. ` +
    `You can add a link to your brief directly in Linear by editing the initiative and adding a link with "Brief" in the label.\n\n` +
    `If you have questions about what should be in a brief, please reach out to your manager or the product team.`
  );
}

/**
 * Main function to check all initiatives for missing briefs
 * and send DM reminders to owners
 */
export async function checkInitiativeBriefs(env: Env): Promise<BriefCheckResult> {
  const initiatives = await fetchInitiativesWithLinks(env);

  const result: BriefCheckResult = {
    initiativesChecked: initiatives.length,
    missingBriefs: [],
    unmappedUsers: [],
  };

  for (const initiative of initiatives) {
    // Skip initiatives that have briefs
    if (hasBrief(initiative)) {
      continue;
    }

    // Initiative is missing a brief
    const ownerEmail = initiative.owner?.email;
    const ownerName = initiative.owner?.name ?? "Unknown";

    // If no owner or email, can't send notification
    if (!initiative.owner || !ownerEmail) {
      result.missingBriefs.push({
        initiative: { name: initiative.name, url: initiative.url },
        owner: { name: ownerName, email: ownerEmail ?? "unknown" },
        dmSent: false,
      });
      continue;
    }

    // Look up the user in our mapping
    const user = findUserByEmail(ownerEmail);

    if (!user) {
      result.unmappedUsers.push(ownerEmail);
      result.missingBriefs.push({
        initiative: { name: initiative.name, url: initiative.url },
        owner: { name: ownerName, email: ownerEmail },
        dmSent: false,
      });
      continue;
    }

    // Check cooldown - don't spam users
    const inCooldown = await isInCooldown(initiative.id, env);
    if (inCooldown) {
      result.missingBriefs.push({
        initiative: { name: initiative.name, url: initiative.url },
        owner: { name: ownerName, email: ownerEmail },
        dmSent: false,
      });
      continue;
    }

    // Send the DM
    const message = generateBriefReminderMessage(initiative.name, initiative.url);
    const dmResult = await postDirectMessage(user.slackId, message, env);

    if (dmResult.ts) {
      // Record the notification to start cooldown
      await recordNotification(initiative.id, env);
      result.missingBriefs.push({
        initiative: { name: initiative.name, url: initiative.url },
        owner: { name: ownerName, email: ownerEmail },
        dmSent: true,
      });
    } else {
      result.missingBriefs.push({
        initiative: { name: initiative.name, url: initiative.url },
        owner: { name: ownerName, email: ownerEmail },
        dmSent: false,
        error: dmResult.error,
      });
    }
  }

  return result;
}

/**
 * Format brief check results for display in Slack
 */
export function formatBriefCheckResults(result: BriefCheckResult): string {
  const lines: string[] = [];

  lines.push(`*Brief Check Results*`);
  lines.push(`${result.initiativesChecked} initiatives checked`);
  lines.push("");

  if (result.missingBriefs.length === 0) {
    lines.push(":white_check_mark: All initiatives have briefs!");
    return lines.join("\n");
  }

  lines.push(`:warning: ${result.missingBriefs.length} missing briefs:`);
  lines.push("");

  for (const missing of result.missingBriefs) {
    const status = missing.dmSent
      ? ":speech_balloon: DM sent"
      : missing.error
        ? `:x: Error: ${missing.error}`
        : ":hourglass: Not notified";

    lines.push(
      `- *<${missing.initiative.url}|${missing.initiative.name}>* (Owner: ${missing.owner.name}) - ${status}`
    );
  }

  if (result.unmappedUsers.length > 0) {
    lines.push("");
    lines.push(`:bust_in_silhouette: Unmapped users (couldn't send DM):`);
    for (const email of result.unmappedUsers) {
      lines.push(`  - ${email}`);
    }
  }

  return lines.join("\n");
}
