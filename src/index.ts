import type { Env } from "./types";
import { instrument, ResolveConfigFn } from "@microlabs/otel-cf-workers";
import app from "./router";
import { handleScheduled } from "./handlers/cron";
import { getBotUserId, resetBotUserIdCache } from "./handlers/slack";

// OpenTelemetry configuration for ai-observer export
const otelConfig: ResolveConfigFn = (env: Env, _trigger) => ({
  exporter: {
    url: "http://localhost:4318/v1/traces",
  },
  service: {
    name: "chorus",
  },
});

// Export handler for testing
export const handler = {
  // fetch is handled by Hono
  fetch: app.fetch,
  /**
   * Handle scheduled cron triggers (weekly check-ins)
   */
  scheduled: handleScheduled,
};

// Default export wrapped with OpenTelemetry instrumentation
// This sends traces directly to Honeycomb with full custom span attribute support
export default instrument(handler, otelConfig);

// For testing
export { getBotUserId, resetBotUserIdCache };