import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        // Use test config that excludes Vectorize/AI bindings (require remote mode)
        wrangler: { configPath: "./wrangler.test.toml" },
      },
    },
  },
});
