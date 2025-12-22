import type { ResolveConfigFn } from "@microlabs/otel-cf-workers";
import type { Env } from "./types";

export const traceConfig: ResolveConfigFn<Env> = (env, _trigger) => ({
  exporter: {
    url: "https://api.honeycomb.io/v1/traces",
    headers: {
      "x-honeycomb-team": env.HONEYCOMB_API_KEY,
    },
  },
  service: {
    name: "chorus",
  },
  sampling: {
    headSampler: { ratio: 1.0 },
  },
});
