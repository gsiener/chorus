import { defineConfig } from "vitest/config";

/**
 * Vitest config for quality/evaluation tests
 *
 * These tests make real API calls and are slower/costlier than unit tests.
 * Run with: npm run test:quality
 */
export default defineConfig({
  test: {
    include: ["src/__tests__/claude-quality.test.ts", "src/__tests__/claude-golden.test.ts"],
    testTimeout: 60000,
    hookTimeout: 30000,
    // Run sequentially to avoid rate limits
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
