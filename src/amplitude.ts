/**
 * Amplitude Product Analytics Integration for Chorus
 *
 * Fetches product metrics from Amplitude to provide context for
 * answering questions about product performance and trends,
 * and sends weekly Slack reports.
 */

import type { Env } from "./types";
import { postMessage } from "./slack";

const AMPLITUDE_API_URL = "https://amplitude.com/api/2";

// Cache configuration
const CACHE_KEY = "amplitude:metrics:weekly";
const CACHE_TTL_SECONDS = 900; // 15 minutes

// Slack channel for weekly reports
const WEEKLY_REPORT_CHANNEL = "CCESHFY67"; // #product-management
const TEST_CHANNEL = "C0A5NUH6GF4"; // #chorus-test

// Amplitude chart URLs (metric name -> chart ID)
const AMPLITUDE_CHART_BASE = "https://app.amplitude.com/analytics/honeycomb/chart";
const CHART_IDS: Record<string, string> = {
  "Monthly Active Teams": "b95qjuy9",
  "DAU/MAU (Enterprise)": "g8j5k8bo",
  "New Enterprise Users": "11234s52",
  "Week 1 Retention": "nalng92",
  "MTTI (Trace Viewers)": "e5wcni3n",
  "Canvas & MCP Users": "01ylvdqg",
  "Board Creates": "k9xr6g9z",
  "SLO Engagement": "kmkl2tw2",
};

// --- Types ---

export interface AmplitudeMetric {
  name: string;
  category: string;
  currentValue: number;
  previousValue: number;
  changePercent: number;
  unit: string;
  chartUrl?: string;
}

export interface GrowingAccount {
  teamSlug: string;
  currentUsers: number;
  previousUsers: number;
  changePercent: number;
}

export interface AmplitudeMetrics {
  metrics: AmplitudeMetric[];
  growingAccounts: GrowingAccount[];
  fetchedAt: string;
  weekStart: string;
  weekEnd: string;
}

// --- Helpers ---

/**
 * Build Basic Auth header for Amplitude REST API V2
 */
function buildAuthHeader(env: Env): string {
  const credentials = `${env.AMPLITUDE_API_KEY}:${env.AMPLITUDE_API_SECRET}`;
  return `Basic ${btoa(credentials)}`;
}

/**
 * Get date strings for current and previous weeks
 */
export function getWeekRanges(): {
  currentStart: string;
  currentEnd: string;
  previousStart: string;
  previousEnd: string;
} {
  const now = new Date();
  // End of current week = yesterday (most recent complete day)
  const currentEnd = new Date(now);
  currentEnd.setUTCDate(currentEnd.getUTCDate() - 1);

  // Start of current week = 7 days before end
  const currentStart = new Date(currentEnd);
  currentStart.setUTCDate(currentStart.getUTCDate() - 6);

  // Previous week
  const previousEnd = new Date(currentStart);
  previousEnd.setUTCDate(previousEnd.getUTCDate() - 1);

  const previousStart = new Date(previousEnd);
  previousStart.setUTCDate(previousStart.getUTCDate() - 6);

  const fmt = (d: Date) =>
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;

  return {
    currentStart: fmt(currentStart),
    currentEnd: fmt(currentEnd),
    previousStart: fmt(previousStart),
    previousEnd: fmt(previousEnd),
  };
}

/**
 * Format a date string from YYYYMMDD to readable format (e.g., "Jan 27")
 */
function formatDateRange(yyyymmdd: string): string {
  const year = parseInt(yyyymmdd.slice(0, 4));
  const month = parseInt(yyyymmdd.slice(4, 6)) - 1;
  const day = parseInt(yyyymmdd.slice(6, 8));
  const d = new Date(year, month, day);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// --- Amplitude API Queries ---

interface SegmentationResult {
  data?: {
    series: number[][];
    // seriesLabels are numbers for simple queries, [index, slug] for grouped queries
    seriesLabels: unknown[];
    // seriesCollapsed can be {value} or [{value}] depending on grouping
    seriesCollapsed?: Array<{ value: number } | Array<{ value: number }>>;
    xValues?: string[];
  };
}

interface RetentionEntry {
  count: number;
  outof: number;
  incomplete: boolean;
}

interface RetentionResult {
  data?: {
    series?: Array<{
      values?: Record<string, RetentionEntry[]>;
    }>;
    seriesLabels?: string[];
  };
}

/**
 * Query Amplitude event segmentation endpoint
 */
async function querySegmentation(
  params: {
    e: object;
    start: string;
    end: string;
    m?: string;
    i?: number;
    s?: object[];
    limit?: number;
  },
  env: Env,
): Promise<SegmentationResult> {
  const url = new URL(`${AMPLITUDE_API_URL}/events/segmentation`);
  url.searchParams.set("e", JSON.stringify(params.e));
  url.searchParams.set("start", params.start);
  url.searchParams.set("end", params.end);
  if (params.m) url.searchParams.set("m", params.m);
  if (params.i !== undefined) url.searchParams.set("i", String(params.i));
  if (params.s) url.searchParams.set("s", JSON.stringify(params.s));
  if (params.limit !== undefined) url.searchParams.set("limit", String(params.limit));

  const response = await fetch(url.toString(), {
    headers: { Authorization: buildAuthHeader(env) },
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`Amplitude segmentation error: ${response.status} - ${text}`);
    throw new Error(`Amplitude API error: ${response.status}`);
  }

  return response.json() as Promise<SegmentationResult>;
}

/**
 * Query Amplitude retention endpoint
 */
async function queryRetention(
  params: {
    se: object;
    re: object;
    start: string;
    end: string;
    rm?: string;
    i?: number;
    s?: object[];
  },
  env: Env,
): Promise<RetentionResult> {
  const url = new URL(`${AMPLITUDE_API_URL}/retention`);
  url.searchParams.set("se", JSON.stringify(params.se));
  url.searchParams.set("re", JSON.stringify(params.re));
  url.searchParams.set("start", params.start);
  url.searchParams.set("end", params.end);
  if (params.rm) url.searchParams.set("rm", params.rm);
  if (params.i !== undefined) url.searchParams.set("i", String(params.i));
  if (params.s) url.searchParams.set("s", JSON.stringify(params.s));

  const response = await fetch(url.toString(), {
    headers: { Authorization: buildAuthHeader(env) },
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`Amplitude retention error: ${response.status} - ${text}`);
    throw new Error(`Amplitude API error: ${response.status}`);
  }

  return response.json() as Promise<RetentionResult>;
}

/**
 * Sum the values in a segmentation series for a given date range
 */
function sumSeries(result: SegmentationResult): number {
  if (!result.data?.series?.[0]) return 0;
  return result.data.series[0].reduce((sum, v) => sum + v, 0);
}

/**
 * Get the average of values in a segmentation series
 */
function avgSeries(result: SegmentationResult): number {
  if (!result.data?.series?.[0]) return 0;
  const series = result.data.series[0];
  const nonZero = series.filter((v) => v > 0);
  if (nonZero.length === 0) return 0;
  return nonZero.reduce((sum, v) => sum + v, 0) / nonZero.length;
}

/**
 * Get the last non-zero value in a series (most recent data point)
 */
function lastValue(result: SegmentationResult): number {
  if (!result.data?.series?.[0]) return 0;
  const series = result.data.series[0];
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] > 0) return series[i];
  }
  return 0;
}

// --- Enterprise segment filter ---
const ENTERPRISE_SEGMENT = [
  {
    prop: "gp:team_plan",
    op: "is",
    values: ["Enterprise"],
  },
];

// --- Individual Metric Fetchers ---

async function fetchMAT(
  start: string,
  end: string,
  env: Env,
): Promise<number> {
  const result = await querySegmentation(
    {
      e: {
        event_type: "_active",
        group_by: [{ type: "event", value: "team_slug" }],
      },
      start,
      end,
      m: "uniques",
      i: 30,
      limit: 5000,
    },
    env,
  );
  // Count unique team slugs with activity (exclude "(none)")
  if (!result.data?.seriesLabels) return 0;
  // seriesLabels are [index, slug] pairs when grouped
  const labels = result.data.seriesLabels as unknown as Array<[number, string]>;
  return labels.filter(
    (l) => Array.isArray(l) && l[1] !== "(none)",
  ).length;
}

async function fetchDAUMAU(
  start: string,
  end: string,
  env: Env,
): Promise<number> {
  // DAU/MAU ratio for Enterprise users on run-query
  const result = await querySegmentation(
    {
      e: { event_type: "run-query" },
      start,
      end,
      m: "pct_dau",
      i: 1,
      s: ENTERPRISE_SEGMENT,
    },
    env,
  );
  // Amplitude returns fractions (0.0-1.0), convert to percentage
  return Math.round(avgSeries(result) * 1000) / 10;
}

async function fetchMTTI(
  start: string,
  end: string,
  env: Env,
): Promise<number> {
  // Trace viewers as a proxy for insight discovery
  const result = await querySegmentation(
    {
      e: { event_type: "trace-span-viewed" },
      start,
      end,
      m: "uniques",
      i: 1,
    },
    env,
  );
  return Math.round(avgSeries(result));
}

async function fetchCanvasMCPUsers(
  start: string,
  end: string,
  env: Env,
): Promise<number> {
  // Composite: canvas-user-message-sent OR open-in-canvas-clicked OR mcp-session-started
  // Fetch each separately and take unique users (approximate via max)
  const [canvas, openCanvas, mcp] = await Promise.all([
    querySegmentation(
      { e: { event_type: "canvas-user-message-sent" }, start, end, m: "uniques", i: 7 },
      env,
    ),
    querySegmentation(
      { e: { event_type: "open-in-canvas-clicked" }, start, end, m: "uniques", i: 7 },
      env,
    ),
    querySegmentation(
      { e: { event_type: "mcp-session-started" }, start, end, m: "uniques", i: 7 },
      env,
    ),
  ]);
  // Sum unique users across features (slight overcount for users using multiple)
  return lastValue(canvas) + lastValue(openCanvas) + lastValue(mcp);
}

async function fetchNewEnterpriseUsers(
  start: string,
  end: string,
  env: Env,
): Promise<number> {
  const result = await querySegmentation(
    {
      e: { event_type: "_new" },
      start,
      end,
      m: "uniques",
      i: 7,
      s: ENTERPRISE_SEGMENT,
    },
    env,
  );
  return lastValue(result);
}

async function fetchWeek1Retention(
  start: string,
  end: string,
  env: Env,
): Promise<number> {
  const result = await queryRetention(
    {
      se: { event_type: "_new" },
      re: { event_type: "_active" },
      start,
      end,
      rm: "rolling",
      i: 7,
    },
    env,
  );
  // The API returns series[0].values = { "date": [{count, outof}, ...] }
  // We want the earliest complete cohort's week-1 retention (index 1)
  const series = result.data?.series?.[0]?.values;
  if (!series) return 0;

  // Find the earliest cohort (most complete data)
  const cohortDates = Object.keys(series).sort();
  for (const date of cohortDates) {
    const entries = series[date];
    if (entries && entries.length > 1 && !entries[1].incomplete) {
      const week1 = entries[1];
      return Math.round((week1.count / week1.outof) * 1000) / 10;
    }
  }
  // Fallback: use most recent complete entry at index 1
  for (const date of cohortDates) {
    const entries = series[date];
    if (entries && entries.length > 1) {
      const week1 = entries[1];
      return Math.round((week1.count / week1.outof) * 1000) / 10;
    }
  }
  return 0;
}

async function fetchBoardCreates(
  start: string,
  end: string,
  env: Env,
): Promise<number> {
  const result = await querySegmentation(
    {
      e: { event_type: "create-board" },
      start,
      end,
      m: "totals",
      i: 7,
    },
    env,
  );
  return lastValue(result);
}

async function fetchSLOEngagement(
  start: string,
  end: string,
  env: Env,
): Promise<number> {
  const result = await querySegmentation(
    {
      e: { event_type: "ce:Useful SLO Engagement" },
      start,
      end,
      m: "uniques",
      i: 7,
    },
    env,
  );
  return lastValue(result);
}

async function fetchSharingUsers(
  start: string,
  end: string,
  env: Env,
): Promise<number> {
  const [share, copyLink, comment, canvasShare] = await Promise.all([
    querySegmentation(
      { e: { event_type: "show-share-popover" }, start, end, m: "uniques", i: 7 },
      env,
    ),
    querySegmentation(
      { e: { event_type: "query-template-copy-link" }, start, end, m: "uniques", i: 7 },
      env,
    ),
    querySegmentation(
      { e: { event_type: "comment-on-query-run" }, start, end, m: "uniques", i: 7 },
      env,
    ),
    querySegmentation(
      { e: { event_type: "canvas-shared" }, start, end, m: "uniques", i: 7 },
      env,
    ),
  ]);
  return lastValue(share) + lastValue(copyLink) + lastValue(comment) + lastValue(canvasShare);
}

async function fetchGrowingAccounts(
  env: Env,
): Promise<GrowingAccount[]> {
  const { currentStart, currentEnd, previousStart, previousEnd } = getWeekRanges();

  const groupedEvent = {
    event_type: "_active",
    group_by: [{ type: "event", value: "team_slug" }],
    filters: [
      {
        group_type: "User",
        subprop_type: "user",
        subprop_key: "gp:team_plan",
        subprop_op: "is",
        subprop_value: ["Enterprise"],
      },
    ],
  };

  // Fetch active Enterprise users grouped by team_slug for both weeks
  const [currentResult, previousResult] = await Promise.all([
    querySegmentation(
      {
        e: groupedEvent,
        start: currentStart,
        end: currentEnd,
        m: "uniques",
        i: 7,
      },
      env,
    ),
    querySegmentation(
      {
        e: groupedEvent,
        start: previousStart,
        end: previousEnd,
        m: "uniques",
        i: 7,
      },
      env,
    ),
  ]);

  // Parse grouped results into team -> count maps
  const currentTeams = parseGroupedResults(currentResult);
  const previousTeams = parseGroupedResults(previousResult);

  // Calculate growth for each team
  const accounts: GrowingAccount[] = [];
  for (const [slug, currentUsers] of Object.entries(currentTeams)) {
    const previousUsers = previousTeams[slug] ?? 0;
    if (previousUsers < 20) continue; // Enterprise accounts have 20+ users
    const changePercent =
      previousUsers > 0
        ? ((currentUsers - previousUsers) / previousUsers) * 100
        : 0;
    if (changePercent > 0) {
      accounts.push({
        teamSlug: slug,
        currentUsers,
        previousUsers,
        changePercent: Math.round(changePercent * 10) / 10,
      });
    }
  }

  // Sort by growth rate descending, take top 5
  return accounts.sort((a, b) => b.changePercent - a.changePercent).slice(0, 5);
}

/**
 * Parse grouped segmentation results into a slug -> value map.
 * When group_by is used in the event definition, the API returns:
 *   seriesLabels: [[0, "team-a"], [0, "team-b"], ...]
 *   seriesCollapsed: [[{value: 100}], [{value: 200}], ...]
 */
function parseGroupedResults(
  result: SegmentationResult,
): Record<string, number> {
  const teams: Record<string, number> = {};
  if (!result.data?.seriesLabels || !result.data?.seriesCollapsed) return teams;

  const labels = result.data.seriesLabels as unknown as Array<[number, string]>;
  const collapsed = result.data.seriesCollapsed;

  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    const slug = Array.isArray(label) ? label[1] : String(label);
    if (!slug || slug === "(none)") continue;

    // seriesCollapsed entries are wrapped: [[{value: N}], [{value: M}], ...]
    const entry = collapsed[i];
    const value = Array.isArray(entry) ? entry[0]?.value ?? 0 : entry?.value ?? 0;
    if (value > 0) {
      teams[slug] = value;
    }
  }
  return teams;
}

// --- Orchestration ---

function calcChange(current: number, previous: number): number {
  if (previous === 0) return 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/**
 * Fetch all metrics for both current and previous weeks
 */
export async function fetchAllMetrics(env: Env): Promise<AmplitudeMetrics> {
  const { currentStart, currentEnd, previousStart, previousEnd } = getWeekRanges();

  // Fetch all metrics in parallel for both periods
  const [
    matCurrent, matPrevious,
    dauMauCurrent, dauMauPrevious,
    mttiCurrent, mttiPrevious,
    canvasCurrent, canvasPrevious,
    newEntCurrent, newEntPrevious,
    retentionCurrent, retentionPrevious,
    boardsCurrent, boardsPrevious,
    sloCurrent, sloPrevious,
    sharingCurrent, sharingPrevious,
    growingAccounts,
  ] = await Promise.all([
    fetchMAT(currentStart, currentEnd, env),
    fetchMAT(previousStart, previousEnd, env),
    fetchDAUMAU(currentStart, currentEnd, env),
    fetchDAUMAU(previousStart, previousEnd, env),
    fetchMTTI(currentStart, currentEnd, env),
    fetchMTTI(previousStart, previousEnd, env),
    fetchCanvasMCPUsers(currentStart, currentEnd, env),
    fetchCanvasMCPUsers(previousStart, previousEnd, env),
    fetchNewEnterpriseUsers(currentStart, currentEnd, env),
    fetchNewEnterpriseUsers(previousStart, previousEnd, env),
    fetchWeek1Retention(currentStart, currentEnd, env),
    fetchWeek1Retention(previousStart, previousEnd, env),
    fetchBoardCreates(currentStart, currentEnd, env),
    fetchBoardCreates(previousStart, previousEnd, env),
    fetchSLOEngagement(currentStart, currentEnd, env),
    fetchSLOEngagement(previousStart, previousEnd, env),
    fetchSharingUsers(currentStart, currentEnd, env),
    fetchSharingUsers(previousStart, previousEnd, env),
    fetchGrowingAccounts(env),
  ]);

  const metric = (
    name: string,
    category: string,
    currentValue: number,
    previousValue: number,
    unit: string,
  ): AmplitudeMetric => {
    const chartId = CHART_IDS[name];
    return {
      name,
      category,
      currentValue,
      previousValue,
      changePercent: calcChange(currentValue, previousValue),
      unit,
      chartUrl: chartId ? `${AMPLITUDE_CHART_BASE}/${chartId}` : undefined,
    };
  };

  const metrics: AmplitudeMetric[] = [
    metric("Monthly Active Teams", "Engagement", matCurrent, matPrevious, "teams"),
    metric("DAU/MAU (Enterprise)", "Engagement",
      Math.round(dauMauCurrent * 10) / 10, Math.round(dauMauPrevious * 10) / 10, "%"),
    metric("New Enterprise Users", "Activation & Retention", newEntCurrent, newEntPrevious, "users"),
    metric("Week 1 Retention", "Activation & Retention",
      Math.round(retentionCurrent * 10) / 10, Math.round(retentionPrevious * 10) / 10, "%"),
    metric("MTTI (Trace Viewers)", "Activation & Retention", mttiCurrent, mttiPrevious, "users"),
    metric("Canvas & MCP Users", "Feature Adoption", canvasCurrent, canvasPrevious, "users"),
    metric("Board Creates", "Feature Adoption", boardsCurrent, boardsPrevious, "total"),
    metric("SLO Engagement", "Feature Adoption", sloCurrent, sloPrevious, "users"),
    metric("Sharing Users", "Feature Adoption", sharingCurrent, sharingPrevious, "users"),
  ];

  return {
    metrics,
    growingAccounts,
    fetchedAt: new Date().toISOString(),
    weekStart: currentStart,
    weekEnd: currentEnd,
  };
}

// --- Formatters ---

function trendArrow(changePercent: number): string {
  if (changePercent > 1) return "↑";
  if (changePercent < -1) return "↓";
  return "→";
}

/**
 * Build a spark bar showing relative magnitude (1-8 blocks)
 */
function sparkBar(current: number, previous: number): string {
  if (previous === 0) return "▓▓▓▓▓▓▓▓";
  const ratio = Math.min(current / previous, 2);
  const blocks = Math.max(1, Math.round(ratio * 4));
  return "▓".repeat(blocks) + "░".repeat(Math.max(0, 8 - blocks));
}

function formatValue(value: number, unit: string): string {
  if (unit === "%") return `${value}%`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

const CATEGORY_EMOJI: Record<string, string> = {
  Engagement: ":busts_in_silhouette:",
  "Activation & Retention": ":seedling:",
  "Feature Adoption": ":sparkles:",
};

const RANK_EMOJI = [":first_place_medal:", ":second_place_medal:", ":third_place_medal:", "4.", "5."];

/**
 * Format metrics for Slack weekly report (mrkdwn)
 */
export function formatMetricsForSlack(data: AmplitudeMetrics): string {
  const weekRange = `${formatDateRange(data.weekStart)} – ${formatDateRange(data.weekEnd)}`;
  const lines: string[] = [
    `:bar_chart: *Weekly Product Metrics* (${weekRange})`,
    "",
  ];

  // Group metrics by category
  const categories = new Map<string, AmplitudeMetric[]>();
  for (const m of data.metrics) {
    const existing = categories.get(m.category) ?? [];
    existing.push(m);
    categories.set(m.category, existing);
  }

  for (const [category, metrics] of categories) {
    const emoji = CATEGORY_EMOJI[category] ?? ":chart_with_upwards_trend:";
    lines.push(`${emoji} *${category}*`);
    for (const m of metrics) {
      const absChange = Math.abs(m.changePercent);
      const bar = sparkBar(m.currentValue, m.previousValue);
      const label = m.chartUrl
        ? `<${m.chartUrl}|${m.name}>`
        : m.name;
      lines.push(
        `    *${label}:* ${formatValue(m.currentValue, m.unit)}  \`${bar}\`  ${trendArrow(m.changePercent)} ${absChange}% WoW`,
      );
    }
    lines.push("");
  }

  // Growing accounts section
  if (data.growingAccounts.length > 0) {
    lines.push(":fire: *Top Growing Accounts*");
    for (let i = 0; i < data.growingAccounts.length; i++) {
      const a = data.growingAccounts[i];
      const rank = RANK_EMOJI[i] ?? `${i + 1}.`;
      lines.push(
        `    ${rank}  *${a.teamSlug}* — +${a.changePercent}% (${a.previousUsers} → ${a.currentUsers} users)`,
      );
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/**
 * Format metrics as plain text context for Claude's system prompt
 */
export function formatMetricsForClaude(data: AmplitudeMetrics): string {
  const weekRange = `${formatDateRange(data.weekStart)} – ${formatDateRange(data.weekEnd)}`;
  const lines: string[] = [
    `Product metrics for the week of ${weekRange}:`,
    "",
  ];

  for (const m of data.metrics) {
    const arrow = trendArrow(m.changePercent);
    const absChange = Math.abs(m.changePercent);
    const urlSuffix = m.chartUrl ? ` [${m.chartUrl}]` : "";
    lines.push(
      `- ${m.name}: ${formatValue(m.currentValue, m.unit)} (${arrow} ${absChange}% week-over-week)${urlSuffix}`,
    );
  }

  if (data.growingAccounts.length > 0) {
    lines.push("");
    lines.push("Fastest growing accounts this week:");
    for (const a of data.growingAccounts) {
      lines.push(
        `- ${a.teamSlug}: +${a.changePercent}% (${a.previousUsers} → ${a.currentUsers} users)`,
      );
    }
  }

  return lines.join("\n");
}

// --- Cache Management ---

/**
 * Clear the Amplitude metrics cache
 */
export async function clearAmplitudeCache(env: Env): Promise<void> {
  await env.DOCS_KV.delete(CACHE_KEY);
  console.log("Amplitude metrics cache cleared");
}

/**
 * Get Amplitude metrics context for Claude, with caching
 */
export async function getAmplitudeContext(
  env: Env,
): Promise<string | null> {
  if (!env.AMPLITUDE_API_KEY || !env.AMPLITUDE_API_SECRET) {
    console.log("Amplitude API credentials not configured, skipping metrics");
    return null;
  }

  // Check cache first
  const cached = await env.DOCS_KV.get(CACHE_KEY);
  if (cached) {
    console.log("Using cached Amplitude metrics context");
    try {
      const data = JSON.parse(cached) as AmplitudeMetrics;
      return formatMetricsForClaude(data);
    } catch {
      // Invalid cache, fall through to fetch
    }
  }

  try {
    const data = await fetchAllMetrics(env);

    // Cache the raw data (so both Slack and Claude formats can be derived)
    await env.DOCS_KV.put(CACHE_KEY, JSON.stringify(data), {
      expirationTtl: CACHE_TTL_SECONDS,
    });

    return formatMetricsForClaude(data);
  } catch (error) {
    console.error("Failed to fetch Amplitude metrics:", error);
    return null;
  }
}

/**
 * Fetch raw metrics (for debug endpoint)
 */
export async function getAmplitudeMetrics(
  env: Env,
): Promise<AmplitudeMetrics | null> {
  if (!env.AMPLITUDE_API_KEY || !env.AMPLITUDE_API_SECRET) {
    return null;
  }

  // Check cache first
  const cached = await env.DOCS_KV.get(CACHE_KEY);
  if (cached) {
    try {
      return JSON.parse(cached) as AmplitudeMetrics;
    } catch {
      // Invalid cache, fall through
    }
  }

  try {
    const data = await fetchAllMetrics(env);
    await env.DOCS_KV.put(CACHE_KEY, JSON.stringify(data), {
      expirationTtl: CACHE_TTL_SECONDS,
    });
    return data;
  } catch (error) {
    console.error("Failed to fetch Amplitude metrics:", error);
    return null;
  }
}

// --- Weekly Report ---

/**
 * Send weekly product metrics report to Slack
 */
export async function sendWeeklyMetricsReport(
  env: Env,
): Promise<{ success: boolean; error?: string }> {
  if (!env.AMPLITUDE_API_KEY || !env.AMPLITUDE_API_SECRET) {
    console.log("Amplitude API credentials not configured, skipping weekly report");
    return { success: false, error: "Amplitude credentials not configured" };
  }

  try {
    const data = await fetchAllMetrics(env);

    // Cache the data
    await env.DOCS_KV.put(CACHE_KEY, JSON.stringify(data), {
      expirationTtl: CACHE_TTL_SECONDS,
    });

    const message = formatMetricsForSlack(data);
    await postMessage(WEEKLY_REPORT_CHANNEL, message, undefined, env);

    console.log("Weekly metrics report sent to Slack");
    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Failed to send weekly metrics report:", errorMessage);
    return { success: false, error: errorMessage };
  }
}

/**
 * Send a test metrics report to the test channel
 */
export async function sendTestMetricsReport(
  env: Env,
): Promise<{ success: boolean; data?: AmplitudeMetrics; error?: string }> {
  if (!env.AMPLITUDE_API_KEY || !env.AMPLITUDE_API_SECRET) {
    return { success: false, error: "Amplitude credentials not configured" };
  }

  try {
    const data = await fetchAllMetrics(env);

    await env.DOCS_KV.put(CACHE_KEY, JSON.stringify(data), {
      expirationTtl: CACHE_TTL_SECONDS,
    });

    const message = formatMetricsForSlack(data);
    await postMessage(TEST_CHANNEL, message, undefined, env);

    console.log("Test metrics report sent to test channel");
    return { success: true, data };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Failed to send test metrics report:", errorMessage);
    return { success: false, error: errorMessage };
  }
}
