import { Hono } from "hono";
import { Env } from "./types";
import { handleDocsApi, handleTestCheckin, handleTestTelemetry } from "./handlers/api";
import { handleSlashCommand, handleSlackEvents } from "./handlers/slack";

const app = new Hono<{ Bindings: Env }>();

// api routes
app.all("/api/docs", handleDocsApi);
app.post("/api/test-checkin", handleTestCheckin);
app.post("/api/test-telemetry", handleTestTelemetry);

// slack routes
app.post("/slack/slash", handleSlashCommand);
app.post("/slack/events", handleSlackEvents);

app.get("/", (c) => {
  return c.text("Hello, world!");
});

export default app;