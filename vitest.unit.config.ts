/**
 * Vitest configuration for unit tests
 *
 * These tests run in Node.js (not Cloudflare Workers pool) for faster execution.
 * Use this for tests that don't require actual Workers bindings.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  // Transform .md files as raw strings
  plugins: [
    {
      name: "markdown-raw",
      transform(code: string, id: string) {
        if (id.endsWith(".md")) {
          return {
            code: `export default ${JSON.stringify(code)}`,
            map: null,
          };
        }
      },
    },
  ],

  test: {
    // Run in Node.js environment (faster than workers pool)
    environment: "node",

    // Use vmThreads pool for lower memory overhead
    pool: "vmThreads",
    poolOptions: {
      vmThreads: {
        memoryLimit: "1GB",
      },
    },

    // Only include unit test files
    // Note: embeddings.test.ts runs separately due to memory constraints
    include: [
      "src/__tests__/claude.test.ts",
      "src/__tests__/slack.test.ts",
      "src/__tests__/docs.test.ts",
      "src/__tests__/initiatives.test.ts",
      "src/__tests__/checkins.test.ts",
      "src/__tests__/thread-context.test.ts",
      "src/__tests__/initiative-nlp.test.ts",
      "src/__tests__/http-utils.test.ts",
      "src/__tests__/linear.test.ts",
      "src/__tests__/user-mapping.test.ts",
      "src/__tests__/brief-checker.test.ts",
      "src/__tests__/capabilities.test.ts",
    ],

    // Exclude integration tests (those need workers pool)
    exclude: [
      "src/__tests__/index.test.ts",
      "src/__tests__/files.test.ts",
      "src/__tests__/claude-quality.test.ts",
      "src/__tests__/claude-golden.test.ts",
      "node_modules/**",
    ],

    // Global test setup
    globals: true,

    // Increase timeout for tests that make API calls
    testTimeout: 10000,
  },

  // Resolve aliases for cleaner imports
  resolve: {
    alias: {
      "@": "/src",
    },
  },
});
