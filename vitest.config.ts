import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

/**
 * Vitest configuration for integration tests
 *
 * These tests run in Cloudflare Workers pool and require actual bindings.
 * For faster unit tests, use: npm run test:unit (vitest.unit.config.ts)
 */
export default defineWorkersConfig({
  test: {
    // Only include integration tests that need Workers bindings
    include: [
      "src/__tests__/index.test.ts",
      "src/__tests__/files.test.ts",
    ],

    // Exclude unit tests (run with test:unit) and quality tests
    exclude: [
      "src/__tests__/claude.test.ts",
      "src/__tests__/slack.test.ts",
      "src/__tests__/docs.test.ts",
      "src/__tests__/initiatives.test.ts",
      "src/__tests__/embeddings.test.ts",
      "src/__tests__/checkins.test.ts",
      "src/__tests__/thread-context.test.ts",
      "src/__tests__/initiative-nlp.test.ts",
      "src/__tests__/http-utils.test.ts",
      "src/__tests__/linear.test.ts",
      "src/__tests__/claude-quality.test.ts",
      "src/__tests__/claude-golden.test.ts",
      "node_modules/**",
    ],

    poolOptions: {
      workers: {
        // Use test config that excludes Vectorize/AI bindings (require remote mode)
        wrangler: { configPath: "./wrangler.test.toml" },
      },
    },
  },
});
