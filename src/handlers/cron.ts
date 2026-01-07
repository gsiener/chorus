import type { Env } from "../types";
import { sendWeeklyCheckins } from "../checkins";
import type { ExecutionContext, ScheduledController } from "@cloudflare/workers-types";

export async function handleScheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  console.log(
    "Running scheduled check-ins at",
    new Date(controller.scheduledTime).toISOString()
  );
  ctx.waitUntil(sendWeeklyCheckins(env));
}
