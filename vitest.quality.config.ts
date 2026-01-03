import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

/**
 * Vitest config for quality/evaluation tests
 *
 * These tests make real API calls and are slower/costlier than unit tests.
 * Run with: npm run test:quality
 */
export default defineConfig(({ mode }) => {
  // Load from .env file (local development)
  const fileEnv = loadEnv(mode, process.cwd(), "");

  // Merge with system env vars (GitHub Actions passes secrets this way)
  const env = {
    ...fileEnv,
    // System env vars take precedence (for CI)
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || fileEnv.ANTHROPIC_API_KEY,
  };

  return {
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
      env,
    },
  };
});
